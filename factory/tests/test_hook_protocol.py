"""Run the real hook launcher as a subprocess to pin its stdin and stdout protocol."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LAUNCHER = ".claude/hooks/run"
WRITE = {"tool_name": "Write", "tool_input": {"file_path": "notes.txt", "content": "x"}, "cwd": "."}
HARMLESS = {
    "guard_git": {"tool_name": "Bash", "tool_input": {"command": "git status"}, "cwd": "."},
    "guard_paths": WRITE,
    "guard_quality": WRITE,
    "finish_check": {"hook_event_name": "Stop", "stop_hook_active": False, "cwd": "."},
}


@unittest.skipIf(shutil.which("sh") is None, "sh is not on PATH")
class HookProtocolTests(unittest.TestCase):
    def run_hook(self, name: str, stdin: str, **environment: str) -> subprocess.CompletedProcess[str]:
        env = {k: v for k, v in os.environ.items() if k != "FACTORY_RUN"}
        env["CLAUDE_PROJECT_DIR"] = str(ROOT)
        env.update(environment)
        return subprocess.run(
            ["sh", LAUNCHER, name], input=stdin, capture_output=True, text=True, cwd=ROOT, env=env, timeout=120
        )

    def test_denied_command_prints_a_deny_decision(self) -> None:
        payload = {"tool_name": "Bash", "tool_input": {"command": "git push --force"}, "cwd": "."}
        result = self.run_hook("guard_git", json.dumps(payload))
        self.assertEqual(result.returncode, 0, result.stderr)
        decision = json.loads(result.stdout)["hookSpecificOutput"]["permissionDecision"]
        self.assertEqual(decision, "deny")

    def test_allowed_command_prints_nothing(self) -> None:
        result = self.run_hook("guard_git", json.dumps(HARMLESS["guard_git"]))
        self.assertEqual((result.returncode, result.stdout), (0, ""), result.stderr)

    def test_every_hook_answers_harmless_input_with_nothing(self) -> None:
        for name, payload in HARMLESS.items():
            with self.subTest(hook=name):
                result = self.run_hook(name, json.dumps(payload))
                self.assertEqual((result.returncode, result.stdout), (0, ""), result.stderr)

    def test_empty_and_invalid_input_do_not_crash(self) -> None:
        for stdin in ("", "not json"):
            with self.subTest(stdin=stdin):
                result = self.run_hook("guard_git", stdin)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("Traceback", result.stderr)

    def test_unknown_hook_name_exits_2(self) -> None:
        self.assertEqual(self.run_hook("no_such_hook", "{}").returncode, 2)

    def test_the_named_interpreter_runs_the_hook(self) -> None:
        payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": "git push --force"}, "cwd": "."})
        result = self.run_hook("guard_git", payload, FACTORY_HOOK_PYTHON=sys.executable)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_a_named_interpreter_that_is_missing_exits_2_although_python3_is_on_the_path(self) -> None:
        with tempfile.TemporaryDirectory() as empty:
            missing = str(Path(empty) / "no-such-python")
            result = self.run_hook("guard_git", json.dumps(HARMLESS["guard_git"]), FACTORY_HOOK_PYTHON=missing)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("FACTORY_HOOK_PYTHON", result.stderr)

    def test_a_named_program_that_is_not_python_3_11_exits_2(self) -> None:
        # sh cannot run the version check, which is what an interpreter that is too old would also fail
        result = self.run_hook("guard_git", json.dumps(HARMLESS["guard_git"]), FACTORY_HOOK_PYTHON=shutil.which("sh"))
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("FACTORY_HOOK_PYTHON", result.stderr)

    def run_without_python(self, name: str, factory_run: bool) -> subprocess.CompletedProcess[str]:
        """Run the launcher by the absolute path of sh with a PATH that holds nothing at all."""
        with tempfile.TemporaryDirectory() as empty:
            env = {k: v for k, v in os.environ.items() if k not in ("FACTORY_RUN", "PATH", "Path")}
            env.update({"PATH": empty, "CLAUDE_PROJECT_DIR": str(ROOT)})
            if factory_run:
                env["FACTORY_RUN"] = "1"
            sh = shutil.which("sh")
            probe = subprocess.run([sh, "-c", "command -v python3 python py"], capture_output=True, text=True, env=env,
                                   cwd=ROOT, timeout=60)
            if probe.stdout.strip():
                self.skipTest("a Python is still found with an empty PATH on this machine")
            return subprocess.run([sh, LAUNCHER, name], input="{}", capture_output=True, text=True, cwd=ROOT, env=env,
                                  timeout=60)

    def test_stop_hook_without_python_lets_an_interactive_session_stop(self) -> None:
        result = self.run_without_python("finish_check", factory_run=False)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))

    def test_stop_hook_without_python_still_blocks_a_factory_run(self) -> None:
        result = self.run_without_python("finish_check", factory_run=True)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("no Python 3.11 or newer", result.stderr)

    def test_other_hooks_without_python_still_exit_2_in_an_interactive_session(self) -> None:
        self.assertEqual(self.run_without_python("guard_git", factory_run=False).returncode, 2)


if __name__ == "__main__":
    unittest.main()
