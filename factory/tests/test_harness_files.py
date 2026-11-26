"""Keep the Claude Code harness files (settings, skills, agents, AGENTS.md) consistent with each other."""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CLAUDE = ROOT / ".claude"
HOOKS = CLAUDE / "hooks"
SETTINGS = CLAUDE / "settings.json"
READ_ONLY_AGENTS = {"design-critic", "step-reviewer"}
READ_ONLY_TOOLS = {"Read", "Grep", "Glob"}
HOOK_COMMAND = re.compile(r"""^sh "\$CLAUDE_PROJECT_DIR/\.claude/hooks/run" (\w+)$""")


def parse_frontmatter(text: str) -> dict[str, str]:
    """Read the `key: value` lines between the first two `---` lines; values may be quoted."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    fields: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            return fields
        key, separator, value = line.partition(":")
        if separator and key.strip():
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            fields[key.strip()] = value
    return {}


def read_frontmatter(path: Path) -> dict[str, str]:
    return parse_frontmatter(path.read_text(encoding="utf-8"))


def load_settings() -> dict:
    return json.loads(SETTINGS.read_text(encoding="utf-8"))


def settings_commands(settings: dict) -> list[str]:
    commands = []
    for entries in settings.get("hooks", {}).values():
        for entry in entries:
            for hook in entry.get("hooks", []):
                commands.append(hook.get("command", ""))
    return commands


class SettingsTests(unittest.TestCase):
    def test_settings_is_valid_json_with_the_expected_shape(self) -> None:
        settings = load_settings()
        for kind in ("deny", "ask"):
            rules = settings["permissions"][kind]
            self.assertIsInstance(rules, list)
            self.assertTrue(all(isinstance(rule, str) for rule in rules), kind)
        for event in ("PreToolUse", "Stop"):
            for entry in settings["hooks"][event]:
                self.assertIsInstance(entry["hooks"], list)
                for hook in entry["hooks"]:
                    self.assertEqual(hook["type"], "command")
                    self.assertIsInstance(hook["command"], str)
                    self.assertIsInstance(hook["timeout"], (int, float))
                    self.assertNotIsInstance(hook["timeout"], bool)

    def test_settings_reference_existing_hooks(self) -> None:
        commands = settings_commands(load_settings())
        self.assertTrue(commands)
        for command in commands:
            match = HOOK_COMMAND.match(command)
            self.assertIsNotNone(match, command)
            self.assertTrue((HOOKS / f"{match.group(1)}.py").is_file(), command)

    def test_every_hook_file_is_registered(self) -> None:
        registered = {m.group(1) for c in settings_commands(load_settings()) if (m := HOOK_COMMAND.match(c))}
        hook_files = {p.stem for p in HOOKS.glob("guard_*.py")} | {"finish_check"}
        self.assertEqual(hook_files - registered, set())


class SkillTests(unittest.TestCase):
    def test_skills_have_valid_frontmatter(self) -> None:
        for path in sorted(CLAUDE.glob("skills/*/SKILL.md")):
            fields = read_frontmatter(path)
            self.assertEqual(fields.get("name"), path.parent.name, path)
            self.assertTrue(1 <= len(fields.get("description", "")) <= 1024, path)

    def test_factory_skills_are_not_model_invocable(self) -> None:
        for path in sorted(CLAUDE.glob("skills/factory-*/SKILL.md")):
            fields = read_frontmatter(path)
            self.assertEqual(fields.get("disable-model-invocation"), "true", path)


class AgentTests(unittest.TestCase):
    def test_agents_have_valid_frontmatter(self) -> None:
        for path in sorted(CLAUDE.glob("agents/*.md")):
            fields = read_frontmatter(path)
            self.assertEqual(fields.get("name"), path.stem, path)
            self.assertTrue(fields.get("description"), path)
            self.assertTrue(fields.get("tools"), path)

    def test_read_only_agents_cannot_write_or_run(self) -> None:
        for name in sorted(READ_ONLY_AGENTS):
            path = CLAUDE / "agents" / f"{name}.md"
            if not path.is_file():
                continue
            tools = {t.strip() for t in read_frontmatter(path).get("tools", "").split(",") if t.strip()}
            self.assertTrue(tools <= READ_ONLY_TOOLS, f"{name}: {sorted(tools - READ_ONLY_TOOLS)}")


class AgentsMdTests(unittest.TestCase):
    def test_agents_md_is_short(self) -> None:
        if not (ROOT / "docs" / "engineering.md").is_file():
            self.skipTest("docs/engineering.md does not exist yet")
        text = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        self.assertLessEqual(len(text.splitlines()), 150)
        self.assertIn("docs/engineering.md", text)


if __name__ == "__main__":
    unittest.main()
