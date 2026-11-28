"""Publish a finished run: read the runner's files as hostile data, settle one outcome, then show it on GitHub.

The same module hands a pull request over to a person (`hand_off`), since it is the one that writes as the bot.
"""

import contextlib
import dataclasses
import json
import urllib.parse
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from factory import bundle_check, compose, gitops, hygiene, jobs, result, snapshot, spool
from factory.bundle_check import Verdict
from factory.config import Config, is_trusted
from factory.decide import BUILDING, NEEDS_HUMAN, QUEUED, STATUS_PREFIX
from factory.github_api import GitHub, GitHubError, GraphQLRefused
from factory.result import MAX_THREAD_REPLIES, PULL_REQUEST_STAGES
from factory.snapshot import Bot, Issue, branch_for
from factory.spool import Spool, SpoolError, SpoolMissing

RESULT_FILE = "result.json"
BUNDLE_FILE = "commits.bundle"
SETTLED_FILE = "settled.json"
THREADS_FILE = "threads.json"
MAX_THREADS_BYTES = 1_000_000
# The bound rests on the per-field character limits of `factory.result.validate`: a summary of 4,000, twenty
# questions of 2,000, a failure reason of 4,000, ten follow-ups of 120 and 1,000, a pull request title of 120 and
# body of 20,000 characters, and the replies kept, each of 4,000. JSON may spend 12 bytes on one character (a
# surrogate pair, escaped), and the record's keys, indentation and problems take far less than the 100,000 bytes
# added for them and 400 more for each reply's keys.
MAX_SETTLED_CHARACTERS = 4_000 + 20 * 2_000 + 4_000 + 10 * (120 + 1_000) + 120 + 20_000 + MAX_THREAD_REPLIES * 4_000
MAX_SETTLED_BYTES = 12 * MAX_SETTLED_CHARACTERS + 100_000 + MAX_THREAD_REPLIES * 400
PULL_REQUEST_NOTICES = ("fix-rounds-exhausted",)  # the notices that go on the open pull request, not the issue
BASE_BRANCH = "main"
STAGE_LABEL = "stage:fix"
NOT_FOUND = 404
# A reset time reported more than six hours ahead is not believed: a process in the container can forge the event
# that reports it, and this bounds how long one forgery holds the factory back.
LATEST_RESET = timedelta(hours=6)
TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
NOT_KEPT = "the work so far was not kept"
REFUSED_PUSH = "GitHub refused the push of the checked commits"
BRANCH_MOVED = "the work branch changed on GitHub while the run was going"
STATUS_AFTER = {"done": BUILDING, "usage_limit": QUEUED}  # every other outcome waits for a person
# What GitHub answers to a review request it cannot take (the person is the author, or no collaborator), and to a
# reply whose comment or thread is gone: neither stops the publish.
REVIEW_REQUEST_REFUSED = (422,)
REPLY_REFUSED = (NOT_FOUND, 422)
READY_FOR_REVIEW = ("mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) "
                    "{ clientMutationId } }")
RESOLVE_THREAD = "mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { clientMutationId } }"


def _is_count(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _is_texts(value: object) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _is_reply(value: object) -> bool:
    return (isinstance(value, dict) and set(value) == {"thread", "comment_id", "text", "resolved"}
            and isinstance(value["thread"], str) and spool.THREAD_ID.fullmatch(value["thread"]) is not None
            and _is_number(value["comment_id"]) and isinstance(value["text"], str)
            and isinstance(value["resolved"], bool))


def _is_pair(value: object, keys: tuple[str, str]) -> bool:
    return isinstance(value, dict) and set(value) == set(keys) and all(isinstance(value[key], str) for key in keys)


# What each field of a stored record must look like for `_Settled.from_record` to trust it. compose checks the
# values themselves when it builds the texts; the head must be a commit name before git sees it, and the model one
# that compose accepts: `record` never stores another, so a record that holds one is not what it wrote.
_RECORD_SHAPES: Mapping[str, Callable[[object], bool]] = {
    "outcome": lambda value: isinstance(value, str),
    "duration_seconds": _is_count,
    "model": lambda value: isinstance(value, str) and compose.MODEL.fullmatch(value) is not None,
    "reason": lambda value: value is None or isinstance(value, str),
    "retry_at": lambda value: isinstance(value, str),
    "head_sha": lambda value: value is None or (isinstance(value, str) and gitops.SHA.fullmatch(value) is not None),
    "commits": _is_count,
    "problems": _is_texts,
    "summary": lambda value: isinstance(value, str),
    "questions": _is_texts,
    "failure_reason": lambda value: isinstance(value, str),
    "follow_ups": lambda value: isinstance(value, list) and all(_is_pair(item, ("title", "reason")) for item in value),
    "pull_request": lambda value: value is None or _is_pair(value, ("title", "body")),
    "replies": lambda value: isinstance(value, list) and len(value) <= MAX_THREAD_REPLIES and all(map(_is_reply, value)),
}


@dataclass(frozen=True)
class _Settled:
    """What a run came to, with everything its writes need; stored as `settled.json` before the first write.

    The texts are the result's own, kept only from a valid result without a hygiene finding; compose neutralises
    them when it builds what is posted. `head_sha` and `commits` describe checked commits that are to be pushed.
    `replies` are the answers of a done `revise` run to review threads the dispatcher knows, each with the id of
    the thread's first comment and whether to resolve the thread; they are the only part of the result's replies
    that is ever posted.
    """

    outcome: str
    duration_seconds: int
    model: str
    reason: str | None = None
    retry_at: str = ""
    head_sha: str | None = None
    commits: int = 0
    problems: tuple[str, ...] = ()
    summary: str = ""
    questions: tuple[str, ...] = ()
    failure_reason: str = ""
    follow_ups: tuple[Mapping[str, str], ...] = ()
    pull_request: Mapping[str, str] | None = None
    replies: tuple[Mapping[str, object], ...] = ()

    def record(self) -> dict:
        return dataclasses.asdict(self)

    @classmethod
    def from_record(cls, record: dict, stage: str) -> "_Settled | None":
        """The outcome a record holds, or None when the record does not have the shape `record` writes.

        A done run of a stage that opens the pull request must hold its text; a fix or revise run need not.
        """
        if set(record) != set(_RECORD_SHAPES) or not all(fits(record[name]) for name, fits in _RECORD_SHAPES.items()):
            return None
        if record["outcome"] == "done" and record["pull_request"] is None and stage not in PULL_REQUEST_STAGES:
            return None
        return cls(**{**record, "problems": tuple(record["problems"]), "questions": tuple(record["questions"]),
                      "follow_ups": tuple(record["follow_ups"]), "replies": tuple(record["replies"])})

    def failed_internally(self) -> "_Settled":
        """The same run as an internal error: nothing is pushed, and neither its texts nor its model are shown."""
        return _Settled("crashed", self.duration_seconds, "", reason="internal")

    def rejected(self, problem: str) -> "_Settled":
        """The same run refused for one problem found on GitHub: its commits are not pushed, its texts still shown."""
        return dataclasses.replace(self, outcome="rejected", head_sha=None, commits=0, problems=(problem,))


def _hygiene_labels(data: Mapping) -> list[str]:
    """The label of each hygiene finding in the texts of a valid result that are posted, each once.

    Never the text that matched. The verification is not posted, so a host path in a command the agent ran is no
    finding; the finish check scans the same texts, so the agent learns of a finding before the dispatcher does.
    """
    found = (label for _, text in result.posted_texts(data) for _, label in hygiene.text_problems(text))
    return list(dict.fromkeys(found))


def _texts(data: Mapping) -> dict:
    """What compose needs from a valid result, as keyword arguments of `_Settled`."""
    return {
        "summary": data["summary"], "questions": tuple(data.get("questions") or ()),
        "failure_reason": data.get("failure_reason") or "", "follow_ups": tuple(data.get("follow_ups") or ()),
        "pull_request": data.get("pull_request"),
    }


def _is_number(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _is_for_branch(pull: object, branch: str) -> bool:
    if not isinstance(pull, dict):
        return False
    head = pull.get("head")
    return _is_number(pull.get("number")) and isinstance(head, dict) and head.get("ref") == branch


@dataclass(frozen=True)
class Publisher:
    """Shows on GitHub what finished runs came to, as the factory's bot.

    The only code that both reads the runner's files and writes to GitHub: it reads `runs/` only through the spool,
    checks a private copy of the bundle, and passes the result's raw text to `compose`, which neutralises it.
    """

    spool: Spool
    github: GitHub
    config: Config
    bot: Bot
    workrepo: Path
    scratch: Path
    push_url: str
    token: Callable[[], str]
    clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)

    def publish(self, job_id: str, issue: Issue, now: datetime) -> str:
        """Settle the run's one outcome, show it on GitHub, close the job, and return the outcome.

        The outcome is settled once and stored in the job's own directory before the first write. The writes go in
        this order: the push, the pull request, the replies to review threads, the run comment, the status label;
        then the job is closed, and only then is the quarantine ref dropped. A GitHubError, GitError or SpoolError
        leaves the job finished, so the next poll repeats the call from the stored outcome, and each write is
        skipped, or has the same effect again, when it was already made.

        The stage, the round and the pull request come from the request, never from the result. A `fix_issue` run
        opens the issue's pull request and comments on the issue. A `fix` or `revise` run works on the pull request
        the request names: it opens and closes none, replaces its text when the result holds new text, comments on
        it, and may be done without a commit. The issue's status label is set on the issue in every case.

        Commits are pushed only while the work branch on GitHub is still where the run started, or already at the
        checked head. When it is elsewhere, or GitHub refuses the push, the run is stored again as rejected, and that
        is what is shown: a push that can never succeed must end in a comment, not in a retry without end.

        A request that is no longer what the dispatcher wrote, or that belongs to another job or another issue,
        raises SpoolError on every call before anything is read or written: a wiring bug is a person's to look at.
        """
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("now must be a timezone-aware datetime")
        branch = branch_for(issue.number)
        request = self._request(job_id, branch, issue.number)
        settled, pull_request_text = self._settled(job_id, request, issue, branch, now)
        if settled.head_sha is not None:
            settled = self._push(job_id, request, branch, settled)
        self._show(job_id, request, issue, branch, settled, pull_request_text if settled.outcome == "done" else None)
        self._close(job_id, settled)
        return settled.outcome

    def give_up(self, job_id: str, issue: Issue, now: datetime) -> str:
        """Show the run as an internal error after publishing it has failed too often; close the job; return that.

        The internal error is stored over the settled outcome without reading anything from `runs/`, and shown with
        the writes of any outcome without commits, each safe to repeat: the run comment, which carries the marker,
        then the status label, then the close. `now` is checked as `publish` checks it, and the request too.
        """
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("now must be a timezone-aware datetime")
        branch = branch_for(issue.number)
        request = self._request(job_id, branch, issue.number)
        _, loaded = self._stored(job_id, request["stage"])
        settled = self._store(job_id, loaded.failed_internally() if loaded is not None
                              else _Settled("crashed", 0, "", reason="internal"))
        self._show(job_id, request, issue, branch, settled, None)
        self._close(job_id, settled)
        return settled.outcome

    def post_notice(self, issue: Issue, key: str) -> None:
        """Post the fixed notice `key`, unless GitHub now lists that notice last with no trusted comment after it.

        The comments are read the way `decide` reads them: the issue's and, when the issue has an open pull request,
        that pull request's, listed fresh (the poll's may lag behind a notice just posted) and merged by id. A
        trusted comment after the notice, on either side, is an answer that did not settle it, such as a second
        `app:` line that names no app either or a `/factory retry` that failed again, and gets the notice again.
        The notice of exhausted fix rounds goes on the open pull request, where the fix runs commented; every other
        notice goes on the issue.
        """
        body = compose.notice(key)
        pull = issue.pull_request
        pull_number = pull.number if pull is not None and pull.open else None
        found = self._stream(issue, pull_number)
        markers_found = found.markers(self.bot)
        last = markers_found[-1] if markers_found else None
        if last is not None and last.data.get("kind") == "notice" and last.data.get("key") == key:
            answered = any(comment.id > last.comment_id and comment.author != self.bot.login
                           and is_trusted(comment.author, self.config) for comment in found.comments)
            if not answered:
                return
        target = pull_number if key in PULL_REQUEST_NOTICES and pull_number is not None else issue.number
        self.github.post(f"{self.github.repo}/issues/{target}/comments", {"body": body})

    def hand_off(self, issue: Issue) -> None:
        """Hand the issue's pull request to a person: mark it ready, ask for their review, and say so.

        Nothing is written when GitHub now says the pull request is closed, when its head is no longer the one the
        poll saw, when that head has a failing review, or when its hand-off comment is already there. Only a trusted
        person is asked for a review. The comment is the last write, so a hand-off that stopped before it is done
        again in full; marking ready and asking for a review are skipped or harmless the second time. A GitHubError
        other than GitHub's refusal of the review request is raised, and the next poll repeats the hand-off.
        """
        pull = issue.pull_request
        if pull is None or not pull.open or pull.verdict == "fail":
            return
        body = compose.handoff_comment(pull.head_sha, pull.verdict)  # refused before anything is written
        path = f"{self.github.repo}/pulls/{pull.number}"
        fresh = self.github.get(path)
        if not isinstance(fresh, dict):
            raise GitHubError(0, "GET /pulls did not answer with a pull request")
        head = fresh.get("head")
        if fresh.get("state") != "open" or not isinstance(head, dict) or head.get("sha") != pull.head_sha:
            return
        comments = self._listed(issue, f"{self.github.repo}/issues/{pull.number}/comments")
        if any(marker.data.get("kind") == "handoff" and marker.data.get("head") == pull.head_sha
               for marker in comments.markers(self.bot)):
            return
        if fresh.get("draft") is True:
            self.github.graphql(READY_FOR_REVIEW, {"id": pull.node_id})
        if issue.trigger_actor and is_trusted(issue.trigger_actor, self.config):
            self._request_review(path, issue.trigger_actor)
        self.github.post(f"{self.github.repo}/issues/{pull.number}/comments", {"body": body})

    def _request_review(self, pull_path: str, reviewer: str) -> None:
        """Ask the person for a review; GitHub refuses when they are the author or cannot review, which is fine."""
        try:
            self.github.post(f"{pull_path}/requested_reviewers", {"reviewers": [reviewer]})
        except GitHubError as error:
            if error.status not in REVIEW_REQUEST_REFUSED:
                raise

    def set_status(self, issue_number: int, add: str | None, remove: Sequence[str]) -> None:
        """Remove each label in `remove`, then add `add`; a label that is already gone is not an error."""
        labels = f"{self.github.repo}/issues/{issue_number}/labels"
        for name in remove:
            try:
                self.github.delete(f"{labels}/{urllib.parse.quote(name, safe='')}")
            except GitHubError as error:
                if error.status != NOT_FOUND:
                    raise
        if add is not None:
            self.github.post(labels, {"labels": [add]})

    @property
    def _repository(self) -> str:
        return self.github.repo.removeprefix("/repos/")

    def _request(self, job_id: str, branch: str, issue_number: int) -> dict:
        """The dispatcher's own request for the job, which must still be what it wrote, for this job and issue."""
        request = self.spool.request(job_id)
        problems = jobs.validate_request(request)
        if problems:
            raise SpoolError(f"request.json: {'; '.join(problems)}")
        if request["job_id"] != job_id:
            raise SpoolError("request.json is the request of another job")
        if request["branch"] != branch:
            raise SpoolError(f"request.json names another branch than the one of issue #{issue_number}")
        if request["stage"] in PULL_REQUEST_STAGES and request["pull_request"] == 0:
            raise SpoolError("request.json names no pull request for a stage that works on one")
        return request

    # Working out the outcome ---------------------------------------------------------------------------------------

    def _settled(self, job_id: str, request: Mapping, issue: Issue, branch: str,
                 now: datetime) -> tuple[_Settled, Mapping[str, str] | None]:
        """The run's one outcome and its pull request's text, both final before the first write.

        A repeat loads the stored outcome and reads nothing from `runs/` again, so the runner cannot change it
        between two calls. A stored record that is unusable, or whose commits to push are no longer in the work
        repository, makes the repeat an internal error, stored over it, rather than a second reading of the run.
        """
        found, loaded = self._stored(job_id, request["stage"])
        if not found:
            settled = self._settle(job_id, request, branch, now)
        elif loaded is None:
            settled = _Settled("crashed", 0, request["model"], reason="internal")
        elif loaded.head_sha is not None and not self._has_commit(loaded.head_sha):
            settled = loaded.failed_internally()
        else:
            settled = loaded
        try:
            pull_request_text = self._compose_ahead(job_id, request, issue.number, branch, settled)
        except ValueError:
            settled, pull_request_text = settled.failed_internally(), None
        if settled is not loaded:
            self._store(job_id, settled)
        return settled, pull_request_text

    def _stored(self, job_id: str, stage: str) -> tuple[bool, _Settled | None]:
        """Whether an earlier call stored an outcome, and that outcome unless its record is unusable.

        A record that is not JSON, not an object or not of the shape `_Settled.record` writes is unusable; so is one
        the spool refuses to read (a link, a file over the limit).
        """
        try:
            record = self.spool.read_job_json(job_id, SETTLED_FILE, MAX_SETTLED_BYTES)
        except SpoolError:
            return True, None
        if record is None:
            return False, None
        return True, _Settled.from_record(record, stage)

    def _settle(self, job_id: str, request: Mapping, branch: str, now: datetime) -> _Settled:
        """The outcome from the run record and, for a completed run, its result and bundle."""
        try:
            run = self.spool.run_record(job_id)
        except SpoolError:
            return _Settled("crashed", 0, request["model"], reason="internal")
        timing = {"duration_seconds": run["duration_seconds"], "model": run["model"] or request["model"]}
        if run["status"] == "usage_limit":
            return _Settled("usage_limit", **timing, retry_at=self._retry_at(run["resets_at"], now))
        if run["status"] != "completed":
            return _Settled(run["status"], **timing, reason=run["reason"])
        return self._settle_completed(job_id, request, branch, timing)

    def _settle_completed(self, job_id: str, request: Mapping, branch: str, timing: dict) -> _Settled:
        """A completed run's outcome: its result decides first, and only a clean done or needs_input checks commits."""
        data = self._result(job_id, request["stage"])
        if data is None:
            return _Settled("crashed", **timing, reason="agent_error")
        labels = _hygiene_labels(data)
        if labels:
            problems = tuple(f"the result's text contains {label}" for label in labels)
            return _Settled("rejected", **timing, problems=problems)
        texts = _texts(data)
        if data["outcome"] == "failed":
            return _Settled("failed", **timing, **texts)
        verdict = self._check_bundle(job_id, request["base_sha"], branch)
        kept = {"head_sha": verdict.head_sha, "commits": verdict.commits} if verdict is not None and verdict.ok else {}
        if data["outcome"] == "needs_input":
            problems = (NOT_KEPT, *verdict.problems) if verdict is not None and not verdict.ok else ()
            return _Settled("needs_input", **timing, **texts, **kept, problems=problems)
        if verdict is None and request["stage"] not in PULL_REQUEST_STAGES:
            return _Settled("rejected", **timing, **texts, problems=(bundle_check.NO_COMMITS,))
        if verdict is not None and not verdict.ok:
            return _Settled("rejected", **timing, **texts, problems=verdict.problems)
        replies = self._replies(job_id, data) if request["stage"] == "revise" else ()
        return _Settled("done", **timing, **texts, **kept, replies=replies)

    def _replies(self, job_id: str, data: Mapping) -> tuple[dict, ...]:
        """The replies of a result to threads in the job's `threads.json`, at most one a thread, the first kept.

        A thread the file does not hold is ignored, and so is a file that is missing or unusable: the agent was
        shown only the threads the file lists, so a reply to another is a guess or an attack.
        """
        known = self._threads(job_id)
        chosen: dict[str, dict] = {}
        for entry in data.get("thread_replies") or ():
            thread = entry["thread_id"]
            if thread in known and thread not in chosen:
                chosen[thread] = {"thread": thread, "comment_id": known[thread], "text": entry["body"],
                                  "resolved": entry["resolved"]}
        return tuple(chosen.values())  # never more than MAX_THREAD_REPLIES: a valid result holds no more entries

    def _threads(self, job_id: str) -> dict[str, int]:
        """`{thread id: first comment id}` from the file the dispatcher wrote, without any entry that is not one."""
        try:
            index = self.spool.read_job_json(job_id, THREADS_FILE, MAX_THREADS_BYTES) or {}
        except SpoolError:
            return {}
        return {thread: comment_id for thread, comment_id in index.items()
                if spool.THREAD_ID.fullmatch(thread) and _is_number(comment_id)}

    def _retry_at(self, resets_at: int | None, now: datetime) -> str:
        """The reported reset when it lies in the next six hours, else now plus the configured backoff."""
        if resets_at is not None:
            reset = datetime.fromtimestamp(resets_at, timezone.utc)
            if now < reset <= now + LATEST_RESET:
                return reset.strftime(TIME_FORMAT)
        backoff = timedelta(minutes=self.config.dispatcher.usage_limit_backoff_minutes)
        return (now + backoff).astimezone(timezone.utc).strftime(TIME_FORMAT)

    def _result(self, job_id: str, stage: str) -> dict | None:
        """The result when it is a regular file within its limit, JSON, and valid for the stage; else None.

        Validation problems are dropped, not posted: they can quote the agent's text.
        """
        try:
            data = json.loads(self.spool.read_run_file(job_id, RESULT_FILE, result.MAX_RESULT_BYTES).decode("utf-8"))
        except (SpoolError, ValueError, RecursionError):  # ValueError: bytes that are not UTF-8 or text not JSON
            return None
        return None if result.validate(data, stage) else data

    def _check_bundle(self, job_id: str, base_sha: str, branch: str) -> Verdict | None:
        """The bundle check on a private copy of the bundle, or None when the run handed over no bundle.

        The check reads the file several times; on the copy, the runner cannot swap it in between. The copy is
        needed only by the check: the push takes the checked head the check fetched into the work repository.
        """
        megabytes = self.config.dispatcher.max_bundle_megabytes
        try:
            data = self.spool.read_run_file(job_id, BUNDLE_FILE, megabytes * bundle_check.MEGABYTE)
        except SpoolMissing:
            return None
        except SpoolError:
            return Verdict(False, None, 0, (bundle_check.missing_or_too_large(megabytes),))
        copy = self.scratch / f"{job_id}.bundle"
        try:
            self._write_copy(copy, data)
            return bundle_check.check(copy, workrepo=self.workrepo, base_sha=base_sha, branch=branch, job_id=job_id,
                                      bot=self.bot, config=self.config)
        finally:
            with contextlib.suppress(OSError):  # must not hide what the check raised; a stray copy is harmless
                copy.unlink(missing_ok=True)

    def _write_copy(self, copy: Path, data: bytes) -> None:
        try:
            self.scratch.mkdir(parents=True, exist_ok=True)
            copy.write_bytes(data)
        except OSError as error:
            raise SpoolError(f"{BUNDLE_FILE} cannot be copied for checking: "
                             f"{error.strerror or type(error).__name__}") from None

    def _has_commit(self, sha: str) -> bool:
        """Whether the work repository still holds the commit, whatever names it.

        `resolve` answers None for a commit that is not there and raises GitError when git itself fails, which
        `git cat-file -e` could not tell apart (it exits 128 for both).
        """
        return gitops.resolve(self.workrepo, sha) == sha

    def _compose_ahead(self, job_id: str, request: Mapping, issue_number: int, branch: str,
                       settled: _Settled) -> Mapping[str, str] | None:
        """The pull request's text for a done run that has one, and a trial run comment, so compose cannot refuse
        between writes.

        The trial leaves out only the pull request's link, which exists after the pull request step and is checked
        against compose's own form there. A reply cannot make compose refuse: a text it will not take is not posted.
        """
        self._run_comment(job_id, request, branch, settled, url="")
        if settled.outcome != "done" or settled.pull_request is None:
            return None
        return {
            "title": compose.pull_request_title(settled.pull_request["title"]),
            "body": compose.pull_request_body(settled.pull_request["body"], issue_number, settled.follow_ups),
        }

    # Showing it on GitHub ------------------------------------------------------------------------------------------

    def _push(self, job_id: str, request: Mapping, branch: str, settled: _Settled) -> _Settled:
        """Push the checked commits and return the outcome; a rejected one, stored, when GitHub stands in the way.

        A branch that GitHub does not have yet is fine for a `fix_issue` run: one that starts from `main` creates
        it. A fix or revise run works on a branch that exists, so a missing one was deleted and stays so. Any other
        failure of the push, of the network or of signing in, is raised, so that the next poll tries again.
        """
        base_sha = request["base_sha"]
        allowed = (base_sha, settled.head_sha)
        if request["stage"] not in PULL_REQUEST_STAGES:
            allowed += (None,)
        if self._branch_head(branch) not in allowed:
            return self._store(job_id, settled.rejected(BRANCH_MOVED))
        try:
            gitops.push(self.workrepo, self.push_url, self.token(), settled.head_sha, branch)
        except gitops.PushRefused:
            return self._store(job_id, settled.rejected(REFUSED_PUSH))
        return settled

    def _branch_head(self, branch: str) -> str | None:
        """The commit the work branch names on GitHub, or None when GitHub has no such branch."""
        try:
            answer = self.github.get(f"{self.github.repo}/git/ref/heads/{branch}")
        except GitHubError as error:
            if error.status != NOT_FOUND:
                raise
            return None
        target = answer.get("object") if isinstance(answer, dict) else None
        sha = target.get("sha") if isinstance(target, dict) else None
        if not (isinstance(sha, str) and gitops.SHA.fullmatch(sha)):
            raise GitHubError(0, "GET /git/ref did not answer with a commit")  # never push on a guess
        return sha

    def _store(self, job_id: str, settled: _Settled) -> _Settled:
        self.spool.write_job_json(job_id, SETTLED_FILE, settled.record())
        return settled

    def _close(self, job_id: str, settled: _Settled) -> None:
        """Close the job at this moment, then drop its quarantine ref."""
        self.spool.close(job_id, settled.outcome, self.clock())
        self._clean_up(job_id)

    def _show(self, job_id: str, request: Mapping, issue: Issue, branch: str, settled: _Settled,
              pull_request_text: Mapping[str, str] | None) -> None:
        """The writes after the push, each safe to repeat; the comment comes last of those on GitHub's pull request.

        A fix or revise run's writes go to the pull request the request names, and its replies to review threads
        come before its comment, which is what ends the job: an interruption before it repeats every earlier write.
        """
        stage = request["stage"]
        if stage in PULL_REQUEST_STAGES:
            number = request["pull_request"]
            if pull_request_text is not None:
                self._replace_text(number, pull_request_text)
            if stage == "revise" and settled.outcome == "done":
                self._post_replies(issue, job_id, number, settled.replies)
            url = ""  # the comment is on that pull request already
        else:
            number = issue.number
            url = self._pull_request(branch, pull_request_text) if pull_request_text is not None else ""
        self._post_run_comment(issue, number, job_id, self._run_comment(job_id, request, branch, settled, url),
                               settled.outcome)
        wanted = STATUS_AFTER.get(settled.outcome, NEEDS_HUMAN)
        others = [label for label in issue.labels if label.startswith(STATUS_PREFIX) and label != wanted]
        self.set_status(issue.number, wanted, others)

    def _replace_text(self, number: int, text: Mapping[str, str]) -> None:
        """Give the pull request the run's text, but only when the bot opened it, as read from GitHub now.

        One that another account opened keeps its text, as in `_pull_request`.
        """
        pull = self.github.get(f"{self.github.repo}/pulls/{number}")
        if isinstance(pull, dict) and self._is_the_bots(pull):
            self.github.patch(f"{self.github.repo}/pulls/{number}", dict(text))

    def _pull_request(self, branch: str, text: Mapping[str, str]) -> str:
        """The branch's open pull request, opened as a draft when there is none; return its link.

        The bot's own pull request gets the run's text and the stage label. One that another account opened from
        the branch is the run's pull request too, but its text and labels stay that account's.
        """
        owner = self._repository.split("/")[0]
        listed = self.github.get(f"{self.github.repo}/pulls", {
            "head": f"{owner}:{branch}", "base": BASE_BRANCH, "state": "open", "per_page": "10"})
        if not isinstance(listed, list):
            raise GitHubError(0, "GET /pulls did not answer with a list")  # never open a second one on a guess
        for_branch = [pull for pull in listed if _is_for_branch(pull, branch)]
        own = [pull for pull in for_branch if self._is_the_bots(pull)]
        if own:
            pull = max(own, key=lambda candidate: candidate["number"])
            self.github.patch(f"{self.github.repo}/pulls/{pull['number']}", dict(text))
        elif for_branch:
            return self._pull_request_url(max(for_branch, key=lambda candidate: candidate["number"]))
        else:
            pull = self.github.post(f"{self.github.repo}/pulls",
                                    {**text, "head": branch, "base": BASE_BRANCH, "draft": True})
            if not (isinstance(pull, dict) and _is_number(pull.get("number"))):
                raise GitHubError(0, "POST /pulls did not answer with a pull request number")
        self.github.post(f"{self.github.repo}/issues/{pull['number']}/labels", {"labels": [STAGE_LABEL]})
        return self._pull_request_url(pull)

    def _is_the_bots(self, pull: dict) -> bool:
        user = pull.get("user")
        user_id = user.get("id") if isinstance(user, dict) else None
        return _is_number(user_id) and user_id == self.bot.user_id

    def _pull_request_url(self, pull: Mapping) -> str:
        """GitHub's own link when it has compose's form, else one built from the repository and the number.

        A link that has neither form is left out rather than refused, since the pull request step has written.
        """
        url = pull.get("html_url")
        if isinstance(url, str) and compose.PULL_REQUEST_URL.fullmatch(url):
            return url
        built = f"https://github.com/{self._repository}/pull/{pull['number']}"
        return built if compose.PULL_REQUEST_URL.fullmatch(built) else ""

    def _run_comment(self, job_id: str, request: Mapping, branch: str, settled: _Settled, url: str) -> str:
        """The run's comment. The texts go to compose raw: compose neutralises them, exactly once.

        A done run names its head: the commit it pushed, or, when it made none and so pushed nothing, the one it
        started from, which was the work branch's head when the job was made. The stage and the round are the
        request's.
        """
        head = (settled.head_sha or request["base_sha"]) if settled.outcome == "done" else ""
        return compose.run_comment(
            job_id=job_id, stage=request["stage"], outcome=settled.outcome, duration_seconds=settled.duration_seconds,
            model=settled.model, summary=settled.summary, questions=settled.questions,
            failure_reason=settled.failure_reason, problems=settled.problems, follow_ups=settled.follow_ups,
            pull_request_url=url, branch=branch, kept_commits=settled.commits, retry_at=settled.retry_at,
            reason=settled.reason, round=request["round"], head=head,
        )

    def _post_replies(self, issue: Issue, job_id: str, number: int, replies: Sequence[Mapping[str, object]]) -> None:
        """Reply once to each thread, then resolve the ones that are to be; a repeat does only what is missing.

        The review comments are listed afresh, once, and a thread that already holds this job's reply from the bot
        gets none. Resolving a resolved thread does nothing, so it is simply done again.
        """
        already: set[object] | None = None
        for reply in replies:
            body = self._reply_body(job_id, reply)
            answered = True  # a reply without text has nothing to post
            if body is not None:
                if already is None:
                    already = self._replied_threads(issue, job_id, number)
                answered = reply["thread"] in already or self._reply(number, reply, body)
            if reply["resolved"] and answered:  # resolving a thread the reply never reached would hide it unanswered
                self._resolve(reply["thread"])

    def _reply(self, number: int, reply: Mapping[str, object], body: str) -> bool:
        """Post one reply and say whether it was taken; a 404 or 422 means the comment or its thread is gone."""
        try:
            self.github.post(f"{self.github.repo}/pulls/{number}/comments/{reply['comment_id']}/replies",
                             {"body": body})
        except GitHubError as error:
            if error.status not in REPLY_REFUSED:
                raise
            return False
        return True

    def _resolve(self, thread: object) -> None:
        """Resolve a thread; when GitHub answers that it does not exist, it is skipped.

        Any other refusal (a limit, a permission) and any failed request raise, and the publish is tried again.
        """
        try:
            self.github.graphql(RESOLVE_THREAD, {"id": thread})
        except GraphQLRefused as refused:
            if not refused.not_found:
                raise

    @staticmethod
    def _reply_body(job_id: str, reply: Mapping[str, object]) -> str | None:
        """The reply as it is posted, ending in the marker that says which job and thread it answers.

        None for a text with nothing in it but white space or control characters: there is nothing to post.
        """
        try:
            return compose.thread_reply(reply["text"], job_id=job_id, thread_id=reply["thread"])
        except ValueError:
            return None

    def _replied_threads(self, issue: Issue, job_id: str, number: int) -> set[object]:
        """The threads the bot has already answered for this job, from the pull request's review comments."""
        found = self._listed(issue, f"{self.github.repo}/pulls/{number}/comments").markers(self.bot)
        return {marker.data.get("thread") for marker in found
                if marker.data.get("kind") == "reply" and marker.data.get("job") == job_id}

    def _post_run_comment(self, issue: Issue, number: int, job_id: str, body: str, outcome: str) -> None:
        """Post the comment on the issue or pull request `number` unless the bot's comments already report this job.

        A usage limit right after a usage limit edits that comment instead, so a long wait leaves one comment.
        """
        found = self._fresh(issue, number).markers(self.bot)
        if any(marker.data.get("job") == job_id for marker in found):
            return
        if outcome == "usage_limit" and found and found[-1].outcome == "usage_limit":
            self.github.patch(f"{self.github.repo}/issues/comments/{found[-1].comment_id}", {"body": body})
        else:
            self.github.post(f"{self.github.repo}/issues/{number}/comments", {"body": body})

    def _fresh(self, issue: Issue, number: int | None = None) -> Issue:
        """The issue with the comments of issue or pull request `number` (its own by default) as GitHub lists them."""
        return self._listed(issue, f"{self.github.repo}/issues/{number or issue.number}/comments")

    def _stream(self, issue: Issue, pull_number: int | None) -> Issue:
        """The issue with its comments and, for an open pull request, the pull request's, fresh and merged by id."""
        stream = self._fresh(issue)
        if pull_number is None:
            return stream
        merged = {comment.id: comment for comment in (*stream.comments, *self._fresh(issue, pull_number).comments)}
        return dataclasses.replace(issue, comments=tuple(sorted(merged.values(), key=lambda comment: comment.id)))

    def _listed(self, issue: Issue, path: str) -> Issue:
        """The issue with the comments GitHub lists at `path` now, oldest first; the one passed in may be a poll old."""
        listed = self.github.get_all(path, {"per_page": "100"})
        comments = (snapshot.comment_from(entry) for entry in listed)
        ordered = sorted((comment for comment in comments if comment is not None), key=lambda comment: comment.id)
        return dataclasses.replace(issue, comments=tuple(ordered))

    def _clean_up(self, job_id: str) -> None:
        """Drop the quarantine ref of a job already closed, as far as git lets it: a ref left behind is harmless.

        It runs after the close, so an interruption before the close leaves the checked head for the repeat.
        """
        with contextlib.suppress(gitops.GitError):
            gitops.run_git(self.workrepo, "update-ref", "-d", f"refs/quarantine/{job_id}")
