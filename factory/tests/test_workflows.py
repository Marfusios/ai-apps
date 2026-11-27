"""Text checks of the GitHub workflow files; there is no YAML library, so they read lines."""

import re
import unittest
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"
PINNED_ACTION = re.compile(r"^\s*(?:-\s+)?uses:\s*\S+@[0-9a-f]{40}\s+# v\d")


def workflow_files() -> list[Path]:
    return sorted(WORKFLOWS.glob("*.yml"))


def read(name: str) -> str:
    return (WORKFLOWS / name).read_text(encoding="utf-8")


def jobs(text: str) -> dict[str, str]:
    """Return each job's text block, keyed by the job's name."""
    blocks: dict[str, list[str]] = {}
    current = None
    in_jobs = False
    for line in text.splitlines():
        if re.match(r"^\S", line):
            in_jobs = line.startswith("jobs:")
            current = None
        elif in_jobs and (match := re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)):
            current = match.group(1)
            blocks[current] = []
        elif current is not None:
            blocks[current].append(line)
    return {name: "\n".join(lines) for name, lines in blocks.items()}


def run_blocks(text: str) -> list[str]:
    """Return the script text of every `run:` step, single-line or block."""
    scripts: list[str] = []
    lines = text.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"^(\s*)(?:-\s+)?run:\s*(.*)$", line)
        if not match:
            continue
        if match.group(2) not in ("|", ">", "|-", ">-"):
            scripts.append(match.group(2))
            continue
        indent = len(match.group(1))
        body = []
        for following in lines[index + 1:]:
            if following.strip() and len(following) - len(following.lstrip()) <= indent:
                break
            body.append(following)
        scripts.append("\n".join(body))
    return scripts


def permission_lines(text: str) -> list[str]:
    """Return the indented lines of every `permissions:` mapping."""
    found: list[str] = []
    lines = text.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"^(\s*)permissions:\s*$", line)
        if not match:
            continue
        for following in lines[index + 1:]:
            if not following.strip() or len(following) - len(following.lstrip()) <= len(match.group(1)):
                break
            found.append(following.strip())
    return found


class EveryWorkflowTests(unittest.TestCase):
    def test_there_are_workflows_to_check(self) -> None:
        self.assertTrue(workflow_files())

    def test_every_action_is_pinned_to_a_commit_with_a_version_comment(self) -> None:
        for path in workflow_files():
            for line in path.read_text(encoding="utf-8").splitlines():
                if re.match(r"^\s*(?:-\s+)?uses:", line):
                    self.assertRegex(line, PINNED_ACTION, f"{path.name}: {line.strip()}")

    def test_no_workflow_uses_pull_request_target(self) -> None:
        for path in workflow_files():
            self.assertNotIn("pull_request_target", path.read_text(encoding="utf-8"), path.name)


class AppChecksWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.text = read("app-checks.yml")

    def test_has_the_three_jobs_the_dispatcher_and_the_matrix_rely_on(self) -> None:
        self.assertEqual(set(jobs(self.text)), {"plan", "app", "apps"})

    def test_may_only_read_the_repository(self) -> None:
        self.assertEqual(permission_lines(self.text), ["contents: read"])

    def test_no_event_value_is_expanded_inside_a_script(self) -> None:
        for script in run_blocks(self.text):
            self.assertNotIn("${{ github.event", script)

    def test_the_apps_job_is_the_single_gate(self) -> None:
        block = jobs(self.text)["apps"]
        self.assertIn("if: always()", block)
        self.assertRegex(block, r"needs:\s*\[plan, app\]")


if __name__ == "__main__":
    unittest.main()
