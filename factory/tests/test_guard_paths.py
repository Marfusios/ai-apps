"""Tests for the path guard hook: where an agent may write."""

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from factory.config import Config, load
from factory.tests.hookload import load_hook

guard_paths = load_hook("guard_paths")
CONFIG = load()


class DecideTests(unittest.TestCase):
    def setUp(self) -> None:
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.holder = Path(holder.name).resolve()
        self.project = self.holder / "project"
        for directory in ("apps/x", ".github/workflows", ".git/hooks"):
            (self.project / directory).mkdir(parents=True)

    def decide(self, path: str, factory_run: bool, cwd: Path | None = None) -> str:
        decision = guard_paths.decide(path, project=self.project, cwd=cwd or self.project,
                                      factory_run=factory_run, config=CONFIG)
        return decision.action

    def check(self, expected: dict[str, str], factory_run: bool) -> None:
        for path, action in expected.items():
            with self.subTest(path=path, factory_run=factory_run):
                self.assertEqual(self.decide(path, factory_run), action)

    def test_interactive_session_may_edit_anything_but_git_internals_and_credentials(self):
        self.check({"AGENTS.md": "allow", ".git/hooks/pre-commit": "deny", "apps/x/.env": "ask",
                    "apps/x/.env.example": "allow", "apps/x/app.env.example": "allow"}, factory_run=False)

    def test_credential_files_are_recognised_like_the_repository_checker_does(self):
        self.check({"apps/x/.env.local": "ask", "apps/x/prod.env": "ask", "apps/x/server.pem": "ask",
                    "apps/x/a.KEY": "ask", "apps/x/a.p12": "ask", "apps/x/a.pfx": "ask",
                    "apps/x/secrets/a.txt": "ask", "apps/x/Credentials/a.txt": "ask",
                    "apps/x/environment.py": "allow", "apps/x/keys.py": "allow"}, factory_run=False)

    def test_git_internals_are_denied_at_any_depth(self):
        self.check({".git/config": "deny", "apps/x/.git/config": "deny", ".git": "deny"}, factory_run=False)

    def test_factory_run_may_write_only_writable_roots(self):
        self.check({"apps/x/src/a.ts": "allow", "packages/p/a.py": "allow", "AGENTS.md": "deny",
                    ".github/workflows/c.yml": "deny", "factory/config.toml": "deny", "scripts/a.py": "deny",
                    "docs/a.md": "deny", ".git/hooks/pre-commit": "deny"}, factory_run=True)

    def test_factory_run_denies_credentials(self):
        self.check({"apps/x/server.pem": "deny", "apps/x/.env": "deny", "apps/x/.env.example": "allow"},
                   factory_run=True)

    def test_factory_deny_reason_lists_the_writable_roots_and_the_way_out(self):
        reason = guard_paths.decide("AGENTS.md", project=self.project, cwd=self.project, factory_run=True,
                                    config=CONFIG).reason
        self.assertIn("apps/", reason)
        self.assertIn("packages/", reason)
        self.assertIn("follow-up", reason)
        self.assertIn("question", reason)

    def test_dotdot_and_backslashes_do_not_escape(self):
        self.check({"apps/x/../../AGENTS.md": "deny", "apps\\..\\AGENTS.md": "deny",
                    "apps/x/../x/a.ts": "allow"}, factory_run=True)

    def test_symlink_into_protected_directory_is_denied(self):
        try:
            os.symlink(os.path.join("..", "..", ".github"), self.project / "apps" / "x" / "link",
                       target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("this platform refuses to create symbolic links")
        self.check({"apps/x/link/c.yml": "deny"}, factory_run=True)

    def test_paths_outside_the_project_are_allowed(self):
        outside = str(self.holder / "sibling.txt")
        self.check({outside: "allow"}, factory_run=False)
        self.check({outside: "allow"}, factory_run=True)

    def test_git_internals_are_denied_even_outside_the_project(self):
        # in a linked worktree the real git directory lies outside the project
        hook = str(self.holder / "main-checkout" / ".git" / "hooks" / "pre-commit")
        for factory_run in (False, True):
            self.check({hook: "deny", str(self.holder / "project-other" / ".git" / "config"): "deny"},
                       factory_run=factory_run)

    def test_sibling_sharing_a_name_prefix_is_outside_the_project(self):
        self.check({str(self.holder / "project2" / "AGENTS.md"): "allow"}, factory_run=True)

    def test_relative_path_is_resolved_against_cwd(self):
        self.assertEqual(self.decide("a.ts", True, cwd=self.project / "apps" / "x"), "allow")
        self.assertEqual(self.decide("a.ts", True, cwd=self.project), "deny")
        self.assertEqual(self.decide("../../AGENTS.md", True, cwd=self.project / "apps" / "x"), "deny")

    def test_case_is_ignored_only_on_windows(self):
        expected = "allow" if os.name == "nt" else "deny"
        self.check({"APPS/x/a.ts": expected}, factory_run=True)
        self.check({".GIT/config": "deny" if os.name == "nt" else "allow"}, factory_run=False)

    def test_absolute_path_inside_the_project_is_judged_like_its_relative_form(self):
        self.check({str(self.project / "apps" / "x" / "a.ts"): "allow", str(self.project / "AGENTS.md"): "deny"},
                   factory_run=True)


class MainTests(unittest.TestCase):
    def run_hook(self, data: dict, factory_run: bool = False) -> str:
        stdin = io.TextIOWrapper(io.BytesIO(json.dumps(data).encode()))
        environment = {"FACTORY_RUN": "1"} if factory_run else {}
        output = io.StringIO()
        with mock.patch("sys.stdin", stdin), mock.patch.dict(os.environ, environment, clear=False), \
                contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as raised:
            guard_paths.main()
        self.assertEqual(raised.exception.code, 0)
        return output.getvalue()

    def setUp(self) -> None:
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.project = Path(holder.name).resolve()
        (self.project / "apps").mkdir()
        patcher = mock.patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": str(self.project)})
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("FACTORY_RUN", None)

    def event(self, key: str, path: object) -> dict:
        return {"tool_name": "Write", "tool_input": {key: path, "content": "x"}, "cwd": str(self.project)}

    def test_denies_git_internals(self):
        output = json.loads(self.run_hook(self.event("file_path", ".git/hooks/pre-commit")))
        self.assertEqual(output["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_notebook_path_is_judged_too(self):
        output = json.loads(self.run_hook(self.event("notebook_path", "AGENTS.ipynb"), factory_run=True))
        self.assertEqual(output["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_harmless_edit_prints_nothing(self):
        self.assertEqual(self.run_hook(self.event("file_path", "apps/a.ts")), "")

    def test_a_write_tool_without_a_usable_path_is_denied(self):
        for tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
            for tool_input in ({}, {"file_path": 7}, {"notebook_path": ["a"]}, "x"):
                with self.subTest(tool=tool, tool_input=tool_input):
                    output = json.loads(self.run_hook({"tool_name": tool, "tool_input": tool_input}))
                    decision = output["hookSpecificOutput"]
                    self.assertEqual(decision["permissionDecision"], "deny")
                    self.assertIn("no path to inspect", decision["permissionDecisionReason"])

    def test_input_that_names_no_write_tool_is_allowed(self):
        self.assertEqual(self.run_hook({}), "")
        self.assertEqual(self.run_hook({"tool_input": {}}), "")
        self.assertEqual(self.run_hook({"tool_name": "Read", "tool_input": {}}), "")
        self.assertEqual(self.run_hook({"tool_name": "Bash", "tool_input": {"command": "ls"}}), "")

    def test_unreadable_configuration_falls_back_to_the_default_roots(self):
        with mock.patch.object(guard_paths, "load", side_effect=ValueError("broken")):
            self.assertEqual(self.run_hook(self.event("file_path", "apps/a.ts"), factory_run=True), "")
            output = json.loads(self.run_hook(self.event("file_path", "AGENTS.md"), factory_run=True))
        self.assertEqual(output["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_a_failure_while_deciding_is_a_denial(self):
        with mock.patch.object(guard_paths, "decide", side_effect=RuntimeError("boom")):
            output = json.loads(self.run_hook(self.event("file_path", "apps/a.ts")))
        self.assertEqual(output["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("could not inspect", output["hookSpecificOutput"]["permissionDecisionReason"])


class FallbackConfigTests(unittest.TestCase):
    def test_fallback_has_the_default_writable_roots(self):
        config = guard_paths.fallback_config()
        self.assertIsInstance(config, Config)
        self.assertEqual(config.writable_paths, ("apps/", "packages/"))


if __name__ == "__main__":
    unittest.main()
