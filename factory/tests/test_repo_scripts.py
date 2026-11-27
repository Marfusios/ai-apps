"""Tests for scripts/new_app.py and scripts/check_repo.py, run in a throwaway git repository."""

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HAVE_GIT = shutil.which("git") is not None


def _run(script: Path, cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(script), *args], cwd=cwd, capture_output=True, text=True, check=False
    )


@unittest.skipUnless(HAVE_GIT, "git is not on PATH")
class RepoScriptTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name)
        for name in ("scripts", "templates"):
            shutil.copytree(ROOT / name, self.repo / name, ignore=shutil.ignore_patterns("__pycache__"))
        # The factory's Markdown links into docs/, which the throwaway repository does not have.
        shutil.copytree(
            ROOT / "factory", self.repo / "factory", ignore=shutil.ignore_patterns("__pycache__", "*.md")
        )
        (self.repo / "apps").mkdir()
        (self.repo / "apps" / "README.md").write_text(
            "# Apps\n\n| App | Purpose | Status |\n| --- | --- | --- |\n<!-- app-catalog -->\n",
            encoding="utf-8",
        )
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True, capture_output=True)

    def new_app(self, name: str = "demo-app") -> subprocess.CompletedProcess:
        return _run(self.repo / "scripts" / "new_app.py", self.repo, name)

    def check(self) -> subprocess.CompletedProcess:
        return _run(self.repo / "scripts" / "check_repo.py", self.repo)

    def test_new_app_fills_placeholders_in_every_file(self) -> None:
        result = self.new_app()
        self.assertEqual(result.returncode, 0, result.stderr)
        files = [p for p in (self.repo / "apps" / "demo-app").rglob("*") if p.is_file()]
        self.assertIn("AGENTS.md", {p.name for p in files})
        for path in files:
            self.assertNotIn("{{", path.read_text(encoding="utf-8"), path.name)
        agents = (self.repo / "apps" / "demo-app" / "AGENTS.md").read_text(encoding="utf-8")
        self.assertTrue(agents.startswith("# Demo App: notes for agents"))

    def test_new_app_output_passes_check_repo(self) -> None:
        self.assertEqual(self.new_app().returncode, 0)
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_check_repo_requires_agents_md_and_factory_toml(self) -> None:
        for required in ("AGENTS.md", "factory.toml"):
            with self.subTest(required=required):
                if not (self.repo / "apps" / "demo-app").exists():
                    self.assertEqual(self.new_app().returncode, 0)
                target = self.repo / "apps" / "demo-app" / required
                saved = target.read_text(encoding="utf-8")
                target.unlink()
                result = self.check()
                target.write_text(saved, encoding="utf-8")
                self.assertEqual(result.returncode, 1)
                self.assertIn(f"apps/demo-app: missing {required}", result.stdout)

    def test_check_repo_reports_factory_toml_problems(self) -> None:
        self.assertEqual(self.new_app().returncode, 0)
        path = self.repo / "apps" / "demo-app" / "factory.toml"
        path.write_text(
            path.read_text(encoding="utf-8").replace("[commands]", "[commands]\nextra = \"x\""),
            encoding="utf-8",
        )
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("apps/demo-app/factory.toml: commands.extra", result.stdout)

    def test_check_repo_survives_unloadable_factory_config(self) -> None:
        self.assertEqual(self.new_app().returncode, 0)
        (self.repo / "factory" / "config.toml").write_text("not valid = = toml", encoding="utf-8")
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("factory/config.toml", result.stdout)
        self.assertNotIn("Traceback", result.stderr)

    def test_this_repository_passes(self) -> None:
        result = _run(ROOT / "scripts" / "check_repo.py", ROOT)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
