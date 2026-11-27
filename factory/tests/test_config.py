"""Tests for the repository-wide factory configuration."""

import tempfile
import unittest
from pathlib import Path

from factory.config import ConfigError, is_trusted, is_writable, load

TOP = """schema = 1
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
DISPATCHER = """
[dispatcher]
poll_seconds = 45
usage_limit_backoff_minutes = 30
max_bundle_megabytes = 50
max_file_megabytes = 5
max_commits = 50
required_checks = ["repository", "apps", "review"]
max_fix_rounds = 3
"""
REVIEW = """
[review]
bot_login = "github-actions[bot]"
bot_user_id = 41898282
"""
AGENT = """
[agent]
permission_mode = "auto"
claude_code_version = "2.1.332"
base_image = "docker.io/library/node:24-bookworm-slim"
cpus = 4

[agent.toolchains]
node = ["24"]
"""
STAGES = """
[stages.fix_issue]
model = "opus"
timeout_minutes = 90
max_turns = 300

[stages.fix]
model = "opus"
timeout_minutes = 60
max_turns = 200

[stages.revise]
model = "opus"
timeout_minutes = 60
max_turns = 200
"""
VALID = TOP + DISPATCHER + REVIEW + AGENT + STAGES

# (name, text to replace, replacement, key the message must contain)
INVALID_SETTINGS = [
    ("poll low", "poll_seconds = 45", "poll_seconds = 14", "dispatcher.poll_seconds"),
    ("poll high", "poll_seconds = 45", "poll_seconds = 601", "dispatcher.poll_seconds"),
    ("poll bool", "poll_seconds = 45", "poll_seconds = true", "dispatcher.poll_seconds"),
    ("poll string", "poll_seconds = 45", 'poll_seconds = "45"', "dispatcher.poll_seconds"),
    ("poll float", "poll_seconds = 45", "poll_seconds = 45.0", "dispatcher.poll_seconds"),
    ("backoff low", "backoff_minutes = 30", "backoff_minutes = 4", "dispatcher.usage_limit_backoff_minutes"),
    ("backoff high", "backoff_minutes = 30", "backoff_minutes = 721", "dispatcher.usage_limit_backoff_minutes"),
    ("bundle zero", "max_bundle_megabytes = 50", "max_bundle_megabytes = 0", "dispatcher.max_bundle_megabytes"),
    ("bundle high", "max_bundle_megabytes = 50", "max_bundle_megabytes = 501", "dispatcher.max_bundle_megabytes"),
    ("file zero", "max_file_megabytes = 5", "max_file_megabytes = 0", "dispatcher.max_file_megabytes"),
    ("file high", "max_file_megabytes = 5", "max_file_megabytes = 101", "dispatcher.max_file_megabytes"),
    ("commits zero", "max_commits = 50", "max_commits = 0", "dispatcher.max_commits"),
    ("commits high", "max_commits = 50", "max_commits = 501", "dispatcher.max_commits"),
    ("fix rounds zero", "max_fix_rounds = 3", "max_fix_rounds = 0", "dispatcher.max_fix_rounds"),
    ("fix rounds high", "max_fix_rounds = 3", "max_fix_rounds = 11", "dispatcher.max_fix_rounds"),
    ("fix rounds bool", "max_fix_rounds = 3", "max_fix_rounds = true", "dispatcher.max_fix_rounds"),
    ("fix rounds string", "max_fix_rounds = 3", 'max_fix_rounds = "3"', "dispatcher.max_fix_rounds"),
    ("fix rounds missing", "max_fix_rounds = 3\n", "", "dispatcher.max_fix_rounds"),
    ("checks empty", 'required_checks = ["repository", "apps", "review"]', "required_checks = []",
     "dispatcher.required_checks"),
    ("checks not a list", 'required_checks = ["repository", "apps", "review"]', 'required_checks = "apps"',
     "dispatcher.required_checks"),
    ("check not a string", '"repository", "apps"', '1, "apps"', "dispatcher.required_checks"),
    ("check empty name", '"repository", "apps"', '"", "apps"', "dispatcher.required_checks"),
    ("check bad character", '"repository", "apps"', '"repo/sitory", "apps"', "dispatcher.required_checks"),
    ("check too long", '"repository", "apps"', '"' + "a" * 101 + '", "apps"', "dispatcher.required_checks"),
    ("check trailing newline", '"repository", "apps"', '"apps\\n", "apps"', "dispatcher.required_checks"),
    ("checks missing", 'required_checks = ["repository", "apps", "review"]\n', "", "dispatcher.required_checks"),
    ("login empty", 'bot_login = "github-actions[bot]"', 'bot_login = ""', "review.bot_login"),
    ("login not a string", 'bot_login = "github-actions[bot]"', "bot_login = 7", "review.bot_login"),
    ("user id zero", "bot_user_id = 41898282", "bot_user_id = 0", "review.bot_user_id"),
    ("user id negative", "bot_user_id = 41898282", "bot_user_id = -1", "review.bot_user_id"),
    ("user id bool", "bot_user_id = 41898282", "bot_user_id = true", "review.bot_user_id"),
    ("user id string", "bot_user_id = 41898282", 'bot_user_id = "41898282"', "review.bot_user_id"),
    ("user id missing", "bot_user_id = 41898282\n", "", "review.bot_user_id"),
    ("unknown review key", "bot_user_id = 41898282", "bot_user_id = 41898282\nextra = 1", "review"),
    ("unknown dispatcher key", "max_commits = 50", "max_commits = 50\nextra = 1", "dispatcher"),
    ("missing dispatcher key", "max_commits = 50\n", "", "dispatcher.max_commits"),
    ("permission mode", 'permission_mode = "auto"', 'permission_mode = "plan"', "agent.permission_mode"),
    ("version too short", '"2.1.332"', '"2.1"', "agent.claude_code_version"),
    ("version prefix", '"2.1.332"', '"v2.1.332"', "agent.claude_code_version"),
    ("version non-ASCII digit", '"2.1.332"', '"2.1.\\u0663"', "agent.claude_code_version"),
    ("version trailing newline", '"2.1.332"', '"2.1.332\\n"', "agent.claude_code_version"),
    ("base image registry", "docker.io/library/node:24-bookworm-slim", "evil.example/node:24", "agent.base_image"),
    ("unknown agent key", "[agent.toolchains]", "extra = 1\n\n[agent.toolchains]", "agent"),
    ("cpus zero", "cpus = 4", "cpus = 0", "agent.cpus"),
    ("cpus high", "cpus = 4", "cpus = 257", "agent.cpus"),
    ("cpus bool", "cpus = 4", "cpus = true", "agent.cpus"),
    ("cpus string", "cpus = 4", 'cpus = "4"', "agent.cpus"),
    ("cpus missing", "cpus = 4\n", "", "agent.cpus"),
    ("toolchain name", 'node = ["24"]', 'ruby = ["3"]', "agent.toolchains"),
    ("toolchain empty list", 'node = ["24"]', "node = []", "agent.toolchains.node"),
    ("toolchain non-string", 'node = ["24"]', "node = [24]", "agent.toolchains.node"),
    ("toolchain empty string", 'node = ["24"]', 'node = [""]', "agent.toolchains.node"),
    ("no toolchains", '[agent.toolchains]\nnode = ["24"]\n', "", "agent.toolchains"),
    ("stage name", "[stages.fix_issue]", "[stages.bogus]", "stages.bogus"),
    ("no fix_issue stage", "[stages.fix_issue]", "[stages.plan]", "stages.fix_issue"),
    ("no fix stage", "[stages.fix]", "[stages.plan]", "stages.fix is required"),
    ("no revise stage", "[stages.revise]", "[stages.plan]", "stages.revise is required"),
    ("model uppercase", 'model = "opus"', 'model = "Opus"', "stages.fix_issue.model"),
    ("model empty", 'model = "opus"', 'model = ""', "stages.fix_issue.model"),
    ("timeout low", "timeout_minutes = 90", "timeout_minutes = 4", "stages.fix_issue.timeout_minutes"),
    ("timeout high", "timeout_minutes = 90", "timeout_minutes = 361", "stages.fix_issue.timeout_minutes"),
    ("turns low", "max_turns = 300", "max_turns = 9", "stages.fix_issue.max_turns"),
    ("turns high", "max_turns = 300", "max_turns = 1001", "stages.fix_issue.max_turns"),
    ("unknown stage key", "max_turns = 300", "max_turns = 300\nextra = 1", "stages.fix_issue"),
    ("no stages", STAGES, "\n[stages]\n", "stages"),
    ("writable path without slash", 'writable_paths = ["apps/"]', 'writable_paths = ["apps"]', "writable_paths"),
    ("registry without slash", 'image_registries = ["docker.io/library/"]',
     'image_registries = ["docker.io/library"]', "image_registries"),
]


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

    def test_repository_config_has_dispatcher_agent_and_stage_settings(self):
        config = load()
        dispatcher = config.dispatcher
        self.assertEqual((dispatcher.poll_seconds, dispatcher.usage_limit_backoff_minutes,
                          dispatcher.max_bundle_megabytes, dispatcher.max_file_megabytes, dispatcher.max_commits),
                         (45, 30, 50, 5, 50))
        self.assertEqual((dispatcher.required_checks, dispatcher.max_fix_rounds),
                         (("repository", "apps", "review"), 3))
        self.assertEqual((config.review.bot_login, config.review.bot_user_id), ("github-actions[bot]", 41898282))
        agent = config.agent
        self.assertEqual((agent.permission_mode, agent.claude_code_version, agent.base_image, agent.cpus),
                         ("auto", "2.1.332", "docker.io/library/node:24-bookworm-slim", 4))
        self.assertEqual(dict(agent.toolchains), {"node": ("24",), "python": ("3.11",)})
        stage = config.stages["fix_issue"]
        self.assertEqual((stage.model, stage.timeout_minutes, stage.max_turns), ("opus", 90, 300))
        for name in ("fix", "revise"):
            stage = config.stages[name]
            self.assertEqual((stage.model, stage.timeout_minutes, stage.max_turns), ("opus", 60, 200), name)

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

    def test_is_trusted_ignores_case(self):
        config = load()
        self.assertTrue(is_trusted("Marfusios", config))
        self.assertTrue(is_trusted("marfusios", config))
        self.assertFalse(is_trusted("Marfusios2", config))
        self.assertFalse(is_trusted("", config))

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

    def test_a_bot_account_cannot_be_trusted(self):
        for login in ("factory[bot]", "Factory[BOT]"):
            with self.subTest(login), self.assertRaises(ConfigError) as caught:
                self.load_text(VALID.replace('trusted_logins = ["someone"]', f'trusted_logins = ["someone", "{login}"]'))
            self.assertIn("trusted_logins", str(caught.exception))
            self.assertIn("bot account", str(caught.exception))

    def test_invalid_settings_name_their_key(self):
        for name, old, new, key in INVALID_SETTINGS:
            with self.subTest(name):
                self.assertIn(old, VALID)
                with self.assertRaises(ConfigError) as caught:
                    self.load_text(VALID.replace(old, new))
                self.assertIn(key, str(caught.exception))

    def test_each_settings_table_is_required(self):
        for table, text in (("dispatcher", DISPATCHER), ("review", REVIEW), ("agent", AGENT), ("stages", STAGES)):
            with self.subTest(table), self.assertRaises(ConfigError) as caught:
                self.load_text(VALID.replace(text, ""))
            self.assertIn(table, str(caught.exception))

    def test_wrongly_shaped_tables_raise_config_error_saying_what_they_must_be(self):
        top = "schema = 1\n"
        toolchains = '[agent.toolchains]\nnode = ["24"]\n'
        cases = {
            "dispatcher is a list": (VALID.replace(DISPATCHER, "").replace(top, top + "dispatcher = [1]\n"),
                                     "dispatcher must be a table"),
            "agent is a string": (VALID.replace(AGENT, "").replace(top, top + 'agent = "x"\n'),
                                  "agent must be a table"),
            "stages is a list": (VALID.replace(STAGES, "").replace(top, top + "stages = []\n"),
                                 "stages must be a table"),
            "toolchains is a list": (VALID.replace(toolchains, "toolchains = []\n"),
                                     "agent.toolchains must be a non-empty table"),
        }
        for name, (text, message) in cases.items():
            with self.subTest(name), self.assertRaises(ConfigError) as caught:
                self.load_text(text)
            self.assertIn(message, str(caught.exception))

    def test_duplicate_label_names_are_rejected(self):
        label = TOP[TOP.index("[[labels]]"):]
        with self.assertRaises(ConfigError) as caught:
            self.load_text(VALID.replace(DISPATCHER, label + DISPATCHER, 1))
        self.assertIn("factory:epic", str(caught.exception))

    def test_deeply_nested_value_raises_config_error(self):
        with self.assertRaises(ConfigError):
            self.load_text(VALID + "extra = " + "[" * 100_000 + "\n")

    def test_missing_file_raises_config_error(self):
        with self.assertRaises(ConfigError):
            load(Path(tempfile.gettempdir()) / "no-such-factory-config.toml")

    def test_an_unreadable_file_is_named_without_its_path(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ConfigError) as caught:
                load(Path(directory) / "missing.toml")
        self.assertNotIn(Path(directory).name, str(caught.exception))
        self.assertTrue(str(caught.exception).startswith("cannot read missing.toml: "))


if __name__ == "__main__":
    unittest.main()
