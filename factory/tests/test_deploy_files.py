"""Keep the deployment files, the host guide and the issue forms in line with what the code reads and reports."""

import importlib.util
import re
import unittest
from collections.abc import Callable, Mapping
from pathlib import Path

from factory import compose, dispatcher, hygiene, jobs, pod, runner, spool

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "factory" / "deploy"
GUIDE = ROOT / "docs" / "factory" / "HOST_SETUP.md"
FORMS = ROOT / ".github" / "ISSUE_TEMPLATE"
EXAMPLES = ("dispatcher.env.example", "runner.env.example")
COMMANDS = ("factory.dispatcher", "factory.runner", "factory.image.build")
MISSING = re.compile(r"([A-Z][A-Z0-9_]*) is missing")
ASSIGNMENT = re.compile(r"([A-Z][A-Z0-9_]*)=(.*)")
FORM_FIELD_TYPES = {"markdown", "input", "textarea", "dropdown", "checkboxes"}


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def required_variables(settings_from_env: Callable[[Mapping[str, str]], object], error: type[Exception]) -> list[str]:
    """The variables a settings function needs, named by the error it raises for an empty environment."""
    try:
        settings_from_env({})
    except error as raised:
        return MISSING.findall(str(raised))
    raise AssertionError("an empty environment was accepted")


def dispatcher_variables() -> list[str]:
    return required_variables(dispatcher.settings_from_env, dispatcher.SettingsError)


def runner_variables() -> list[str]:
    return required_variables(runner.settings_from_env, runner.SettingsError)


def unit_entries(name: str) -> list[tuple[str, str, str]]:
    """(section, key, value) for each setting of a unit file, in order, with repeated keys kept."""
    entries, section = [], ""
    for line in read(DEPLOY / name).splitlines():
        line = line.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            continue
        key, separator, value = line.partition("=")
        if not separator:
            raise ValueError(f"{name}: not a setting: {line}")
        entries.append((section, key.strip(), value.strip()))
    return entries


def assignments(name: str) -> dict[str, str]:
    """The variables an example file assigns, with their values; comments and blank lines are skipped."""
    found = {}
    for line in read(DEPLOY / name).splitlines():
        match = ASSIGNMENT.fullmatch(line)
        if match:
            found[match.group(1)] = match.group(2)
    return found


class UnitTests(unittest.TestCase):
    def assert_unit(self, name: str, module: str, environment_files: list[str]) -> list[tuple[str, str]]:
        entries = unit_entries(name)
        service = [(key, value) for section, key, value in entries if section == "Service"]
        self.assertIsNotNone(importlib.util.find_spec(module), module)
        self.assertIn(("ExecStart", f"/usr/bin/python3 -m {module}"), service)
        self.assertEqual([value for key, value in service if key == "EnvironmentFile"], environment_files)
        for setting in (("WorkingDirectory", "/srv/factory/app"), ("Restart", "always"), ("RestartSec", "15"),
                        ("UMask", "0027"), ("Environment", "PYTHONDONTWRITEBYTECODE=1"),
                        ("Environment", "PYTHONUNBUFFERED=1")):
            self.assertIn(setting, service)
        self.assertIn(("Install", "WantedBy", "default.target"), entries)
        return service

    def test_the_dispatcher_unit_runs_the_dispatcher_with_its_settings_and_no_new_privileges(self):
        service = self.assert_unit("factory-dispatcher.service", "factory.dispatcher",
                                   ["%h/.config/factory/dispatcher.env"])
        self.assertIn(("NoNewPrivileges", "yes"), service)

    def test_the_runner_unit_reads_the_token_file_and_leaves_stopping_the_container_to_the_runner(self):
        service = self.assert_unit("factory-runner.service", "factory.runner",
                                   ["%h/.config/factory/runner.env", "%h/.config/factory/claude.env"])
        self.assertIn(("KillMode", "mixed"), service)
        self.assertIn(("TimeoutStopSec", "60"), service)
        # rootless Podman needs its setuid helpers, which no new privileges would disable
        self.assertNotIn("NoNewPrivileges", [key for key, _ in service])


class ExampleEnvironmentTests(unittest.TestCase):
    def test_the_dispatcher_example_assigns_exactly_the_variables_the_dispatcher_reads(self):
        self.assertEqual(sorted(assignments("dispatcher.env.example")), sorted(dispatcher_variables()))

    def test_the_runner_example_assigns_all_but_the_token_and_says_where_the_token_goes(self):
        variables = runner_variables()
        self.assertIn(pod.TOKEN_VARIABLE, variables)
        self.assertEqual(sorted(assignments("runner.env.example")), sorted(set(variables) - {pod.TOKEN_VARIABLE}))
        text = read(DEPLOY / "runner.env.example")
        self.assertIn(pod.TOKEN_VARIABLE, text)
        self.assertIn("claude.env", text)

    def test_the_shared_directories_are_the_guides_defaults(self):
        for name in EXAMPLES:
            values = assignments(name)
            self.assertEqual(values["FACTORY_SPOOL_DIR"], "/srv/factory/spool", name)
            self.assertEqual(values["FACTORY_MIRROR_DIR"], "/srv/factory/mirror", name)

    def test_every_line_reads_the_same_to_systemd_and_to_the_shell(self):
        for name in EXAMPLES:
            for number, line in enumerate(read(DEPLOY / name).splitlines(), 1):
                with self.subTest(file=name, line=number):
                    if line and not line.startswith("#"):
                        match = ASSIGNMENT.fullmatch(line)
                        self.assertIsNotNone(match)
                        self.assertIsNone(re.search(r"[\s'\"#$`\\]", match.group(2)))

    def test_no_line_of_an_example_has_a_hygiene_finding(self):
        for name in EXAMPLES:
            for number, line in enumerate(read(DEPLOY / name).splitlines(), 1):
                self.assertEqual(hygiene.line_problems(line), [], f"{name}:{number}")


class HostGuideTests(unittest.TestCase):
    def setUp(self) -> None:
        self.text = read(GUIDE)

    def test_the_guide_explains_every_reason_a_run_can_record_in_the_words_of_its_comment(self):
        self.assertEqual(set(compose.REASON_WORDS), set(spool.RUN_REASONS))
        for reason in spool.RUN_REASONS:
            self.assertIn(f"`{reason}`", self.text)
            self.assertIn(compose.REASON_WORDS[reason], self.text)

    def test_the_guide_explains_every_outcome_word_of_a_run_comment(self):
        for word in compose.OUTCOME_WORDS.values():
            self.assertIn(word, self.text)

    def test_the_guide_names_every_environment_variable(self):
        for variable in {*dispatcher_variables(), *runner_variables()}:
            self.assertIn(f"`{variable}`", self.text)

    def test_the_guide_runs_the_three_commands(self):
        for module in COMMANDS:
            self.assertIn(f"python3 -m {module}", self.text)


class IssueFormTests(unittest.TestCase):
    """The issue forms are simple YAML; they are checked by text, since the tools use no YAML library."""

    NAMES = ("fix.yml", "task.yml")

    def test_each_form_has_the_top_level_keys_of_an_issue_form_and_sets_no_labels(self):
        for name in self.NAMES:
            lines = read(FORMS / name).splitlines()
            top = {line.partition(":")[0] for line in lines if line and not line[0].isspace() and ":" in line}
            self.assertLessEqual({"name", "description", "body"}, top, name)
            self.assertFalse([line for line in lines if line.strip().startswith("labels:")], name)

    def test_each_field_has_a_known_type_and_a_unique_id(self):
        for name in self.NAMES:
            text = read(FORMS / name)
            types = re.findall(r"^  - type: (\S+)$", text, re.MULTILINE)
            ids = re.findall(r"^    id: (\S+)$", text, re.MULTILINE)
            self.assertTrue(types, name)
            self.assertLessEqual(set(types), FORM_FIELD_TYPES, name)
            self.assertEqual(len(ids), len(set(ids)), name)
            self.assertEqual(len(ids), len([kind for kind in types if kind != "markdown"]), name)

    def test_each_form_asks_for_the_app_under_the_heading_the_dispatcher_reads(self):
        # GitHub shows an answer under a heading made of the field's label, and the dispatcher reads that heading.
        label = jobs.APP_HEADING.removeprefix("### ")
        for name in self.NAMES:
            self.assertRegex(read(FORMS / name), rf"(?m)^    id: app\n    attributes:\n      label: {label}$", name)

    def test_each_form_says_a_maintainer_labels_it_and_only_trusted_text_reaches_the_agent(self):
        for name in self.NAMES:
            text = read(FORMS / name)
            self.assertIn("`factory:fix`", text, name)
            self.assertIn("restates the request in a comment", text, name)
            self.assertNotIn("still being built", text, name)

    def test_the_epic_form_says_the_epic_pipeline_is_not_built_and_a_maintainer_handles_epics_by_hand(self):
        text = read(FORMS / "epic.yml")
        self.assertIn("The epic pipeline is not built yet.", text)
        self.assertIn("a maintainer handles labelled epics by hand", text)
        self.assertNotIn("dispatcher", text)
        self.assertNotIn("still being built", text)


if __name__ == "__main__":
    unittest.main()
