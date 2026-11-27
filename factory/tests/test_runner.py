"""Tests for the runner: real git for the clone, a real spool, and a fake that plays Podman and the agent."""

import dataclasses
import io
import json
import logging
import os
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from factory import config as factory_config
from factory import runner
from factory.bundle_check import MEGABYTE
from factory.result import MAX_RESULT_BYTES
from factory.spool import Spool, SpoolError, new_job_id, validate_run
from factory.tests import gitrepo
from factory.tests.gitrepo import Repo

CONFIG = factory_config.load()
NOW = datetime(2026, 11, 27, 10, 0, 0, tzinfo=timezone.utc)
BRANCH = "factory/fix-12"
TOKEN = "token-" + "x" * 20
DIGEST = "sha256:" + "d" * 16
IMAGE = "localhost/factory-agent:1"
APP_TOML = """schema = 1

[toolchain]
python = "3.11"

[commands]
setup = "make setup"
check = "make check"

[quality]
format = "ruff"
lint = "ruff"
types = "mypy"
tests = "pytest"
"""
SERVICE_TOML = """
[[services]]
name = "db"
image = "docker.io/library/postgres:16"
ready = "pg_isready"
memory = "512m"
"""
INIT = '{"type":"system","subtype":"init","model":"claude-opus-5-5"}'
SUCCESS = '{"type":"result","subtype":"success","num_turns":12}'
RESULT = json.dumps({"schema": 1, "outcome": "done"})


@dataclasses.dataclass
class Call:
    argv: list[str]
    env: dict | None
    cwd: Path | None
    timeout: float | None

    @property
    def is_agent(self) -> bool:
        return self.argv[:2] == ["podman", "run"] and "claude" in self.argv


@dataclasses.dataclass
class Container:
    """What a script sees of the container it plays: the mounted directories and the standard output."""

    checkout: Path
    out: Path
    stdout: object
    argv: list[str]

    def commit(self) -> None:
        gitrepo.git("-C", str(self.checkout), "commit", "--allow-empty", "-q", "-m", "agent change")


def mount(argv: list[str], target: str) -> Path:
    return Path(next(word for word in argv if f":{target}" in word).split(f":{target}")[0])


def good_script(container: Container) -> None:
    container.commit()
    (container.out / "result.json").write_text(RESULT, encoding="utf-8")
    container.stdout.write(f"{INIT}\n{SUCCESS}\n".encode())


class FakePodman:
    """Records every program the runner starts; runs real git where the host would and plays the containers."""

    def __init__(self) -> None:
        self.calls: list[Call] = []
        self.agent: Callable[[Container], None] = good_script
        self.image_status = 0
        self.image_label = DIGEST
        self.bundle_runs = 0

    def __call__(self, argv, *, env=None, cwd=None, stdout=None, stderr=None, timeout=None) -> int:
        argv = list(argv)
        self.calls.append(Call(argv, None if env is None else dict(env), cwd, timeout))
        if argv[0] == "git":
            return subprocess.run(argv, env=env, cwd=cwd, capture_output=True, check=False).returncode
        if argv[:3] == ["podman", "image", "inspect"]:
            stdout.write(self.image_label.encode())
            return self.image_status
        if argv[:2] == ["podman", "run"]:
            container = Container(mount(argv, "/workspace"), mount(argv, "/factory/out"), stdout, argv)
            if "claude" in argv:
                self.agent(container)
                return 0
            return self._bundle(container, stderr)
        return 0

    def _bundle(self, container: Container, stderr) -> int:
        self.bundle_runs += 1
        tail = container.argv[container.argv.index("git"):]
        done = subprocess.run(["git", "-C", str(container.checkout), "bundle", "create",
                               str(container.out / "commits.bundle"), tail[-1]], env=gitrepo.environment(),
                              capture_output=True, check=False)
        stderr.write(done.stderr)
        return done.returncode

    @property
    def podman_runs(self) -> list[Call]:
        return [call for call in self.calls if call.argv[:2] == ["podman", "run"]]

    def after_agent(self) -> list[Call]:
        index = next(i for i, call in enumerate(self.calls) if call.is_agent)
        return self.calls[index + 1:]


class RunnerCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        handler = logging.NullHandler()
        runner.log.addHandler(handler)
        self.addCleanup(runner.log.removeHandler, handler)
        self.source = Repo(self.root / "source")
        self.source.commit({"README.md": "# Demo\n", "apps/demo/factory.toml": APP_TOML})
        self.base = self.source.head
        self.mirror_dir = self.root / "mirror"
        self.mirror_dir.mkdir()
        self.source.bare_clone(self.mirror_dir / "repo.git")
        self.work = self.root / "work"
        self.spool = Spool(self.root / "spool")
        self.spool.prepare("dispatcher")
        self.settings = runner.Settings(self.root / "spool", self.mirror_dir, self.work, IMAGE)
        self.fake = FakePodman()
        self.ticks = 0
        patcher = mock.patch.dict(os.environ, {"CLAUDE_CODE_OAUTH_TOKEN": TOKEN})
        patcher.start()
        self.addCleanup(patcher.stop)

    def clock(self) -> datetime:
        self.ticks += 1
        return NOW + timedelta(seconds=self.ticks)

    def runner(self, **changes) -> runner.Runner:
        options = {"run": self.fake, "clock": self.clock, "confined": lambda: True, "digest": lambda: DIGEST}
        return runner.Runner(self.settings, CONFIG, self.spool, **{**options, **changes})

    def request(self, job_id: str, /, **changes) -> dict:
        return {
            "schema": 1, "job_id": job_id, "stage": "fix_issue", "skill": "factory-fix-issue", "app": "demo",
            "branch": BRANCH, "base_sha": self.base, "repository_url": "https://github.com/owner/name.git",
            "model": "opus", "permission_mode": "auto", "timeout_minutes": 90, "max_turns": 300,
            "git_name": "factory-test[bot]", "git_email": "bot@example.com", **changes,
        }

    def submit(self, minutes: int = 0, **changes) -> str:
        job_id = new_job_id("fix_issue", 12, NOW + timedelta(minutes=minutes))
        self.spool.submit(job_id, {
            "request.json": json.dumps(self.request(job_id, **changes)).encode(),
            "job.json": b'{"schema": 1}', "context.md": b"# Issue\n",
        })
        return job_id

    def handle(self, job_id: str | None = None, **changes) -> dict:
        job_id = job_id or self.submit()
        self.assertEqual(self.runner(**changes).run_next(), job_id)
        return self.spool.run_record(job_id)

    def commit_app(self, toml: str) -> None:
        """Change the app's factory.toml in the mirror; later jobs start from the new commit."""
        self.source.commit({"apps/demo/factory.toml": toml})
        self.base = self.source.head
        gitrepo.git("-C", str(self.mirror_dir / "repo.git"), "fetch", "-q", str(self.source.path),
                    "+refs/heads/main:refs/heads/main")

    def delivered(self, job_id: str, name: str) -> Path:
        return self.root / "spool" / "runs" / job_id / name


class RefusalTests(RunnerCase):
    def test_an_unconfined_host_refuses_before_any_container(self):
        job = self.submit()
        self.runner(confined=lambda: False).run_next()
        record = self.spool.run_record(job)
        self.assertEqual((record["status"], record["reason"]), ("refused", "firewall"))
        self.assertEqual(self.fake.podman_runs, [])
        self.assertEqual(self.fake.calls, [])

    def test_a_bad_request_is_refused(self):
        other_job = "20260101T000000Z-fix_issue-1-00000000"
        for minutes, changes in enumerate(({"base_sha": "nope"}, {"job_id": other_job})):
            with self.subTest(changes=changes):
                record = self.handle(self.submit(minutes=minutes, **changes))
                self.assertEqual((record["status"], record["reason"]), ("refused", "request"))
        self.assertEqual(self.fake.podman_runs, [])

    def test_a_missing_request_is_refused(self):
        job = self.submit()
        self.spool.job_file(job, "request.json").unlink()
        self.runner().run_next()
        self.assertEqual(self.spool.run_record(job)["reason"], "request")

    def test_a_stale_or_missing_image_is_refused(self):
        self.fake.image_label = "sha256:other"
        self.assertEqual(self.handle()["reason"], "image")
        self.fake.image_label, self.fake.image_status = DIGEST, 1
        self.assertEqual(self.handle(self.submit(minutes=1))["reason"], "image")
        self.assertEqual(self.fake.podman_runs, [])

    def test_without_a_digest_only_the_image_must_exist(self):
        self.fake.image_label = "anything"
        self.assertEqual(self.handle(digest=None)["status"], "completed")

    def test_the_image_check_asks_podman_for_the_label(self):
        self.handle()
        argv = self.fake.calls[0].argv
        self.assertEqual(argv, ["podman", "image", "inspect", "--format", '{{index .Labels "factory.harness"}}', IMAGE])
        self.assertEqual(self.fake.calls[0].cwd, self.work)

    def test_an_unsupported_toolchain_and_declared_services_are_refused(self):
        cases = (
            ("toolchain", APP_TOML.replace('"3.11"', '"2.7"')),
            ("toolchain", APP_TOML.replace('python = "3.11"', 'ruby = "3"')),
            ("toolchain", "schema = 2\n"),
            ("services", APP_TOML + SERVICE_TOML),
        )
        for minutes, (reason, toml) in enumerate(cases):
            with self.subTest(reason=reason, toml=toml[:30]):
                self.commit_app(toml)
                record = self.handle(self.submit(minutes=minutes))
                self.assertEqual((record["status"], record["reason"]), ("refused", reason))
                self.assertEqual(self.fake.podman_runs, [])

    def test_an_app_that_is_not_in_the_checkout_is_refused(self):
        record = self.handle(self.submit(app="ghost"))
        self.assertEqual((record["status"], record["reason"]), ("refused", "toolchain"))

    def test_a_failed_clone_is_crashed_clone(self):
        record = self.handle(self.submit(base_sha="f" * 40))
        self.assertEqual((record["status"], record["reason"]), ("crashed", "clone"))
        self.assertEqual(self.fake.podman_runs, [])
        self.assertFalse((self.work / record["job_id"]).exists())


class CloneTests(RunnerCase):
    def test_the_clone_uses_only_its_own_git_configuration(self):
        self.handle()
        clone = next(call for call in self.fake.calls if call.argv[:2] == ["git", "clone"])
        self.assertEqual(clone.argv[2:4], ["--no-checkout", "--no-hardlinks"])
        self.assertEqual(clone.argv[4], str(self.mirror_dir / "repo.git"))
        self.assertEqual(clone.env["GIT_CONFIG_NOSYSTEM"], "1")
        self.assertEqual(clone.env["GIT_TERMINAL_PROMPT"], "0")
        self.assertTrue(Path(clone.env["GIT_CONFIG_GLOBAL"]).is_relative_to(self.work))

    def test_the_git_configuration_trusts_the_mirror(self):
        seen = []

        def spy(argv, **kwargs):
            if argv[:2] == ["git", "clone"]:
                seen.append(Path(kwargs["env"]["GIT_CONFIG_GLOBAL"]).read_text(encoding="utf-8"))
            return self.fake(argv, **kwargs)

        self.handle(run=spy)
        self.assertEqual(seen, [f"[safe]\n\tdirectory = {(self.mirror_dir / 'repo.git').as_posix()}\n"])

    def test_the_work_branch_starts_at_the_base_with_the_bots_identity(self):
        seen = {}

        def script(container: Container) -> None:
            def git(*args: str) -> str:
                return gitrepo.git("-C", str(container.checkout), *args)

            seen.update(branch=git("rev-parse", "--abbrev-ref", "HEAD"), head=git("rev-parse", "HEAD"),
                        name=git("config", "user.name"), email=git("config", "user.email"),
                        origin=git("remote", "get-url", "origin"), tracked=git("ls-files", "apps/demo"))

        self.fake.agent = script
        self.handle()
        self.assertEqual(seen, {
            "branch": BRANCH, "head": self.base, "name": "factory-test[bot]", "email": "bot@example.com",
            "origin": "https://github.com/owner/name.git", "tracked": "apps/demo/factory.toml",
        })

    def test_the_agent_sees_the_job_files_but_not_the_request(self):
        seen = {}

        def script(container: Container) -> None:
            job = mount(container.argv, "/factory/job")
            seen["files"] = sorted(path.name for path in job.iterdir())

        self.fake.agent = script
        self.handle()
        self.assertEqual(seen["files"], ["context.md", "job.json"])


class AgentRunTests(RunnerCase):
    def test_a_good_run_hands_back_the_result_and_the_bundle(self):
        job = self.submit()
        self.runner().run_next()
        record = self.spool.run_record(job)
        self.assertEqual((record["status"], record["reason"], record["model"], record["turns"], record["resets_at"]),
                         ("completed", None, "claude-opus-5-5", 12, None))
        self.assertEqual(self.delivered(job, "result.json").read_text(encoding="utf-8"), RESULT)
        heads = gitrepo.git("bundle", "list-heads", str(self.delivered(job, "commits.bundle")))
        self.assertIn(f"refs/heads/{BRANCH}", heads)
        self.assertEqual(validate_run(record), [])

    def test_the_workspace_and_staging_are_removed_but_the_transcript_stays(self):
        job = self.submit()
        self.runner().run_next()
        self.assertFalse((self.work / job).exists())
        self.assertFalse((self.work / "staging" / job).exists())
        transcript = self.work / "transcripts" / f"{job}.jsonl"
        self.assertEqual(transcript.read_text(encoding="utf-8"), f"{INIT}\n{SUCCESS}\n")
        self.assertTrue((self.work / "transcripts" / f"{job}.err").exists())

    @unittest.skipUnless(os.name == "posix", "file modes are only honoured on POSIX")
    def test_the_transcript_is_private(self):
        job = self.submit()
        self.runner().run_next()
        mode = stat.S_IMODE((self.work / "transcripts" / f"{job}.jsonl").stat().st_mode)
        self.assertEqual(mode, 0o600)

    def test_the_agent_container_runs_with_the_requests_values_in_the_work_directory(self):
        job = self.submit(timeout_minutes=7)
        self.runner().run_next()
        call = next(call for call in self.fake.calls if call.is_agent)
        self.assertEqual(call.timeout, 7 * 60)
        self.assertEqual(call.cwd, self.work)
        self.assertEqual(call.argv[5], f"factory-{job}")
        self.assertEqual(call.argv[call.argv.index(IMAGE) + 1:][:3], ["claude", "-p", "/factory-fix-issue"])

    def test_the_token_is_in_no_argv_and_the_environment_is_the_runners_own(self):
        job = self.submit()
        self.runner().run_next()
        self.assertTrue(self.fake.calls)
        for call in self.fake.calls:
            self.assertFalse(any(TOKEN in word for word in call.argv))
            if call.argv[0] == "podman":
                self.assertIsNone(call.env)  # the runner's own environment, so Podman can copy the token by name
            else:
                self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", call.env)
        record_text = self.delivered(job, "run.json").read_text(encoding="utf-8")
        self.assertNotIn(TOKEN, record_text)

    def test_a_timeout_kills_the_container_and_reports_timeout(self):
        def script(container: Container) -> None:
            raise subprocess.TimeoutExpired(container.argv, 1)

        self.fake.agent = script
        job = self.submit()
        self.runner().run_next()
        self.assertEqual(self.spool.run_record(job)["status"], "timeout")
        tail = [call.argv for call in self.fake.after_agent()]
        self.assertEqual(tail, [["podman", "kill", f"factory-{job}"], ["podman", "rm", "-f", f"factory-{job}"]])
        self.assertFalse(self.delivered(job, "result.json").exists())

    def test_a_failing_kill_does_not_stop_the_run_from_being_recorded(self):
        def failing(argv, **kwargs):
            if argv[:2] == ["podman", "kill"]:
                raise subprocess.TimeoutExpired(argv, 1)
            return self.fake(argv, **kwargs)

        def script(container: Container) -> None:
            raise subprocess.TimeoutExpired(container.argv, 1)

        self.fake.agent = script
        job = self.submit()
        with self.assertLogs("factory.runner", level="ERROR"):
            self.runner(run=failing).run_next()
        self.assertEqual(self.spool.run_record(job)["status"], "timeout")

    def test_a_limited_run_without_a_result_reports_usage_limit(self):
        limited = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1795863600}}'
        self.fake.agent = lambda container: container.stdout.write(f"{INIT}\n{limited}\n".encode())
        record = self.handle()
        self.assertEqual((record["status"], record["reason"], record["resets_at"]), ("usage_limit", None, 1795863600))
        self.assertEqual(self.fake.bundle_runs, 0)

    def test_a_limited_run_that_wrote_a_result_is_completed(self):
        limited = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1795863600}}'

        def script(container: Container) -> None:
            good_script(container)
            container.stdout.write(f"{limited}\n".encode())

        self.fake.agent = script
        record = self.handle()
        self.assertEqual((record["status"], record["resets_at"]), ("completed", None))

    def test_a_turn_limit_reports_crashed_max_turns(self):
        line = '{"type":"result","subtype":"error_max_turns","num_turns":300}'
        self.fake.agent = lambda container: container.stdout.write(f"{INIT}\n{line}\n".encode())
        record = self.handle()
        self.assertEqual((record["status"], record["reason"], record["turns"]), ("crashed", "max_turns", 300))

    def test_a_run_without_a_result_is_an_agent_error(self):
        self.fake.agent = lambda container: container.stdout.write(f"{INIT}\n".encode())
        record = self.handle()
        self.assertEqual((record["status"], record["reason"]), ("crashed", "agent_error"))
        self.assertEqual(record["model"], "claude-opus-5-5")

    def test_an_oversized_or_odd_result_counts_as_missing(self):
        def oversized(container: Container) -> None:
            (container.out / "result.json").write_bytes(b"x" * (MAX_RESULT_BYTES + 1))

        def not_a_file(container: Container) -> None:
            (container.out / "result.json").mkdir()

        for minutes, script in enumerate((oversized, not_a_file)):
            self.fake.agent = script
            record = self.handle(self.submit(minutes=minutes))
            self.assertEqual((record["status"], record["reason"]), ("crashed", "agent_error"))

    @unittest.skipUnless(hasattr(os, "symlink") and os.name == "posix", "needs symbolic links")
    def test_a_result_that_is_a_link_is_left_out(self):
        target = self.root / "elsewhere.json"
        target.write_text(RESULT, encoding="utf-8")

        def script(container: Container) -> None:
            (container.out / "result.json").symlink_to(target)

        self.fake.agent = script
        self.assertEqual(self.handle()["reason"], "agent_error")

    def test_a_run_without_commits_is_completed_without_a_bundle(self):
        def script(container: Container) -> None:
            (container.out / "result.json").write_text(RESULT, encoding="utf-8")
            container.stdout.write(f"{INIT}\n{SUCCESS}\n".encode())

        self.fake.agent = script
        job = self.submit()
        self.runner().run_next()
        self.assertEqual(self.spool.run_record(job)["status"], "completed")
        self.assertTrue(self.delivered(job, "result.json").exists())
        self.assertFalse(self.delivered(job, "commits.bundle").exists())

    def test_a_bundle_the_agent_planted_is_not_handed_over(self):
        def script(container: Container) -> None:
            (container.out / "result.json").write_text(RESULT, encoding="utf-8")
            (container.out / "commits.bundle").write_bytes(b"planted")

        self.fake.agent = script
        job = self.submit()
        self.runner().run_next()
        self.assertFalse(self.delivered(job, "commits.bundle").exists())

    def test_an_oversized_bundle_is_left_out(self):
        small = dataclasses.replace(CONFIG, dispatcher=dataclasses.replace(CONFIG.dispatcher, max_bundle_megabytes=1))

        def script(container: Container) -> None:
            good_script(container)
            blob = os.urandom(MEGABYTE + 4096)
            (container.checkout / "big.bin").write_bytes(blob)
            gitrepo.git("-C", str(container.checkout), "add", "big.bin")
            gitrepo.git("-C", str(container.checkout), "commit", "-q", "-m", "big")

        self.fake.agent = script
        job = self.submit()
        runner.Runner(self.settings, small, self.spool, run=self.fake, clock=self.clock, confined=lambda: True,
                      digest=None).run_next()
        self.assertEqual(self.spool.run_record(job)["status"], "completed")
        self.assertFalse(self.delivered(job, "commits.bundle").exists())

    def test_a_failing_bundle_is_an_internal_crash(self):
        def failing(argv, **kwargs):
            if argv[:2] == ["podman", "run"] and "claude" not in argv:
                kwargs["stderr"].write(b"fatal: Invalid revision range")
                return 128
            return self.fake(argv, **kwargs)

        record = self.handle(run=failing)
        self.assertEqual((record["status"], record["reason"]), ("crashed", "internal"))

    def test_the_bundle_container_runs_with_a_timeout_and_its_own_name(self):
        job = self.submit()
        self.runner().run_next()
        bundle = next(call for call in self.fake.podman_runs if not call.is_agent)
        self.assertIn(f"factory-{job}-bundle", bundle.argv)
        self.assertIn("--network=none", bundle.argv)
        self.assertIsNotNone(bundle.timeout)

    def test_a_timed_out_bundle_is_an_internal_crash_and_its_container_is_removed(self):
        def slow(argv, **kwargs):
            if argv[:2] == ["podman", "run"] and "claude" not in argv:
                raise subprocess.TimeoutExpired(argv, 1)
            return self.fake(argv, **kwargs)

        job = self.submit()
        self.runner(run=slow).run_next()
        self.assertEqual(self.spool.run_record(job)["reason"], "internal")
        self.assertIn(["podman", "rm", "-f", f"factory-{job}-bundle"], [call.argv for call in self.fake.calls])

    def test_no_host_command_runs_in_the_checkout_after_the_agent(self):
        self.handle()
        after = self.fake.after_agent()
        self.assertTrue(after)
        self.assertTrue(all(call.argv[0] == "podman" for call in after), [call.argv[:2] for call in after])

    def test_a_model_name_that_does_not_fit_the_record_is_replaced(self):
        def script(container: Container) -> None:
            good_script(container)
            container.stdout.write(b'{"type":"system","subtype":"init","model":"bad model!"}\n')

        self.fake.agent = script
        record = self.handle()
        self.assertEqual((record["status"], record["model"]), ("completed", ""))

    def test_a_turn_count_that_does_not_fit_the_record_is_replaced(self):
        def script(container: Container) -> None:
            good_script(container)
            container.stdout.write(b'{"type":"result","subtype":"success","num_turns":99999999}\n')

        self.fake.agent = script
        record = self.handle()
        self.assertEqual((record["status"], record["turns"]), ("completed", None))


class FailureTests(RunnerCase):
    def test_an_unexpected_exception_still_ends_in_one_crashed_record(self):
        def boom(container: Container) -> None:
            raise RuntimeError("boom " + TOKEN)

        self.fake.agent = boom
        job = self.submit()
        with self.assertLogs("factory.runner", level="ERROR") as logs:
            self.runner().run_next()
        record = self.spool.run_record(job)
        self.assertEqual((record["status"], record["reason"]), ("crashed", "internal"))
        self.assertFalse((self.work / job).exists())
        self.assertNotIn(TOKEN, "\n".join(logs.output))

    def test_a_failed_publication_of_the_files_falls_back_to_a_bare_crashed_record(self):
        spool = self.spool
        real = spool.finish
        calls = []

        def finish(job_id, run, files):
            calls.append(dict(files))
            if len(calls) == 1:
                raise SpoolError("disk full")
            real(job_id, run, files)

        job = self.submit()
        with mock.patch.object(spool, "finish", finish), self.assertLogs("factory.runner", level="ERROR"):
            self.runner().run_next()
        record = spool.run_record(job)
        self.assertEqual((record["status"], record["reason"]), ("crashed", "internal"))
        self.assertEqual(calls[1], {})
        self.assertFalse((self.work / job).exists())

    def test_when_no_record_can_be_written_the_runner_goes_on(self):
        job = self.submit()
        with mock.patch.object(self.spool, "finish", side_effect=SpoolError("gone")), \
                self.assertLogs("factory.runner", level="ERROR") as logs:
            self.assertEqual(self.runner().run_next(), job)
        self.assertEqual(len(logs.records), 2)
        self.assertFalse((self.work / job).exists())

    def test_a_workspace_that_cannot_be_removed_is_logged_not_raised(self):
        job = self.submit()
        with mock.patch.object(runner, "remove_tree", side_effect=OSError("busy")), \
                self.assertLogs("factory.runner", level="ERROR"):
            self.runner().run_next()
        self.assertEqual(self.spool.run_record(job)["status"], "completed")


class QueueTests(RunnerCase):
    def test_no_job_means_none(self):
        self.assertIsNone(self.runner().run_next())

    def test_the_oldest_queued_job_goes_first(self):
        newer, older = self.submit(minutes=5), self.submit(minutes=1)
        self.assertEqual(self.runner().run_next(), older)
        self.assertEqual(self.spool.state(older), "finished")
        self.assertEqual(self.spool.state(newer), "queued")

    def test_a_job_another_runner_claimed_is_skipped(self):
        taken, free = self.submit(minutes=1), self.submit(minutes=2)
        self.spool.claim(taken, NOW)
        self.assertEqual(self.runner().run_next(), free)
        self.assertEqual(self.spool.state(taken), "running")

    def test_a_lost_claim_race_returns_none(self):
        self.submit()
        with mock.patch.object(self.spool, "claim", return_value=False):
            self.assertIsNone(self.runner().run_next())
        self.assertEqual(self.fake.calls, [])

    def test_recover_finishes_jobs_left_running(self):
        stuck, queued = self.submit(minutes=1), self.submit(minutes=2)
        self.spool.claim(stuck, NOW)
        leftover = self.work / stuck / "checkout" / "objects"
        leftover.mkdir(parents=True)
        (leftover / "pack").write_text("x", encoding="utf-8")
        os.chmod(leftover / "pack", stat.S_IREAD)
        self.assertEqual(self.runner().recover(), [stuck])
        record = self.spool.run_record(stuck)
        self.assertEqual((record["status"], record["reason"]), ("crashed", "internal"))
        self.assertEqual(self.spool.state(queued), "queued")
        self.assertFalse((self.work / stuck).exists())

    def test_old_transcripts_are_deleted_at_start_up(self):
        directory = self.work / "transcripts"
        directory.mkdir(parents=True)
        old, fresh = directory / "old.jsonl", directory / "fresh.jsonl"
        for path in (old, fresh):
            path.write_text("{}\n", encoding="utf-8")
        stale = (NOW - timedelta(days=15)).timestamp()
        os.utime(old, (stale, stale))
        recent = (NOW - timedelta(days=13)).timestamp()
        os.utime(fresh, (recent, recent))
        self.assertEqual(self.runner(clock=lambda: NOW).prune_transcripts(), ["old.jsonl"])
        self.assertEqual([path.name for path in directory.iterdir()], ["fresh.jsonl"])

    def test_pruning_without_a_transcript_directory_does_nothing(self):
        self.assertEqual(self.runner().prune_transcripts(), [])


class SettingsTests(unittest.TestCase):
    def absolute(self, name: str) -> str:
        return str(Path(tempfile.gettempdir()) / name)

    def env(self, **changes) -> dict:
        base = {"FACTORY_SPOOL_DIR": self.absolute("s"), "FACTORY_MIRROR_DIR": self.absolute("m"),
                "FACTORY_WORK_DIR": self.absolute("w"), "FACTORY_IMAGE": IMAGE, "CLAUDE_CODE_OAUTH_TOKEN": TOKEN}
        return {**base, **changes}

    def test_the_settings_come_from_the_environment_without_the_token(self):
        settings = runner.settings_from_env(self.env())
        self.assertEqual(settings, runner.Settings(Path(self.absolute("s")), Path(self.absolute("m")),
                                                   Path(self.absolute("w")), IMAGE))
        self.assertNotIn(TOKEN, repr(settings))
        self.assertEqual(settings.mirror, Path(self.absolute("m")) / "repo.git")

    def test_every_problem_is_reported_at_once_and_no_value_is_echoed(self):
        env = self.env(FACTORY_SPOOL_DIR="relative-secret", FACTORY_IMAGE="--bad image")
        del env["FACTORY_WORK_DIR"]
        env["CLAUDE_CODE_OAUTH_TOKEN"] = ""
        with self.assertRaises(runner.SettingsError) as raised:
            runner.settings_from_env(env)
        message = str(raised.exception)
        for name in ("FACTORY_SPOOL_DIR", "FACTORY_WORK_DIR", "FACTORY_IMAGE", "CLAUDE_CODE_OAUTH_TOKEN"):
            self.assertIn(name, message)
        self.assertNotIn("relative-secret", message)
        self.assertNotIn("bad image", message)

    def test_a_missing_token_is_a_problem(self):
        env = self.env()
        del env["CLAUDE_CODE_OAUTH_TOKEN"]
        with self.assertRaisesRegex(runner.SettingsError, "CLAUDE_CODE_OAUTH_TOKEN is missing"):
            runner.settings_from_env(env)


class ConfinementTests(unittest.TestCase):
    def test_a_host_that_accepts_the_connection_is_not_confined(self):
        self.assertFalse(runner.confined())

    def test_a_host_that_refuses_the_connection_is_confined(self):
        with mock.patch.object(socket.socket, "connect", side_effect=ConnectionRefusedError):
            self.assertTrue(runner.confined())

    def test_both_sockets_are_closed(self):
        made = []
        real = socket.socket

        class Spy(real):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                made.append(self)

        with mock.patch.object(socket, "socket", Spy):
            runner.confined()
        self.assertEqual(len(made), 2)
        self.assertTrue(all(sock.fileno() == -1 for sock in made))


class FileHelperTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def test_transcript_lines_skip_an_overlong_line_and_keep_the_rest(self):
        path = self.root / "t.jsonl"
        long_line = "x" * (runner.MAX_TRANSCRIPT_LINE + 1)
        edge = "y" * runner.MAX_TRANSCRIPT_LINE
        path.write_text(f"first\n{long_line}\n{edge}\n{long_line}", encoding="utf-8")
        self.assertEqual(list(runner.transcript_lines(path)), ["first", edge])

    def test_transcript_lines_keep_a_last_line_without_a_newline(self):
        path = self.root / "t.jsonl"
        path.write_text("a\nb", encoding="utf-8")
        self.assertEqual(list(runner.transcript_lines(path)), ["a", "b"])

    def test_remove_tree_removes_read_only_files(self):
        objects = self.root / "w" / "objects" / "ab"
        objects.mkdir(parents=True)
        (objects / "cd").write_text("x", encoding="utf-8")
        os.chmod(objects / "cd", stat.S_IREAD)
        runner.remove_tree(self.root / "w")
        self.assertFalse((self.root / "w").exists())

    def test_remove_tree_of_nothing_is_fine(self):
        runner.remove_tree(self.root / "missing")


class ProgramTests(RunnerCase):
    def test_check_reports_each_condition_on_its_own_line(self):
        ok, lines = runner.check(self.runner(), self.spool)
        self.assertTrue(ok)
        self.assertEqual(lines, ["confinement: ok", "image: ok", "spool: ok"])

    def test_check_fails_when_any_condition_fails(self):
        self.fake.image_status = 1
        ok, lines = runner.check(self.runner(confined=lambda: False), Spool(self.root / "nowhere"))
        self.assertFalse(ok)
        self.assertEqual([line.split(":")[0] for line in lines], ["confinement", "image", "spool"])
        self.assertFalse(any(line.endswith(": ok") for line in lines))

    def test_serve_handles_jobs_until_stopped_and_once_handles_one(self):
        first, second = self.submit(minutes=1), self.submit(minutes=2)
        runner.serve(self.runner(), threading.Event(), once=True)
        self.assertEqual((self.spool.state(first), self.spool.state(second)), ("finished", "queued"))
        stop = threading.Event()
        instance = self.runner()
        real = instance.run_next

        def run_next():
            handled = real()
            if handled is None:
                stop.set()
            return handled

        instance.run_next = run_next
        with mock.patch.object(runner, "IDLE_SECONDS", 0.0):
            runner.serve(instance, stop)
        self.assertEqual(self.spool.state(second), "finished")

    def test_serve_survives_a_failing_poll(self):
        stop = threading.Event()
        instance = self.runner()

        def broken():
            stop.set()
            raise SpoolError("unreadable")

        instance.run_next = broken
        with self.assertLogs("factory.runner", level="ERROR"):
            runner.serve(instance, stop)

    def test_a_stop_signal_ends_the_idle_wait(self):
        stop = threading.Event()
        stop.set()
        runner._sleep(stop, 60.0)

    def test_main_reports_bad_settings_without_echoing_them(self):
        env = {"FACTORY_SPOOL_DIR": "relative-secret"}
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(logging, "basicConfig"),                 self.assertLogs("factory.runner", level="ERROR") as logs:
            self.assertEqual(runner.main([]), 2)
        self.assertNotIn("relative-secret", "\n".join(logs.output))

    def test_main_check_prints_one_line_each_and_exits_by_the_result(self):
        env = {"FACTORY_SPOOL_DIR": str(self.root / "spool"), "FACTORY_MIRROR_DIR": str(self.mirror_dir),
               "FACTORY_WORK_DIR": str(self.work), "FACTORY_IMAGE": IMAGE, "CLAUDE_CODE_OAUTH_TOKEN": TOKEN}
        for expected, confinement in ((0, True), (1, False)):
            instance = self.runner(confined=lambda: confinement)
            output = io.StringIO()
            with mock.patch.dict(os.environ, env, clear=True), mock.patch("sys.stdout", output),                     mock.patch.object(logging, "basicConfig"), mock.patch.object(runner, "Runner", lambda *_: instance):
                self.assertEqual(runner.main(["--check"]), expected)
            self.assertEqual(len(output.getvalue().splitlines()), 3)


    def test_main_recovers_jobs_left_running_and_then_handles_one_job(self):
        stuck, queued = self.submit(minutes=1), self.submit(minutes=2)
        self.spool.claim(stuck, NOW)
        env = {"FACTORY_SPOOL_DIR": str(self.root / "spool"), "FACTORY_MIRROR_DIR": str(self.mirror_dir),
               "FACTORY_WORK_DIR": str(self.work), "FACTORY_IMAGE": IMAGE, "CLAUDE_CODE_OAUTH_TOKEN": TOKEN}
        instance = self.runner()
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(logging, "basicConfig"),                 mock.patch.object(runner, "Runner", lambda *_: instance),                 self.assertLogs("factory.runner", level="WARNING"):
            self.assertEqual(runner.main(["--once"]), 0)
        self.assertEqual(self.spool.run_record(stuck)["reason"], "internal")
        self.assertEqual(self.spool.state(queued), "finished")

    def test_main_stops_when_the_spool_is_not_ready(self):
        env = {"FACTORY_SPOOL_DIR": str(self.root / "nowhere"), "FACTORY_MIRROR_DIR": str(self.mirror_dir),
               "FACTORY_WORK_DIR": str(self.work), "FACTORY_IMAGE": IMAGE, "CLAUDE_CODE_OAUTH_TOKEN": TOKEN}
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(logging, "basicConfig"),                 self.assertLogs("factory.runner", level="ERROR"):
            self.assertEqual(runner.main(["--once"]), 1)


class RunProgramTests(unittest.TestCase):
    def test_the_exit_status_is_returned_and_output_goes_to_the_given_files(self):
        with tempfile.TemporaryFile() as out:
            status = runner.run_program([sys.executable, "-c", "import sys; print('hi'); sys.exit(3)"], stdout=out,
                                        timeout=60)
            out.seek(0)
            self.assertEqual((status, out.read().strip()), (3, b"hi"))

    def test_a_program_that_outlives_its_timeout_raises(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            runner.run_program([sys.executable, "-c", "import time; time.sleep(30)"], timeout=0.5)


if __name__ == "__main__":
    unittest.main()
