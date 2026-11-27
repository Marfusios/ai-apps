"""Tests for the agent image: the managed settings, the build context, the harness digest and the build command."""

import contextlib
import copy
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from factory import pod, runner
from factory.config import ConfigError, load
from factory.image import build, managed_settings

ROOT = Path(__file__).resolve().parents[2]
CONFIG = load()


EXPECTED_PATHS_COMMAND = ("FACTORY_HOOK_PYTHON=/usr/bin/python3 /bin/sh /opt/factory/harness/.claude/hooks/run "
                          "guard_paths")


def project_settings() -> dict:
    return json.loads((ROOT / ".claude" / "settings.json").read_text(encoding="utf-8"))


def copy_harness(destination: Path) -> None:
    """Copy the files HARNESS_FILES names, and a document that it does not, into a fresh tree."""
    for pattern in build.HARNESS_FILES:
        for path in ROOT.glob(pattern):
            if path.is_file():
                target = destination / path.relative_to(ROOT)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(path.read_bytes())
    (destination / "README.md").write_text("a document\n", encoding="utf-8")


class TemporaryDirectoryTestCase(unittest.TestCase):
    def setUp(self) -> None:
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.tmp = Path(holder.name).resolve()


class ManagedSettingsTests(unittest.TestCase):
    def test_managed_settings_point_every_hook_at_the_image_copy(self):
        project = project_settings()
        managed = managed_settings.build(project)
        commands = [h["command"] for group in managed["hooks"].values() for entry in group for h in entry["hooks"]]
        self.assertEqual(len(commands), 4)
        self.assertTrue(all("/opt/factory/harness/.claude/hooks/run" in c and "CLAUDE_PROJECT_DIR" not in c
                            for c in commands))
        self.assertIs(managed["allowManagedHooksOnly"], True)
        self.assertTrue(set(project["permissions"]["ask"]) <= set(managed["permissions"]["deny"]))

    def test_only_the_managed_keys_remain_and_the_rules_keep_their_order_without_duplicates(self):
        project = project_settings()
        project["permissions"]["ask"] = [project["permissions"]["deny"][0], "Bash(gh pr merge *)"]
        managed = managed_settings.build(project)
        self.assertEqual(set(managed), {"allowManagedHooksOnly", "attribution", "env", "hooks", "includeCoAuthoredBy",
                                        "permissions"})
        self.assertEqual(set(managed["permissions"]), {"deny"})
        self.assertEqual(managed["permissions"]["deny"], project["permissions"]["deny"] + ["Bash(gh pr merge *)"])

    def test_the_clis_attribution_is_switched_off_whatever_the_project_file_says(self):
        project = {**project_settings(), "attribution": {"commit": "Generated", "pr": "Generated"},
                   "includeCoAuthoredBy": True}
        managed = managed_settings.build(project)
        self.assertEqual(managed["attribution"], {"commit": "", "pr": ""})
        self.assertIs(managed["includeCoAuthoredBy"], False)

    def test_the_factory_variables_are_fixed_as_the_runner_passes_them_so_no_settings_file_can_change_them(self):
        managed = managed_settings.build({**project_settings(), "env": {"FACTORY_RUN": "0"}})
        self.assertEqual(managed["env"], {"FACTORY_RUN": "1", "FACTORY_JOB_DIR": "/factory/job",
                                          "FACTORY_RESULT_PATH": "/factory/out/result.json"})
        request = {"stage": "fix_issue", "skill": "factory-fix-issue", "base_sha": "a" * 40, "model": "opus",
                   "permission_mode": "auto", "max_turns": 300}
        argv = pod.agent_argv(request, pod.Mounts(Path("c"), Path("j"), Path("o")), "localhost/agent:1", "x")
        passed = dict(value.split("=", 1) for flag, value in zip(argv, argv[1:]) if flag == "--env" and "=" in value)
        self.assertEqual({name: passed[name] for name in managed["env"]}, managed["env"])

    def test_the_other_keys_of_each_hook_entry_are_kept_and_the_input_is_left_alone(self):
        project = project_settings()
        before = copy.deepcopy(project)
        managed = managed_settings.build(project)
        self.assertEqual(project, before)
        entry = managed["hooks"]["PreToolUse"][1]
        self.assertEqual(entry["matcher"], "Edit|Write|MultiEdit|NotebookEdit")
        self.assertEqual(entry["hooks"][0], {"type": "command", "timeout": 20,
                                             "command": EXPECTED_PATHS_COMMAND})

    def test_every_command_names_its_interpreter_and_the_absolute_shell(self):
        managed = managed_settings.build(project_settings())
        commands = {h["command"] for group in managed["hooks"].values() for entry in group for h in entry["hooks"]}
        self.assertEqual(commands, {
            f"FACTORY_HOOK_PYTHON=/usr/bin/python3 /bin/sh /opt/factory/harness/.claude/hooks/run {name}"
            for name in managed_settings.EXPECTED_HOOKS})

    def test_an_unexpected_hook_command_fails_the_build(self):
        project = project_settings()
        project["hooks"]["Stop"][0]["hooks"][0]["command"] = "sh ./finish_check.sh"
        with self.assertRaisesRegex(ValueError, "Stop"):
            managed_settings.build(project)

    def test_a_command_that_does_not_start_with_the_project_launcher_fails_the_build(self):
        launcher = 'sh "$CLAUDE_PROJECT_DIR/.claude/hooks/run" guard_git'
        for command in (f"true || {launcher}", f" {launcher}", f"bash {launcher[3:]}",
                        launcher.replace("sh ", "FOO=1 sh ", 1)):
            with self.subTest(command=command):
                project = project_settings()
                project["hooks"]["PreToolUse"][0]["hooks"][0]["command"] = command
                with self.assertRaisesRegex(ValueError, "PreToolUse"):
                    managed_settings.build(project)

    def test_a_guard_removed_from_the_settings_fails_the_build(self):
        project = project_settings()
        del project["hooks"]["PreToolUse"][1]["hooks"][1]
        with self.assertRaisesRegex(ValueError, "guard_quality"):
            managed_settings.build(project)

    def test_a_hook_that_is_not_expected_fails_the_build(self):
        project = project_settings()
        project["hooks"]["Stop"][0]["hooks"].append(
            {"type": "command", "command": 'sh "$CLAUDE_PROJECT_DIR/.claude/hooks/run" extra'})
        with self.assertRaisesRegex(ValueError, "extra"):
            managed_settings.build(project)

    def test_settings_without_a_pre_tool_use_or_a_stop_command_fail_the_build(self):
        for event in ("PreToolUse", "Stop"):
            with self.subTest(event=event):
                project = project_settings()
                del project["hooks"][event]
                with self.assertRaisesRegex(ValueError, event):
                    managed_settings.build(project)

    def test_wrongly_shaped_hooks_fail_the_build(self):
        shapes = ({"Stop": ["x"]}, {"Stop": {"hooks": []}}, {"Stop": [{"hooks": "x"}]}, {"Stop": [{"hooks": ["x"]}]},
                  {"Stop": [{"hooks": [{"command": 1}]}]}, ["x"])
        for hooks in shapes:
            with self.subTest(hooks=hooks):
                project = project_settings()
                project["hooks"] = hooks
                with self.assertRaises(ValueError):
                    managed_settings.build(project)

    def test_settings_without_hooks_fail_the_build(self):
        with self.assertRaises(ValueError):
            managed_settings.build({"permissions": {"deny": [], "ask": []}})


class WriteContextTests(TemporaryDirectoryTestCase):
    def test_the_context_holds_the_harness_in_the_repository_layout(self):
        build.write_context(ROOT, self.tmp)
        for name in ("Containerfile", "managed-settings.json", "harness/.claude/hooks/run",
                     "harness/.claude/hooks/finish_check.py", "harness/factory/config.py",
                     "harness/factory/config.toml", "harness/factory/result.py"):
            self.assertTrue((self.tmp / name).is_file(), name)
        self.assertFalse((self.tmp / "harness" / "factory" / "tests").exists())

    def test_the_context_leaves_out_what_the_hooks_do_not_need(self):
        build.write_context(ROOT, self.tmp)
        harness = self.tmp / "harness"
        self.assertEqual({p.name for p in harness.iterdir()}, {".claude", "factory"})
        self.assertEqual({p.name for p in (harness / ".claude").iterdir()}, {"hooks"})
        self.assertFalse(any(p.is_dir() for p in (harness / ".claude" / "hooks").iterdir()))
        self.assertFalse(any(p.is_dir() for p in (harness / "factory").iterdir()))
        self.assertEqual({p.suffix for p in (harness / "factory").iterdir()}, {".py", ".toml"})

    def test_the_managed_settings_file_is_the_same_bytes_every_time(self):
        build.write_context(ROOT, self.tmp / "one")
        build.write_context(ROOT, self.tmp / "two")
        first = (self.tmp / "one" / "managed-settings.json").read_bytes()
        self.assertEqual(first, (self.tmp / "two" / "managed-settings.json").read_bytes())
        self.assertTrue(first.endswith(b"}\n"))
        self.assertEqual(json.loads(first), managed_settings.build(project_settings()))

    def test_the_context_holds_lf_files_whatever_the_checkout_holds(self):
        tree = self.tmp / "tree"
        copy_harness(tree)
        launcher = tree / ".claude" / "hooks" / "run"
        launcher.write_bytes(launcher.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
        build.write_context(tree, self.tmp / "context")
        copied = (self.tmp / "context" / "harness" / ".claude" / "hooks" / "run").read_bytes()
        self.assertNotIn(b"\r", copied)
        self.assertIn(b"\n", copied)

    def test_a_destination_that_already_holds_something_is_refused(self):
        (self.tmp / "left-over").write_text("x", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            build.write_context(ROOT, self.tmp)
        self.assertEqual([p.name for p in self.tmp.iterdir()], ["left-over"])

    def test_the_copied_hooks_import_the_copied_factory_package(self):
        context = self.tmp / "context"
        build.write_context(ROOT, context)
        project, elsewhere = self.tmp / "project", self.tmp / "elsewhere"
        project.mkdir()
        elsewhere.mkdir()
        event = {"tool_name": "Write", "tool_input": {"file_path": str(project / "README.md"), "content": "x"},
                 "cwd": str(project)}
        env = {name: value for name, value in os.environ.items() if name != "PYTHONPATH"}
        env.update(FACTORY_RUN="1", CLAUDE_PROJECT_DIR=str(project))
        done = subprocess.run([sys.executable, str(context / "harness" / ".claude" / "hooks" / "guard_paths.py")],
                              input=json.dumps(event), capture_output=True, text=True, cwd=elsewhere, env=env,
                              timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")


    def test_the_copied_package_imports_the_modules_the_hooks_load_late(self):
        context = self.tmp / "context"
        build.write_context(ROOT, context)
        elsewhere = self.tmp / "elsewhere"
        elsewhere.mkdir()
        env = {name: value for name, value in os.environ.items() if name != "PYTHONPATH"}
        code = ("import sys; sys.path.insert(0, sys.argv[1]); "
                "import factory.config, factory.app_config, factory.result; print(factory.result.__file__)")
        harness = context / "harness"
        done = subprocess.run([sys.executable, "-c", code, str(harness)], capture_output=True, text=True,
                              cwd=elsewhere, env=env, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue(Path(done.stdout.strip()).is_relative_to(harness), done.stdout)


class DigestTests(TemporaryDirectoryTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.tree = self.tmp / "tree"
        copy_harness(self.tree)

    def test_the_digest_changes_with_a_hook_and_not_with_a_document(self):
        before = build.harness_digest(self.tree)
        (self.tree / "README.md").write_text("another document\n", encoding="utf-8")
        self.assertEqual(build.harness_digest(self.tree), before)
        with (self.tree / ".claude" / "hooks" / "guard_git.py").open("a", encoding="utf-8") as hook:
            hook.write("# changed\n")
        self.assertNotEqual(build.harness_digest(self.tree), before)

    def test_the_digest_is_the_same_when_a_checkout_holds_crlf_line_endings(self):
        before = build.harness_digest(self.tree)
        hook = self.tree / ".claude" / "hooks" / "guard_paths.py"
        hook.write_bytes(hook.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
        self.assertEqual(build.harness_digest(self.tree), before)

    def test_the_digest_ignores_bytecode_and_changes_with_a_new_harness_file(self):
        before = build.harness_digest(self.tree)
        cache = self.tree / ".claude" / "hooks" / "__pycache__"
        cache.mkdir()
        (cache / "guard_git.cpython-311.pyc").write_bytes(b"\0")
        (self.tree / "factory" / "stray.pyc").write_bytes(b"\0")
        self.assertEqual(build.harness_digest(self.tree), before)
        (self.tree / "factory" / "added.py").write_text("", encoding="utf-8")
        self.assertNotEqual(build.harness_digest(self.tree), before)

    def test_moving_bytes_between_two_files_changes_the_digest(self):
        (self.tree / "factory" / "a.py").write_bytes(b"ab")
        (self.tree / "factory" / "b.py").write_bytes(b"")
        before = build.harness_digest(self.tree)
        (self.tree / "factory" / "a.py").write_bytes(b"a")
        (self.tree / "factory" / "b.py").write_bytes(b"b")
        self.assertNotEqual(build.harness_digest(self.tree), before)

    def test_a_checkout_below_a_directory_named_pycache_is_still_digested(self):
        nested = self.tmp / "__pycache__" / "checkout"
        copy_harness(nested)
        self.assertEqual(build.harness_digest(nested), build.harness_digest(self.tree))

    def test_the_digest_is_a_sha256_hex_string(self):
        self.assertRegex(build.harness_digest(self.tree), r"^[0-9a-f]{64}$")


class BuildArgvTests(unittest.TestCase):
    def test_build_argv_carries_the_pinned_version_the_base_image_and_the_label(self):
        argv = build.build_argv(Path("ctx"), "factory-agent:1", CONFIG, "abc")
        self.assertEqual(argv, [
            "podman", "build",
            "--build-arg", f"BASE_IMAGE={CONFIG.agent.base_image}",
            "--build-arg", f"CLAUDE_CODE_VERSION={CONFIG.agent.claude_code_version}",
            "--label", "factory.harness=abc",
            "-t", "factory-agent:1", str(Path("ctx"))])


class ContainerfileTests(unittest.TestCase):
    def test_the_containerfile_ends_as_the_unprivileged_user(self):
        lines = (ROOT / "factory" / "image" / "Containerfile").read_text(encoding="utf-8").splitlines()
        self.assertEqual([line for line in lines if line.startswith("USER ")][-1], "USER node")
        self.assertEqual(lines[-1], "WORKDIR /workspace")

    def test_the_agent_cannot_write_where_the_system_looks_first(self):
        text = (ROOT / "factory" / "image" / "Containerfile").read_text(encoding="utf-8")
        lines = text.splitlines()
        self.assertNotIn("chown", text)
        # the home is an ARG so that no line holds a literal home-directory path, which the repository checker refuses
        self.assertIn("ARG AGENT_HOME=/home/node", lines)
        self.assertIn("ENV NPM_CONFIG_PREFIX=${AGENT_HOME}/.npm-global", lines)
        self.assertIn("ENV PATH=${PATH}:${AGENT_HOME}/.npm-global/bin", lines)
        self.assertLess(lines.index("ENV PATH=${PATH}:${AGENT_HOME}/.npm-global/bin"), lines.index("USER node"))
        installs = text[text.index("RUN npm install -g"):text.index("COPY harness")]
        self.assertIn("corepack enable", installs)
        self.assertIn("claude-code", installs)

    def test_tini_is_process_1_and_python_can_make_virtual_environments(self):
        lines = (ROOT / "factory" / "image" / "Containerfile").read_text(encoding="utf-8").splitlines()
        install = next(line for line in lines if "apt-get install" in line).split()
        for package in ("git", "python3", "ca-certificates", "tini", "python3-venv", "python3-pip"):
            with self.subTest(package=package):
                self.assertIn(package, install)
        # tini reaps the processes the agent's tools leave behind, which the CLI as process 1 would not
        entrypoint = 'ENTRYPOINT ["/usr/bin/tini", "--"]'
        self.assertIn(entrypoint, lines)
        self.assertLess(lines.index(entrypoint), lines.index("USER node"))

    def test_the_comment_on_the_path_claims_only_what_the_lines_below_it_do(self):
        lines = (ROOT / "factory" / "image" / "Containerfile").read_text(encoding="utf-8").splitlines()
        comment = lines[lines.index("ARG AGENT_HOME=/home/node") - 1]
        self.assertTrue(comment.startswith("# "), comment)
        self.assertNotIn("nothing it can write", comment)
        self.assertIn("PATH", comment)

    def test_the_image_label_and_name_are_the_ones_the_runner_checks(self):
        self.assertEqual(build.IMAGE_LABEL, runner.IMAGE_LABEL)
        self.assertIs(runner.IMAGE_NAME, build.IMAGE_NAME)


class MainTests(TemporaryDirectoryTestCase):
    def run_main(self, argv: list[str], environment: dict[str, str]) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, environment, clear=True), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            status = build.main(argv)
        return status, out.getvalue(), err.getvalue()

    def test_a_missing_or_empty_image_name_is_an_error_and_starts_nothing(self):
        for environment in ({}, {"FACTORY_IMAGE": ""}):
            with self.subTest(environment=environment), mock.patch.object(build.subprocess, "run") as run:
                status, _, err = self.run_main([], environment)
                self.assertEqual(status, 2)
                self.assertIn("FACTORY_IMAGE", err)
                run.assert_not_called()

    def test_an_image_name_that_could_be_read_as_an_option_is_refused(self):
        for name in ("--help", "-t", "Upper", "a b", "x:"):
            with self.subTest(name=name), mock.patch.object(build.subprocess, "run") as run:
                status, _, err = self.run_main([], {"FACTORY_IMAGE": name})
                self.assertEqual(status, 2)
                self.assertIn("FACTORY_IMAGE", err)
                run.assert_not_called()

    def test_print_digest_prints_the_digest_and_runs_nothing(self):
        with mock.patch.object(build.subprocess, "run") as run:
            status, out, _ = self.run_main(["--print-digest"], {})
        self.assertEqual(status, 0)
        self.assertEqual(out.strip(), build.harness_digest(ROOT))
        run.assert_not_called()

    def test_a_configuration_that_cannot_be_loaded_is_a_one_line_message_and_status_2(self):
        error = ConfigError("cannot read config.toml: broken")
        with mock.patch.object(build, "load_config", side_effect=error), \
                mock.patch.object(build.subprocess, "run") as run:
            status, out, err = self.run_main([], {"FACTORY_IMAGE": "factory-agent:1"})
        self.assertEqual(status, 2)
        self.assertEqual(out, "")
        self.assertEqual(err, "the factory configuration cannot be loaded: cannot read config.toml: broken\n")
        run.assert_not_called()

    def test_the_build_gets_a_context_that_is_removed_afterwards_and_podmans_status_is_returned(self):
        seen: dict = {}

        def fake_run(argv, **_):
            context = Path(argv[-1])
            seen.update(argv=argv, context=context, had_containerfile=(context / "Containerfile").is_file())
            return subprocess.CompletedProcess(argv, 3)

        with mock.patch.object(build.subprocess, "run", side_effect=fake_run):
            status, _, _ = self.run_main([], {"FACTORY_IMAGE": "factory-agent:1"})
        self.assertEqual(status, 3)
        self.assertTrue(seen["had_containerfile"])
        self.assertFalse(seen["context"].exists())
        self.assertEqual(seen["argv"][:2], ["podman", "build"])
        self.assertIn(f"factory.harness={build.harness_digest(ROOT)}", seen["argv"])
        self.assertEqual(seen["argv"][-3:-1], ["-t", "factory-agent:1"])

    def test_the_context_is_removed_when_the_build_cannot_start(self):
        seen: dict = {}

        def fake_run(argv, **_):
            seen["context"] = Path(argv[-1])
            raise FileNotFoundError("podman")

        with mock.patch.object(build.subprocess, "run", side_effect=fake_run):
            status, _, err = self.run_main([], {"FACTORY_IMAGE": "factory-agent:1"})
        self.assertNotEqual(status, 0)
        self.assertIn("podman", err)
        self.assertFalse(seen["context"].exists())


if __name__ == "__main__":
    unittest.main()
