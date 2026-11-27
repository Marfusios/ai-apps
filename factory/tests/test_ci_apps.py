"""Tests for scripts/ci_apps.py: which apps a pull request touches, their matrix, and running a command."""

import contextlib
import importlib.util
import io
import shutil
import tempfile
import unittest
from pathlib import Path

from factory import config as factory_config

ROOT = Path(__file__).resolve().parents[2]
HAVE_SH = shutil.which("sh") is not None

_spec = importlib.util.spec_from_file_location("ci_apps", ROOT / "scripts" / "ci_apps.py")
ci_apps = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ci_apps)

REGISTRIES = factory_config.load().image_registries

VALID_TOML = """schema = 1

[commands]
setup = "{setup}"
check = "{check}"

[quality]
format = "ruff"
lint = "ruff"
types = "mypy"
tests = "pytest"
"""


class TouchedAppsTests(unittest.TestCase):
    existing = {"alpha", "beta", "gamma"}

    def test_selects_the_apps_whose_files_changed_sorted(self) -> None:
        paths = ["apps/gamma/src/a.py", "apps/alpha/README.md", "apps/gamma/b.py"]
        self.assertEqual(ci_apps.touched_apps(paths, self.existing), ["alpha", "gamma"])

    def test_a_package_change_selects_every_existing_app(self) -> None:
        self.assertEqual(ci_apps.touched_apps(["packages/shared/x.py"], self.existing), ["alpha", "beta", "gamma"])

    def test_paths_outside_apps_and_packages_select_nothing(self) -> None:
        self.assertEqual(ci_apps.touched_apps(["README.md", "factory/x.py", "apps/README.md"], self.existing), [])

    def test_an_app_that_no_longer_exists_is_left_out(self) -> None:
        self.assertEqual(ci_apps.touched_apps(["apps/removed/a.py", "apps/beta/a.py"], self.existing), ["beta"])


class TempRepoCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def add_app(self, name: str, toml: str) -> Path:
        directory = self.root / "apps" / name
        directory.mkdir(parents=True)
        (directory / "factory.toml").write_text(toml, encoding="utf-8")
        return directory


class MatrixTests(TempRepoCase):
    def test_the_real_aircase_entry_carries_its_toolchain_and_commands(self) -> None:
        entries = ci_apps.matrix(["aviation-investigations"], ROOT, REGISTRIES)
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry["app"], "aviation-investigations")
        self.assertEqual(entry["node"], "24")
        self.assertEqual(entry["python"], "")
        self.assertEqual(entry["check"], "pnpm typecheck && pnpm lint && pnpm test")
        self.assertNotIn("error", entry)

    def test_a_broken_factory_toml_is_listed_with_an_error_and_no_commands(self) -> None:
        self.add_app("broken", "schema = 2\n")
        [entry] = ci_apps.matrix(["broken"], self.root, REGISTRIES)
        self.assertEqual(entry["app"], "broken")
        self.assertTrue(entry["error"])
        self.assertEqual((entry["setup"], entry["check"], entry["node"], entry["python"]), ("", "", "", ""))


@unittest.skipUnless(HAVE_SH, "sh is not on PATH")
class RunTests(TempRepoCase):
    def run_main(self, *args: str) -> tuple[int, str]:
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            status = ci_apps.main(["--root", str(self.root), *args])
        return status, errors.getvalue()

    def test_returns_the_status_of_the_chosen_command(self) -> None:
        self.add_app("demo", VALID_TOML.format(setup="true", check="exit 3"))
        self.assertEqual(self.run_main("run", "demo", "setup")[0], 0)
        self.assertEqual(self.run_main("run", "demo", "check")[0], 3)

    def test_the_command_starts_in_the_app_directory(self) -> None:
        self.add_app("demo", VALID_TOML.format(setup="test -f factory.toml", check="true"))
        self.assertEqual(self.run_main("run", "demo", "setup")[0], 0)

    def test_an_app_whose_factory_toml_does_not_load_fails_with_the_stored_problem(self) -> None:
        self.add_app("broken", "schema = 2\n")
        status, message = self.run_main("run", "broken", "check")
        self.assertNotEqual(status, 0)
        self.assertIn("schema: must be 1", message)

    def test_an_app_that_does_not_exist_fails(self) -> None:
        status, message = self.run_main("run", "missing", "check")
        self.assertNotEqual(status, 0)
        self.assertTrue(message)


if __name__ == "__main__":
    unittest.main()
