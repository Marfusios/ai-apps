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

    def test_no_script_expands_an_expression_at_all(self) -> None:
        for script in run_blocks(self.text):
            self.assertNotIn("${{", script)

    def test_the_app_job_never_runs_the_bare_python_the_app_may_replace(self) -> None:
        block = jobs(self.text)["app"]
        for script in run_blocks(block):
            self.assertNotRegex(script, r"(?<![\w$\"/.-])python3?\b")
        tools = re.search(r"- uses: actions/setup-python.*?(?=\n      - )", block, re.S).group(0)
        self.assertIn("id: tools", tools)
        self.assertIn("update-environment: false", tools)
        self.assertIn("steps.tools.outputs.python-path", block)

    def test_the_apps_job_reads_both_results_and_accepts_a_skipped_app(self) -> None:
        block = jobs(self.text)["apps"]
        self.assertIn("needs.plan.result", block)
        self.assertIn("needs.app.result", block)
        self.assertRegex(block, r"success \| skipped\) ;;")

    def test_the_apps_job_is_the_single_gate(self) -> None:
        block = jobs(self.text)["apps"]
        self.assertIn("if: always()", block)
        self.assertRegex(block, r"needs:\s*\[plan, app\]")


SAME_REPOSITORY = "github.event.pull_request.head.repo.full_name == github.repository"
CODEX_ACTION = "openai/codex-action@306c6a196a99dcc6582530c396a19d2672d5e9ec # v1.14"


def steps(block: str) -> dict[str, str]:
    """Return each step's text of a job, keyed by its id (or its name when it has none)."""
    found: dict[str, str] = {}
    for chunk in re.split(r"\n      - (?=\S)", block)[1:]:
        key = re.search(r"^\s*id:\s*(\S+)", chunk, re.M) or re.search(r"^(?:name:\s*)?(.+)$", chunk, re.M)
        found[key.group(1)] = chunk
    return found


class ReviewWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.text = read("review.yml")
        self.jobs = jobs(self.text)

    def test_runs_on_pull_requests_with_no_permissions_by_default(self) -> None:
        self.assertEqual(set(self.jobs), {"codex", "review"})
        self.assertRegex(self.text, r"(?m)^permissions: \{\}$")
        self.assertNotRegex(self.text, r"(?m)^permissions:\s*$")
        self.assertRegex(self.text, r"types: \[opened, synchronize, reopened\]")
        self.assertNotIn("ready_for_review", self.text)

    def test_one_review_per_pull_request_and_a_new_push_cancels_the_old(self) -> None:
        self.assertRegex(self.text, r"group: review-\$\{\{ github\.event\.pull_request\.number \}\}")
        self.assertIn("cancel-in-progress: true", self.text)

    def test_both_jobs_run_only_for_a_branch_of_this_repository(self) -> None:
        for name, block in self.jobs.items():
            with self.subTest(name):
                self.assertRegex(block, rf"(?m)^    if: .*{re.escape(SAME_REPOSITORY)}")

    def test_the_api_key_is_in_the_job_that_only_reads_and_nowhere_else(self) -> None:
        codex = self.jobs["codex"]
        self.assertEqual(permission_lines(codex), ["contents: read"])
        self.assertNotIn("write", codex)
        self.assertEqual(self.text.count("secrets."), 2)
        lines = [line.strip() for line in codex.splitlines() if "secrets.OPENAI_API_KEY" in line]
        self.assertEqual(lines, ["openai-api-key: ${{ secrets.OPENAI_API_KEY }}"] * 2)

    def test_the_job_that_comments_holds_no_secret_and_runs_only_base_code(self) -> None:
        block = self.jobs["review"]
        self.assertEqual(permission_lines(block), ["contents: read", "pull-requests: write"])
        self.assertNotIn("secrets.", block)
        self.assertNotIn("OPENAI", block)
        self.assertIn("ref: ${{ github.event.pull_request.base.sha }}", block)
        self.assertNotIn("refs/pull", block)
        self.assertIn("persist-credentials: false", block)
        self.assertIn("python-version: \"3.11\"", block)

    def test_the_review_job_is_the_check_other_programs_wait_for(self) -> None:
        block = self.jobs["review"]
        self.assertRegex(block, r"(?m)^    needs: codex$")
        self.assertRegex(block, r"(?m)^    if: always\(\) && ")

    def test_the_codex_checkout_is_the_merge_ref_without_credentials(self) -> None:
        checkout = steps(self.jobs["codex"])["uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1"]
        self.assertIn("ref: refs/pull/${{ github.event.pull_request.number }}/merge", checkout)
        self.assertIn("persist-credentials: false", checkout)

    def test_prompt_and_schema_come_from_the_base_commit_outside_the_checkout(self) -> None:
        script = run_blocks(steps(self.jobs["codex"])["prepare"])[0]
        self.assertIn('git show "$BASE_SHA:factory/review/$prompt" > "$RUNNER_TEMP/prompt.md"', script)
        self.assertIn('git show "$BASE_SHA:factory/review/schema.json" > "$RUNNER_TEMP/schema.json"', script)
        self.assertNotIn("LABELS", steps(self.jobs["codex"])["prepare"])
        self.assertNotIn("labels", self.text)
        # Without rename detection a file moved into an epic's documents still lists its old path, so it reads as code.
        self.assertIn('git diff --name-only --no-renames -z "$BASE_SHA...$HEAD_SHA"', script)
        self.assertIn(r'rb"apps/[^/]+/docs/epics/.+"', script)
        self.assertIn("prompt=document.md", script)
        self.assertIn("prompt=code.md", script)
        for value in ("BASE_SHA", "HEAD_SHA", "PR_NUMBER"):
            self.assertRegex(script, rf"printf '[^']*%s\\n' \"\${value}\"")

    def test_a_base_without_the_prompt_makes_the_model_steps_skip(self) -> None:
        found = steps(self.jobs["codex"])
        self.assertIn('echo "ready=false" >> "$GITHUB_OUTPUT"', found["prepare"])
        self.assertIn("steps.prepare.outputs.ready == 'true'", found["first"])

    def test_both_model_steps_use_the_pinned_action_read_only_and_may_fail(self) -> None:
        found = steps(self.jobs["codex"])
        for key, model in (("first", "FACTORY_REVIEW_MODEL"), ("fallback", "FACTORY_REVIEW_FALLBACK_MODEL")):
            with self.subTest(key):
                step = found[key]
                self.assertIn(f"uses: {CODEX_ACTION}", step)
                self.assertIn("continue-on-error: true", step)
                self.assertIn('permission-profile: ":read-only"', step)
                self.assertIn("prompt-file: ${{ runner.temp }}/prompt.md", step)
                self.assertIn("output-schema-file: ${{ runner.temp }}/schema.json", step)
                self.assertIn(f"model: ${{{{ vars.{model} }}}}", step)
                self.assertIn("allow-bot-users: mk-factory", step)

    def test_a_hung_model_call_ends_inside_its_step_so_the_report_still_runs(self) -> None:
        found = steps(self.jobs["codex"])
        for key in ("first", "fallback"):
            self.assertIn("timeout-minutes: 12", found[key], key)
        self.assertRegex(self.jobs["codex"], r"(?m)^    timeout-minutes: 30$")

    def test_the_codex_cli_is_pinned(self) -> None:
        found = steps(self.jobs["codex"])
        for key in ("first", "fallback"):
            self.assertIn('codex-version: "0.172.0"', found[key], key)

    def test_the_answer_step_is_the_last_one_of_the_codex_job(self) -> None:
        self.assertEqual(list(steps(self.jobs["codex"]))[-1], "answer")

    def test_the_fallback_runs_only_after_a_failure_and_when_it_is_configured(self) -> None:
        self.assertIn("if: steps.first.outcome == 'failure' && vars.FACTORY_REVIEW_FALLBACK_MODEL != ''",
                      steps(self.jobs["codex"])["fallback"])

    def test_the_job_answers_with_the_fallback_when_it_succeeded_else_the_first(self) -> None:
        block = self.jobs["codex"]
        step = steps(block)["answer"]
        self.assertIn("answer: ${{ steps.answer.outputs.answer }}", block)
        self.assertIn("FALLBACK: ${{ steps.fallback.outputs.final-message }}", step)
        self.assertIn("FIRST: ${{ steps.first.outputs.final-message }}", step)
        script = run_blocks(step)[0]
        self.assertIn("answer=${FALLBACK:-$FIRST}", script)
        self.assertIn("wc -c", script)
        self.assertIn("-le 100000", script)
        self.assertIn('echo "answer<<$delimiter"', script)
        self.assertIn("/dev/urandom", script)
        self.assertIn(">> \"$GITHUB_OUTPUT\"", script)
        self.assertIn("model: ${{ steps.fallback.outcome == 'success' && vars.FACTORY_REVIEW_FALLBACK_MODEL"
                      " || vars.FACTORY_REVIEW_MODEL }}", block)

    def test_the_report_runs_from_the_base_and_posts_before_it_exits_with_its_status(self) -> None:
        script = run_blocks(steps(self.jobs["review"])["Report the verdict as a comment"])[0]
        self.assertIn("if [ ! -f factory/review/report.py ]", script)
        self.assertIn("python -m factory.review.report --answer-file \"$RUNNER_TEMP/answer.json\" "
                      "--head \"$HEAD_SHA\" --model \"$MODEL\" --out \"$RUNNER_TEMP/comment.md\"", script)
        self.assertIn("|| status=$?", script)
        self.assertIn('if [ -s "$RUNNER_TEMP/comment.md" ]; then', script)
        self.assertIn('gh api "repos/$REPOSITORY/issues/$PR_NUMBER/comments" -F "body=@$RUNNER_TEMP/comment.md"', script)
        self.assertLess(script.index("gh api"), script.index('exit "$status"'))
        self.assertIn("GH_TOKEN: ${{ github.token }}", self.jobs["review"])
        self.assertIn("ANSWER: ${{ needs.codex.outputs.answer }}", self.jobs["review"])

    def test_no_script_expands_an_expression(self) -> None:
        for script in run_blocks(self.text):
            self.assertNotIn("${{", script)


if __name__ == "__main__":
    unittest.main()
