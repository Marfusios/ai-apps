"""Publish a finished run: read the runner's files as hostile data, settle one outcome, then show it on GitHub."""

import contextlib
import dataclasses
import json
import re
import urllib.parse
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from factory import bundle_check, compose, gitops, hygiene, jobs, result, snapshot
from factory.bundle_check import Verdict
from factory.config import Config
from factory.decide import BUILDING, NEEDS_HUMAN, QUEUED, STATUS_PREFIX
from factory.github_api import GitHub, GitHubError
from factory.snapshot import Bot, Issue, Marker, branch_for
from factory.spool import Spool, SpoolError, SpoolMissing

RESULT_FILE = "result.json"
BUNDLE_FILE = "commits.bundle"
SETTLED_FILE = "settled.json"
# The settled texts come from one result; JSON escaping can make them at most three times its size.
MAX_SETTLED_BYTES = 4 * result.MAX_RESULT_BYTES
BASE_BRANCH = "main"
STAGE_LABEL = "stage:fix"
NOT_FOUND = 404
# The longest usage window is a week: a reset time further ahead than that and a day is not believed.
LATEST_RESET = timedelta(days=8)
TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
PULL_REQUEST_URL = re.compile(r"https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/[0-9]+")  # compose's form
NOT_KEPT = "the work so far was not kept"
STATUS_AFTER = {"done": BUILDING, "usage_limit": QUEUED}  # every other outcome waits for a person


@dataclass(frozen=True)
class _Settled:
    """What a run came to, with everything its writes need; stored as `settled.json` before the first write.

    The texts are the result's own, kept only from a valid result without a hygiene finding; compose neutralises
    them when it builds what is posted. `head_sha` and `commits` describe checked commits that are to be pushed.
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

    def record(self) -> dict:
        return dataclasses.asdict(self)

    @classmethod
    def from_record(cls, record: dict) -> "_Settled":
        try:
            settled = cls(**record)
        except TypeError:
            raise SpoolError(f"{SETTLED_FILE} does not hold a settled outcome") from None
        return dataclasses.replace(settled, problems=tuple(settled.problems), questions=tuple(settled.questions),
                                   follow_ups=tuple(settled.follow_ups))

    def failed_internally(self) -> "_Settled":
        """The same run as an internal error: nothing is pushed and none of its texts is shown."""
        return _Settled("crashed", self.duration_seconds, self.model, reason="internal")


def _strings(value: object) -> Iterator[str]:
    """Every string in a JSON value, object keys included."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for name, item in value.items():
            yield from _strings(name)
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)


def _hygiene_labels(data: object) -> list[str]:
    """The label of each hygiene finding anywhere in the result, each once; never the text that matched."""
    return list(dict.fromkeys(label for text in _strings(data) for _, label in hygiene.text_problems(text)))


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

    def publish(self, job_id: str, issue: Issue, now: datetime) -> str:
        """Settle the run's one outcome, show it on GitHub, close the job, and return the outcome.

        The outcome is settled once and stored in the job's own directory before the first write. The writes go in
        this order: the push, the pull request, the run comment, the status label; the job is closed last. A
        GitHubError or GitError leaves the job finished, so the next poll repeats the call from the stored outcome,
        and each write is skipped, or has the same effect again, when it was already made. A request that is no
        longer what the dispatcher wrote raises SpoolError before anything is written.
        """
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("now must be a timezone-aware datetime")
        request = self._request(job_id)
        branch = branch_for(issue.number)
        settled, pull_request_text = self._settled(job_id, request, issue, branch, now)
        self._show(job_id, request["stage"], issue, branch, settled, pull_request_text)
        self._clean_up(job_id)
        self.spool.close(job_id, settled.outcome, now)
        return settled.outcome

    def post_notice(self, issue: Issue, key: str) -> None:
        """Post the fixed notice `key`, unless the issue's last marker is already that notice."""
        body = compose.notice(key)
        found = issue.markers(self.bot)
        last = found[-1].data if found else {}
        if last.get("kind") == "notice" and last.get("key") == key:
            return
        self.github.post(f"{self.github.repo}/issues/{issue.number}/comments", {"body": body})

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

    def _request(self, job_id: str) -> dict:
        """The dispatcher's own request for the job, which must still be what it wrote."""
        request = self.spool.request(job_id)
        problems = jobs.validate_request(request)
        if problems:
            raise SpoolError(f"request.json: {'; '.join(problems)}")
        return request

    # Working out the outcome ---------------------------------------------------------------------------------------

    def _settled(self, job_id: str, request: Mapping, issue: Issue, branch: str,
                 now: datetime) -> tuple[_Settled, Mapping[str, str] | None]:
        """The run's one outcome and its pull request's text, both final before the first write.

        A repeat loads the stored outcome and reads nothing from `runs/` again, so the runner cannot change it
        between two calls. Stored commits to push must still be in quarantine: when they are gone, the repeat is an
        internal error rather than a second reading of the bundle.
        """
        stored = self.spool.read_job_json(job_id, SETTLED_FILE, MAX_SETTLED_BYTES)
        loaded = _Settled.from_record(stored) if stored is not None else None
        if loaded is None:
            settled = self._settle(job_id, request, branch, now)
        elif loaded.head_sha is not None and not self._quarantined(job_id, loaded.head_sha):
            settled = loaded.failed_internally()
        else:
            settled = loaded
        try:
            pull_request_text = self._compose_ahead(job_id, request["stage"], issue.number, branch, settled)
        except ValueError:
            settled, pull_request_text = settled.failed_internally(), None
        if settled is not loaded:
            self.spool.write_job_json(job_id, SETTLED_FILE, settled.record())
        return settled, pull_request_text

    def _settle(self, job_id: str, request: Mapping, branch: str, now: datetime) -> _Settled:
        """The outcome from the run record and, for a completed run, its result and bundle."""
        if request["job_id"] != job_id or request["branch"] != branch:
            return _Settled("crashed", 0, request["model"], reason="internal")  # never one job's work on another issue
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
        if verdict is None:
            return _Settled("rejected", **timing, **texts, problems=(bundle_check.NO_COMMITS,))
        if not verdict.ok:
            return _Settled("rejected", **timing, **texts, problems=verdict.problems)
        return _Settled("done", **timing, **texts, **kept)

    def _retry_at(self, resets_at: int | None, now: datetime) -> str:
        """The reported reset when it lies in the next eight days, else now plus the configured backoff."""
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
        needed only by the check: the push takes the checked head from the quarantine ref the check leaves.
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

    def _quarantined(self, job_id: str, head_sha: str) -> bool:
        return gitops.resolve(self.workrepo, f"refs/quarantine/{job_id}") == head_sha

    def _compose_ahead(self, job_id: str, stage: str, issue_number: int, branch: str,
                       settled: _Settled) -> Mapping[str, str] | None:
        """The pull request's text for a done run, and a trial run comment, so compose cannot refuse between writes.

        The trial leaves out only the pull request's link, which exists after the pull request step and is checked
        against compose's own form there.
        """
        self._run_comment(job_id, stage, branch, settled, url="")
        if settled.outcome != "done":
            return None
        return {
            "title": compose.pull_request_title(settled.pull_request["title"]),
            "body": compose.pull_request_body(settled.pull_request["body"], issue_number, settled.follow_ups),
        }

    # Showing it on GitHub ------------------------------------------------------------------------------------------

    def _show(self, job_id: str, stage: str, issue: Issue, branch: str, settled: _Settled,
              pull_request_text: Mapping[str, str] | None) -> None:
        """The writes, each safe to repeat; the comment comes after the pull request, since it links it."""
        if settled.head_sha is not None:
            gitops.push(self.workrepo, self.push_url, self.token(), settled.head_sha, branch)
        url = self._pull_request(branch, pull_request_text) if pull_request_text is not None else ""
        self._post_run_comment(issue, job_id, self._run_comment(job_id, stage, branch, settled, url), settled.outcome)
        wanted = STATUS_AFTER.get(settled.outcome, NEEDS_HUMAN)
        others = [label for label in issue.labels if label.startswith(STATUS_PREFIX) and label != wanted]
        self.set_status(issue.number, wanted, others)

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
        if isinstance(url, str) and PULL_REQUEST_URL.fullmatch(url):
            return url
        built = f"https://github.com/{self._repository}/pull/{pull['number']}"
        return built if PULL_REQUEST_URL.fullmatch(built) else ""

    def _run_comment(self, job_id: str, stage: str, branch: str, settled: _Settled, url: str) -> str:
        """The run's comment. The texts go to compose raw: compose neutralises them, exactly once."""
        return compose.run_comment(
            job_id=job_id, stage=stage, outcome=settled.outcome, duration_seconds=settled.duration_seconds,
            model=settled.model, summary=settled.summary, questions=settled.questions,
            failure_reason=settled.failure_reason, problems=settled.problems, follow_ups=settled.follow_ups,
            pull_request_url=url, branch=branch, kept_commits=settled.commits, retry_at=settled.retry_at,
            reason=settled.reason,
        )

    def _post_run_comment(self, issue: Issue, job_id: str, body: str, outcome: str) -> None:
        """Post the comment unless one of the bot's own comments already reports this job.

        A usage limit right after a usage limit edits that comment instead, so a long wait leaves one comment.
        """
        found = self._fresh_markers(issue)
        if any(marker.data.get("job") == job_id for marker in found):
            return
        if outcome == "usage_limit" and found and found[-1].outcome == "usage_limit":
            self.github.patch(f"{self.github.repo}/issues/comments/{found[-1].comment_id}", {"body": body})
        else:
            self.github.post(f"{self.github.repo}/issues/{issue.number}/comments", {"body": body})

    def _fresh_markers(self, issue: Issue) -> tuple[Marker, ...]:
        """The markers in the bot's own comments as GitHub lists them now; the issue passed in may be a poll old."""
        listed = self.github.get_all(f"{self.github.repo}/issues/{issue.number}/comments", {"per_page": "100"})
        comments = (snapshot.comment_from(entry) for entry in listed)
        ordered = sorted((comment for comment in comments if comment is not None), key=lambda comment: comment.id)
        return dataclasses.replace(issue, comments=tuple(ordered)).markers(self.bot)

    def _clean_up(self, job_id: str) -> None:
        """Drop the quarantine ref once the run is shown; a failure is ignored, since it must not undo that.

        After a failed write the ref stays, so the repeat pushes the same checked head.
        """
        with contextlib.suppress(gitops.GitError):
            gitops.run_git(self.workrepo, "update-ref", "-d", f"refs/quarantine/{job_id}")
