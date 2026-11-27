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


    def test_hooks_are_registered_under_the_expected_event_and_matcher(self) -> None:
        registered = []
        for event, entries in load_settings()["hooks"].items():
            for entry in entries:
                names = [HOOK_COMMAND.match(hook["command"]).group(1) for hook in entry["hooks"]]
                registered.append((event, entry.get("matcher"), names))
        self.assertEqual(registered, [
            ("PreToolUse", "Bash|PowerShell|Monitor", ["guard_git"]),
            ("PreToolUse", "Edit|Write|MultiEdit|NotebookEdit", ["guard_paths", "guard_quality"]),
            ("Stop", None, ["finish_check"]),
        ])

    def test_permission_rules_do_not_contradict_the_hooks(self) -> None:
        permissions = load_settings()["permissions"]
        # the hook allows a commit whose message merely mentions the flag, so only the leading form is a rule
        self.assertIn("Bash(git commit --no-verify*)", permissions["deny"])
        self.assertNotIn("Bash(git commit * --no-verify*)", permissions["deny"])
        # listing and reading secrets and variables is allowed by the hook
        self.assertEqual([rule for rule in permissions["ask"] if rule.startswith(("Bash(gh secret", "Bash(gh variable"))],
                         ["Bash(gh secret set *)", "Bash(gh secret delete *)", "Bash(gh variable set *)",
                          "Bash(gh variable delete *)"])


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

    def test_the_fix_issue_skill_handles_each_kind_of_small_change_in_both_modes(self) -> None:
        path = CLAUDE / "skills" / "factory-fix-issue" / "SKILL.md"
        text = path.read_text(encoding="utf-8")
        self.assertIn("small change", read_frontmatter(path)["description"])
        for heading in ("## Decide which kind of small change it is", "## Fix a bug", "## Add a small feature",
                        "## Do a chore", "## When to stop and return questions"):
            self.assertIn(heading, text)
        self.assertIn("When `FACTORY_RUN` is not set", text)

    def test_a_chore_sets_up_and_checks_first_and_keeps_every_suppression_reasoned(self) -> None:
        text = (CLAUDE / "skills" / "factory-fix-issue" / "SKILL.md").read_text(encoding="utf-8")
        chore = " ".join(text.partition("## Do a chore")[2].partition("\n## ")[0].split())
        first = chore.partition("Before you change anything")[2]
        self.assertLess(first.index("`setup`"), first.index("`check`"))
        for words in ("ignore the app's own code", "suppression", "its reason", "docs/engineering.md"):
            with self.subTest(words=words):
                self.assertIn(words, chore)

    def test_every_kind_keeps_its_commit_messages_and_posted_texts_to_what_the_dispatcher_publishes(self) -> None:
        text = (CLAUDE / "skills" / "factory-fix-issue" / "SKILL.md").read_text(encoding="utf-8")
        every = " ".join(text.partition("## Then, for every kind")[2].partition("\n## ")[0].split())
        for words in ("commit message", "no person", "its own", "host path", "private address", "finish check"):
            with self.subTest(words=words):
                self.assertIn(words, every)

    def test_a_chore_that_changes_a_quality_tool_updates_the_apps_commands_with_it(self) -> None:
        text = (CLAUDE / "skills" / "factory-fix-issue" / "SKILL.md").read_text(encoding="utf-8")
        chore = text.partition("## Do a chore")[2].partition("\n## ")[0]
        for name in ("apps/<app>/factory.toml", "[quality]", "commands.check", "commands.quick", "Commands"):
            self.assertIn(name, chore)


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
        text = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        self.assertLessEqual(len(text.splitlines()), 150)
        self.assertIn("docs/engineering.md", text)

    def test_agents_md_names_the_three_kinds_of_small_change(self) -> None:
        text = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        flow = text.partition("## How work flows")[2].partition("\n## ")[0]
        for kind in ("`factory:fix`", "bug fix", "small feature", "chore"):
            self.assertIn(kind, flow)


if __name__ == "__main__":
    unittest.main()
