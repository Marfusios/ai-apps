"""The dispatcher program: poll GitHub, decide, apply, and publish finished runs; `python -m factory.dispatcher`."""

import argparse
import json
import logging
import os
import re
import signal
import sys
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Protocol

from factory import compose, gitops, jobs, snapshot
from factory.config import Config
from factory.config import load as load_config
from factory.decide import Action, CloseJob, JobView, PostNotice, PublishRun, SetStatus, StartJob, decide
from factory.github_api import GitHub, GitHubError, RateLimited, post_as_app
from factory.github_auth import AuthError, InstallationToken
from factory.gitops import GitError
from factory.publish import Publisher
from factory.snapshot import Bot, Issue, branch_for
from factory.spool import JOB_ID, TIME_FORMAT, Spool, SpoolError, new_job_id

log = logging.getLogger("factory.dispatcher")

REPOSITORY = re.compile(r"(?!\.+/)[A-Za-z0-9._-]+/(?!\.+$)[A-Za-z0-9._-]+")
LOGIN = re.compile(r"[A-Za-z0-9-]+(?:\[bot\])?")
DIGITS = re.compile(r"[0-9]+")  # explicit [0-9]: \d would accept other scripts' digits
STAGE = "fix_issue"
SETTLE_WINDOW = timedelta(minutes=10)  # how long a published job still holds its issue while GitHub's listing lags
UNREADABLE_REQUEST = "unreadable request"
FIRST_RETRY_SECONDS = 60
LONGEST_RETRY_SECONDS = 30 * 60
SHORTEST_RATE_LIMIT_SLEEP_SECONDS = 60  # a reset time that is not ahead must not make the loop spin
LONGEST_SLEEP_SECONDS = 3600
SLEEP_SLICE_SECONDS = 1.0
PRUNE_EVERY = timedelta(hours=1)
GC_EVERY = timedelta(days=1)
STATE_DIRECTORY_MODE = 0o700
# What can go wrong in one poll that the next poll may not meet again.
RECOVERABLE = (GitHubError, GitError, SpoolError, AuthError, OSError)


class SettingsError(ValueError):
    """The environment lacks a setting or holds a malformed one; the message names variables, never their values."""


@dataclass(frozen=True)
class Settings:
    repository: str
    app_id: str
    installation_id: str
    key_file: Path
    bot: Bot
    spool_dir: Path
    mirror_dir: Path
    state_dir: Path

    @property
    def mirror(self) -> Path:
        return self.mirror_dir / "repo.git"

    @property
    def workrepo(self) -> Path:
        return self.state_dir / "work.git"

    @property
    def scratch(self) -> Path:
        return self.state_dir / "scratch"


def settings_from_env(env: Mapping[str, str]) -> Settings:
    """Read every setting, or raise a SettingsError naming each variable that is missing or malformed."""
    problems: list[str] = []

    def text(name: str, pattern: re.Pattern[str] | None = None, *, absolute: bool = False) -> str:
        value = env.get(name, "")
        if not value:
            problems.append(f"{name} is missing")
        elif pattern is not None and pattern.fullmatch(value) is None:
            problems.append(f"{name} is malformed")
        elif absolute and not Path(value).is_absolute():
            problems.append(f"{name} must be an absolute path")
        else:
            return value
        return ""

    repository = text("FACTORY_REPOSITORY", REPOSITORY)
    app_id = text("FACTORY_APP_ID", re.compile(r"\S+"))
    installation_id = text("FACTORY_INSTALLATION_ID", DIGITS)
    key_file = text("FACTORY_APP_KEY_FILE")
    login = text("FACTORY_BOT_LOGIN", LOGIN)
    user_id = text("FACTORY_BOT_USER_ID", DIGITS)
    if user_id and int(user_id) <= 0:
        problems.append("FACTORY_BOT_USER_ID must be positive")
    spool_dir = text("FACTORY_SPOOL_DIR", absolute=True)
    mirror_dir = text("FACTORY_MIRROR_DIR", absolute=True)
    state_dir = text("FACTORY_STATE_DIR", absolute=True)
    if problems:
        raise SettingsError("; ".join(problems))
    return Settings(repository, app_id, installation_id, Path(key_file), Bot(login, int(user_id)), Path(spool_dir),
                    Path(mirror_dir), Path(state_dir))


def _issue_of(job_id: str, request: object) -> int | None:
    """The issue a job is for, named by its id; None unless the request's branch is that issue's work branch."""
    if JOB_ID.fullmatch(job_id) is None:
        return None
    number = int(job_id.split("-")[2])
    branch = request.get("branch") if isinstance(request, dict) else None
    return number if branch == branch_for(number) else None


def _closed_recently(spool: Spool, job_id: str, now: datetime) -> bool:
    """True when the dispatcher closed the job within the settle window after publishing it."""
    try:
        record = spool.read_job_json(job_id, "closed.json")
    except SpoolError:
        return False
    reason = record.get("reason") if record else None
    stamp = record.get("closed_at") if record else None
    if not (isinstance(reason, str) and reason in compose.OUTCOME_WORDS and isinstance(stamp, str)):
        return False
    try:
        closed_at = datetime.strptime(stamp, TIME_FORMAT).replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    return now - closed_at < SETTLE_WINDOW


def job_views(spool: Spool, now: datetime, *, close_unreadable: bool = True) -> list[JobView]:
    """A view of every job that is not closed, and of each job published within the last ten minutes.

    A job whose request cannot be read is closed with the reason `unreadable request` (not when
    `close_unreadable` is false) and has no view. A job closed for another reason, such as a discard, has none.
    """
    views = []
    for job_id in spool.job_ids():
        state = spool.state(job_id)
        try:
            issue = _issue_of(job_id, spool.request(job_id))
        except SpoolError:
            issue = None
        if state == "closed":
            if issue is not None and _closed_recently(spool, job_id, now):
                views.append(JobView(job_id, issue, state))
        elif issue is None:
            if close_unreadable:
                spool.close(job_id, UNREADABLE_REQUEST, now)
        else:
            views.append(JobView(job_id, issue, state))
    return views


def _retry_delay(failures: int) -> timedelta:
    return timedelta(seconds=min(FIRST_RETRY_SECONDS * 2 ** (failures - 1), LONGEST_RETRY_SECONDS))


class Git(Protocol):
    """The part of `factory.gitops` the dispatcher uses, so that a test can stand in for the network."""

    def ensure_mirror(self, mirror: Path, url: str, token: str) -> None: ...

    def ensure_workrepo(self, workrepo: Path, mirror: Path) -> None: ...

    def resolve(self, repo: Path, ref: str) -> str | None: ...

    def run_git(self, repo: Path | None, *args: str) -> bytes: ...


class Dispatcher:
    """One tick: read GitHub, decide, apply; and the loop and upkeep around it."""

    def __init__(
        self,
        settings: Settings,
        config: Config,
        github: GitHub,
        spool: Spool,
        publisher: Publisher,
        *,
        token: Callable[[], str],
        git: Git = gitops,
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self._settings = settings
        self._config = config
        self._github = github
        self._spool = spool
        self._publisher = publisher
        self._token = token
        self._git = git
        self._clock = clock
        self._publish_failures: dict[str, tuple[int, datetime]] = {}  # job id -> failed attempts, next attempt
        self._last_prune = clock()
        self._last_gc: datetime | None = None  # none yet: the first idle housekeeping collects

    def prepare(self) -> None:
        self._spool.prepare("dispatcher")

    def tick(self, dry_run: bool = False) -> list[Action]:
        """Fetch, decide and apply; return the actions decided. With `dry_run` nothing is written anywhere."""
        now = self._clock()
        current = snapshot.fetch(self._github)
        views = job_views(self._spool, now, close_unreadable=not dry_run)
        actions = decide(current, views, now, self._config, self._settings.bot)
        if dry_run:
            return actions
        issues = {issue.number: issue for issue in current.issues}
        waiting = {view.job_id for view in views if view.state != "closed"}
        self._publish_failures = {job: failure for job, failure in self._publish_failures.items() if job in waiting}
        failed_issues: set[int] = set()  # what follows a failed action for an issue may depend on it
        for action in actions:
            if isinstance(action, PublishRun):
                self._publish(action, issues[action.issue], now)  # a failure delays this job only
                continue
            if getattr(action, "issue", None) in failed_issues:
                continue
            try:
                self._apply(action, issues, now)
            except RateLimited:
                raise
            except RECOVERABLE as error:
                log.error("%s failed: %s", action.describe(), type(error).__name__)
                if hasattr(action, "issue"):
                    failed_issues.add(action.issue)
        return actions

    def run(self, stop: threading.Event) -> None:
        """Tick until `stop` is set; the current tick always finishes."""
        poll = float(self._config.dispatcher.poll_seconds)
        while not stop.is_set():
            delay = poll
            try:
                self.tick()
            except RateLimited as error:
                wait = error.retry_at - self._clock().timestamp()
                delay = float(min(max(wait, SHORTEST_RATE_LIMIT_SLEEP_SECONDS), LONGEST_SLEEP_SECONDS))
                log.error("GitHub's rate limit is reached; waiting %d seconds", delay)
            except RECOVERABLE as error:
                log.error("the poll failed: %s", type(error).__name__)
            self.housekeeping()
            _sleep(stop, delay)

    def housekeeping(self) -> None:
        """Prune the spool about hourly and collect garbage in the git repositories about daily; never raises."""
        now = self._clock()
        if now - self._last_prune >= PRUNE_EVERY:
            self._last_prune = now
            try:
                self._spool.prune("dispatcher", now)
            except RECOVERABLE as error:
                log.error("pruning the spool failed: %s", type(error).__name__)
        if self._last_gc is None or now - self._last_gc >= GC_EVERY:
            try:
                idle = self._is_idle()
            except RECOVERABLE as error:
                log.error("the idle check failed: %s", type(error).__name__)
            else:
                if idle:
                    self._last_gc = now
                    self._collect_garbage()  # logs its own failures

    def _collect_garbage(self) -> None:
        for repository in (self._settings.mirror, self._settings.workrepo):
            try:
                self._git.run_git(repository, "gc", "--quiet")
            except (GitError, OSError) as error:
                log.error("git maintenance failed: %s", type(error).__name__)

    def _is_idle(self) -> bool:
        """True when no job is waiting, running or waiting to be published."""
        return all(self._spool.state(job_id) == "closed" for job_id in self._spool.job_ids())

    def _publish(self, action: PublishRun, issue: Issue, now: datetime) -> None:
        """Publish a finished run unless its retry time has not come. A failure delays the next attempt, nothing more."""
        failures, next_attempt = self._publish_failures.get(action.job_id, (0, now))
        if now < next_attempt:
            return
        try:
            self._publisher.publish(action.job_id, issue, now)
        except RateLimited:
            raise
        except RECOVERABLE as error:
            log.error("%s failed: %s", action.describe(), type(error).__name__)
            self._publish_failures[action.job_id] = (failures + 1, now + _retry_delay(failures + 1))
            return
        self._publish_failures.pop(action.job_id, None)

    def _apply(self, action: Action, issues: Mapping[int, Issue], now: datetime) -> None:
        if isinstance(action, SetStatus):
            self._publisher.set_status(action.issue, action.add, action.remove)
        elif isinstance(action, StartJob):
            self._start_job(issues[action.issue], action.app, now)
        elif isinstance(action, PostNotice):
            self._publisher.post_notice(issues[action.issue], action.key)
        elif isinstance(action, CloseJob):
            self._spool.close(action.job_id, action.reason, now)
        else:
            raise TypeError(f"unknown action {type(action).__name__}")

    def _start_job(self, issue: Issue, app: str, now: datetime) -> None:
        settings = self._settings
        self._git.ensure_mirror(settings.mirror, f"https://github.com/{settings.repository}.git", self._token())
        self._git.ensure_workrepo(settings.workrepo, settings.mirror)
        branch = branch_for(issue.number)
        # A run that asked a question left checked commits on its branch; the next run goes on from them.
        base_sha = self._git.resolve(settings.mirror, f"refs/heads/{branch}") or self._git.resolve(
            settings.mirror, "refs/heads/main")
        if base_sha is None:
            raise GitError("resolve", "no commit to start from")
        job_id = new_job_id(STAGE, issue.number, now)
        bot = settings.bot
        request = jobs.request_file(job_id=job_id, stage=STAGE, app=app, branch=branch, base_sha=base_sha,
                                    repository=settings.repository, config=self._config, bot=bot)
        job = jobs.job_file(stage=STAGE, app=app, issue=issue, branch=branch, base_sha=base_sha, config=self._config)
        self._spool.submit(job_id, {
            "request.json": _json(request),
            "job.json": _json(job),
            "context.md": jobs.context(issue, self._config, bot).encode("utf-8"),
        })


def _json(record: Mapping) -> bytes:
    return (json.dumps(record, indent=2) + "\n").encode("utf-8")


def _sleep(stop: threading.Event, seconds: float) -> None:
    """Wait in short slices so that a stop signal ends the wait within a second or two, whatever the platform."""
    deadline = time.monotonic() + seconds
    while not stop.is_set():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        stop.wait(min(SLEEP_SLICE_SECONDS, remaining))


def build_dispatcher(settings: Settings, config: Config) -> Dispatcher:
    tokens = InstallationToken(settings.app_id, settings.installation_id, settings.key_file, post=post_as_app)
    github = GitHub(settings.repository, tokens.get, refresh=tokens.refresh)
    spool = Spool(settings.spool_dir)
    publisher = Publisher(
        spool=spool, github=github, config=config, bot=settings.bot, workrepo=settings.workrepo,
        scratch=settings.scratch, push_url=f"https://github.com/{settings.repository}.git", token=tokens.get,
    )
    return Dispatcher(settings, config, github, spool, publisher, token=tokens.get)


def _make_state_directories(settings: Settings) -> None:
    for directory in (settings.state_dir, settings.scratch, settings.mirror_dir):
        directory.mkdir(mode=STATE_DIRECTORY_MODE, parents=True, exist_ok=True)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="factory.dispatcher", description="Poll GitHub and run the factory's jobs.")
    parser.add_argument("--once", action="store_true", help="run one tick and exit")
    parser.add_argument("--dry-run", action="store_true", help="print what one tick would do; write nothing")
    args = parser.parse_args(argv)
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        settings = settings_from_env(os.environ)
    except SettingsError as error:
        log.error("settings: %s", error)
        return 2
    dispatcher = build_dispatcher(settings, load_config())
    if args.dry_run:
        return _one_tick(dispatcher, dry_run=True)
    _make_state_directories(settings)
    dispatcher.prepare()
    if args.once:
        return _one_tick(dispatcher, dry_run=False)
    stop = threading.Event()
    for name in ("SIGINT", "SIGTERM"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), lambda *_: stop.set())
    dispatcher.run(stop)
    return 0


def _one_tick(dispatcher: Dispatcher, *, dry_run: bool) -> int:
    try:
        actions = dispatcher.tick(dry_run=dry_run)
    except RECOVERABLE as error:
        log.error("the poll failed: %s", type(error).__name__)
        return 1
    if dry_run:
        for action in actions:
            print(action.describe())
    return 0


if __name__ == "__main__":
    sys.exit(main())
