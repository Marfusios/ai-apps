"""Keep the deployment files, the host guide, the design and the issue forms in line with what the code does."""

import importlib.util
import re
import unittest
from collections.abc import Callable, Mapping
from pathlib import Path

from factory import compose, dispatcher, hygiene, jobs, pod, runner, spool
from factory.config import load as load_config

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "factory" / "deploy"
GUIDE = ROOT / "docs" / "factory" / "HOST_SETUP.md"
DESIGN = ROOT / "docs" / "factory" / "DESIGN.md"
CONFIG = load_config()
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

    def section(self, number: int) -> str:
        return self.text.partition(f"\n## {number}. ")[2].partition("\n## ")[0]

    def assert_says(self, text: str, *words: str) -> None:
        flowing = " ".join(text.split())  # a line break inside a phrase is a space
        for word in words:
            with self.subTest(words=word):
                self.assertIn(word, flowing)

    def test_section_1_counts_tini_as_part_of_the_image(self):
        self.assert_says(self.section(1), "`tini`", "the agent image brings")

    def test_section_4_bounds_the_disk_the_runner_can_fill(self):
        self.assert_says(self.section(4), "file system of a fixed size", "disk quota", "`FACTORY_WORK_DIR`",
                         "container storage", f"{runner.TRANSCRIPT_CAP // 1_000_000} MB")

    def test_section_4_names_the_cpus_setting_beside_the_slice_cap_it_should_agree_with(self):
        self.assert_says(self.section(4), "`cpus`", "`[agent]`", f"cpus = {CONFIG.agent.cpus}",
                         f"CPUQuota={CONFIG.agent.cpus}00%")

    def test_the_check_prints_four_lines_with_the_cpus_the_runner_uses(self):
        step = self.section(7).partition("\n6. ")[2].partition("\n7. ")[0]
        self.assert_says(step, "these four lines", f"cpus: {CONFIG.agent.cpus}")

    def test_the_log_shows_each_action_and_the_end_of_each_publication(self):
        self.assert_says(self.text, "each action it takes", "published as")

    def test_section_5_says_where_the_downloaded_key_may_wait_and_deletes_it(self):
        self.assert_says(self.section(5), "only its owner can read", "rm <downloaded-key-file>")

    def test_section_8_sets_the_umask_before_the_pull_and_stops_the_dispatcher_before_once(self):
        step = self.section(8).partition("\n3. ")[2].partition("\n4. ")[0]
        self.assertLess(step.index("umask 0027"), step.index("pull --ff-only"))
        self.assert_says(step, "`--once`", "stop the dispatcher's service")

    def test_the_guide_says_what_to_do_when_nothing_seems_to_happen(self):
        part = self.text.partition("### When nothing seems to happen\n")[2].partition("\n### ")[0]
        self.assert_says(part, "`status:building`", "eight", "Removing `factory:fix`", "Restart the runner",
                         "merged", "re-applies", "status label", "could not be read in full")

    def test_the_image_paragraph_claims_only_what_keeps_the_guards_on(self):
        step = self.section(7).partition("\n5. ")[2].partition("\n6. ")[0]
        self.assert_says(step, "`-E -s`", "`FACTORY_RUN`", "`tini`")
        self.assertNotIn("nothing the agent can write comes before", " ".join(self.text.split()))

    def test_a_rejected_run_and_an_internal_error_name_what_publishing_can_meet(self):
        self.assert_says(self.text, "the work branch changed on GitHub", "GitHub refused the push",
                         "eight times", "`attempts.json`")


class DesignTests(unittest.TestCase):
    def setUp(self) -> None:
        self.text = read(DESIGN)

    def test_an_issue_carries_at_most_one_status_label(self):
        self.assertIn("At most one at a time.", self.text)
        self.assertNotIn("Exactly one at a time", self.text)

    def test_the_checks_before_publishing_name_the_commit_message_rule(self):
        checks = self.text.partition("**What the dispatcher checks before publishing a result.**")[2]
        checks = checks.partition("**What the bot posts.**")[0]
        for words in ("commit message mentions no person", "`#<issue>`"):
            with self.subTest(words=words):
                self.assertIn(words, checks)

    def test_the_resource_cap_names_the_disk(self):
        (line,) = [line for line in self.text.splitlines() if "resource cap" in line]
        self.assertIn("disk", line)

    def test_the_confinement_says_a_run_sees_only_the_cpus_it_may_use(self):
        confinement = " ".join(self.text.partition("**Confinement on the host.**")[2].partition("**Residual")[0].split())
        self.assertIn("`cpus` in `factory/config.toml`", confinement)

    def test_the_hooks_paragraph_says_how_the_image_starts_them_and_what_it_fixes(self):
        hooks = self.text.partition("**Hooks** (`.claude/hooks/`")[2].partition("### 9.1")[0]
        for words in ("`-E -s`", "user site directory", "`FACTORY_RUN`", "managed settings"):
            with self.subTest(words=words):
                self.assertIn(words, hooks)


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
