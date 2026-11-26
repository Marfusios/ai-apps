"""Tests for validation of apps/<app>/factory.toml."""

import tempfile
import unittest
from pathlib import Path

from factory.app_config import AppConfigError, load

REGISTRIES = ("docker.io/library/", "docker.elastic.co/")

MINIMAL = """schema = 1

[toolchain]
node = "22"

[commands]
setup = "npm ci"
check = "npm test"

[quality]
format = "prettier"
lint = "eslint"
types = "tsc"
tests = "vitest"
"""

SERVICE = """
[[services]]
name = "db"
image = "docker.io/library/postgres:16"
ready = "pg_isready"
memory = "512m"
"""


class AppConfigTest(unittest.TestCase):
    def load_text(self, text: str):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "factory.toml").write_text(text, encoding="utf-8")
            return load(Path(tmp), REGISTRIES)

    def problems(self, text: str) -> list[str]:
        with self.assertRaises(AppConfigError) as ctx:
            self.load_text(text)
        return ctx.exception.problems

    def assert_problem_at(self, text: str, key: str):
        problems = self.problems(text)
        self.assertTrue(any(p.startswith(key) for p in problems), problems)

    def test_minimal_valid_file(self):
        config = self.load_text(MINIMAL)
        self.assertEqual(config.toolchain, {"node": "22"})
        self.assertEqual(config.setup, "npm ci")
        self.assertEqual(config.check, "npm test")
        self.assertIsNone(config.quick)
        self.assertEqual(config.quality["lint"], "eslint")
        self.assertEqual(config.services, ())

    def test_valid_service_and_quick(self):
        config = self.load_text(
            MINIMAL.replace('check = "npm test"', 'check = "npm test"\nquick = "npm run lint"')
            + SERVICE.replace('memory = "512m"', 'memory = "4096m"\nenv = { A = "b" }')
        )
        self.assertEqual(config.quick, "npm run lint")
        self.assertEqual(config.services[0].name, "db")
        self.assertEqual(config.services[0].env, {"A": "b"})

    def test_unknown_key_is_reported_with_its_path(self):
        self.assert_problem_at(MINIMAL.replace("[quality]", 'extra = "x"\n\n[quality]'), "commands.extra")
        self.assert_problem_at(MINIMAL + "[other]\nx = 1\n", "other")

    def test_every_problem_is_reported_at_once(self):
        text = MINIMAL.replace('setup = "npm ci"', 'setup = ""').replace('lint = "eslint"', 'lint = "none"')
        self.assertEqual(len(self.problems(text)), 2)

    def test_quality_none_needs_a_reason(self):
        self.assert_problem_at(MINIMAL.replace('lint = "eslint"', 'lint = "none"'), "quality.lint")
        self.assert_problem_at(MINIMAL.replace('lint = "eslint"', 'lint = "none: short"'), "quality.lint")
        config = self.load_text(MINIMAL.replace('lint = "eslint"', 'lint = "none: not adopted yet"'))
        self.assertEqual(config.quality["lint"], "none: not adopted yet")

    def test_service_image_must_come_from_a_listed_registry(self):
        self.assert_problem_at(MINIMAL + SERVICE.replace("docker.io/library/postgres:16", "example.org/x:1"),
                               "services[0].image")

    def test_service_image_needs_a_tag_or_digest(self):
        for image in ("docker.io/library/postgres", "docker.io/library/postgres:"):
            with self.subTest(image):
                self.assert_problem_at(MINIMAL + SERVICE.replace("docker.io/library/postgres:16", image),
                                       "services[0].image")
        digest = "docker.io/library/postgres@sha256:" + "a" * 64
        config = self.load_text(MINIMAL + SERVICE.replace("docker.io/library/postgres:16", digest))
        self.assertEqual(len(config.services), 1)

    def test_service_rejects_mounts_and_flags(self):
        self.assert_problem_at(MINIMAL + SERVICE + 'volumes = ["/a:/b"]\n', "services[0].volumes")
        self.assert_problem_at(MINIMAL + SERVICE + "privileged = true\n", "services[0].privileged")

    def test_service_memory_limit_and_name(self):
        for memory in ("5g", "8192m", "lots", "0x"):
            with self.subTest(memory):
                self.assert_problem_at(MINIMAL + SERVICE.replace("512m", memory), "services[0].memory")
        self.assert_problem_at(MINIMAL + SERVICE.replace('"db"', '"Bad_Name"'), "services[0].name")

    def test_duplicate_service_names_and_too_many_services(self):
        self.assert_problem_at(MINIMAL + SERVICE + SERVICE, "services[1].name")
        five = "".join(SERVICE.replace('"db"', f'"db{i}"') for i in range(5))
        self.assert_problem_at(MINIMAL + five, "services")

    def test_toolchain_versions(self):
        self.assert_problem_at(MINIMAL.replace('node = "22"', 'node = "latest"'), "toolchain.node")
        self.assert_problem_at(MINIMAL.replace('node = "22"', 'ruby = "3"'), "toolchain.ruby")

    def test_schema_must_be_one(self):
        self.assert_problem_at(MINIMAL.replace("schema = 1", "schema = 2"), "schema")

    def test_multiline_command_is_rejected(self):
        self.assert_problem_at(MINIMAL.replace('setup = "npm ci"', 'setup = "npm ci\\nrm x"'), "commands.setup")
        self.assert_problem_at(MINIMAL.replace('setup = "npm ci"', 'setup = "' + "a" * 501 + '"'), "commands.setup")

    def test_missing_file_and_invalid_toml_are_app_config_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(AppConfigError):
                load(Path(tmp), REGISTRIES)
            (Path(tmp) / "factory.toml").write_text("schema = ", encoding="utf-8")
            with self.assertRaises(AppConfigError) as ctx:
                load(Path(tmp), REGISTRIES)
            self.assertTrue(ctx.exception.problems)


if __name__ == "__main__":
    unittest.main()
