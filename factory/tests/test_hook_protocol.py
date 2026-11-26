"""Run the real hook launcher as a subprocess to pin its stdin and stdout protocol."""

import json
import os
import shutil
import subprocess
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
    def run_hook(self, name: str, stdin: str) -> subprocess.CompletedProcess[str]:
        env = {k: v for k, v in os.environ.items() if k != "FACTORY_RUN"}
        env["CLAUDE_PROJECT_DIR"] = str(ROOT)
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


if __name__ == "__main__":
    unittest.main()
