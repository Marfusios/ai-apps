"""Tests for the finish check hook: when a factory run may end its turn."""

import contextlib
import io
import json
import os
import tempfile
import shutil
import subprocess
import sys
import time
import unittest
from collections.abc import Sequence
from pathlib import Path
from unittest import mock

from factory.tests.hookload import load_hook

finish_check = load_hook("finish_check")

BASE = "0123abc"
FACTORY_TOML = """schema = 1
[commands]
setup = "true"
check = "true"
{quick}
[quality]
format = "ruff"
lint = "ruff"
types = "mypy"
tests = "pytest"
"""
QUICK_LINE = 'quick = "make quick"'
DIFF_ARGV = ("git", "-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", f"{BASE}...HEAD")


class Clock:
    """A clock the tests move by hand."""

    def __init__(self) -> None:
        self.seconds = 0.0

    def __call__(self) -> float:
        return self.seconds


class FakeRun:
    """Stands in for the subprocess runner: answers each command from a table and records the calls."""

    def __init__(self, status: str = "", count: str = "1", diff: str = "apps/x/a.ts\n",
                 checker: tuple[int, str] = (0, ""), quick: tuple[int, str] = (0, ""),
                 ancestor: tuple[int, str] = (0, "")):
        self.answers = {
            ("git", "status", "--porcelain"): (0, status),
            ("git", "merge-base", "--is-ancestor", BASE, "HEAD"): ancestor,
            ("git", "rev-list", "--count", f"{BASE}..HEAD"): (0, count),
            DIFF_ARGV: (0, diff),
            ("checker",): checker,
            ("sh", "-c", "make quick"): quick,
        }
        self.calls: list[tuple[tuple[str, ...], Path, int]] = []

    def __call__(self, argv: Sequence[str], cwd: Path, timeout: int) -> tuple[int, str]:
        key = ("checker",) if argv[-1].endswith("check_repo.py") else tuple(argv)
        self.calls.append((tuple(argv), cwd, timeout))
        return self.answers[key]

    def commands(self) -> list[tuple[str, ...]]:
        return [call[0] for call in self.calls]


class SlowRun(FakeRun):
    """A FakeRun whose commands advance a Clock by a fixed number of seconds each."""

    def __init__(self, clock: Clock, step: float, **kwargs):
        super().__init__(**kwargs)
        self.clock, self.step = clock, step

    def __call__(self, argv: Sequence[str], cwd: Path, timeout: int) -> tuple[int, str]:
        result = super().__call__(argv, cwd, timeout)
        self.clock.seconds += self.step
        return result


class EvaluateTests(unittest.TestCase):
    def setUp(self) -> None:
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.root = Path(holder.name)
        self.repo = self.root / "repo"
        (self.repo / "apps" / "x").mkdir(parents=True)
        self.result_path = self.root / "result.json"

    def write_app(self, quick: bool = True, name: str = "x") -> None:
        app = self.repo / "apps" / name
        app.mkdir(parents=True, exist_ok=True)
        (app / "factory.toml").write_text(FACTORY_TOML.format(quick=QUICK_LINE if quick else ""), encoding="utf-8")

    def write_result(self, outcome: str = "done", stage: str = "step") -> None:
        data: dict = {"schema": 1, "outcome": outcome, "summary": "Did the work."}
        if outcome == "done":
            data["verification"] = [{"command": "make quick", "exit_code": 0, "summary": "passed"}]
            if stage not in ("revise", "fix"):
                data["pull_request"] = {"title": "Add x", "body": "Adds x."}
        elif outcome == "needs_input":
            data["questions"] = ["Which one?"]
        else:
            data["failure_reason"] = "Could not build it."
        self.result_path.write_text(json.dumps(data), encoding="utf-8")

    def env(self, stage: str = "step", **extra: str) -> dict[str, str]:
        env = {"FACTORY_RUN": "1", "FACTORY_STAGE": stage, "FACTORY_RESULT_PATH": str(self.result_path),
               "FACTORY_BASE_SHA": BASE}
        env.update(extra)
        return env

    def evaluate(self, run: FakeRun, stage: str = "step", **extra: str) -> list[str]:
        return finish_check.evaluate(self.env(stage, **extra), self.repo, run)

    def test_interactive_session_is_never_blocked(self) -> None:
        run = FakeRun()
        self.assertEqual(finish_check.evaluate({}, self.repo, run), [])
        self.assertEqual(finish_check.evaluate({"FACTORY_RUN": "0"}, self.repo, run), [])
        self.assertEqual(run.calls, [])

    def test_missing_environment_variables_are_named(self) -> None:
        run = FakeRun()
        problems = finish_check.evaluate({"FACTORY_RUN": "1", "FACTORY_STAGE": "step"}, self.repo, run)
        self.assertEqual(len(problems), 2)
        self.assertIn("FACTORY_RESULT_PATH", problems[0])
        self.assertIn("FACTORY_BASE_SHA", problems[1])
        self.assertEqual(run.calls, [])

    def test_missing_result_file_blocks(self) -> None:
        run = FakeRun()
        problems = self.evaluate(run)
        self.assertEqual(problems, ["No result file yet. Write it at the path in FACTORY_RESULT_PATH, "
                                    "in the shape factory/AGENT_CONTRACT.md describes."])
        self.assertEqual(run.calls, [])

    def test_unreadable_result_file_is_named_by_error_type_without_the_path(self) -> None:
        self.result_path.mkdir()  # a directory cannot be read as a file, whatever the platform says about it
        run = FakeRun()
        problems = self.evaluate(run)
        self.assertEqual(len(problems), 1)
        self.assertRegex(problems[0], r"^The result file cannot be read \(\w+\)\.$")
        self.assertNotIn(str(self.result_path), problems[0])
        self.assertEqual(run.calls, [])

    def test_invalid_result_blocks_with_its_problems_only(self) -> None:
        self.result_path.write_text(json.dumps({"schema": 2, "outcome": "done"}), encoding="utf-8")
        run = FakeRun()
        problems = self.evaluate(run)
        self.assertTrue(any("schema: must be 1" in p for p in problems))
        self.assertTrue(any("summary" in p for p in problems))
        self.assertEqual(run.calls, [])

    def test_needs_input_skips_repository_checks(self) -> None:
        for outcome in ("needs_input", "failed"):
            with self.subTest(outcome=outcome):
                self.write_result(outcome)
                run = FakeRun(status=" M apps/x/a.ts\n")
                self.assertEqual(self.evaluate(run), [])
                self.assertEqual(run.calls, [])

    def test_done_and_clean_is_allowed(self) -> None:
        self.write_result()
        self.write_app()
        run = FakeRun()
        self.assertEqual(self.evaluate(run), [])
        quick_call = [call for call in run.calls if call[0] == ("sh", "-c", "make quick")]
        self.assertEqual(quick_call, [(("sh", "-c", "make quick"), self.repo / "apps" / "x", 600)])

    def test_done_with_uncommitted_work_blocks(self) -> None:
        self.write_result()
        self.write_app()
        problems = self.evaluate(FakeRun(status=" M apps/x/a.ts\n"))
        self.assertEqual(len(problems), 1)
        self.assertIn("uncommitted", problems[0])
        self.assertIn("apps/x/a.ts", problems[0])

    def test_done_step_without_commits_blocks_but_revise_does_not(self) -> None:
        self.write_app()
        self.write_result(stage="step")
        problems = self.evaluate(FakeRun(count="0"), stage="step")
        self.assertEqual(len(problems), 1)
        self.assertIn("no commits", problems[0])
        self.write_result(stage="revise")
        run = FakeRun(count="0")
        self.assertEqual(self.evaluate(run, stage="revise"), [])
        self.assertNotIn(("git", "rev-list", "--count", f"{BASE}..HEAD"), run.commands())
        self.write_result(stage="fix")
        self.assertEqual(self.evaluate(FakeRun(count="0"), stage="fix"), [])

    def test_done_touching_a_protected_path_blocks(self) -> None:
        self.write_result()
        self.write_app()
        problems = self.evaluate(FakeRun(diff="apps/x/a.ts\nAGENTS.md\n"))
        self.assertEqual(len(problems), 1)
        self.assertIn("AGENTS.md", problems[0])
        self.assertIn("may not write", problems[0])

    def test_a_protected_file_moved_into_an_app_is_still_refused(self) -> None:
        # with renames detected git would list only the new name; the command asks for both
        self.write_result()
        self.write_app()
        run = FakeRun(diff="AGENTS.md\napps/x/notes.md\n")
        problems = self.evaluate(run)
        self.assertEqual(len(problems), 1)
        self.assertIn("AGENTS.md", problems[0])
        self.assertIn("may not write", problems[0])
        self.assertIn(DIFF_ARGV, run.commands())

    def test_failing_repository_checker_blocks(self) -> None:
        self.write_result()
        self.write_app()
        problems = self.evaluate(FakeRun(checker=(1, "secret found in apps/x/a.ts")))
        self.assertEqual(len(problems), 1)
        self.assertIn("scripts/check_repo.py", problems[0])
        self.assertIn("secret found", problems[0])

    def test_failing_quick_command_blocks_with_output_tail(self) -> None:
        self.write_result()
        self.write_app()
        output = "\n".join(f"line {n}" for n in range(1, 61))
        problems = self.evaluate(FakeRun(quick=(2, output)))
        self.assertEqual(len(problems), 1)
        self.assertIn("apps/x", problems[0])
        self.assertIn("line 60", problems[0])
        self.assertIn("line 21", problems[0])
        self.assertNotIn("line 20\n", problems[0] + "\n")

    def test_app_without_quick_command_is_not_run(self) -> None:
        self.write_result()
        self.write_app(quick=False)
        run = FakeRun()
        self.assertEqual(self.evaluate(run), [])
        self.assertNotIn(("sh", "-c", "make quick"), run.commands())

    def test_quick_command_timeout_is_a_problem_not_a_crash(self) -> None:
        self.write_result()
        self.write_app()
        problems = self.evaluate(FakeRun(quick=(124, "timed out after 600 seconds")), FACTORY_QUICK_TIMEOUT="600")
        self.assertEqual(len(problems), 1)
        self.assertIn("timed out after 600 seconds", problems[0])

    def test_quick_timeout_comes_from_the_environment_or_defaults(self) -> None:
        self.write_result()
        self.write_app()
        for value, expected in (("30", 30), ("abc", 600), ("0", 600), ("-5", 600), ("", 600), ("nan", 600), ("inf", 600)):
            with self.subTest(value=value):
                run = FakeRun()
                self.evaluate(run, FACTORY_QUICK_TIMEOUT=value)
                timeouts = [call[2] for call in run.calls if call[0][0] == "sh"]
                self.assertEqual(timeouts, [expected])

    def test_app_whose_factory_toml_does_not_load_blocks(self) -> None:
        self.write_result()
        (self.repo / "apps" / "x" / "factory.toml").write_text("schema = 2\n", encoding="utf-8")
        problems = self.evaluate(FakeRun())
        self.assertEqual(len(problems), 1)
        self.assertIn("apps/x/factory.toml", problems[0])
        self.assertIn("schema: must be 1", problems[0])

    def test_deleted_app_directory_is_skipped(self) -> None:
        self.write_result()
        run = FakeRun(diff="apps/gone/a.ts\n")
        self.assertEqual(self.evaluate(run), [])

    def test_apps_are_processed_in_sorted_order(self) -> None:
        self.write_result()
        self.write_app(name="b")
        self.write_app(name="a")
        problems = self.evaluate(FakeRun(diff="apps/b/x\napps/a/y\napps/a/z\n", quick=(1, "boom")))
        self.assertEqual(len(problems), 2)
        self.assertIn("apps/a", problems[0])
        self.assertIn("apps/b", problems[1])

    def test_failing_git_command_is_a_problem_carrying_its_output(self) -> None:
        self.write_result()
        self.write_app()
        run = FakeRun()
        run.answers[("git", "status", "--porcelain")] = (128, "fatal: not a git repository")
        problems = self.evaluate(run)
        self.assertEqual(len(problems), 1)
        self.assertIn("git status --porcelain", problems[0])
        self.assertIn("not a git repository", problems[0])

    def test_non_ascii_path_marks_its_app_as_touched(self) -> None:
        self.write_result()
        self.write_app()
        run = FakeRun(diff="apps/x/café.ts\n", quick=(1, "boom"))
        problems = self.evaluate(run)
        self.assertEqual(len(problems), 1)
        self.assertIn("apps/x", problems[0])
        diff_calls = [argv for argv in run.commands() if "diff" in argv]
        self.assertEqual(diff_calls, [DIFF_ARGV])

    def test_unreadable_factory_config_keeps_the_problems_already_found(self) -> None:
        from factory import config as factory_config

        self.write_result()
        self.write_app()
        broken = self.root / "broken.toml"
        broken.write_text("not = [valid", encoding="utf-8")
        run = FakeRun(status=" M apps/x/a.ts\n", checker=(1, "secret found"))
        with mock.patch.object(factory_config, "DEFAULT_PATH", broken):
            problems = self.evaluate(run)
        self.assertEqual(len(problems), 3)
        self.assertIn("uncommitted", problems[0])
        self.assertIn("factory configuration", problems[1])
        self.assertIn(broken.name, problems[1])
        self.assertIn("scripts/check_repo.py", problems[2])
        self.assertNotIn(("sh", "-c", "make quick"), run.commands())

    def test_quick_command_runs_only_for_stages_that_install_dependencies(self) -> None:
        for stage, runs in (("design", False), ("plan", False), ("step", True), ("fix", True), ("revise", True),
                            ("fix_issue", True)):
            with self.subTest(stage=stage):
                self.write_result(stage=stage)
                self.write_app()
                run = FakeRun(quick=(1, "boom"))
                problems = self.evaluate(run, stage=stage)
                self.assertEqual(("sh", "-c", "make quick") in run.commands(), runs)
                self.assertEqual(len(problems), 1 if runs else 0, problems)

    def test_history_rewritten_below_the_base_blocks(self) -> None:
        self.write_result()
        self.write_app()
        run = FakeRun(ancestor=(1, ""))
        problems = self.evaluate(run)
        self.assertEqual(len(problems), 1)
        self.assertIn("rewritten", problems[0])
        self.assertIn("Restore the base commit", problems[0])
        commands = run.commands()
        self.assertLess(commands.index(("git", "status", "--porcelain")),
                        commands.index(("git", "merge-base", "--is-ancestor", BASE, "HEAD")))

    def test_base_that_is_an_ancestor_adds_no_problem(self) -> None:
        self.write_result()
        self.write_app()
        run = FakeRun(ancestor=(0, ""))
        self.assertEqual(self.evaluate(run), [])
        self.assertIn(("git", "merge-base", "--is-ancestor", BASE, "HEAD"), run.commands())

    def test_quick_timeout_above_the_ceiling_is_clamped(self) -> None:
        self.write_result()
        self.write_app()
        run = FakeRun()
        self.evaluate(run, FACTORY_QUICK_TIMEOUT="5000")
        self.assertEqual([call[2] for call in run.calls if call[0][0] == "sh"], [600])

    def test_deadline_reached_before_the_quick_command_skips_it_and_says_so(self) -> None:
        self.write_result()
        self.write_app()
        clock = Clock()
        run = SlowRun(clock, 300)  # the deadline passes while the git calls run, before the checker and the quick command
        problems = finish_check.evaluate(self.env(), self.repo, run, now=clock)
        self.assertNotIn(("sh", "-c", "make quick"), run.commands())
        self.assertEqual(len(problems), 1)
        self.assertIn("ran out of time", problems[0])
        self.assertIn("840", problems[0])
        self.assertIn("did not run", problems[0])

    def test_deadline_names_the_quick_command_that_did_not_run(self) -> None:
        self.write_result()
        self.write_app()
        clock = Clock()

        class Late(FakeRun):
            def __call__(self, argv, cwd, timeout):
                result = super().__call__(argv, cwd, timeout)
                if argv[-1].endswith("check_repo.py"):
                    clock.seconds = 840
                return result

        run = Late()
        problems = finish_check.evaluate(self.env(), self.repo, run, now=clock)
        self.assertNotIn(("sh", "-c", "make quick"), run.commands())
        self.assertEqual(len(problems), 1)
        self.assertIn("apps/x", problems[0])
        self.assertIn("ran out of time", problems[0])

    def test_every_call_gets_the_smaller_of_its_timeout_and_the_time_left(self) -> None:
        self.write_result()
        self.write_app()
        clock = Clock()

        class AfterStatus(FakeRun):
            def __call__(self, argv, cwd, timeout):
                result = super().__call__(argv, cwd, timeout)
                if tuple(argv) == ("git", "status", "--porcelain"):
                    clock.seconds = 740  # leaves 100 seconds
                return result

        run = AfterStatus()
        self.assertEqual(finish_check.evaluate(self.env(), self.repo, run, now=clock), [])
        self.assertEqual(run.calls[0][2], 120)  # the first call still had the whole budget
        self.assertEqual([call[2] for call in run.calls[1:]], [100, 100, 100, 100, 100])

    def test_touched_apps_ignores_files_outside_an_app(self) -> None:
        paths = ["apps/README.md", "apps/x/a", "apps/x/b/c", "docs/apps/y/z", "apps/w/q"]
        self.assertEqual(finish_check.touched_apps(paths), ["w", "x"])


class MainTests(unittest.TestCase):
    def run_main(self, env: dict[str, str]) -> tuple[str, int]:
        out = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True), contextlib.redirect_stdout(out), \
                mock.patch("sys.stdin", io.TextIOWrapper(io.BytesIO(b"{}"))):
            with self.assertRaises(SystemExit) as raised:
                finish_check.main()
        return out.getvalue(), raised.exception.code

    def test_interactive_session_prints_nothing_and_exits_zero(self) -> None:
        with mock.patch.object(finish_check, "evaluate", side_effect=AssertionError("must not run")):
            self.assertEqual(self.run_main({}), ("", 0))

    def test_factory_run_with_problems_prints_a_block_decision(self) -> None:
        with mock.patch.object(finish_check, "evaluate", return_value=["one", "two"]):
            out, code = self.run_main({"FACTORY_RUN": "1"})
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"decision": "block", "reason": "one\ntwo"})

    def test_factory_run_without_problems_prints_nothing(self) -> None:
        with mock.patch.object(finish_check, "evaluate", return_value=[]):
            self.assertEqual(self.run_main({"FACTORY_RUN": "1"}), ("", 0))

    def test_unexpected_exception_becomes_one_readable_problem(self) -> None:
        with mock.patch.object(finish_check, "evaluate", side_effect=KeyError("secret detail")):
            out, code = self.run_main({"FACTORY_RUN": "1"})
        self.assertEqual(code, 0)
        reason = json.loads(out)["reason"]
        self.assertIn("finish check itself failed", reason)
        self.assertIn("KeyError", reason)
        self.assertNotIn("Traceback", reason)


class RunCommandTests(unittest.TestCase):
    def test_timeout_returns_124_with_a_message(self) -> None:
        code, output = finish_check.run_command([finish_check.sys.executable, "-c", "import time; time.sleep(5)"],
                                                Path.cwd(), 1)
        self.assertEqual(code, 124)
        self.assertIn("timed out after 1 seconds", output)

    @unittest.skipUnless(shutil.which("sh"), "needs a POSIX shell")
    def test_timeout_returns_promptly_even_when_a_grandchild_holds_the_pipe(self) -> None:
        started = time.monotonic()
        code, output = finish_check.run_command(["sh", "-c", "sleep 30 & wait"], Path.cwd(), 1)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(code, 124)
        self.assertIn("timed out after 1 seconds", output)

    @unittest.skipUnless(shutil.which("sh"), "needs a POSIX shell")
    def test_a_process_that_hit_the_timeout_with_a_grandchild_still_exits_cleanly(self) -> None:
        script = ("import sys\n"
                  "from pathlib import Path\n"
                  "from factory.tests.hookload import load_hook\n"
                  "code, output = load_hook('finish_check').run_command(['sh', '-c', 'sleep 30 & wait'], Path.cwd(), 1)\n"
                  "print(code, output)\n")
        started = time.monotonic()
        child = subprocess.run([sys.executable, "-W", "error", "-c", script], cwd=finish_check.REPO_ROOT, capture_output=True,
                               text=True, timeout=60)
        self.assertLess(time.monotonic() - started, 15)
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertIn("124 timed out after 1 seconds", child.stdout)
        self.assertNotIn("Fatal Python error", child.stderr)
        self.assertNotIn("Exception ignored", child.stderr)

    def test_output_and_exit_code_are_returned(self) -> None:
        code, output = finish_check.run_command(
            [finish_check.sys.executable, "-c", "import sys; print('out'); print('err', file=sys.stderr); sys.exit(3)"],
            Path.cwd(), 30)
        self.assertEqual(code, 3)
        self.assertIn("out", output)
        self.assertIn("err", output)

    def test_missing_program_is_a_result_not_a_crash(self) -> None:
        code, output = finish_check.run_command(["no-such-program-for-finish-check"], Path.cwd(), 5)
        self.assertEqual(code, 127)
        self.assertIn("could not run", output)


if __name__ == "__main__":
    unittest.main()
