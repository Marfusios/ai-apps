"""The dispatcher's decision function: what GitHub shows and what jobs exist, in; the actions to take, out."""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timezone

from factory.config import Config, is_trusted
from factory.jobs import choose_app, is_retry
from factory.snapshot import Bot, Comment, Issue, Marker, Snapshot

STATUS_PREFIX = "status:"
BUILDING = "status:building"
QUEUED = "status:queued"
NEEDS_HUMAN = "status:needs-human"
DONE = "status:done"
PAUSE_LABEL = "factory:pause"
CLOSE_REASON = "the issue is closed or no longer labelled"
RETRYABLE = ("failed", "timeout", "crashed", "refused", "rejected")
RETRY_AT = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")


@dataclass(frozen=True)
class JobView:
    job_id: str
    issue: int
    # "queued", "running" or "finished" are live; "closed" is a job the dispatcher closed a few minutes ago after
    # publishing it, passed in for a settle window while GitHub's comment list may still lag behind the write.
    state: str


@dataclass(frozen=True)
class SetStatus:
    issue: int
    add: str | None
    remove: tuple[str, ...]

    def describe(self) -> str:
        parts = ([f"add {self.add}"] if self.add else []) + ([f"remove {', '.join(self.remove)}"] if self.remove else [])
        return f"issue #{self.issue}: set the status ({'; '.join(parts)})"


@dataclass(frozen=True)
class StartJob:
    issue: int
    app: str

    def describe(self) -> str:
        return f"issue #{self.issue}: start a fix_issue run for app {self.app}"


@dataclass(frozen=True)
class PublishRun:
    job_id: str
    issue: int

    def describe(self) -> str:
        return f"issue #{self.issue}: publish the finished run {self.job_id}"


@dataclass(frozen=True)
class PostNotice:
    issue: int
    key: str  # "untrusted-author", "needs-app" or "pr-closed"

    def describe(self) -> str:
        return f"issue #{self.issue}: post the {self.key} notice"


@dataclass(frozen=True)
class CloseJob:
    job_id: str
    reason: str

    def describe(self) -> str:
        return f"job {self.job_id}: close it ({self.reason})"


Action = SetStatus | StartJob | PublishRun | PostNotice | CloseJob


def _trusted(login: str | None, config: Config) -> bool:
    return is_trusted(login or "", config)


def _status(issue: Issue, wanted: str | None) -> list[Action]:
    """A SetStatus giving the issue exactly the `wanted` status label (none for None), or nothing when it has it."""
    current = [label for label in issue.labels if label.startswith(STATUS_PREFIX)]
    if current == ([wanted] if wanted else []):
        return []
    remove = tuple(label for label in current if label != wanted)
    return [SetStatus(issue.number, None if wanted in current else wanted, remove)]


def _trusted_comments_after(issue: Issue, marker: Marker | None, config: Config, bot: Bot) -> list[Comment]:
    """Comments by trusted people (never the bot) later than the marker's comment; all of them without a marker."""
    after = marker.comment_id if marker else 0
    return [c for c in issue.comments if c.id > after and c.author != bot.login and is_trusted(c.author, config)]


def _retry_time(marker: Marker) -> datetime | None:
    """The marker's `retry_at`, or None when it is missing or not exactly `YYYY-MM-DDTHH:MM:SSZ`."""
    text = marker.data.get("retry_at")
    if not isinstance(text, str) or not RETRY_AT.fullmatch(text):
        return None
    try:
        return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _retry_is_ahead(marker: Marker, now: datetime) -> bool:
    retry_at = _retry_time(marker)
    return retry_at is not None and now < retry_at


def _last_marker(issue: Issue, bot: Bot) -> Marker | None:
    found = issue.markers(bot)
    return found[-1] if found else None


# Rule 1 -----------------------------------------------------------------------------------------------------------
# An open issue that could not be read this poll counts as live: a read that failed must not close its jobs.


def _live_issue_numbers(snapshot: Snapshot, config: Config) -> set[int]:
    return {i.number for i in snapshot.issues if i.open and (i.unreadable or _trusted(i.trigger_actor, config))}


def _close_dead_jobs(jobs: Sequence[JobView], live: set[int]) -> list[Action]:
    """Every job that is not live and is `queued` or `finished` is closed; a `running` or `closed` one is left alone."""
    return [
        CloseJob(job.job_id, CLOSE_REASON)
        for job in jobs
        if job.issue not in live and job.state in ("queued", "finished")
    ]


# Rule 2 -----------------------------------------------------------------------------------------------------------


def _closed_issue(issue: Issue) -> list[Action]:
    """A closed issue shows `status:done` when its pull request is merged, else no status."""
    merged = issue.pull_request is not None and issue.pull_request.merged
    return _status(issue, DONE if merged else None)


# Rule 3 -----------------------------------------------------------------------------------------------------------
# An open issue whose label no trusted person applied gets nothing. Neither does an open issue that could not be read
# this poll: it gets no actions, does not want to start and blocks nothing; rule 1 keeps its jobs.


def _is_handled(issue: Issue, config: Config) -> bool:
    return issue.open and not issue.unreadable and _trusted(issue.trigger_actor, config)


# Rule 4: the situation table. A row that lets the issue start returns None ----------------------------------------


def _job_rows(issue: Issue, jobs: Sequence[JobView]) -> list[Action] | None:
    """Rows 1 and 2: a finished job is published; a queued or running one means building."""
    own = [job for job in jobs if job.issue == issue.number and job.state != "closed"]
    finished = [job for job in own if job.state == "finished"]
    if finished:
        return [PublishRun(finished[0].job_id, issue.number)]
    if own:
        return _status(issue, BUILDING)
    return None


def _is_settling(issue: Issue, jobs: Sequence[JobView], bot: Bot) -> bool:
    """True while a job the dispatcher closed has no marker of its own on the issue yet: the poll may lag."""
    jobs_seen = (marker.data.get("job") for marker in issue.markers(bot))
    seen = {job for job in jobs_seen if isinstance(job, str)}  # any other value is unhashable or no job id
    return any(job.issue == issue.number and job.state == "closed" and job.job_id not in seen for job in jobs)


def _without_marker_rows(issue: Issue, trusted_comments: list[Comment], config: Config) -> list[Action] | None:
    """Rows 4 to 6: an issue the factory has not written to yet, or whose comments from the factory are gone.

    Only an open pull request holds the issue back: after one was closed without merging, an issue without a marker
    is like any other.
    """
    if issue.pull_request is not None and issue.pull_request.open:  # no marker, an open pull request exists
        return []
    if not is_trusted(issue.author, config) and not trusted_comments:  # no marker, author not trusted
        return [PostNotice(issue.number, "untrusted-author"), *_status(issue, NEEDS_HUMAN)]
    return None  # no marker otherwise


def _needs_input_rows(issue: Issue, trusted_after: list[Comment]) -> list[Action] | None:
    """Rows 7 and 8: wait for a trusted reply after the marker."""
    return None if trusted_after else _status(issue, NEEDS_HUMAN)


def _failure_rows(issue: Issue, trusted_after: list[Comment]) -> list[Action] | None:
    """Rows 9 and 10: failed, timeout, crashed, refused or rejected wait for a trusted `/factory retry`."""
    return None if any(is_retry(c) for c in trusted_after) else _status(issue, NEEDS_HUMAN)


def _usage_limit_rows(issue: Issue, marker: Marker, now: datetime) -> list[Action] | None:
    """Rows 11 and 12: wait until `retry_at`, which counts as past when unreadable."""
    return _status(issue, QUEUED) if _retry_is_ahead(marker, now) else None


def _done_rows(issue: Issue) -> list[Action]:
    """Rows 13 to 15: a finished run follows its pull request; none, or one this table does not know, does nothing."""
    pull = issue.pull_request
    if pull is None:
        return []
    if pull.open:
        return _status(issue, BUILDING)
    return [PostNotice(issue.number, "pr-closed"), *_status(issue, NEEDS_HUMAN)]


def _after_marker_rows(issue: Issue, marker: Marker, now: datetime, config: Config, bot: Bot) -> list[Action] | None:
    trusted_after = _trusted_comments_after(issue, marker, config, bot)
    outcome = marker.outcome
    if outcome == "needs_input":
        return _needs_input_rows(issue, trusted_after)
    if outcome in RETRYABLE:
        return _failure_rows(issue, trusted_after)
    if outcome == "usage_limit":
        return _usage_limit_rows(issue, marker, now)
    if outcome == "done":
        return _done_rows(issue)
    return []  # anything else: an unknown outcome


def _open_issue_rows(
    issue: Issue, jobs: Sequence[JobView], now: datetime, config: Config, bot: Bot
) -> list[Action] | None:
    """What a trusted open issue needs, or None when it wants to start."""
    from_jobs = _job_rows(issue, jobs)
    if from_jobs is not None:
        return from_jobs
    if _is_settling(issue, jobs, bot):  # a closed job whose marker is not visible yet: do nothing this poll
        return []
    if issue.pull_request is not None and issue.pull_request.merged:  # its pull request is merged
        return _status(issue, DONE)
    marker = _last_marker(issue, bot)
    if marker is None:
        return _without_marker_rows(issue, _trusted_comments_after(issue, None, config, bot), config)
    return _after_marker_rows(issue, marker, now, config, bot)


# Rules 5 to 7 -----------------------------------------------------------------------------------------------------


def _usage_limit_ahead(snapshot: Snapshot, now: datetime, config: Config, bot: Bot) -> bool:
    """True when an open trusted issue's last marker is a usage limit whose `retry_at` is still ahead."""
    for issue in snapshot.issues:
        marker = _last_marker(issue, bot)
        if (
            issue.open and _trusted(issue.trigger_actor, config) and marker is not None
            and marker.outcome == "usage_limit" and _retry_is_ahead(marker, now)
        ):
            return True
    return False


def _starts_blocked(
    snapshot: Snapshot, jobs: Sequence[JobView], now: datetime, config: Config, bot: Bot
) -> bool:
    """One job at a time, and none while halted, while a usage limit still holds or while an issue settles.

    A closed job counts only while its issue settles: until its marker is listed, the outcome it published, a usage
    limit for one, is not known yet.
    """
    settling = any(_is_handled(issue, config) and _is_settling(issue, jobs, bot) for issue in snapshot.issues)
    return (snapshot.halted or any(job.state != "closed" for job in jobs) or settling
            or _usage_limit_ahead(snapshot, now, config, bot))


def _wants_to_start(issue: Issue, snapshot: Snapshot, config: Config) -> tuple[list[Action], str | None]:
    """The actions of an issue that wants to start, and its app when it still does after rules 5 and 6."""
    app = choose_app(issue, snapshot.apps, config)
    if app is None:  # rule 5
        return [PostNotice(issue.number, "needs-app"), *_status(issue, NEEDS_HUMAN)], None
    if PAUSE_LABEL in issue.labels:  # rule 6
        return _status(issue, QUEUED), None
    return [], app


def decide(snapshot: Snapshot, jobs: Sequence[JobView], now: datetime, config: Config, bot: Bot) -> list[Action]:
    """The actions this poll calls for. Pure: same input, same list, no clock and no I/O. `now` must be aware."""
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be a timezone-aware datetime")
    actions = _close_dead_jobs(jobs, _live_issue_numbers(snapshot, config))
    ordered = sorted(snapshot.issues, key=lambda issue: issue.number)
    for issue in ordered:
        if not issue.open:
            actions += _closed_issue(issue)

    pending: list[tuple[Issue, list[Action]]] = []  # trusted open issues, with their actions so far
    app_of: dict[int, str] = {}  # issues that want to start, in ascending number
    for issue in ordered:
        if not _is_handled(issue, config):  # rule 3
            continue
        rows = _open_issue_rows(issue, jobs, now, config, bot)
        if rows is None:
            rows, app = _wants_to_start(issue, snapshot, config)
            if app is not None:
                app_of[issue.number] = app
        pending.append((issue, rows))

    blocked = _starts_blocked(snapshot, jobs, now, config, bot)
    first = next(iter(app_of)) if app_of and not blocked else None
    for issue, rows in pending:
        actions += rows
        if issue.number == first:
            actions += [*_status(issue, BUILDING), StartJob(issue.number, app_of[issue.number])]
        elif issue.number in app_of:
            actions += _status(issue, QUEUED)
    return actions
