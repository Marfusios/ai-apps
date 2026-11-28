"""Tests for the dispatcher program: a real spool and git repositories, an in-memory GitHub and a fixed clock."""

import contextlib
import io
import json
import logging
import os
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from factory import dispatcher as dispatcher_module
from factory import gitops, jobs
from factory import config as factory_config
from factory.decide import CloseJob, HandOff, PostNotice, PublishRun, SetStatus, StartJob
from factory.dispatcher import Dispatcher, Settings, SettingsError, job_views, settings_from_env
from factory.github_api import GitHubError, RateLimited
from factory.publish import Publisher
from factory.snapshot import Bot, Check, Comment, Issue, PullRequest, Review, Snapshot
from factory.spool import Spool, SpoolError, new_job_id
from factory.tests.fakes import FakeGitHub
from factory.tests.gitrepo import Repo

CONFIG = factory_config.load()
BOT = Bot("factory-test[bot]", 4242)
NOW = datetime(2026, 11, 27, 10, 15, 0, tzinfo=timezone.utc)
TOKEN = "token-" + "x" * 20
BASE_FILES = {"README.md": "# Demo\n", "apps/demo/a.txt": "old\n"}
REPOSITORY = "owner/name"


def key(path: str, params: dict) -> tuple:
    return (path, tuple(sorted(params.items())))


def valid_env(root: Path) -> dict[str, str]:
    return {
        "FACTORY_REPOSITORY": REPOSITORY, "FACTORY_APP_ID": "12345", "FACTORY_INSTALLATION_ID": "678",
        "FACTORY_APP_KEY_FILE": str(root / "app.key"), "FACTORY_BOT_LOGIN": BOT.login,
        "FACTORY_BOT_USER_ID": str(BOT.user_id), "FACTORY_SPOOL_DIR": str(root / "spool"),
        "FACTORY_MIRROR_DIR": str(root / "mirror"), "FACTORY_STATE_DIR": str(root / "state"),
    }


class GitStandIn:
    """`gitops` with the mirror fetched from a local repository, and maintenance recorded instead of run."""

    resolve = staticmethod(gitops.resolve)
    ensure_workrepo = staticmethod(gitops.ensure_workrepo)

    def __init__(self, upstream: Repo) -> None:
        self._upstream = upstream
        self.mirror_requests: list[tuple[str, str]] = []
        self.maintenance: list[tuple[Path | None, tuple[str, ...]]] = []

    def ensure_mirror(self, mirror: Path, url: str, token: str) -> None:
        self.mirror_requests.append((url, token))
        gitops.ensure_mirror(mirror, str(self._upstream.path), token)

    def run_git(self, repo: Path | None, *args: str) -> bytes:
        self.maintenance.append((repo, args))
        return b""


class SettingsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()

    def test_settings_from_env_reads_every_variable(self):
        settings = settings_from_env(valid_env(self.root))
        self.assertEqual(settings.repository, REPOSITORY)
        self.assertEqual(settings.bot, BOT)
        self.assertEqual(settings.mirror, self.root / "mirror" / "repo.git")
        self.assertEqual(settings.workrepo, self.root / "state" / "work.git")
        self.assertEqual(settings.scratch, self.root / "state" / "scratch")

    def test_settings_from_env_reports_every_problem_at_once(self):
        env = valid_env(self.root)
        del env["FACTORY_APP_ID"], env["FACTORY_BOT_LOGIN"]
        env["FACTORY_INSTALLATION_ID"] = "not-digits-secret"
        with self.assertRaises(SettingsError) as raised:
            settings_from_env(env)
        message = str(raised.exception)
        for name in ("FACTORY_APP_ID", "FACTORY_BOT_LOGIN", "FACTORY_INSTALLATION_ID"):
            self.assertIn(name, message)
        self.assertNotIn("not-digits-secret", message)

    def test_a_malformed_value_is_named_and_never_echoed(self):
        cases = {
            "FACTORY_BOT_USER_ID": ["0", "-3", "12x", ""],
            "FACTORY_BOT_LOGIN": ["-factory[bot]", "-x"],
            "FACTORY_REPOSITORY": ["name", "a/b/c", "../x", "owner/..", "ow ner/name"],
            "FACTORY_SPOOL_DIR": ["relative/spool"],
            "FACTORY_MIRROR_DIR": ["mirror"],
            "FACTORY_STATE_DIR": ["state"],
        }
        for name, values in cases.items():
            for value in values:
                with self.subTest(name=name, value=value):
                    env = {**valid_env(self.root), name: value}
                    with self.assertRaises(SettingsError) as raised:
                        settings_from_env(env)
                    self.assertIn(name, str(raised.exception))
                    if value:
                        self.assertNotIn(value, str(raised.exception))


class JobViewsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.spool = Spool(self.root / "spool")
        self.spool.prepare("dispatcher")

    def submit(self, issue: int = 12, *, request: bytes | None = None) -> str:
        job = new_job_id("fix_issue", issue, NOW)
        record = jobs.request_file(job_id=job, stage="fix_issue", app="demo", branch=f"factory/fix-{issue}",
                                   base_sha="a" * 40, repository=REPOSITORY, config=CONFIG, bot=BOT)
        self.spool.submit(job, {"request.json": request if request is not None else json.dumps(record).encode()})
        return job

    def test_a_live_job_has_a_view_with_its_issue_and_state(self):
        job = self.submit(12)
        self.assertEqual([(v.job_id, v.issue, v.state) for v in job_views(self.spool, NOW)], [(job, 12, "queued")])

    def test_a_job_with_an_unreadable_request_is_closed_and_has_no_view(self):
        for request in (b"not json", b"[]", b'{"branch": "main"}'):
            with self.subTest(request=request):
                job = self.submit(request=request)
                self.assertEqual(job_views(self.spool, NOW), [])
                self.assertEqual(self.spool.state(job), "closed")
                self.assertEqual(self.spool.read_job_json(job, "closed.json")["reason"], "unreadable request")

    def test_a_request_for_another_issue_than_its_job_is_unreadable(self):
        job = new_job_id("fix_issue", 12, NOW)
        record = jobs.request_file(job_id=job, stage="fix_issue", app="demo", branch="factory/fix-13",
                                   base_sha="a" * 40, repository=REPOSITORY, config=CONFIG, bot=BOT)
        self.spool.submit(job, {"request.json": json.dumps(record).encode()})
        self.assertEqual(job_views(self.spool, NOW), [])
        self.assertEqual(self.spool.read_job_json(job, "closed.json")["reason"], "unreadable request")

    def test_a_dry_view_does_not_close_the_job(self):
        job = self.submit(request=b"not json")
        self.assertEqual(job_views(self.spool, NOW, close_unreadable=False), [])
        self.assertEqual(self.spool.state(job), "queued")

    def test_a_job_published_two_minutes_ago_has_a_closed_view(self):
        job = self.submit(12)
        self.spool.close(job, "done", NOW - timedelta(minutes=2))
        self.assertEqual([(v.job_id, v.issue, v.state) for v in job_views(self.spool, NOW)], [(job, 12, "closed")])

    def test_a_job_published_twenty_minutes_ago_has_no_view(self):
        job = self.submit(12)
        self.spool.close(job, "done", NOW - timedelta(minutes=20))
        self.assertEqual(job_views(self.spool, NOW), [])

    def test_a_discarded_job_has_no_view(self):
        job = self.submit(12)
        self.spool.close(job, "the issue is closed or no longer labelled", NOW - timedelta(minutes=2))
        self.assertEqual(job_views(self.spool, NOW), [])

    def test_a_closed_record_with_an_odd_reason_or_time_gives_no_view(self):
        stamp = (NOW - timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
        for record in ({"reason": ["done"], "closed_at": stamp}, {"reason": {"a": 1}, "closed_at": stamp},
                       {"reason": "done", "closed_at": "yesterday"}, {"reason": "done", "closed_at": 5},
                       {"reason": "done"}):
            with self.subTest(record=record):
                job = self.submit(12)
                self.spool.job_file(job, "closed.json").write_text(json.dumps(record))
                self.assertEqual(job_views(self.spool, NOW), [])

    def test_a_closed_record_that_cannot_be_read_gives_no_view(self):
        job = self.submit(12)
        self.spool.job_file(job, "closed.json").write_text("not json")
        self.assertEqual(job_views(self.spool, NOW), [])


class DispatcherTestCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.now = NOW
        self.upstream = Repo(self.tmp / "upstream")
        self.base = self.upstream.commit(BASE_FILES)
        self.settings = settings_from_env(valid_env(self.tmp))
        self.spool = Spool(self.settings.spool_dir)
        self.spool.prepare("dispatcher")
        self.settings.scratch.mkdir(parents=True)
        self.settings.mirror_dir.mkdir(parents=True)
        self.github = FakeGitHub(REPOSITORY, user={"login": BOT.login, "id": BOT.user_id})
        self.labels = f"{self.github.repo}/issues/12/labels"
        self.comments = f"{self.github.repo}/issues/12/comments"
        self.script_github()
        self.git = GitStandIn(self.upstream)
        self.dispatcher = self.build(self.spool)

    def script_github(self) -> None:
        repo, answers = self.github.repo, self.github.answers
        fix = {"labels": "factory:fix", "per_page": "100"}
        answers[key(f"{repo}/issues", {"state": "open", **fix})] = [{
            "number": 12, "title": "Fix the greeting", "body": "It says helo.", "user": {"login": "Marfusios"},
            "labels": [{"name": "factory:fix"}],
        }]
        answers[key(f"{repo}/issues", {"state": "closed", "labels": "factory:fix", "sort": "updated",
                                       "direction": "desc", "per_page": "30"})] = []
        answers[key(f"{repo}/issues/12/events", {"per_page": "100"})] = [
            {"event": "labeled", "label": {"name": "factory:fix"}, "actor": {"login": "Marfusios"}}]
        answers[key(self.comments, {"per_page": "100"})] = []
        answers[key(f"{repo}/pulls", {"head": "owner:factory/fix-12", "state": "all", "per_page": "10"})] = []
        answers[key(f"{repo}/issues", {"state": "open", "labels": "factory:halt", "per_page": "1"})] = []
        answers[key(f"{repo}/contents/apps", {})] = [{"name": "demo", "type": "dir"}]

    def build(self, spool: Spool, settings: Settings | None = None) -> Dispatcher:
        settings = settings or self.settings
        publisher = Publisher(
            spool=spool, github=self.github, config=CONFIG, bot=BOT, workrepo=settings.workrepo,
            scratch=settings.scratch, push_url=str(self.tmp / "remote.git"), token=lambda: TOKEN,
            clock=lambda: self.now,
        )
        return Dispatcher(settings, CONFIG, self.github, spool, publisher, token=lambda: TOKEN, git=self.git,
                          clock=lambda: self.now)

    def runner_finishes(self, job: str, status: str = "timeout") -> None:
        """Hand the job back as the runner does, with no result."""
        self.spool.claim(job, self.now)
        run = {
            "schema": 1, "job_id": job, "status": status, "reason": None, "started_at": "2026-11-27T10:00:00Z",
            "finished_at": "2026-11-27T10:12:05Z", "duration_seconds": 725, "model": "some-model", "turns": 12,
            "resets_at": None,
        }
        self.spool.finish(job, run, {})

    def only_job(self) -> str:
        (job,) = self.spool.job_ids()
        return job

    def calls_to(self, method: str, path: str) -> list:
        return [body for called_method, called, body in self.github.calls if (called_method, called) == (method, path)]

    @contextlib.contextmanager
    def quiet_logging(self):
        """`main` configures logging on the root logger; leave it as it was."""
        root = logging.getLogger()
        handlers, level = list(root.handlers), root.level
        try:
            yield
        finally:
            root.handlers[:] = handlers
            root.setLevel(level)

    def tree(self) -> set[Path]:
        return set(self.tmp.rglob("*"))


class TickTest(DispatcherTestCase):
    def test_a_fresh_issue_becomes_a_job_in_the_spool(self):
        actions = self.dispatcher.tick()
        job = self.only_job()
        request = self.spool.request(job)
        self.assertEqual((request["branch"], request["base_sha"], request["app"]),
                         ("factory/fix-12", self.base, "demo"))
        self.assertEqual(json.loads(self.spool.job_file(job, "job.json").read_text())["issue"]["number"], 12)
        self.assertIn("Fix the greeting", self.spool.job_file(job, "context.md").read_text(encoding="utf-8"))
        self.assertIn("status:building", self.github.posted(self.labels)["labels"])
        self.assertIn(StartJob(12, "demo"), actions)

    def test_the_mirror_is_fetched_from_the_repository_with_the_installation_token(self):
        self.dispatcher.tick()
        self.assertEqual(self.git.mirror_requests, [(f"https://github.com/{REPOSITORY}.git", TOKEN)])

    def test_a_second_tick_does_not_start_a_second_job(self):
        self.dispatcher.tick()
        actions = self.dispatcher.tick()
        self.assertEqual(len(self.spool.job_ids()), 1)
        self.assertFalse([a for a in actions if isinstance(a, StartJob)])

    def test_the_base_is_the_work_branch_when_it_already_exists(self):
        self.upstream.switch("factory/fix-12", self.base)
        checked = self.upstream.commit({"apps/demo/a.txt": "kept\n"})
        self.dispatcher.tick()
        self.assertEqual(self.spool.request(self.only_job())["base_sha"], checked)
        self.assertNotEqual(checked, self.base)

    def test_a_repository_without_a_commit_to_start_from_ends_the_tick(self):
        self.upstream.git("update-ref", "-d", "refs/heads/main")
        self.upstream.git("update-ref", "refs/heads/other", self.base)
        self.upstream.git("symbolic-ref", "HEAD", "refs/heads/other")
        with self.assertLogs("factory.dispatcher", "ERROR") as logged:
            self.dispatcher.tick()
        self.assertEqual(self.spool.job_ids(), [])
        self.assertEqual(len(logged.records), 1)

    def test_a_failing_fetch_decides_nothing(self):
        self.github.fail.add(f"{self.github.repo}/issues")
        with self.assertRaises(GitHubError):
            self.dispatcher.tick()
        self.assertEqual(self.spool.job_ids(), [])
        self.assertEqual(self.github.calls, [])

    def test_a_failed_status_change_starts_no_job_and_is_logged_once(self):
        self.github.fail.add(("POST", self.labels))
        with self.assertLogs("factory.dispatcher", "ERROR") as logged:
            actions = self.dispatcher.tick()
        self.assertTrue([a for a in actions if isinstance(a, StartJob)])
        self.assertEqual(self.spool.job_ids(), [])
        (line,) = [record.getMessage() for record in logged.records]
        self.assertEqual(line, f"{SetStatus(12, 'status:building', ()).describe()} failed: GitHubError")

    def decided(self, *actions):
        return mock.patch.object(dispatcher_module, "decide", return_value=list(actions))

    def test_a_failed_action_skips_the_rest_of_its_issue_only(self):
        self.dispatcher.tick()
        job = self.only_job()
        self.runner_finishes(job)
        self.github.fail.add(("POST", f"{self.github.repo}/issues/3/labels"))
        with self.decided(SetStatus(3, "status:building", ()), StartJob(3, "demo"), PublishRun(job, 12)), \
                mock.patch.object(Dispatcher, "_start_job") as start, self.assertLogs("factory.dispatcher", "ERROR"):
            self.dispatcher.tick()
        start.assert_not_called()
        self.assertEqual(self.spool.state(job), "closed")

    def test_a_failed_notice_skips_that_issues_status_and_not_another_issues(self):
        self.github.fail.add(("POST", self.comments))
        with self.decided(PostNotice(12, "needs-app"), SetStatus(12, "status:needs-human", ()),
                          SetStatus(3, "status:queued", ())), self.assertLogs("factory.dispatcher", "ERROR"):
            self.dispatcher.tick()
        self.assertEqual(self.calls_to("POST", self.labels), [])
        self.assertEqual(self.calls_to("POST", f"{self.github.repo}/issues/3/labels"), [{"labels": ["status:queued"]}])

    def test_a_request_the_runner_would_refuse_is_never_submitted_and_skips_its_issue(self):
        with self.decided(StartJob(12, "AirCase"), SetStatus(12, "status:building", ()),
                          SetStatus(3, "status:queued", ())), self.assertLogs("factory.dispatcher", "ERROR") as logged:
            self.dispatcher.tick()
        self.assertEqual(self.spool.job_ids(), [])
        self.assertEqual(logged.output, [f"ERROR:factory.dispatcher:{StartJob(12, 'AirCase').describe()} failed: "
                                         "SpoolError"])
        self.assertEqual(self.calls_to("POST", self.labels), [])
        self.assertEqual(self.calls_to("POST", f"{self.github.repo}/issues/3/labels"), [{"labels": ["status:queued"]}])

    def test_a_failed_close_skips_nothing_else(self):
        self.dispatcher.tick()
        job = self.only_job()
        with self.decided(CloseJob(job, "gone"), SetStatus(12, "status:queued", ())), \
                mock.patch.object(self.spool, "close", side_effect=SpoolError("no")), \
                self.assertLogs("factory.dispatcher", "ERROR"):
            self.dispatcher.tick()
        self.assertEqual(self.calls_to("POST", self.labels)[-1], {"labels": ["status:queued"]})

    def test_a_rate_limit_while_applying_reaches_the_loop(self):
        with mock.patch.object(Publisher, "set_status", side_effect=RateLimited(429, "limit", 0.0)):
            with self.assertRaises(RateLimited):
                self.dispatcher.tick()

    def test_an_issue_is_not_left_to_a_job_that_is_gone(self):
        self.dispatcher.tick()
        job = self.only_job()
        self.github.answers[key(f"{self.github.repo}/issues", {
            "state": "open", "labels": "factory:fix", "per_page": "100"})] = []
        actions = self.dispatcher.tick()
        self.assertIn(CloseJob(job, "the issue is closed or no longer labelled"), actions)
        self.assertEqual(self.spool.state(job), "closed")

    def test_each_unreadable_issue_is_named_in_one_log_line_and_the_others_go_on(self):
        issues = key(f"{self.github.repo}/issues", {"state": "open", "labels": "factory:fix", "per_page": "100"})
        self.github.answers[issues].insert(0, {"number": 7, "title": "Big", "body": "", "user": {"login": "x"},
                                               "labels": [{"name": "factory:fix"}]})
        self.github.raises[key(f"{self.github.repo}/issues/7/events", {"per_page": "100"})] = GitHubError(0, "big")
        with self.assertLogs("factory.dispatcher", "WARNING") as logged:
            actions = self.dispatcher.tick()
        self.assertEqual(logged.output, ["WARNING:factory.dispatcher:issue #7 could not be read in full this poll, "
                                         "so it is left as it is"])
        self.assertIn(StartJob(12, "demo"), actions)

    def test_each_action_applied_is_logged_at_info_with_its_description(self):
        with self.assertLogs("factory.dispatcher", "INFO") as logged:
            self.dispatcher.tick()
        self.assertEqual(logged.output, [f"INFO:factory.dispatcher:{SetStatus(12, 'status:building', ()).describe()}",
                                         f"INFO:factory.dispatcher:{StartJob(12, 'demo').describe()}"])

    def test_a_notice_is_posted_for_an_issue_nobody_trusts(self):
        issues = key(f"{self.github.repo}/issues", {"state": "open", "labels": "factory:fix", "per_page": "100"})
        self.github.answers[issues][0]["user"] = {"login": "stranger"}
        actions = self.dispatcher.tick()
        self.assertIn(PostNotice(12, "untrusted-author"), actions)
        self.assertEqual(len(self.calls_to("POST", self.comments)), 1)


LOG_LINE = "npm ERR! the build exploded"
UNREADABLE = "the log could not be read"
TRUSTED = "Marfusios"
PULL_NUMBER = 40


def thread_node(thread_id: object, comments: list, *, resolved: object = False, path: object = "apps/demo/a.txt",
                line: object = 3) -> dict:
    return {"id": thread_id, "isResolved": resolved, "path": path, "line": line, "comments": {"nodes": comments}}


def comment_node(database_id: object, body: str, *, review: object = 7, author: str = TRUSTED) -> dict:
    return {"databaseId": database_id, "author": {"login": author}, "body": body,
            "pullRequestReview": {"databaseId": review}}


def threads_answer(*nodes: object) -> dict:
    return {"repository": {"pullRequest": {"reviewThreads": {"nodes": list(nodes)}}}}


class PullRequestRunsTest(DispatcherTestCase):
    """A fix or revise run starts on the open pull request of an issue; the poll is handed in as a snapshot."""

    def setUp(self):
        super().setUp()
        self.upstream.switch("factory/fix-12", self.base)
        self.head = self.upstream.commit({"apps/demo/a.txt": "work\n"})

    def logs_path(self, job_id: int) -> str:
        return f"{self.github.repo}/actions/jobs/{job_id}/logs"

    def review(self, review_id: int = 7, body: str = "Rename the helper.") -> Review:
        return Review(review_id, TRUSTED, "changes_requested", "2026-11-27T10:00:00Z", body)

    def pull(self, **fields) -> PullRequest:
        values = {"number": PULL_NUMBER, "open": True, "merged": False, "url": "https://example.test/pull/40",
                  "head_sha": self.head, "node_id": "PR_node"}
        return PullRequest(**{**values, **fields})

    def issue(self, pull: PullRequest | None, comments: tuple[Comment, ...] = ()) -> Issue:
        return Issue(12, "Fix the greeting", "It says helo.", TRUSTED, True, ("factory:fix",), TRUSTED, comments, pull)

    def tick(self, issue: Issue, *actions, dry_run: bool = False) -> list:
        snap = Snapshot((issue,), False, ("demo",))
        with mock.patch.object(dispatcher_module.snapshot, "fetch", return_value=snap), \
                mock.patch.object(dispatcher_module, "decide", return_value=list(actions)):
            return self.dispatcher.tick(dry_run=dry_run)

    def failed(self, *checks: Check, **fields) -> Issue:
        return self.issue(self.pull(checks=tuple(checks), **fields))

    def context_of(self, job: str) -> str:
        return self.spool.job_file(job, "context.md").read_text(encoding="utf-8")

    def start_fix(self, issue: Issue, round: int = 1) -> str:
        before = set(self.spool.job_ids())
        self.tick(issue, StartJob(12, "demo", "fix", round))
        (job,) = set(self.spool.job_ids()) - before
        return job

    def assert_fails_without_a_job(self, issue: Issue, action, error: str = "GitHubError") -> None:
        with self.assertLogs("factory.dispatcher", "ERROR") as logged:
            self.tick(issue, action)
        self.assertEqual(self.spool.job_ids(), [])
        self.assertEqual(logged.output, [f"ERROR:factory.dispatcher:{action.describe()} failed: {error}"])

    def test_a_fix_run_starts_on_the_pull_request_head_with_the_log_and_the_review_in_its_context(self):
        self.github.downloads[self.logs_path(31)] = f"2026-11-27T10:00:00.1234567Z {LOG_LINE}\n"
        issue = self.failed(Check("unit", "failed", 31), verdict="fail", review_text="The loop never ends.")
        job = self.start_fix(issue)
        request = self.spool.request(job)
        self.assertEqual((request["stage"], request["skill"], request["round"], request["pull_request"]),
                         ("fix", "factory-fix", 1, PULL_NUMBER))
        self.assertEqual((request["base_sha"], request["branch"]), (self.head, "factory/fix-12"))
        record = json.loads(self.spool.job_file(job, "job.json").read_text())
        self.assertEqual((record["stage"], record["round"], record["base_sha"]), ("fix", 1, self.head))
        context = self.context_of(job)
        self.assertIn(f"## Failed check: unit\n\n> {LOG_LINE}", context)
        self.assertIn("> The loop never ends.", context)
        self.assertFalse(self.spool.job_file(job, "threads.json").exists())

    def test_a_fix_run_keeps_the_round_it_was_decided_for(self):
        job = self.start_fix(self.failed(Check("unit", "failed", 0)), round=3)
        self.assertEqual(self.spool.request(job)["round"], 3)

    def test_the_review_text_is_part_of_the_work_only_when_the_verdict_is_fail(self):
        for verdict in ("pass", "unavailable", ""):
            with self.subTest(verdict=verdict):
                job = self.start_fix(self.failed(Check("unit", "failed", 0), verdict=verdict, review_text="Nice."))
                self.assertNotIn("Nice.", self.context_of(job))
                self.spool.close(job, "done", self.now)

    def test_failed_checks_that_are_not_required_names_come_first_and_only_failed_ones_count(self):
        for job_id in (1, 2, 3, 4):
            self.github.downloads[self.logs_path(job_id)] = f"log {job_id}"
        issue = self.failed(Check("apps", "failed", 4), Check("unit b", "failed", 2), Check("passing", "passed", 9),
                            Check("unit a", "failed", 1), Check("other", "other", 8), Check("review", "failed", 3))
        context = self.context_of(self.start_fix(issue))
        headings = [line for line in context.splitlines() if line.startswith("## Failed check")]
        self.assertEqual(headings, ["## Failed check: unit a", "## Failed check: unit b", "## Failed check: apps",
                                    "## Failed check: review"])
        self.assertNotIn("passing", context)

    def test_no_more_logs_are_downloaded_than_the_context_shows_and_the_rest_are_named(self):
        names = [f"job{number}" for number in range(jobs.MAX_FAILED_CHECKS + 2)]
        checks = [Check(name, "failed", number + 1) for number, name in enumerate(names)]
        for check in checks:
            self.github.downloads[self.logs_path(check.job_id)] = "tail"
        with mock.patch.object(self.github, "download_text", wraps=self.github.download_text) as download:
            context = self.context_of(self.start_fix(self.failed(*checks)))
        self.assertEqual(download.call_count, jobs.MAX_FAILED_CHECKS)
        self.assertIn(f"{names[-2]}, {names[-1]}", context)

    def test_a_check_without_a_job_downloads_nothing_and_a_log_that_fails_is_replaced_by_a_line(self):
        self.github.downloads[self.logs_path(5)] = LOG_LINE
        issue = self.failed(Check("a", "failed", 0), Check("b", "failed", 77), Check("c", "failed", 5))
        with mock.patch.object(self.github, "download_text", wraps=self.github.download_text) as download:
            context = self.context_of(self.start_fix(issue))
        self.assertEqual([call.args[0] for call in download.call_args_list],
                         [self.logs_path(77), self.logs_path(5)])
        self.assertEqual(context.count(f"> {UNREADABLE}"), 2)
        self.assertIn(f"> {LOG_LINE}", context)

    def test_a_rate_limit_while_reading_a_log_reaches_the_loop_and_starts_nothing(self):
        with mock.patch.object(self.github, "download_text", side_effect=RateLimited(429, "limit", 0.0)):
            with self.assertRaises(RateLimited):
                self.tick(self.failed(Check("a", "failed", 5)), StartJob(12, "demo", "fix", 1))
        self.assertEqual(self.spool.job_ids(), [])

    def test_a_branch_that_is_not_at_the_pull_request_head_starts_nothing(self):
        self.upstream.commit({"apps/demo/a.txt": "newer\n"})
        self.assert_fails_without_a_job(self.failed(Check("a", "failed", 0)), StartJob(12, "demo", "fix", 1),
                                        "GitError")

    def test_a_branch_the_mirror_does_not_have_starts_nothing(self):
        self.upstream.git("update-ref", "refs/heads/main", self.base)
        self.upstream.git("symbolic-ref", "HEAD", "refs/heads/main")
        self.upstream.git("update-ref", "-d", "refs/heads/factory/fix-12")
        self.assert_fails_without_a_job(self.issue(self.pull(reviews=(self.review(),))),
                                        StartJob(12, "demo", "revise"), "GitError")

    def test_a_fix_or_revise_run_needs_an_open_pull_request_with_a_commit_id_as_its_head(self):
        cases = {"none": None, "closed": self.pull(open=False), "no head": self.pull(head_sha=""),
                 "short head": self.pull(head_sha=self.head[:10]),
                 "upper case head": self.pull(head_sha=self.head.upper())}
        for stage in ("fix", "revise"):
            for name, pull in cases.items():
                with self.subTest(stage=stage, pull=name):
                    self.assert_fails_without_a_job(self.issue(pull), StartJob(12, "demo", stage), "NoPullRequest")
                    self.assertEqual(self.git.mirror_requests, [])  # no fetch is spent on an issue that cannot start

    def test_a_revise_run_gets_the_unresolved_threads_of_the_reviews_it_answers(self):
        self.github.graphql_answers.append(threads_answer(
            thread_node("PRRT_open", [comment_node(501, "Why this name?"), comment_node(502, "Please rename.")]),
            thread_node("PRRT_done", [comment_node(503, "Old remark.")], resolved=True),
            thread_node("PRRT_other", [comment_node(504, "From another review.", review=8)]),
            thread_node("PRRT_plain", [{**comment_node(505, "No review."), "pullRequestReview": None}]),
        ))
        self.tick(self.issue(self.pull(reviews=(self.review(),))), StartJob(12, "demo", "revise"))
        job = self.only_job()
        request = self.spool.request(job)
        self.assertEqual((request["stage"], request["skill"], request["round"], request["pull_request"]),
                         ("revise", "factory-revise", 0, PULL_NUMBER))
        self.assertEqual(request["base_sha"], self.head)
        self.assertEqual(json.loads(self.spool.job_file(job, "threads.json").read_text()), {"PRRT_open": 501})
        context = self.context_of(job)
        self.assertIn("## Review (2026-11-27T10:00:00Z)\n\n> Rename the helper.", context)
        self.assertIn("## Review thread PRRT_open (apps/demo/a.txt:3)", context)
        self.assertIn("> Marfusios:\n> Why this name?\n>\n> Marfusios:\n> Please rename.", context)
        for left_out in ("PRRT_done", "PRRT_other", "PRRT_plain", "Old remark."):
            self.assertNotIn(left_out, context)
        ((_, variables),) = self.github.graphql_calls
        self.assertEqual(variables, {"owner": "owner", "name": "name", "number": PULL_NUMBER})

    def test_a_revise_command_alone_gives_its_instruction_and_no_threads_and_asks_graphql_nothing(self):
        command = Comment(5, TRUSTED, 1, "2026-11-27T10:00:00Z", "/factory revise Use shorter names.")
        self.tick(self.issue(self.pull(), (command,)), StartJob(12, "demo", "revise"))
        job = self.only_job()
        self.assertIn("## Instruction\n\n> Use shorter names.", self.context_of(job))
        self.assertEqual(json.loads(self.spool.job_file(job, "threads.json").read_text()), {})
        self.assertEqual(self.github.graphql_calls, [])

    def test_a_thread_of_an_untrusted_author_only_is_in_neither_the_context_nor_threads_json(self):
        self.github.graphql_answers.append(threads_answer(
            thread_node("PRRT_stranger", [comment_node(701, "Hostile remark", author="stranger")]),
            thread_node("PRRT_trusted", [comment_node(702, "Fine remark")]),
        ))
        self.tick(self.issue(self.pull(reviews=(self.review(),))), StartJob(12, "demo", "revise"))
        job = self.only_job()
        self.assertEqual(json.loads(self.spool.job_file(job, "threads.json").read_text()), {"PRRT_trusted": 702})
        for text in ("PRRT_stranger", "Hostile remark"):
            self.assertNotIn(text, self.context_of(job))

    def test_more_threads_than_a_page_are_logged_in_fixed_words_and_the_first_page_is_given(self):
        self.github.graphql_answers.append({"repository": {"pullRequest": {"reviewThreads": {
            "pageInfo": {"hasNextPage": True}, "nodes": [thread_node("PRRT_open", [comment_node(501, "Why?")])]}}}})
        with self.assertLogs("factory.dispatcher", "WARNING") as logged:
            self.tick(self.issue(self.pull(reviews=(self.review(),))), StartJob(12, "demo", "revise"))
        self.assertEqual(logged.output, ["WARNING:factory.dispatcher:issue #12: the pull request has more review "
                                         "threads than one page, so the run is given the first page only"])
        self.assertEqual(json.loads(self.spool.job_file(self.only_job(), "threads.json").read_text()),
                         {"PRRT_open": 501})

    def test_a_review_with_a_lone_surrogate_still_gives_a_job_with_a_valid_text_file(self):
        self.github.graphql_answers.append(threads_answer())
        review = self.review(body=f"Rename {chr(0xD800)} it.")
        self.tick(self.issue(self.pull(reviews=(review,))), StartJob(12, "demo", "revise"))
        job = self.only_job()
        self.assertIn("Rename ? it.", self.spool.job_file(job, "context.md").read_bytes().decode("utf-8"))

    def test_a_graphql_failure_starts_no_revise_run(self):
        self.github.graphql_answers.append(GitHubError(0, "POST /graphql failed with 1 error"))
        self.assert_fails_without_a_job(self.issue(self.pull(reviews=(self.review(),))),
                                        StartJob(12, "demo", "revise"))

    def test_an_answer_that_holds_no_threads_at_all_starts_no_revise_run(self):
        self.github.graphql_answers.append({"repository": None})
        self.assert_fails_without_a_job(self.issue(self.pull(reviews=(self.review(),))),
                                        StartJob(12, "demo", "revise"))

    def test_a_first_run_for_an_issue_keeps_its_round_and_pull_request_at_zero(self):
        self.tick(self.issue(None), StartJob(12, "demo"))
        job = self.only_job()
        request = self.spool.request(job)
        self.assertEqual((request["stage"], request["round"], request["pull_request"]), ("fix_issue", 0, 0))
        self.assertEqual(json.loads(self.spool.job_file(job, "job.json").read_text())["round"], 0)
        self.assertFalse(self.spool.job_file(job, "threads.json").exists())

    def test_nothing_of_a_check_a_review_or_a_thread_is_logged(self):
        self.github.downloads[self.logs_path(5)] = LOG_LINE
        self.github.graphql_answers.append(threads_answer(thread_node("PRRT_open", [comment_node(501, "Hidden")])))
        issue = self.failed(Check("secret-check", "failed", 5), reviews=(self.review(body="Secret review"),),
                            verdict="fail", review_text="Secret verdict text")
        with self.assertLogs("factory.dispatcher", "INFO") as logged:
            self.tick(issue, StartJob(12, "demo", "fix", 1))
            self.spool.close(self.only_job(), "done", self.now)
            self.tick(issue, StartJob(12, "demo", "revise"))
        self.assertEqual(logged.output, [
            f"INFO:factory.dispatcher:{StartJob(12, 'demo', 'fix', 1).describe()}",
            f"INFO:factory.dispatcher:{StartJob(12, 'demo', 'revise').describe()}"])

    def test_the_hand_off_reaches_the_publisher_with_the_issue(self):
        issue = self.issue(self.pull())
        with mock.patch.object(Publisher, "hand_off") as hand_off:
            self.tick(issue, HandOff(12))
        hand_off.assert_called_once_with(issue)

    def test_a_hand_off_that_fails_is_logged_like_any_failed_action(self):
        with mock.patch.object(Publisher, "hand_off", side_effect=GitHubError(502, "down")), \
                self.assertLogs("factory.dispatcher", "ERROR") as logged:
            self.tick(self.issue(self.pull()), HandOff(12))
        self.assertEqual(logged.output, [f"ERROR:factory.dispatcher:{HandOff(12).describe()} failed: GitHubError"])

    def test_a_hand_off_that_meets_odd_data_does_not_stop_the_actions_after_it(self):
        with mock.patch.object(Publisher, "hand_off", side_effect=ValueError("a refused verdict text")), \
                self.assertLogs("factory.dispatcher", "ERROR") as logged:
            self.tick(self.issue(self.pull()), HandOff(12), SetStatus(3, "status:queued", ()))
        self.assertEqual(logged.output, [f"ERROR:factory.dispatcher:{HandOff(12).describe()} failed: ValueError"])
        self.assertEqual(self.calls_to("POST", f"{self.github.repo}/issues/3/labels"), [{"labels": ["status:queued"]}])

    def test_a_dry_run_makes_no_call_to_github_reads_no_log_and_writes_nothing(self):
        issue = self.issue(self.pull(checks=(Check("a", "failed", 5),), reviews=(self.review(),)))
        before = self.tree()
        with contextlib.ExitStack() as stack:
            for name in ("get", "get_all", "post", "patch", "delete", "graphql", "download_text"):
                stack.enter_context(mock.patch.object(self.github, name, side_effect=AssertionError(name)))
            actions = self.tick(issue, StartJob(12, "demo", "fix", 1), StartJob(12, "demo", "revise"), HandOff(12),
                                dry_run=True)
        self.assertEqual(len(actions), 3)
        self.assertEqual(self.git.mirror_requests, [])
        self.assertEqual(self.tree(), before)


class DryRunTest(DispatcherTestCase):
    def fresh_dispatcher(self) -> tuple[Dispatcher, Path]:
        """A dispatcher whose spool, mirror and state directories do not exist."""
        root = self.tmp / "fresh"
        settings = settings_from_env(valid_env(root))
        return self.build(Spool(settings.spool_dir), settings), root

    def test_dry_run_writes_nothing(self):
        before = self.tree()
        bare, root = self.fresh_dispatcher()
        actions = bare.tick(dry_run=True)
        self.assertIn(StartJob(12, "demo"), actions)
        self.assertEqual(self.github.calls, [])
        self.assertEqual(self.git.mirror_requests, [])
        self.assertEqual(self.tree(), before)
        self.assertFalse(root.exists())

    def test_dry_run_leaves_a_job_with_an_unreadable_request_open(self):
        job = new_job_id("fix_issue", 12, NOW)
        self.spool.submit(job, {"request.json": b"not json"})
        self.dispatcher.tick(dry_run=True)
        self.assertEqual(self.spool.state(job), "queued")

    def test_main_prints_the_actions_of_a_dry_run_and_creates_nothing(self):
        bare, root = self.fresh_dispatcher()
        before = self.tree()
        out = io.StringIO()
        with mock.patch.dict(os.environ, valid_env(root)), \
                mock.patch.object(dispatcher_module, "build_dispatcher", return_value=bare), \
                contextlib.redirect_stdout(out), self.quiet_logging():
            status = dispatcher_module.main(["--dry-run"])
        self.assertEqual(status, 0)
        self.assertIn(StartJob(12, "demo").describe(), out.getvalue().splitlines())
        self.assertEqual(self.github.calls, [])
        self.assertEqual(self.tree(), before)
        self.assertFalse(root.exists())

    def test_building_the_dispatcher_creates_nothing_and_makes_no_request(self):
        root = self.tmp / "fresh"
        settings = settings_from_env(valid_env(root))
        with mock.patch.object(dispatcher_module, "GitHub") as github_class, \
                mock.patch.object(dispatcher_module, "InstallationToken") as token_class:
            dispatcher_module.build_dispatcher(settings, CONFIG)
        tokens = token_class.return_value
        github_class.assert_called_once_with(REPOSITORY, tokens.get, refresh=tokens.refresh)
        self.assertEqual(github_class.return_value.mock_calls, [])
        self.assertEqual(tokens.mock_calls, [])
        self.assertFalse(root.exists())


class OnceTest(DispatcherTestCase):
    def run_main(self, *argv: str) -> int:
        # basicConfig would add a handler that prints the dispatcher's INFO lines into the test output
        with mock.patch.dict(os.environ, valid_env(self.tmp)), mock.patch.object(logging, "basicConfig"), \
                mock.patch.object(dispatcher_module, "build_dispatcher", return_value=self.dispatcher), \
                self.quiet_logging():
            return dispatcher_module.main(list(argv))

    def test_once_returns_zero_after_a_clean_tick(self):
        self.assertEqual(self.run_main("--once"), 0)
        self.assertEqual(len(self.spool.job_ids()), 1)

    def test_main_logs_at_info_even_when_logging_was_set_up_before_it(self):
        root = logging.getLogger()
        with self.quiet_logging():
            root.addHandler(logging.NullHandler())  # basicConfig then leaves the root logger as it is
            root.setLevel(logging.WARNING)
            with mock.patch.dict(os.environ, valid_env(self.tmp)), mock.patch.object(Dispatcher, "tick", return_value=[]), \
                    mock.patch.object(dispatcher_module, "build_dispatcher", return_value=self.dispatcher):
                self.assertEqual(dispatcher_module.main(["--once"]), 0)
            self.assertEqual(root.level, logging.INFO)

    def test_once_returns_one_when_the_tick_raised_and_logs_what_github_said(self):
        self.github.fail.add(f"{self.github.repo}/issues")
        with self.assertLogs("factory.dispatcher", "ERROR") as logged:
            self.assertEqual(self.run_main("--once"), 1)
        self.assertEqual(logged.output, [f"ERROR:factory.dispatcher:the poll failed: GitHub 502: GET "
                                         f"{self.github.repo}/issues failed"])

    def test_a_configuration_that_does_not_load_is_one_line_and_exit_status_2(self):
        problem = factory_config.ConfigError("stages.fix_issue is required")
        with mock.patch.object(dispatcher_module, "load_config", side_effect=problem), \
                self.assertLogs("factory.dispatcher", "ERROR") as logged:
            self.assertEqual(self.run_main("--once"), 2)
        self.assertEqual(logged.output, ["ERROR:factory.dispatcher:configuration: stages.fix_issue is required"])
        self.assertIsNone(logged.records[0].exc_info)

    def test_once_and_the_service_hold_the_lock_and_a_dry_run_takes_none(self):
        taken = []

        def take(state_dir):
            taken.append(state_dir)
            return None

        with mock.patch.object(dispatcher_module, "acquire_lock", side_effect=take), \
                mock.patch.object(Dispatcher, "run"), mock.patch.object(dispatcher_module.signal, "signal"), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.run_main("--once"), 0)
            self.assertEqual(self.run_main(), 0)
            self.assertEqual(self.run_main("--dry-run"), 0)
        self.assertEqual(taken, [self.settings.state_dir, self.settings.state_dir])

    def test_a_second_dispatcher_exits_with_status_1_and_one_line(self):
        with mock.patch.object(dispatcher_module, "acquire_lock", side_effect=dispatcher_module.AlreadyRunning), \
                self.assertLogs("factory.dispatcher", "ERROR") as logged:
            self.assertEqual(self.run_main("--once"), 1)
        self.assertEqual(logged.output, ["ERROR:factory.dispatcher:another dispatcher holds the lock on the state "
                                         "directory"])
        self.assertEqual(self.spool.job_ids(), [])

    def test_a_lock_that_cannot_be_taken_is_a_start_up_failure(self):
        with mock.patch.object(dispatcher_module, "acquire_lock", side_effect=PermissionError("secret detail")), \
                self.assertLogs("factory.dispatcher", "ERROR") as logged:
            self.assertEqual(self.run_main("--once"), 1)
        self.assertEqual(logged.output, ["ERROR:factory.dispatcher:start-up failed: PermissionError"])


class LockTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.state = Path(tmp.name)

    def fake_fcntl(self, error: type[BaseException] | None) -> mock.Mock:
        module = mock.Mock(LOCK_EX=2, LOCK_NB=4)
        module.flock.side_effect = error
        return module

    def test_a_held_lock_means_another_dispatcher(self):
        with mock.patch.object(dispatcher_module, "fcntl", self.fake_fcntl(BlockingIOError)), \
                self.assertRaises(dispatcher_module.AlreadyRunning):
            dispatcher_module.acquire_lock(self.state)

    def test_any_other_error_is_raised_as_it_is(self):
        with mock.patch.object(dispatcher_module, "fcntl", self.fake_fcntl(PermissionError)), \
                self.assertRaises(PermissionError):
            dispatcher_module.acquire_lock(self.state)

    def test_a_free_lock_is_taken_on_the_lock_file_without_blocking(self):
        fcntl = self.fake_fcntl(None)
        with mock.patch.object(dispatcher_module, "fcntl", fcntl):
            handle = dispatcher_module.acquire_lock(self.state)
        self.addCleanup(handle.close)
        self.assertEqual(fcntl.flock.call_args.args[1], 2 | 4)
        self.assertTrue((self.state / "dispatcher.lock").exists())

    def test_without_fcntl_there_is_no_lock(self):
        with mock.patch.object(dispatcher_module, "fcntl", None):
            self.assertIsNone(dispatcher_module.acquire_lock(self.state))

    @unittest.skipUnless(os.name == "posix", "flock exists only on POSIX")
    def test_two_dispatchers_cannot_both_hold_the_lock(self):
        first = dispatcher_module.acquire_lock(self.state)
        self.addCleanup(first.close)
        with self.assertRaises(dispatcher_module.AlreadyRunning):
            dispatcher_module.acquire_lock(self.state)


class PublishTest(DispatcherTestCase):
    def test_a_finished_job_is_published_on_the_next_tick(self):
        self.dispatcher.tick()
        job = self.only_job()
        self.runner_finishes(job)
        actions = self.dispatcher.tick()
        self.assertIn(PublishRun(job, 12), actions)
        self.assertEqual(self.spool.state(job), "closed")
        self.assertEqual(self.spool.read_job_json(job, "closed.json")["reason"], "timeout")
        self.assertEqual(len(self.calls_to("POST", self.comments)), 1)

    def finished_job(self) -> str:
        self.dispatcher.tick()
        job = self.only_job()
        self.runner_finishes(job)
        return job

    def test_the_end_of_a_publication_is_logged_with_the_job_and_its_outcome_word(self):
        job = self.finished_job()
        with self.assertLogs("factory.dispatcher", "INFO") as logged:
            self.dispatcher.tick()
        self.assertEqual(logged.output, [f"INFO:factory.dispatcher:{PublishRun(job, 12).describe()}",
                                         f"INFO:factory.dispatcher:job {job}: published as timed out"])

    def test_a_publish_that_fails_is_retried_only_after_its_delay(self):
        job = self.finished_job()
        self.github.fail_once.add(("POST", self.comments))
        with self.assertLogs("factory.dispatcher", "ERROR") as logged:
            self.dispatcher.tick()
        self.assertEqual(self.spool.state(job), "finished")
        self.assertEqual(len(logged.records), 1)
        calls = len(self.github.calls)

        self.now = NOW + timedelta(seconds=59)
        self.dispatcher.tick()
        self.assertEqual(len(self.github.calls), calls)
        self.assertEqual(self.spool.state(job), "finished")

        self.now = NOW + timedelta(seconds=61)
        self.dispatcher.tick()
        self.assertEqual(self.spool.state(job), "closed")

    def test_the_delay_doubles_with_each_failure_up_to_half_an_hour(self):
        job = self.finished_job()
        attempt_at = NOW
        with mock.patch.object(Publisher, "publish", side_effect=GitHubError(502, "down")) as publish, \
                self.assertLogs("factory.dispatcher", "ERROR"):
            for attempts, delay in enumerate([60, 120, 240, 480, 960, 1800, 1800, 1800], start=1):
                self.now = attempt_at
                self.dispatcher.tick()
                self.assertEqual(publish.call_count, attempts)
                self.now = attempt_at + timedelta(seconds=delay - 1)
                self.dispatcher.tick()
                self.assertEqual(publish.call_count, attempts)
                attempt_at += timedelta(seconds=delay)
        self.assertEqual(self.spool.state(job), "finished")

    def test_a_rate_limit_in_a_publication_reaches_the_loop_and_is_not_counted(self):
        self.finished_job()
        answers = [RateLimited(429, "limit", 0.0), "timeout"]
        with mock.patch.object(Publisher, "publish", side_effect=answers) as publish:
            with self.assertRaises(RateLimited):
                self.dispatcher.tick()
            self.dispatcher.tick()  # at the same time: no delay was set
        self.assertEqual(publish.call_count, 2)

    def test_the_delay_of_a_job_that_is_gone_is_forgotten(self):
        job = self.finished_job()
        with mock.patch.object(Publisher, "publish", side_effect=GitHubError(502, "down")) as publish, \
                self.assertLogs("factory.dispatcher", "ERROR"):
            self.dispatcher.tick()
            self.spool.close(job, "discarded", NOW)
            self.now = NOW + timedelta(seconds=10)
            self.dispatcher.tick()  # the job has no view now
            self.spool.job_file(job, "closed.json").unlink()
            self.now = NOW + timedelta(seconds=20)
            self.dispatcher.tick()
        self.assertEqual(publish.call_count, 2)

    def fail_publications(self, job: str, failures: int, start: datetime = NOW) -> datetime:
        """Let `failures` publications of the job fail, each at its retry time; return the time of the next one."""
        attempt_at = start
        with mock.patch.object(Publisher, "publish", side_effect=GitHubError(502, "down")), \
                self.assertLogs("factory.dispatcher", "ERROR"):
            for _ in range(failures):
                self.now = attempt_at
                self.dispatcher.tick()
                attempt_at += timedelta(seconds=dispatcher_module.LONGEST_RETRY_SECONDS)
        self.assertEqual(self.spool.state(job), "finished")
        return attempt_at

    def assertGivenUp(self, job: str) -> None:
        self.assertEqual(self.spool.read_job_json(job, "closed.json")["reason"], "crashed")
        (comment,) = self.calls_to("POST", self.comments)
        self.assertIn("the factory hit an internal error", comment["body"])
        self.assertEqual(self.github.posted(self.labels), {"labels": ["status:needs-human"]})

    def test_after_eight_failed_publications_the_dispatcher_gives_up_with_an_internal_error(self):
        job = self.finished_job()
        next_attempt = self.fail_publications(job, 8)
        self.assertEqual(self.spool.read_job_json(job, "attempts.json"),
                         {"failed": 8, "first_failed_at": "2026-11-27T10:15:00Z"})
        self.now = next_attempt
        with mock.patch.object(Publisher, "publish") as publish, \
                self.assertLogs("factory.dispatcher", "WARNING") as logged:
            self.dispatcher.tick()
        publish.assert_not_called()
        self.assertEqual(logged.output, [f"WARNING:factory.dispatcher:job {job}: publishing it failed 8 times since "
                                         "2026-11-27T10:15:00Z; it is shown as an internal error instead"])
        self.assertGivenUp(job)

    def test_the_count_of_failed_publications_survives_a_restart(self):
        job = self.finished_job()
        next_attempt = self.fail_publications(job, 7)
        restarted = self.build(self.spool)
        self.now = next_attempt
        with mock.patch.object(Publisher, "publish", side_effect=GitHubError(502, "down")) as publish, \
                self.assertLogs("factory.dispatcher", "ERROR"):
            restarted.tick()
        publish.assert_called_once()
        self.assertEqual(self.spool.read_job_json(job, "attempts.json")["failed"], 8)
        self.now = next_attempt + timedelta(seconds=dispatcher_module.LONGEST_RETRY_SECONDS)
        with self.assertLogs("factory.dispatcher", "WARNING"):
            self.build(self.spool).tick()
        self.assertGivenUp(job)

    def test_a_failed_give_up_is_tried_again_half_an_hour_later(self):
        job = self.finished_job()
        give_up_at = self.fail_publications(job, 8)
        with mock.patch.object(Publisher, "give_up", side_effect=GitHubError(502, "down")) as give_up, \
                self.assertLogs("factory.dispatcher", "ERROR"):
            for moment in (give_up_at, give_up_at + timedelta(minutes=29, seconds=59)):
                self.now = moment
                self.dispatcher.tick()
        give_up.assert_called_once()
        self.now = give_up_at + timedelta(minutes=30)
        with self.assertLogs("factory.dispatcher", "WARNING"):
            self.dispatcher.tick()
        self.assertGivenUp(job)

    def test_a_value_error_from_a_publication_is_a_failed_attempt_and_not_the_end_of_the_loop(self):
        job = self.finished_job()
        with mock.patch.object(Publisher, "publish", side_effect=ValueError("refused")), \
                self.assertLogs("factory.dispatcher", "ERROR") as logged:
            self.dispatcher.tick()
        self.assertIn(f"{PublishRun(job, 12).describe()} failed: ValueError", logged.output[0])
        self.assertEqual(self.spool.read_job_json(job, "attempts.json")["failed"], 1)
        self.assertEqual(self.spool.state(job), "finished")

    def test_a_count_that_cannot_be_stored_still_counts_in_memory(self):
        job = self.finished_job()
        real_write = self.spool.write_job_json

        def full_disk(job_id, name, record):
            if name == "attempts.json":
                raise SpoolError("attempts.json cannot be written: No space left on device")
            return real_write(job_id, name, record)

        with mock.patch.object(self.spool, "write_job_json", side_effect=full_disk):
            next_attempt = self.fail_publications(job, 8)
            self.now = next_attempt
            with self.assertLogs("factory.dispatcher", "WARNING"):
                self.dispatcher.tick()
        self.assertIsNone(self.spool.read_job_json(job, "attempts.json"))
        self.assertGivenUp(job)

    def test_a_failed_publish_does_not_stop_the_actions_that_follow(self):
        self.dispatcher.tick()
        job = self.only_job()
        self.runner_finishes(job)
        self.github.fail.add(("POST", self.comments))
        other = self.github.repo
        issues = key(f"{other}/issues", {"state": "open", "labels": "factory:fix", "per_page": "100"})
        self.github.answers[issues].append({
            "number": 13, "title": "Another", "body": "", "user": {"login": "stranger"},
            "labels": [{"name": "factory:fix"}],
        })
        self.github.answers[key(f"{other}/issues/13/events", {"per_page": "100"})] = [
            {"event": "labeled", "label": {"name": "factory:fix"}, "actor": {"login": "Marfusios"}}]
        self.github.answers[key(f"{other}/issues/13/comments", {"per_page": "100"})] = []
        self.github.answers[key(f"{other}/pulls", {"head": "owner:factory/fix-13", "state": "all",
                                                   "per_page": "10"})] = []
        with self.assertLogs("factory.dispatcher", "ERROR"):
            self.dispatcher.tick()
        self.assertEqual(len(self.calls_to("POST", f"{other}/issues/13/comments")), 1)
        self.assertEqual(self.spool.state(job), "finished")


class LoopTest(DispatcherTestCase):
    def run_once_with(self, tick_effect) -> list[float]:
        stop = threading.Event()
        slept: list[float] = []

        def sleep(event: threading.Event, seconds: float) -> None:
            slept.append(seconds)
            event.set()

        with mock.patch.object(self.dispatcher, "tick", side_effect=tick_effect), \
                mock.patch.object(dispatcher_module, "_sleep", sleep), self.assertLogs("factory.dispatcher", "ERROR"):
            self.dispatcher.run(stop)
        return slept

    def test_the_loop_sleeps_the_poll_interval_between_ticks(self):
        slept = self.run_once_with(GitHubError(502, "down"))
        self.assertEqual(slept, [float(CONFIG.dispatcher.poll_seconds)])

    def test_a_failed_poll_logs_what_github_said_and_only_the_class_of_anything_else(self):
        for error, line in ((GitHubError(0, "GET /x answered more than 10000000 bytes"),
                             "the poll failed: GitHub 0: GET /x answered more than 10000000 bytes"),
                            (OSError("a host path"), "the poll failed: OSError")):
            with self.subTest(line=line):
                stop = threading.Event()
                with mock.patch.object(self.dispatcher, "tick", side_effect=error), \
                        mock.patch.object(dispatcher_module, "_sleep", lambda event, seconds: event.set()), \
                        self.assertLogs("factory.dispatcher", "ERROR") as logged:
                    self.dispatcher.run(stop)
                self.assertIn(f"ERROR:factory.dispatcher:{line}", logged.output)

    def test_a_rate_limit_sleeps_until_it_lifts(self):
        slept = self.run_once_with(RateLimited(429, "limit", NOW.timestamp() + 120))
        self.assertEqual(slept, [120.0])

    def test_a_rate_limit_that_is_not_ahead_still_sleeps_a_minute(self):
        for retry_at in (NOW.timestamp(), NOW.timestamp() - 500, NOW.timestamp() + 5):
            with self.subTest(retry_at=retry_at):
                self.assertEqual(self.run_once_with(RateLimited(429, "limit", retry_at)), [60.0])

    def test_a_rate_limit_sleeps_at_most_an_hour(self):
        slept = self.run_once_with(RateLimited(429, "limit", NOW.timestamp() + 86_400))
        self.assertEqual(slept, [3600.0])

    def test_a_stop_signal_ends_a_sleep_within_a_slice(self):
        stop = threading.Event()
        timer = threading.Timer(0.05, stop.set)
        timer.start()
        self.addCleanup(timer.cancel)
        started = datetime.now()
        dispatcher_module._sleep(stop, 60)
        self.assertLess((datetime.now() - started).total_seconds(), 2)


class HousekeepingTest(DispatcherTestCase):
    def collected(self) -> list[Path | None]:
        return [repo for repo, args in self.git.maintenance if args == ("gc", "--quiet")]

    def make_repositories(self) -> None:
        for repository in (self.settings.mirror, self.settings.workrepo):
            repository.mkdir(parents=True)

    def test_repositories_that_do_not_exist_yet_are_not_collected(self):
        self.settings.mirror.mkdir()
        self.dispatcher.housekeeping()
        self.assertEqual(self.collected(), [self.settings.mirror])

    def test_git_is_collected_on_the_first_idle_housekeeping_and_then_daily(self):
        self.make_repositories()
        self.dispatcher.housekeeping()
        self.assertEqual(self.collected(), [self.settings.mirror, self.settings.workrepo])
        self.now = NOW + timedelta(hours=23)
        self.dispatcher.housekeeping()
        self.assertEqual(len(self.collected()), 2)
        self.now = NOW + timedelta(hours=25)
        self.dispatcher.housekeeping()
        self.assertEqual(len(self.collected()), 4)

    def test_git_is_not_collected_while_a_job_is_waiting(self):
        self.dispatcher.tick()
        self.dispatcher.housekeeping()
        self.assertEqual(self.git.maintenance, [])
        self.spool.close(self.only_job(), "done", NOW)
        self.dispatcher.housekeeping()
        self.assertEqual(len(self.collected()), 2)

    def test_a_failed_collection_is_logged_and_ignored(self):
        self.make_repositories()
        with mock.patch.object(self.git, "run_git", side_effect=gitops.GitError("gc", 1)), \
                self.assertLogs("factory.dispatcher", "ERROR") as logged:
            self.dispatcher.housekeeping()
        self.assertEqual(len(logged.records), 2)

    def test_an_operating_system_error_in_housekeeping_is_logged_and_ignored(self):
        self.now = NOW + timedelta(hours=2)
        with mock.patch.object(self.spool, "job_ids", side_effect=OSError("disk")), \
                mock.patch.object(self.spool, "prune", side_effect=OSError("disk")), \
                self.assertLogs("factory.dispatcher", "ERROR") as logged:
            self.dispatcher.housekeeping()
        self.assertEqual([record.getMessage() for record in logged.records],
                         ["pruning the spool failed: OSError", "the idle check failed: OSError"])

    def test_the_spool_is_pruned_hourly(self):
        self.now = NOW + timedelta(minutes=61)
        with mock.patch.object(self.spool, "prune") as prune:
            self.dispatcher.housekeeping()
            self.dispatcher.housekeeping()
        prune.assert_called_once_with("dispatcher", self.now)


if __name__ == "__main__":
    unittest.main()
