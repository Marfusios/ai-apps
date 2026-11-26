"""Tests for the finish check hook: when a factory run may end its turn."""

import contextlib
import io
import json
import os
import tempfile
import shutil
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


class FakeRun:
    """Stands in for the subprocess runner: answers each command from a table and records the calls."""

    def __init__(self, status: str = "", count: str = "1", diff: str = "apps/x/a.ts\n",
                 checker: tuple[int, str] = (0, ""), quick: tuple[int, str] = (0, "")):
        self.answers = {
            ("git", "status", "--porcelain"): (0, status),
            ("git", "rev-list", "--count", f"{BASE}..HEAD"): (0, count),
            ("git", "-c", "core.quotePath=false", "diff", "--name-only", f"{BASE}...HEAD"): (0, diff),
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
        self.assertEqual(len(problems), 1)
        self.assertIn(str(self.result_path), problems[0])
        self.assertIn("cannot read", problems[0])
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
        self.assertEqual(diff_calls, [("git", "-c", "core.quotePath=false", "diff", "--name-only", f"{BASE}...HEAD")])

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
        code, output = finish_check.run_command(["sh", "-c", "sleep 6 & wait"], Path.cwd(), 1)
        self.assertLess(time.monotonic() - started, 5 + 1 + 3)
        self.assertEqual(code, 124)
        self.assertIn("timed out after 1 seconds", output)

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
