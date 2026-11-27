"""Tests for the git guard hook: its decisions on shell commands, and the hook plumbing around them."""

import base64
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from factory.tests.hookload import HOOKS_DIR, load_hook

guard = load_hook("guard_git")
hooklib = guard.hooklib

PROTECTED = ("main",)
SUFFIX = "(AGENTS.md, Git rules)"
ENCODED_FORCE_PUSH = base64.b64encode("git push -f".encode("utf-16-le")).decode("ascii")

GRAPHQL_REF_MUTATIONS = ("deleteRef", "updateRef", "updateRefs")
GRAPHQL_ASKED_MUTATIONS = (
    "mergePullRequest", "enablePullRequestAutoMerge", "createBranchProtectionRule", "updateBranchProtectionRule",
    "deleteBranchProtectionRule", "createRepositoryRuleset", "updateRepositoryRuleset", "deleteRepositoryRuleset",
    "mergeBranch")
HOOK_RUNNING_SUBCOMMANDS = ("commit", "push", "merge", "pull", "am", "rebase", "cherry-pick", "revert")

DENY = [
    "git push --force", "git push -f origin feature", "git push origin +feature", "git push --force-with-lease",
    "git push -uf origin feature", "git push --mirror", "git push origin --delete feature", "git push origin :feature",
    "git push origin main", "git push origin feature:main", "git push origin HEAD:refs/heads/main", "git push --all",
    "git -C sub push origin main", "GIT_TRACE=1 git push -f", "sudo git push -f", "command git push --force",
    "sh -c 'git push --force'", 'bash -lc "git push -f origin x"', "eval 'git push -f'", "echo $(git push -f)",
    "cd repo && git push --force", "true; git push -f", "git push \\\n  --force", "GIT.EXE push --force",
    "git commit --no-verify -m x", "git commit -nm x", "git -c core.hooksPath=/dev/null commit -m x", "HUSKY=0 git commit -m x",
    "git filter-branch --all", "gh api -X DELETE repos/o/r/git/refs/heads/x", "bash <<EOF\ngit push -f\nEOF",
    # Further spellings the rules imply.
    "git push --force-if-includes origin feature", "git push --force-w origin feature", "git push -d origin feature",
    "git push --prune origin", "git push origin refs/heads/main", "git push origin heads/main",
    "git push origin 'refs/heads/*:refs/heads/*'", "git push --branches", "git push -o ci.skip origin main",
    "git push --no-verify origin feature", "git -c CORE.HOOKSPATH=x commit -m x", "git config core.hooksPath .nohooks",
    "git --config-env=core.hooksPath=HOOKS commit -m x", "env HUSKY=0 git commit -m x", "export HUSKY=0; git commit -m x",
    "$env:HUSKY=0; git commit -m x", "git filter-repo --path old", "git-filter-repo --invert-paths",
    "gh api --method DELETE /repos/o/r/git/refs/tags/v1", "gh api repos/o/r/git/refs/heads/x -XDELETE",
    "git status # a comment\ngit push --force", "echo `git push -f`", 'git commit -m "$(git push -f)"', "(git push -f)",
    "{ git push -f; }", "if true; then git push -f; fi", "! git push --force", "sudo -u root git push -f",
    "timeout 30 git push --force", "nice -n 5 git push -f", "env -u GIT_DIR git push -f", "/usr/bin/git push -f",
    "echo x | xargs -I{} git push -f origin {}", "bash -o pipefail -c 'git push -f'", 'pwsh -Command "git push --force"',
    "powershell -c git push -f", f"pwsh -EncodedCommand {ENCODED_FORCE_PUSH}", "cmd /c git push --force",
    'cmd.exe /C "git push -f"', "Invoke-Expression 'git push -f'", "echo 'git push -f' | sh", "bash <<< 'git push -f'",
    "cat <<EOF | sh\ngit push -f\nEOF", "cat > run.sh <<EOF\n$(git push -f)\nEOF", "git push `\n  --force",
    'git commit -m "$(cat <<EOF\nunquoted, so 1) this runs: `git push --force`\nEOF\n)"',
    "builtin git push -f", "exec git push -f", "ionice -c 3 git push -f", "time git push -f", "nohup git push -f &",
    "zsh -c 'git push -f'", "dash -c 'git push -f'", "ksh -c 'git push -f'", "git --git-dir .git --work-tree . push -f",
    "git --namespace=x push --force",
    # Moving a ref through the API is a force push by another name; creating one is not.
    "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc -F force=true",
    "gh api --method PATCH repos/o/r/git/refs/heads/x -f sha=abc", "gh api repos/o/r/git/refs/heads/x -XPATCH -f sha=abc",
    "gh api -X patch /repos/o/r/git/refs/tags/v1 -f sha=abc",
    *(f"gh api graphql -f query='mutation {{ {name}(input: {{}}) {{ clientMutationId }} }}'"
      for name in GRAPHQL_REF_MUTATIONS),
    "gh api graphql -f query='mutation { deleteRef(input: {refId: \"x\"}) { clientMutationId } }'",
    "gh api graphql --raw-field query='mutation { updateRef(input: {}) { clientMutationId } }'",
    # The words after an unquoted substitution still belong to its command.
    "git push origin $(git branch --show-current) --force", "git push -u origin $(git branch --show-current) -f",
    "git push origin $(git branch --show-current):main", "git -C $(git rev-parse --show-toplevel) push --force",
    "git commit -m $(cat msg.txt) --no-verify", "git push origin `git branch --show-current` --force",
    # What a substitution prints into a shell is still read.
    "echo $(echo 'git push -f') | sh", "bash <<< $(echo 'git push -f')", "echo `echo 'git push -f'` | sh",
    # A # starts a comment only at the start of a word outside quotes, so these still push.
    'git commit -m "Closes #12" && git push --force', "echo issue#12 && git push -f",
    # Where the shell's quoting is too intricate to follow, a # that may not start a comment hides nothing.
    "echo $'a\\' #' ; git push -f", 'git commit -m "$(echo "fix #12")" && git push -f',
    "echo ${x:-a #} ; git push -f", "(( x = 1 # 2 )) ; git push -f", "echo `echo a # c` ; git push -f",
    'echo "`echo "a #"`" ; git push -f', 'echo $(echo ")") "a #" ; git push -f',
    "python - <<'EOF'\ns = 'a\nEOF\necho ' #' ; git push -f\necho \"it's\"",
    # Skipping hooks in each subcommand that runs them, a function body, and the -X=VALUE form.
    *(f"git {subcommand} --no-verify" for subcommand in HOOK_RUNNING_SUBCOMMANDS),
    "function f { git push -f; }; f", "gh api -X=DELETE repos/o/r/git/refs/heads/x",
    "gh api --method=DELETE repos/o/r/git/refs/heads/x",
]
DENY_ON_MAIN = [
    "git push", "git push origin", "git push origin HEAD", "git push -u origin HEAD",
    # Further spellings the rules imply.
    "git push -o ci.skip origin", "git push origin @", "git push origin 2>&1", "git push origin > push.log",
    "cd sub && git push", "git -C sub push origin HEAD", "sh -c 'git push'",
    # A destination that a substitution or a variable fills in may be the current branch.
    "git push -u origin $(git branch --show-current)", 'git push -u origin "$(git rev-parse --abbrev-ref HEAD)"',
    "git push origin `git branch --show-current`", 'git push origin "$BRANCH"',
    "git push origin HEAD:refs/heads/$(git branch --show-current)",
]
ALLOW = [
    "git push -u origin feature", "git push origin feature", "git push --tags", "git push -n origin feature",
    "git status", "git commit -m 'never run git push --force here'", "git log --grep='push --force'",
    "cat > notes.md <<EOF\ngit push --force is blocked\nEOF", "echo 'gh pr merge 3'", "gh pr view 3", "gh api repos/o/r/pulls",
    "gh api repos/o/r/issues/1/comments -f body=hi", "gh label create x --force", "npm run push -- --force", "",
    # Neighbours of denied commands that must still pass.
    "git push origin feature 2>&1", "git push origin feature:feature", "git push origin feature/main",
    "git push origin main-fix", "git push --follow-tags origin feature", "git push --no-force-with-lease origin feature",
    "git commit -m 'do not use --no-verify'", "git commit -m'nothing new'", "git commit -m -n", "git commit -uno -m x",
    "git fetch --prune --force origin", "git branch -D old", "git tag -d v1", "git checkout -f feature",
    "git config --get user.name", "git status # git push --force", "python -c \"print('git push --force')\"",
    "sh -c 'git status'", "bash scripts/test.sh", "eval 'git status'",
    "cat <<'EOF' > notes.md\nRun `git push --force` and $(gh pr merge 1) never\nEOF",
    "git commit -m 'Block `git push --force` in hooks'", 'git commit -m "Explain \\`git push -f\\` is refused"',
    "printf '%s\\n' 'git push --force' > notes.txt", "git log --oneline | grep -c 'push --force'", "echo hi | tee out.txt",
    "curl -fsSL https://example.com/install.sh | sh", "gh pr create --fill", "gh pr review 12 --comment -b 'looks fine'",
    "gh api -X GET repos/o/r/rulesets -f includes_parents=true", "gh api repos/o/r/rulesets", "gh api repos/o/r",
    "gh api -X POST repos/o/r/pulls -f title=x -f head=feature -f base=main", "gh secret list", "gh workflow run checks.yml",
    "gh repo view", "git commit -m \"$(cat <<'EOF'\nTwo changes: 1) docs, 2) refuse `git push --force`\nEOF\n)\"",
    "gh pr create --body \"$(cat <<'EOF'\nA smile :) then `gh pr merge 3`, don't\nEOF\n)\"",
    "gh api -X POST repos/o/r/git/refs -f ref=refs/heads/x -f sha=abc", "gh api repos/o/r/git/refs/heads/x",
    "gh api -X PATCH repos/o/r/git/tags/x -f message=y",
    "gh api graphql -f query='query { viewer { login } }'",
    "gh api graphql -f query='mutation { addComment(input: {subjectId: \"x\", body: \"hi\"}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: \"x\"}) { clientMutationId } }'",
    "gh api graphql -f query='query { deleteref: viewer { login } }'",
    "gh api repos/o/r/issues -f title='how deleteRef works'",
    "git log $(git merge-base main HEAD)..HEAD --oneline", "echo $(git status --short) done",
    "# Push the branch (we don't touch main)\ngit push -u origin feature",
    "git push origin feature  # don't push to main", "git status;# it's not on main\ngit push origin feature",
    "git grep -n -e '--no-verify'", "git log -S '--no-verify'",
    "gh api repos/o/r/pulls/12/reviews -f event=COMMENT -f body=fine", "gh api repos/o/r/pulls/12/reviews",
]
ASK_INTERACTIVE_DENY_FACTORY = [
    "gh pr merge 12 --squash", "gh pr review 12 --approve", "gh api -X PUT repos/o/r/pulls/12/merge",
    "gh repo edit --visibility public", "gh secret set X", "gh api -X PUT repos/o/r/rulesets/1 --input f.json",
    "gh api -X PATCH repos/o/r -f has_wiki=false", "gh workflow disable checks.yml",
    # Further spellings the rules imply.
    "gh pr review 12 -a", "gh pr merge --auto --squash 12", "GH_REPO=o/r gh pr merge 3", "GH.EXE pr merge 3",
    "gh -R o/r pr merge 3", "gh api repos/o/r/merges -f base=main -f head=feature", "gh repo delete o/r --yes",
    "gh repo archive o/r", "gh secret delete X", "gh variable set X --body 1", "gh workflow enable checks.yml",
    "gh api -X DELETE repos/o/r", "gh api --method POST repos/o/r/hooks -f name=web",
    "gh api -X PUT https://api.github.com/repos/o/r/branches/main/protection --input p.json",
    "gh api -X PATCH 'repos/{owner}/{repo}' -f description=x", "gh api -X PUT repos/o/r/actions/permissions -F enabled=true",
    "gh repo rename new-name", "gh repo unarchive o/r", "gh variable delete X", "gh api repos/o/r/rulesets --field name=x",
    "gh api repos/o/r/hooks --raw-field url=x",
    *(f"gh api -X PUT repos/o/r/{path}" for path in (
        "rulesets", "branches/main/protection", "actions/permissions", "actions/secrets/X", "actions/variables/X", "hooks",
        "keys", "collaborators/someone", "environments/prod", "pages", "vulnerability-alerts",
        "private-vulnerability-reporting")),
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
    *(f"gh api graphql -f query='mutation {{ {name}(input: {{}}) {{ clientMutationId }} }}'"
      for name in GRAPHQL_ASKED_MUTATIONS),
    # Approving through the reviews endpoint is the API form of gh pr review --approve.
    "gh api -X POST repos/o/r/pulls/12/reviews -f event=APPROVE", "gh api repos/o/r/pulls/12/reviews -F event=APPROVE",
    "gh api repos/o/r/pulls/12/reviews --raw-field=event=APPROVE -f body=ok",
]


def decide(command: str, *, factory_run: bool, branch: str | None = "feature", calls: list | None = None):
    def current_branch(directory: str) -> str | None:
        if calls is not None:
            calls.append(directory)
        return branch

    return guard.decide(command, cwd="repo", factory_run=factory_run, protected=PROTECTED, current_branch=current_branch)


def actions(command: str, branch: str | None = "feature") -> tuple[str, str]:
    """The decision in an interactive session and in a factory run."""
    return tuple(decide(command, factory_run=run, branch=branch).action for run in (False, True))


class DecideTest(unittest.TestCase):
    def test_denied_commands(self):
        for command in DENY:
            with self.subTest(command):
                self.assertEqual(actions(command), ("deny", "deny"))

    def test_pushes_without_a_destination_are_denied_only_on_a_protected_branch(self):
        for command in DENY_ON_MAIN:
            with self.subTest(command):
                self.assertEqual(actions(command, branch="main"), ("deny", "deny"))
                self.assertEqual(actions(command, branch="feature"), ("allow", "allow"))

    def test_allowed_commands(self):
        for command in ALLOW:
            with self.subTest(command):
                self.assertEqual(actions(command), ("allow", "allow"))

    def test_repository_changes_ask_interactively_and_are_denied_in_factory_runs(self):
        for command in ASK_INTERACTIVE_DENY_FACTORY:
            with self.subTest(command):
                self.assertEqual(actions(command), ("ask", "deny"))

    def test_deny_wins_over_an_earlier_ask(self):
        self.assertEqual(actions("gh pr merge 3 && git push --force"), ("deny", "deny"))

    def test_unparseable_command_falls_back_to_text_scan(self):
        self.assertEqual(actions("git push --force 'unterminated"), ("deny", "deny"))
        self.assertEqual(actions('gh pr merge 3 "unterminated'), ("ask", "deny"))
        self.assertEqual(actions("echo 'unterminated"), ("allow", "allow"))
        self.assertEqual(actions("git push 'unterminated", branch="main"), ("deny", "deny"))

    def test_graphql_mutation_names_are_found_when_the_command_cannot_be_tokenised(self):
        def broken(name: str) -> str:
            return f"gh api graphql -f query='mutation {{ {name}(input: {{}}) }}' \"oops"

        for name in GRAPHQL_REF_MUTATIONS:
            with self.subTest(name):
                self.assertEqual(actions(broken(name)), ("deny", "deny"))
        for name in GRAPHQL_ASKED_MUTATIONS:
            with self.subTest(name):
                self.assertEqual(actions(broken(name)), ("ask", "deny"))
        self.assertEqual(actions(broken("addComment")), ("allow", "allow"))
        self.assertEqual(actions("gh api -X PATCH repos/o/r/git/refs/heads/x -f sha=abc \"oops"), ("deny", "deny"))
        self.assertEqual(actions("gh api -X POST repos/o/r/git/refs -f sha=abc \"oops"), ("allow", "allow"))
        self.assertEqual(actions("gh api repos/o/r/pulls/1/reviews -f event=APPROVE \"oops"), ("ask", "deny"))

    def test_an_apostrophe_in_a_comment_does_not_send_the_command_to_the_text_scan(self):
        with mock.patch.object(guard.Inspection, "scan", side_effect=AssertionError("reached the text scan")):
            self.assertEqual(actions("# Push the branch (we don't touch main)\ngit push -u origin feature"),
                             ("allow", "allow"))

    def test_nesting_deeper_than_five_is_denied(self):
        self.assertEqual(actions("eval " * 5 + "git status"), ("allow", "allow"))
        decision = decide("eval " * 6 + "git status", factory_run=False)
        self.assertEqual(decision.action, "deny")
        self.assertIn("five levels", decision.reason)

    def test_reason_says_what_to_do_instead(self):
        decisions = [decide(c, factory_run=True) for c in DENY + ASK_INTERACTIVE_DENY_FACTORY]
        decisions += [decide(c, factory_run=False) for c in ASK_INTERACTIVE_DENY_FACTORY]
        decisions += [decide(c, factory_run=False, branch="main") for c in DENY_ON_MAIN]
        for decision in decisions:
            with self.subTest(decision.reason):
                self.assertTrue(decision.reason.endswith(SUFFIX))
                self.assertGreater(len(decision.reason), len(SUFFIX) + 40)

    def test_tags_only_push_is_allowed_on_a_protected_branch(self):
        self.assertEqual(actions("git push --tags", branch="main"), ("allow", "allow"))
        self.assertEqual(actions("git push origin --tags main", branch="feature"), ("deny", "deny"))

    def test_unknown_current_branch_does_not_block(self):
        self.assertEqual(actions("git push", branch=None), ("allow", "allow"))

    def test_current_branch_is_only_asked_for_when_a_rule_needs_it(self):
        for command in ("git status", "git push origin feature", "git push --force", "gh pr view 3", "ls -la", ""):
            with self.subTest(command):
                calls = []
                decide(command, factory_run=False, calls=calls)
                self.assertEqual(calls, [])

    def test_current_branch_is_read_in_the_directory_the_push_runs_in(self):
        cases = {
            "git push": ["repo"],
            "git -C sub push origin HEAD": [os.path.join("repo", "sub")],
            "git -C a -C b push": [os.path.join("repo", "a", "b")],
            "cd ../other && git push": [os.path.join("repo", "../other")],
            # Git for Windows cannot read Git Bash's /c/... form when Python hands it over, so it is converted.
            "cd /c/work/other && git push": ["c:/work/other" if os.name == "nt" else "/c/work/other"],
            "git -C /c/work push": ["c:/work" if os.name == "nt" else "/c/work"],
        }
        for command, expected in cases.items():
            with self.subTest(command):
                calls = []
                decide(command, factory_run=False, calls=calls)
                self.assertEqual(calls, expected)


class TextScanSpeedTest(unittest.TestCase):
    def test_a_long_command_that_cannot_be_tokenised_is_answered_in_time(self):
        # A hook that runs past its timeout does not block the call, so the scan must stay fast on long scripts.
        line = "git push origin feature && git commit -m wip && gh api graphql --raw-field q=x && gh pr review 3 -c\n"
        command = "'" + line * (100_000 // len(line)) + "gh pr merge 3 --squash"
        for factory_run, expected in ((False, "ask"), (True, "deny")):
            with self.subTest(factory_run=factory_run):
                start = time.perf_counter()
                decision = decide(command, factory_run=factory_run)
                self.assertLess(time.perf_counter() - start, 2.0)
                self.assertEqual(decision.action, expected)


class MainTest(unittest.TestCase):
    def run_main(self, payload: object, factory_run: bool = False) -> tuple[int, str]:
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        stdin = io.TextIOWrapper(io.BytesIO(raw), encoding="utf-8")
        stdout = io.StringIO()
        with mock.patch.object(sys, "stdin", stdin), contextlib.redirect_stdout(stdout), \
                mock.patch.dict(os.environ, {"FACTORY_RUN": "1" if factory_run else "0"}), \
                self.assertRaises(SystemExit) as caught:
            guard.main()
        return caught.exception.code, stdout.getvalue()

    def bash(self, command: object) -> dict:
        return {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": "."}

    def test_force_push_prints_a_deny_decision(self):
        code, output = self.run_main(self.bash("git push --force"))
        self.assertEqual(code, 0)
        decision = json.loads(output)["hookSpecificOutput"]
        self.assertEqual(decision["hookEventName"], "PreToolUse")
        self.assertEqual(decision["permissionDecision"], "deny")
        self.assertTrue(decision["permissionDecisionReason"].endswith(SUFFIX))

    def test_merge_asks_interactively_and_is_denied_in_a_factory_run(self):
        _, interactive = self.run_main(self.bash("gh pr merge 3"))
        _, factory = self.run_main(self.bash("gh pr merge 3"), factory_run=True)
        self.assertEqual(json.loads(interactive)["hookSpecificOutput"]["permissionDecision"], "ask")
        self.assertEqual(json.loads(factory)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_allowed_or_missing_commands_print_nothing(self):
        for payload in (self.bash("git status"), self.bash(None), self.bash(["git", "push"]), {"tool_input": "x"},
                        {}, [], b"", b"not json", b"[" * 100_000):
            with self.subTest(payload=repr(payload)[:40]):
                self.assertEqual(self.run_main(payload), (0, ""))

    def test_unexpected_error_falls_back_to_the_text_scan(self):
        with mock.patch.object(guard, "decide", side_effect=RuntimeError("bug")):
            _, denied = self.run_main(self.bash("git push --force"))
            _, allowed = self.run_main(self.bash("git status"))
        self.assertEqual(json.loads(denied)["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertEqual(allowed, "")

    def test_protected_branches_come_from_the_configuration_or_fall_back(self):
        self.assertEqual(guard.protected_branches(), ("main",))
        with mock.patch("factory.config.load", side_effect=TypeError("bug")):
            self.assertEqual(guard.protected_branches(), ("main", "master"))

    def test_an_installed_package_named_factory_does_not_replace_the_configuration(self):
        event = json.dumps(self.bash("git push origin main"))
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory, "factory")
            package.mkdir()
            (package / "__init__.py").write_text("", encoding="utf-8")
            (package / "config.py").write_text("from types import SimpleNamespace\n\n\ndef load():\n"
                                               "    return SimpleNamespace(protected_branches=())\n", encoding="utf-8")
            env = {**os.environ, "PYTHONPATH": directory, "PYTHONDONTWRITEBYTECODE": "1", "FACTORY_RUN": "0"}
            result = subprocess.run([sys.executable, str(HOOKS_DIR / "guard_git.py")], input=event, env=env,
                                    capture_output=True, text=True, timeout=60)
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        self.assertIn('"permissionDecision": "deny"', result.stdout)

    def test_failing_text_scan_denies(self):
        with mock.patch.object(guard, "decide", side_effect=RuntimeError("bug")), \
                mock.patch.object(guard, "scan_text", side_effect=RuntimeError("bug")):
            _, output = self.run_main(self.bash("git status"))
        decision = json.loads(output)["hookSpecificOutput"]
        self.assertEqual(decision["permissionDecision"], "deny")
        self.assertIn("could not inspect", decision["permissionDecisionReason"])


class HookLibTest(unittest.TestCase):
    def test_is_factory_run(self):
        self.assertTrue(hooklib.is_factory_run({"FACTORY_RUN": "1"}))
        for env in ({}, {"FACTORY_RUN": "0"}, {"FACTORY_RUN": "true"}):
            self.assertFalse(hooklib.is_factory_run(env), env)

    def test_project_dir_prefers_the_environment_then_the_event(self):
        with mock.patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": "from-env"}):
            self.assertEqual(hooklib.project_dir({"cwd": "from-event"}).name, "from-env")
        with mock.patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": ""}):
            self.assertEqual(hooklib.project_dir({"cwd": "from-event"}).name, "from-event")
            self.assertEqual(hooklib.project_dir({"cwd": 3}), Path.cwd())

    def test_decision_rejects_unknown_actions(self):
        with self.assertRaises(ValueError):
            hooklib.Decision("block")


if __name__ == "__main__":
    unittest.main()
