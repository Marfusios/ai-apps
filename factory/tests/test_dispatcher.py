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
from factory.decide import CloseJob, PostNotice, PublishRun, SetStatus, StartJob
from factory.dispatcher import Dispatcher, Settings, SettingsError, job_views, settings_from_env
from factory.github_api import GitHubError, RateLimited
from factory.publish import Publisher
from factory.snapshot import Bot
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

    def test_an_action_that_fails_ends_the_tick(self):
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

    def test_a_notice_is_posted_for_an_issue_nobody_trusts(self):
        issues = key(f"{self.github.repo}/issues", {"state": "open", "labels": "factory:fix", "per_page": "100"})
        self.github.answers[issues][0]["user"] = {"login": "stranger"}
        actions = self.dispatcher.tick()
        self.assertIn(PostNotice(12, "untrusted-author"), actions)
        self.assertEqual(len(self.calls_to("POST", self.comments)), 1)


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
        with mock.patch.dict(os.environ, valid_env(self.tmp)), \
                mock.patch.object(dispatcher_module, "build_dispatcher", return_value=self.dispatcher), \
                self.quiet_logging():
            return dispatcher_module.main(list(argv))

    def test_once_returns_zero_after_a_clean_tick(self):
        self.assertEqual(self.run_main("--once"), 0)
        self.assertEqual(len(self.spool.job_ids()), 1)

    def test_once_returns_one_when_the_tick_raised(self):
        self.github.fail.add(f"{self.github.repo}/issues")
        with self.assertLogs("factory.dispatcher", "ERROR"):
            self.assertEqual(self.run_main("--once"), 1)


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

    def test_git_is_collected_on_the_first_idle_housekeeping_and_then_daily(self):
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
                         ["pruning the spool failed: OSError", "git maintenance failed: OSError"])

    def test_the_spool_is_pruned_hourly(self):
        self.now = NOW + timedelta(minutes=61)
        with mock.patch.object(self.spool, "prune") as prune:
            self.dispatcher.housekeeping()
            self.dispatcher.housekeeping()
        prune.assert_called_once_with("dispatcher", self.now)


if __name__ == "__main__":
    unittest.main()
