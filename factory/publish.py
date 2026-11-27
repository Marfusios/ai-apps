"""Publish a finished run: read the runner's files as hostile data, settle one outcome, then show it on GitHub."""

import contextlib
import json
import re
import urllib.parse
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

from factory import bundle_check, compose, gitops, hygiene, jobs, result
from factory.bundle_check import Verdict
from factory.config import Config
from factory.decide import BUILDING, NEEDS_HUMAN, QUEUED, STATUS_PREFIX
from factory.github_api import GitHub, GitHubError
from factory.snapshot import Bot, Comment, Issue, Marker, branch_for
from factory.spool import Spool, SpoolError

RESULT_FILE = "result.json"
BUNDLE_FILE = "commits.bundle"
BYTES_PER_MEGABYTE = 1_000_000
BASE_BRANCH = "main"
STAGE_LABEL = "stage:fix"
NOT_FOUND = 404
# The longest usage window is a week: a reset time further ahead than that and a day is not believed.
LATEST_RESET = timedelta(days=8)
TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
PULL_REQUEST_URL = re.compile(r"https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/[0-9]+")
NOT_KEPT = "the work so far was not kept"
STATUS_AFTER = {"done": BUILDING, "usage_limit": QUEUED}  # every other outcome waits for a person


@dataclass(frozen=True)
class _Outcome:
    """What a run came to, with everything its writes need.

    `result` is set only for a valid result without a hygiene finding, the one case in which its text may be posted.
    `kept` is the good verdict whose head is pushed to the work branch.
    """

    outcome: str
    duration_seconds: int
    model: str
    reason: str | None = None
    result: Mapping | None = None
    kept: Verdict | None = None
    problems: tuple[str, ...] = ()
    retry_at: str = ""


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


def _is_number(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _listed_comment(raw: dict) -> Comment:
    """A comment as GitHub lists it; a missing or odd field reads as empty or 0, which matches no bot."""
    user = raw.get("user") if isinstance(raw.get("user"), dict) else {}
    comment_id, author_id = raw.get("id"), user.get("id")
    return Comment(comment_id if _is_number(comment_id) else 0, _text(user.get("login")),
                   author_id if _is_number(author_id) else 0, _text(raw.get("created_at")), _text(raw.get("body")))


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

        The writes go in this order: the push, the pull request, the run comment, the status label; the job is closed
        last. A GitHubError or GitError leaves the job finished, so the next poll repeats the whole call, and each
        write is skipped, or has the same effect again, when it was already made. A request that is no longer what
        the dispatcher wrote raises SpoolError before anything is written.
        """
        if now.tzinfo is None or now.utcoffset() is None:
            raise ValueError("now must be a timezone-aware datetime")
        request = self._request(job_id)
        branch = branch_for(issue.number)
        try:
            settled = self._settle(job_id, request, branch, now)
            self._show(job_id, request["stage"], issue, branch, settled)
        finally:
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

    def _settle(self, job_id: str, request: Mapping, branch: str, now: datetime) -> _Outcome:
        """The run's one outcome, from its run record and, for a completed run, its result and bundle."""
        try:
            run = self.spool.run_record(job_id)
        except SpoolError:
            return _Outcome("crashed", 0, request["model"], reason="internal")
        timing = {"duration_seconds": run["duration_seconds"], "model": run["model"] or request["model"]}
        if run["status"] == "usage_limit":
            return _Outcome("usage_limit", **timing, retry_at=self._retry_at(run["resets_at"], now))
        if run["status"] != "completed":
            return _Outcome(run["status"], **timing, reason=run["reason"])
        return self._settle_completed(job_id, request, branch, timing)

    def _settle_completed(self, job_id: str, request: Mapping, branch: str, timing: dict) -> _Outcome:
        """A completed run's outcome: its result decides first, and only a clean done or needs_input checks commits."""
        data = self._result(job_id, request["stage"])
        if data is None:
            return _Outcome("crashed", **timing, reason="agent_error")
        labels = _hygiene_labels(data)
        if labels:
            problems = tuple(f"the result's text contains {label}" for label in labels)
            return _Outcome("rejected", **timing, problems=problems)
        if data["outcome"] == "failed":
            return _Outcome("failed", **timing, result=data)
        verdict = self._check_bundle(job_id, request["base_sha"], branch)
        if data["outcome"] == "needs_input":
            if verdict is None or verdict.ok:
                return _Outcome("needs_input", **timing, result=data, kept=verdict)
            return _Outcome("needs_input", **timing, result=data, problems=(NOT_KEPT, *verdict.problems))
        if verdict is None:
            return _Outcome("rejected", **timing, result=data, problems=(bundle_check.NO_COMMITS,))
        if not verdict.ok:
            return _Outcome("rejected", **timing, result=data, problems=verdict.problems)
        return _Outcome("done", **timing, result=data, kept=verdict)

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

        The check reads the file several times; on the copy, the runner cannot swap it in between.
        """
        megabytes = self.config.dispatcher.max_bundle_megabytes
        try:
            data = self.spool.read_run_file(job_id, BUNDLE_FILE, megabytes * BYTES_PER_MEGABYTE)
        except SpoolError as error:
            if str(error) == f"{BUNDLE_FILE} is missing":  # the spool's words for a file that is not there
                return None
            return Verdict(False, None, 0, (f"the bundle is missing or larger than {megabytes} MB",))
        copy = self._copy_of(job_id)
        try:
            self.scratch.mkdir(parents=True, exist_ok=True)
            copy.write_bytes(data)
        except OSError as error:
            raise SpoolError(f"{BUNDLE_FILE} cannot be copied for checking: "
                             f"{error.strerror or type(error).__name__}") from None
        return bundle_check.check(copy, workrepo=self.workrepo, base_sha=base_sha, branch=branch, job_id=job_id,
                                  bot=self.bot, config=self.config)

    def _copy_of(self, job_id: str) -> Path:
        return self.scratch / f"{job_id}.bundle"

    # Showing it on GitHub ------------------------------------------------------------------------------------------

    def _show(self, job_id: str, stage: str, issue: Issue, branch: str, settled: _Outcome) -> None:
        """The writes, each safe to repeat; the comment comes after the pull request, since it links it."""
        if settled.kept is not None:
            gitops.push(self.workrepo, self.push_url, self.token(), settled.kept.head_sha, branch)
        url = self._open_pull_request(issue.number, branch, settled.result) if settled.outcome == "done" else ""
        self._post_run_comment(issue, job_id, self._run_comment(job_id, stage, branch, settled, url), settled.outcome)
        wanted = STATUS_AFTER.get(settled.outcome, NEEDS_HUMAN)
        others = [label for label in issue.labels if label.startswith(STATUS_PREFIX) and label != wanted]
        self.set_status(issue.number, wanted, others)

    def _open_pull_request(self, issue_number: int, branch: str, data: Mapping) -> str:
        """Open the branch's draft pull request, or bring the open one's text up to date; label it; return its link."""
        proposed = data["pull_request"]
        text = {
            "title": compose.pull_request_title(proposed["title"]),
            "body": compose.pull_request_body(proposed["body"], issue_number, data.get("follow_ups", [])),
        }
        owner = self._repository.split("/")[0]
        listed = self.github.get(f"{self.github.repo}/pulls",
                                 {"head": f"{owner}:{branch}", "state": "open", "per_page": "10"})
        if not isinstance(listed, list):
            raise GitHubError(0, "GET /pulls did not answer with a list")  # never open a second one on a guess
        open_pulls = [pull for pull in listed if isinstance(pull, dict) and _is_number(pull.get("number"))]
        if open_pulls:
            pull = max(open_pulls, key=lambda candidate: candidate["number"])
            self.github.patch(f"{self.github.repo}/pulls/{pull['number']}", text)
        else:
            pull = self.github.post(f"{self.github.repo}/pulls",
                                    {**text, "head": branch, "base": BASE_BRANCH, "draft": True})
            if not (isinstance(pull, dict) and _is_number(pull.get("number"))):
                raise GitHubError(0, "POST /pulls did not answer with a pull request number")
        self.github.post(f"{self.github.repo}/issues/{pull['number']}/labels", {"labels": [STAGE_LABEL]})
        return self._pull_request_url(pull)

    def _pull_request_url(self, pull: Mapping) -> str:
        """GitHub's own link when it has the expected shape, else one built from the repository and the number."""
        url = pull.get("html_url")
        if isinstance(url, str) and PULL_REQUEST_URL.fullmatch(url):
            return url
        return f"https://github.com/{self._repository}/pull/{pull['number']}"

    def _run_comment(self, job_id: str, stage: str, branch: str, settled: _Outcome, url: str) -> str:
        """The run's comment. The result's text goes to compose raw: compose neutralises it, exactly once."""
        data = settled.result or {}
        return compose.run_comment(
            job_id=job_id, stage=stage, outcome=settled.outcome, duration_seconds=settled.duration_seconds,
            model=settled.model, summary=data.get("summary", ""), questions=data.get("questions") or (),
            failure_reason=data.get("failure_reason") or "", problems=settled.problems,
            follow_ups=data.get("follow_ups", ()), pull_request_url=url, branch=branch,
            kept_commits=settled.kept.commits if settled.kept else 0, retry_at=settled.retry_at,
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
        comments = sorted((_listed_comment(raw) for raw in listed if isinstance(raw, dict)), key=lambda c: c.id)
        return replace(issue, comments=tuple(comments)).markers(self.bot)

    def _clean_up(self, job_id: str) -> None:
        """Drop the quarantine ref and the private copy; a failure is ignored, since it must not undo a publication."""
        with contextlib.suppress(gitops.GitError):
            gitops.run_git(self.workrepo, "update-ref", "-d", f"refs/quarantine/{job_id}")
        with contextlib.suppress(OSError):
            self._copy_of(job_id).unlink(missing_ok=True)
