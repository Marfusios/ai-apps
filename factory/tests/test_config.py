"""Tests for the repository-wide factory configuration."""

import tempfile
import unittest
from pathlib import Path

from factory.config import ConfigError, is_writable, load

VALID = """schema = 1
trusted_logins = ["someone"]
writable_paths = ["apps/"]
protected_branches = ["main"]
image_registries = ["docker.io/library/"]

[[labels]]
name = "factory:epic"
color = "5319e7"
description = "Run it"
applied_by = "person"
"""


class ConfigTest(unittest.TestCase):
    def load_text(self, text: str):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.toml"
            path.write_text(text, encoding="utf-8")
            return load(path)

    def test_repository_config_loads(self):
        config = load()
        self.assertEqual(config.trusted_logins, ("Marfusios",))
        self.assertEqual(config.protected_branches, ("main",))
        self.assertEqual(len(config.labels), 15)
        self.assertEqual({l.applied_by for l in config.labels}, {"person", "dispatcher"})

    def test_label_descriptions_fit_github_limit(self):
        for label in load().labels:
            self.assertLessEqual(len(label.description), 100, label.name)

    def test_is_writable(self):
        config = load()
        for path in ("apps/x/src/a.ts", "packages/shared/b.py", "apps\\x\\README.md"):
            self.assertTrue(is_writable(path, config), path)
        for path in ("AGENTS.md", ".github/workflows/checks.yml", "factory/config.toml", "scripts/check_repo.py",
                     "apps/../AGENTS.md", "/etc/passwd", "apps", "docs/engineering.md", ".claude/settings.json", ""):
            self.assertFalse(is_writable(path, config), path)

    def test_drive_letter_path_is_not_writable(self):
        self.assertFalse(is_writable("C:/apps/x.py", load()))

    def test_minimal_valid_config_loads(self):
        self.assertEqual(self.load_text(VALID).trusted_logins, ("someone",))

    def test_bad_configs_raise_config_error(self):
        cases = {
            "wrong schema": VALID.replace("schema = 1", "schema = 2"),
            "bad applied_by": VALID.replace('"person"', '"robot"'),
            "bad color": VALID.replace("5319e7", "#5319e7"),
            "missing key": VALID.replace('protected_branches = ["main"]\n', ""),
            "invalid toml": "schema = ",
        }
        for name, text in cases.items():
            with self.subTest(name), self.assertRaises(ConfigError):
                self.load_text(text)

    def test_missing_file_raises_config_error(self):
        with self.assertRaises(ConfigError):
            load(Path(tempfile.gettempdir()) / "no-such-factory-config.toml")


if __name__ == "__main__":
    unittest.main()
