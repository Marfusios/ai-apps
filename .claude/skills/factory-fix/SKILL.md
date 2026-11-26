---
name: factory-fix
description: Addresses the failed checks and automated review findings on a factory pull request, verifying each one before acting on it. Entry point of the factory's fix stage, started by the factory or by a person typing /factory-fix.
disable-model-invocation: true
---

Read `factory/AGENT_CONTRACT.md`, `AGENTS.md`, and the app's `AGENTS.md` before anything else.

This skill serves the `fix` stage (`FACTORY_STAGE=fix`): the hosted checks or the automated review
failed on a factory pull request, and you address them on its branch. In a factory run
(`FACTORY_RUN=1`), the branch is checked out at the pull request's head, `$FACTORY_BASE_SHA`.
`<app>` below is `app` in `$FACTORY_JOB_DIR/job.json`, whose `round` says which fix round this is
(after the third the factory asks a person), and `$FACTORY_JOB_DIR/context.md` holds the failed
check output and the review's findings.

When `FACTORY_RUN` is not set, a person started this skill. Ask them which pull request, issue and
app they mean. In place of `context.md`, find the failed checks with `gh pr checks <number>`,
their output with `gh run view <run id> --log-failed`, and the review's findings with
`gh pr view <number> --comments`. Do the same work on the pull request's branch, report in the
conversation what the result file would hold, and write no result file. The git rules of
`AGENTS.md` hold in both modes.

## Work through every item

List every failed check and every finding in `context.md`. Then, for each one:

1. Verify it first, since a check can fail for a reason other than the one it prints and a finding
   can be wrong. Rerun a failed check with the command it ran, from `apps/<app>` for the commands
   of `apps/<app>/factory.toml` and from the repository root for `python3 scripts/check_repo.py`,
   and read the code at a finding's file and line.
2. If it holds, fix the cause. For wrong behaviour, write a failing test first, as "Change
   discipline" in `AGENTS.md` asks. Commit each fix with a one-sentence message.
3. If it does not hold or does not apply, note why, with the evidence: the command and what it
   printed, or the code that shows it.

Never weaken, skip or delete a test, loosen a linter rule, or add a suppression to get a green run.
A suppression is right only when the finding is wrong for that line, and then it carries its
reason on the line (`docs/engineering.md`, "Linted, formatted, typed").

Stay within the pull request's purpose: a finding that asks for more than its step or issue is a
follow-up, not a change here. On a design or plan pull request the findings are about the
document: verify each against the epic, the merged design and `factory/PLAN_FORMAT.md`, and change
the document.

## Verify and write the result

1. With everything committed, start the `verifier` subagent with the app's path `apps/<app>`. It
   reruns `setup` and `check` and answers `VERDICT: pass` or `VERDICT: fail` with each command,
   its exit code and a summary. On `fail`, fix the cause, commit, and run it again.
2. Run `python3 scripts/check_repo.py`; it must pass.
3. Write the result file at `$FACTORY_RESULT_PATH` as "What you return" in
   `factory/AGENT_CONTRACT.md` describes. Return `done` when every check passes and every finding
   is fixed or answered; that holds without a new commit when every finding was wrong. This stage
   fills the fields below and leaves out `thread_replies`, which belongs to the revise stage:
   - `summary`: item by item, what you fixed and why each other item does not apply;
   - `verification`: the verifier's commands with their exit codes and summaries, then
     `python3 scripts/check_repo.py`;
   - `pull_request` only to replace the title and body, when your fixes make them wrong;
   - `follow_ups` for problems you noticed and did not fix.

## When to stop and return questions

Return `needs_input` with `questions`, and a summary of what is finished, when:

- a finding asks for a change that contradicts the merged design or `PLAN.md` on `main`;
- a fix needs a change outside `apps/` and `packages/`, such as a workflow or the repository
  checker, or a new credential or provider account;
- a check fails in a way you cannot reproduce in this checkout, and its output does not show why:
  say what you ran and what you saw;
- a hook refuses something a fix seems to need.

Return `failed` with a `failure_reason` when the toolchain, the network or a service is broken.
Quote the command and its output.
