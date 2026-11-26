---
name: factory-implement
description: Builds one step of an epic's merged plan as one pull request, test first, with a step review and a final verification. Entry point of the factory's step stage, started by the factory or by a person typing /factory-implement.
disable-model-invocation: true
---

Read `factory/AGENT_CONTRACT.md`, `AGENTS.md`, and the app's `AGENTS.md` before anything else.

This skill serves the `step` stage (`FACTORY_STAGE=step`): you build one step of an epic's merged
plan, and nothing beyond it, as one pull request. In a factory run (`FACTORY_RUN=1`), `<app>`,
`<epic>` and `<step>` below are `app`, `epic` and `step_id` in `$FACTORY_JOB_DIR/job.json`, and
`$FACTORY_JOB_DIR/context.md` holds the step's text from `PLAN.md` on `main` and the trusted
comments on the step issue. That text is the task; the step issue only mirrors it.

When `FACTORY_RUN` is not set, a person started this skill. Ask them which app, epic issue and
step they mean. The step's text from `PLAN.md` on `main` stands in for `context.md`, and the
commit that `git merge-base main HEAD` prints stands in for `$FACTORY_BASE_SHA`. Do the same work
on a branch of your own, report in the conversation what the result file would hold, and write no
result file. The git rules of `AGENTS.md` hold in both modes.

## Prepare

1. Read the step's scope, acceptance criteria and verification commands: together they are the
   whole task. Read `DESIGN.md` and `PLAN.md` in `apps/<app>/docs/epics/<epic>-*/`,
   `apps/<app>/README.md`, `docs/engineering.md`, and the code the step touches.
2. Check that what the step depends on is on the branch: the code of the steps in its
   `Depends on` line, and anything the design says must exist first.
3. From `apps/<app>`, run the `setup` command of `apps/<app>/factory.toml` if the dependencies are
   missing, then its `check` command, so you can tell your failures from ones already there.

## Build, one behaviour at a time

Take the behaviours the acceptance criteria name one at a time, simplest first, and for each:

1. Write a test that states the behaviour through a public interface, named for what it states.
2. Run it and see it fail for the reason you expect: an assertion about the missing behaviour, not
   an import error or a typo. A test that passes at once proves nothing yet.
3. Write the least code that makes it pass.
4. Tidy while the tests stay green: the vocabulary's names, the module map's boundaries, no
   duplication (`docs/engineering.md`, "Clean code" and "Continuous care").
5. Run the app's `quick` command (`check` if it has none) and `python3 scripts/check_repo.py`, then
   commit with a one-sentence message, as "Change discipline" in `AGENTS.md` asks. Tidying of more
   than a few lines goes in a commit of its own.

Keep the documents true in the same step (`docs/engineering.md`, "Documents are part of the
code"): the README, the module map and Domain vocabulary in `apps/<app>/AGENTS.md` (drop the
planned mark from a module this step builds), and `.env.example`. Do not edit `PLAN.md`: it
changes only when a person merges a change to it.

When every criterion holds, run the full `check` command and each of the step's verification
commands from `apps/<app>`. Fix what fails, and commit.

## Review your change

1. Commit everything first, since the diff holds only committed work. Then run `mktemp -d`, note
   the directory it prints, which is outside the checkout, and write the diff there:
   `git diff "$FACTORY_BASE_SHA"...HEAD > <directory>/step.diff`.
2. Start the `step-reviewer` subagent and give it the diff file's path, the step's full text from
   `context.md`, and the app's path `apps/<app>`.
3. It answers `VERDICT: pass` or `VERDICT: fail`, then one finding per line as
   `severity | file:line | what is wrong | what would fix it`. Verify each finding against the
   code first, since a reviewer can be wrong. Fix each `blocker` and `major` that holds, in new
   commits. A `minor` you leave becomes a follow-up. For a finding that does not hold, or that you
   decide not to fix, give your reason in the pull request body under "Step review".
4. After fixing a `blocker` or `major`, write a fresh diff and run the reviewer again, up to three
   reviews in all.

## Verify and write the result

1. With everything committed, run the step's verification commands from `apps/<app>` and
   `python3 scripts/check_repo.py` once more, so that they describe the final state.
2. Start the `verifier` subagent with the app's path `apps/<app>`. It runs `setup` and `check` and
   answers `VERDICT: pass` or `VERDICT: fail` with each command, its exit code and a summary. On
   `fail`, fix the cause, commit, and go back to step 1.
3. Write the result file at `$FACTORY_RESULT_PATH` as "What you return" in
   `factory/AGENT_CONTRACT.md` describes. With `done` this stage fills:
   - `pull_request`: a title that says what the step delivers, and a body that says what changed,
     why (it is step `<step>` of the plan for epic #<epic>), how it was verified, each new
     dependency with its reason, and the "Step review" notes;
   - `verification`: the verifier's commands with their exit codes and summaries, then the
     commands of step 1 with theirs;
   - `follow_ups`: problems you noticed and did not fix, the minor findings you left among them.

## When to stop and return questions

Return `needs_input` with `questions`, and a summary of what is finished, when:

- the step is larger than the plan says, or its criteria cannot be met within its scope: say which
  part fits and which does not, instead of growing the pull request;
- the step depends on code or a decision that `main` does not have yet;
- the step, the design and the plan leave open a decision that changes the result;
- the step contradicts the merged design, or meeting it would change the design's architecture;
- the work needs a change outside `apps/` and `packages/`, a new credential or a provider account;
- a `blocker` from the step reviewer cannot be fixed within the step;
- a hook refuses something the step seems to need.

Return `failed` with a `failure_reason` when the toolchain, the network or a service is broken,
such as a `setup` command that cannot download its packages. Quote the command and its output.
