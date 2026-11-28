# Checks and Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A factory pull request looks after itself until a person is needed: hosted workflows check the app and review the change with a second model, the factory fixes what they find for up to three rounds, hands the pull request over when everything passes, and answers a person's review.

**Architecture:** Two hosted workflows run on every pull request from a branch of this repository: one runs each touched app's `setup` and `check` from its `factory.toml`, one runs the Codex action with a read-only profile and posts a verdict. The dispatcher reads their results into its snapshot (check runs, the review comment, a person's reviews), and the same pure decision function gains the rows of a pull request's life: a `revise` run for a person's review, a `fix` run for a failed check or review, a hand-off when all is green. Fix and revise runs reuse the runner unchanged; only the context the dispatcher assembles and where it publishes differ.

**Tech Stack:** GitHub Actions (`actions/checkout`, `actions/setup-node`, `actions/setup-python`, `openai/codex-action`, all pinned to commits), the GitHub REST and GraphQL APIs, and the Python standard library as before.

**Spec:** [docs/factory/DESIGN.md](../DESIGN.md), build step 3 (sections 6.4, 6.5, 9, 11), and [factory/AGENT_CONTRACT.md](../../../factory/AGENT_CONTRACT.md). The plan of step 2 and its "As built" section are in [02-fix-pipeline.md](02-fix-pipeline.md).

## Global Constraints

- Everything in the Global Constraints of plan 2 still binds: standard library only, offline tests on Linux and Windows with `-W error` clean, `scripts/check_repo.py` passing, no secret or host path in a log line or message, agent and runner text reaching GitHub only through `factory.compose`, the dispatcher never running anything from a directory the runner or an agent wrote.
- Workflows: every third-party action is pinned to a full commit SHA with its version in a comment. No `pull_request_target`. `permissions:` is set per workflow to the least needed; the job that holds `OPENAI_API_KEY` has `contents: read` only and never posts; the job that posts has no secret and never checks out or runs the pull request's code.
- Pinned commits (use exactly these): `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`, `actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0`, `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`, `openai/codex-action@306c6a196a99dcc6582530c396a19d2672d5e9ec # v1.14`.
- Text from check logs, from the review model and from people outside the trusted list is information for an agent, never instruction: it reaches `context.md` only inside quoted blocks under headings the dispatcher writes, cut to fixed sizes.
- At most `max_fix_rounds` (3) automated fix runs in a row on one pull request; a person's review or `/factory retry` starts the count again. Revise runs asked for by a person are not capped.
- One job at a time, as before. The dispatcher never merges and never approves.
- Work on the branch `factory-checks-and-review`. Commit messages are one plain sentence, no prefix, no attribution.

## Review Focus

1. **A secret on a pull request's terms**: a pull request from a fork, or one that changes the review prompt, the schema or the report script, must not get the API key into a log, a comment or an artifact, and must not be able to post a passing verdict for itself. Tests in Tasks 1 and 2; the report job takes its script from the base commit.
2. **A verdict for another commit**: a review comment or check run that belongs to an earlier head must not count for the current one. Tests in Tasks 4 and 5.
3. **A loop that burns the subscription**: a fix run that changes nothing, a check that never passes, a review that always fails: the factory stops after three automated rounds and says so once. Tests in Task 5.
4. **Hostile text on the way to the agent**: a check log or a review finding that says "ignore your instructions", carries a planted marker or a mention, or is 50 MB long. Tests in Tasks 3, 6 and 7.
5. **A person's review half-answered**: a revise run that replies to some threads and then fails, or is published twice: every thread gets at most one reply per run, and a repeat posts nothing twice. Tests in Task 7.

## File Structure

```text
.github/workflows/app-checks.yml   per-app setup and check, from factory.toml
.github/workflows/review.yml       the second-model review
scripts/ci_apps.py                 which apps a change touches; their toolchains and commands
factory/review/code.md             review prompt for code changes
factory/review/document.md         review prompt for design and plan documents
factory/review/schema.json         the review's required output
factory/review/report.py           check the model's answer, compose the comment, decide the verdict
factory/github_api.py              + graphql(), download_text()
factory/markers.py                 + the review comment's marker
factory/snapshot.py                + a pull request's checks, verdict, reviews and comments
factory/decide.py                  + the rows of a pull request's life
factory/jobs.py                    + stages fix and revise; extra context sections
factory/compose.py                 + thread replies, the hand-off comment, two notices
factory/publish.py                 + publishing on a pull request, thread replies, hand_off()
factory/dispatcher.py              + starting fix and revise jobs, applying HandOff
factory/config.toml, config.py     + [stages.fix], [stages.revise], required_checks, max_fix_rounds, [review]
```

## How a pull request moves

The comments of an issue and of its pull request form one stream (both are issue comments, so their ids order them). Run markers carry `head` (the branch head after the run) and, for `fix`, `round`. "The marker" below is the newest bot marker in that stream, looking through `needs-app` notices: while such a notice is the newest marker and no trusted person has replied, the issue waits with `status:needs-human`; after a reply the newest marker before the notice decides, so a start that was held back for the app keeps its stage.

The table applies to an open pull request with no job, unless the marker is a `fix_issue` run that did not end `done`, or the `untrusted-author` or `pr-closed` notice: those keep the rows of an issue without a pull request. The first row that applies wins.

| Situation | Action |
| --- | --- |
| the marker is `needs_input` from a `fix` or `revise` run, a trusted comment after it | start that stage again (`fix` at round 1) |
| the marker is a failure from a `fix` or `revise` run, or the `fix-rounds-exhausted` notice, a trusted `/factory retry` after it | start that stage again (`fix` at round 1) |
| a trusted person's review that requests changes or comments, submitted after the newest revise job was created | start `revise` |
| a trusted comment whose first line starts with `/factory revise`, written after the newest revise job was created | start `revise` with the rest as the instruction |
| the marker is `usage_limit` from a `fix` or `revise` run | wait until its time, then start that stage again (`fix` at the same round) |
| the marker is a question or a failure of a `fix` or `revise` run, or the exhausted notice, and nobody answered | `status:needs-human`, nothing else |
| the marker is a run that ended `done`; checks for the head `failed`; fewer than `max_fix_rounds` fix rounds behind | start `fix`, round = the marker's round + 1 (round 1 after a `fix_issue` or `revise` run) |
| the marker is a run that ended `done`; checks `failed`; `max_fix_rounds` rounds behind | notice `fix-rounds-exhausted`, `status:needs-human` |
| the marker is a run that ended `done`; checks `passed`; the review's verdict is not `fail` | `HandOff` |
| anything else (checks pending, already handed over) | nothing |

After the hand-off marker only the two rows of a person's ask start anything: a person has the pull request then, so a failing check starts no automatic run. A revise run that ends `done` is a finished run again, so its head is fixed when its checks fail and handed over when they pass: the person is asked to look again after every round.

A person's asks are measured against the newest revise job, not against the last marker, because a review written while a run is in flight is older than that run's marker and would be lost. A job's creation time is the time in its id, which its run marker carries. A review or a command counts when it is strictly later, to the second, than the job of the newest `revise` run marker, or when there is no revise run yet. `decide.reviews_to_answer` and `decide.revise_instruction` give the dispatcher what a revise run must answer: everything since the newest revise job that ended `done`, so a retried run gets what its failed predecessor was given. The host's clock must agree with GitHub's to within the time between a review and the next poll; a larger difference costs one extra revise run, never a loop.

Fix rounds are read from the marker, not counted. A person's restart is round 1, which is how a person's `/factory retry` starts the count again. A `fix` marker without a valid round counts as `max_fix_rounds`, so the factory stops instead of looping.

Checks for a head are: `failed` when a check named in `required_checks` ended in failure or timed out; otherwise `pending` when a name in `required_checks` is missing or has not passed; otherwise `passed`. Only required names decide: a helper job that breaks (one matrix job, the job that calls the review model) is covered by the aggregate names `apps` and `review`. A cancelled, skipped or neutral run is neither a failure nor a pass of a required name.

More rulings made during the build:

- The review workflow picks the document prompt when every changed file lies under `apps/<app>/docs/epics/` (the bot labels a pull request only after opening it, so a label cannot choose the first review's prompt), and it lists the changed files without rename detection. It does not run again when a pull request is marked ready (that head has its review already).
- Only check runs created by GitHub Actions count (`checks_app`), and a list of check runs longer than one page reads as pending.
- The hand-off does not change the status label: the issue stays `status:building` until the merge, as an epic stays `status:design` while its design waits for a person. The hand-off comment and the review request tell the person.
- The hand-off comment says "found nothing blocking" only for the verdict `pass`. The `review` check also passes when the review model could not run, and then the comment says that no second model has read the commit.
- Not built: a notice for checks that stay pending for good (a cancelled run, a workflow that never started). The pull request's own page shows it; it is a candidate for the health review of build step 5.

---

### Task 1: Per-app checks in CI

**Files:**
- Create: `scripts/ci_apps.py`, `.github/workflows/app-checks.yml`
- Test: `factory/tests/test_ci_apps.py`, `factory/tests/test_workflows.py`

**Interfaces:**
- Produces `scripts/ci_apps.py` (imports `factory.app_config`, `factory.config` like `check_repo.py`):
  - `touched_apps(paths: Iterable[str], existing: Collection[str]) -> list[str]`: the sorted names `<app>` of `apps/<app>/…` paths that are in `existing`; a path under `packages/` selects every existing app
  - `matrix(apps: Sequence[str], root: Path, registries: Sequence[str]) -> list[dict]`: one `{"app", "node", "python", "setup", "check"}` per app from its `factory.toml` (`""` for a toolchain it does not declare); an app whose file does not load is listed with `"error": "<first problem>"` and empty commands
  - `main(argv) -> int`: `matrix --base <sha> --head <sha>` prints the matrix as one line of JSON (the changed paths come from `git diff --name-only --no-renames <base>...<head>`; `--all` lists every app); `run <app> setup|check` runs that command with `sh -c` in the app's directory and returns its status, and fails with the stored error for an app whose `factory.toml` does not load

`app-checks.yml`: name `App checks`; `on: pull_request` and `workflow_dispatch`; `permissions: contents: read`; `concurrency` per pull request with `cancel-in-progress: true`. Jobs:

| Job | Does |
| --- | --- |
| `plan` | checkout with `fetch-depth: 0` and `persist-credentials: false`; Python 3.11; `python scripts/ci_apps.py matrix --base ${{ github.event.pull_request.base.sha }} --head ${{ github.event.pull_request.head.sha }}` (or `--all` on dispatch); output `matrix` |
| `app` | `needs: plan`, skipped when the matrix is empty; `strategy.matrix.include` from it, `fail-fast: false`, name `app (${{ matrix.app }})`, `timeout-minutes: 30`; checkout; `actions/setup-node` when `matrix.node` is set; `actions/setup-python` when `matrix.python` is set (always 3.11 for the script); `python scripts/ci_apps.py run <app> setup`, then `… check` |
| `apps` | `needs: [plan, app]`, `if: always()`; fails unless `plan` succeeded and `app` succeeded or was skipped. This is the one name the dispatcher waits for |

Every value from the event reaches a `run:` step through `env:`, never by `${{ }}` inside the script text.

- [ ] **Step 1: Write the failing tests.** `test_ci_apps.py`: `touched_apps` for app paths, a `packages/` path, a path outside both, an app that no longer exists; `matrix` for the real AirCase (`node` `"24"`, `python` `""`, its `check`), and for a temporary app with a broken `factory.toml` (an `error`, no commands); `main(["run", app, "check"])` runs the command in the app's directory and returns its status (a temporary app whose check is `exit 3`). `test_workflows.py` (text checks, no YAML library): every `uses:` line in every file under `.github/workflows/` has a 40-hex commit and a `# v…` comment; no workflow contains `pull_request_target`; `app-checks.yml` has the three job names, `contents: read` and no other permission, and no `${{ github.event` inside a `run:` block.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Write the script and the workflow.**
- [ ] **Step 4: Run the suite and `scripts/check_repo.py`.**
- [ ] **Step 5: Commit.**

---

### Task 2: The second-model review workflow

**Files:**
- Create: `factory/review/__init__.py`, `factory/review/code.md`, `factory/review/document.md`, `factory/review/schema.json`, `factory/review/report.py`, `.github/workflows/review.yml`
- Modify: `factory/markers.py`, `factory/config.toml`, `factory/config.py`
- Test: `factory/tests/test_review_report.py`, `factory/tests/test_markers.py`, `factory/tests/test_workflows.py`, `factory/tests/test_config.py`

**Interfaces:**
- Produces in `factory.markers`: `REVIEW_PREFIX = "<!-- factory-review:v1 "`, `encode_review(data) -> str`, `parse_review(body) -> dict | None` (same escaping and last-one-wins rule as the run marker; the two prefixes never match each other)
- Produces `factory.review.report`:
  - `SEVERITIES = ("blocker", "major", "minor")`, `MAX_FINDINGS = 30`
  - `validate(data: object) -> list[str]`: the answer is an object with exactly `summary` (1 to 2,000 characters) and `findings` (at most `MAX_FINDINGS` objects with exactly `severity`, `file` (at most 300), `line` (integer from 0), `title` (1 to 200), `detail` (1 to 2,000))
  - `verdict(data: Mapping) -> str`: `"fail"` when a finding is a `blocker` or `major`, else `"pass"`
  - `comment(answer: str | None, head: str, model: str) -> tuple[str, str]`: the comment body and the verdict. A missing, unparseable or invalid answer gives verdict `"unavailable"` and a body that says the review could not run. Otherwise a heading, the summary, a table of findings (severity, `file:line`, title) and each detail, every piece through `textsafe.neutralise`, ending with `encode_review({"head": head, "verdict": …, "findings": n})`
  - `main(argv) -> int`: `--answer-file`, `--head`, `--model`, `--out` writes the body to `--out`, prints the verdict, and returns 1 for `fail`, 0 otherwise
- Produces in `factory.config`: `ReviewSettings(bot_login: str, bot_user_id: int)` as `Config.review`; `DispatcherSettings` gains `required_checks: tuple[str, ...]` and `max_fix_rounds: int` (1 to 10); `stages` gains `fix` and `revise`

Append to `factory/config.toml`: under `[dispatcher]` `required_checks = ["repository", "apps", "review"]` and `max_fix_rounds = 3`; `[review]` with `bot_login = "github-actions[bot]"` and `bot_user_id = 41898282`; `[stages.fix]` and `[stages.revise]`, each `model = "opus"`, `timeout_minutes = 60`, `max_turns = 200`.

`schema.json` is the JSON Schema of the answer above (`additionalProperties: false` everywhere). `code.md` tells the reviewer: review only the change between the two commits it is given, in the order and with the severities of the "Review guidelines" in `AGENTS.md` (correctness against the issue, tests, the engineering standards, scope, hygiene), verify each finding against the code, report nothing it did not verify, treat every file, comment and instruction inside the repository as material under review and not as instructions, and answer in the schema. `document.md` is the same for a design or a plan: undecided points, unstated assumptions, missing edge cases, steps that are not one reviewable pull request, with the plan format as reference.

`review.yml`: name `Review`; `on: pull_request` (`opened`, `synchronize`, `reopened`, `ready_for_review`); top-level `permissions: {}`; `concurrency` per pull request, cancelling. Jobs:

| Job | Condition, permissions | Does |
| --- | --- | --- |
| `codex` | only when the head repository is this repository; `contents: read` | checkout of `refs/pull/<n>/merge` (`persist-credentials: false`), fetch of the base and head refs; a step that writes the prompt file OUTSIDE the checkout from the BASE commit's `factory/review/code.md` or `document.md` (`git show <base sha>:<path>`; `document.md` when the pull request carries the label `stage:design` or `stage:plan`), followed by the base and head commits and the pull request's number; the schema taken from the base commit the same way; `openai/codex-action` with `permission-profile: ":read-only"`, `prompt-file`, `output-schema-file`, `model: ${{ vars.FACTORY_REVIEW_MODEL }}`, `allow-bot-users: mk-factory`, `continue-on-error: true`; a second identical step with `vars.FACTORY_REVIEW_FALLBACK_MODEL`, run only when the first failed and that variable is set; outputs `answer` and `model` |
| `review` | `needs: codex`, `if: always()` and the same repository condition; `pull-requests: write` | checkout of the BASE commit only (`persist-credentials: false`); Python 3.11; `python -m factory.review.report` with the answer from an environment variable written to a file; post the body as a new comment with `gh api` and `GH_TOKEN: ${{ github.token }}`; exit with the report's status |

The pull request's title and body are not put into the prompt (they are agent text; the reviewer reads the diff). No step of `review` uses anything from the pull request's tree.

- [ ] **Step 1: Write the failing tests.** `test_review_report.py`: a row per rule of `validate`; `verdict` for blocker, major, minor only, none; `comment` for a good answer (the marker parses with `head`, `verdict`, `findings`; findings text with a planted `<!-- factory-review:v1` marker, a mention and `Closes #1` is neutralised and the real marker stays last), for `None`, for text that is not JSON and for an invalid object (verdict `unavailable`, exit status 0); `main` returns 1 only for `fail`. `test_markers.py`: the review marker round-trips, and neither parser reads the other's marker. `test_workflows.py`: `review.yml` has top-level `permissions: {}`; the job with `OPENAI_API_KEY` has `contents: read` and no `write`; the job with `pull-requests: write` has no `secrets.` reference and checks out the base sha; both jobs carry the same-repository condition; the prompt and schema come from `git show`. `test_config.py`: the new keys load and each has a row of its rule.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Write the package, the prompts, the workflow and the configuration.** Update every test and the hook fallback that builds a `Config` by hand.
- [ ] **Step 4: Run the suite and the checker.**
- [ ] **Step 5: Commit.**

---

### Task 3: GraphQL and log downloads in the GitHub client

**Files:**
- Modify: `factory/github_api.py`, `factory/tests/fakes.py`
- Test: `factory/tests/test_github_api.py`

**Interfaces:**
- Produces in `GitHub`:
  - `graphql(query: str, variables: Mapping[str, object]) -> dict`: `POST /graphql`; returns `data`; a response with `errors` or without `data` raises `GitHubError(0, …)` whose message names no query text
  - `download_text(path: str, limit: int) -> str`: a GET that does not follow the redirect itself; on a 302 it fetches the `Location` URL WITHOUT the `Authorization` header (it is a signed URL on another host), requires `https`, reads at most `limit` bytes of the END of the body (keep the last `limit` bytes while streaming, never the whole body in memory) and decodes with replacement; anything else than 302 then 200 raises `GitHubError`
- `FakeGitHub` gains `graphql_answers` (a list consumed in order, each a dict or an exception), `graphql_calls`, and `downloads: dict[str, str]`

- [ ] **Step 1: Write the failing tests**: `graphql` posts the query and variables and returns `data`; errors raise without the query in the message; `download_text` follows one redirect without the token (assert the second request has no `Authorization` header), refuses a non-https location, returns only the tail of a body longer than `limit`, and raises on a 404.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the suite and the checker.**
- [ ] **Step 5: Commit.**

---

### Task 4: The pull request in the snapshot

**Files:**
- Modify: `factory/snapshot.py`
- Test: `factory/tests/test_snapshot.py`

**Interfaces:**
- Consumes: `markers.parse_review` (Task 2), `Config.review` and `Config.dispatcher.required_checks` (Task 2).
- Produces in `factory.snapshot`:
  - `@dataclass(frozen=True) class Check: name: str; state: str; job_id: int` (`state` is `"pending"`, `"passed"`, `"failed"` or `"other"` for cancelled, skipped and neutral)
  - `@dataclass(frozen=True) class Review: id: int; author: str; state: str; submitted_at: str; body: str` (`state` lower-cased: `approved`, `changes_requested`, `commented`, `dismissed`)
  - `PullRequest` gains `draft: bool`, `head_sha: str`, `node_id: str`, `checks: tuple[Check, ...] = ()`, `verdict: str = ""`, `review_text: str = ""`, `reviews: tuple[Review, ...] = ()`
  - `checks_state(pull: PullRequest, required: Sequence[str]) -> str`: `"failed"`, `"pending"` or `"passed"` by the rule under "How a pull request moves"
  - `fetch(github: GitHub, config: Config) -> Snapshot` (the configuration is needed again, for the review bot's identity)

For an open issue whose pull request is OPEN, `fetch` also reads, below `github.repo`: `get /commits/<head sha>/check-runs` (`per_page=100`; `check_runs` entries: `name`, `status`, `conclusion`, `id`), `get_all /issues/<pr>/comments`, `get_all /pulls/<pr>/reviews`. The pull request's comments are merged into `Issue.comments` and the whole is sorted by id. `verdict` and `review_text` come from the NEWEST comment written by the review bot (login and id from `config.review`) whose review marker has `head` equal to the pull request's `head_sha`; `review_text` is that comment's body without the marker, cut to 20,000 characters. Pending reviews (no `submitted_at`) are left out. A failure of one of these requests makes that issue unreadable, as for its other requests.

- [ ] **Step 1: Write the failing tests**: check runs map to the four states (`completed`+`success` passed; `failure` and `timed_out` failed; `cancelled`, `skipped`, `neutral` other; anything not completed pending); `checks_state` for each row of the rule, including a required name that is missing, and a failed check that is not required; a review comment for an older head gives no verdict; a comment with the review marker from another account gives none; the newest of two review comments for the head wins; pull request comments appear in `Issue.comments` in id order and the bot's markers in them are found by `Issue.markers`; reviews are parsed and a pending one is dropped; a closed or merged pull request triggers none of the extra requests.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement**, and pass the configuration at every call site of `fetch`.
- [ ] **Step 4: Run the suite and the checker.**
- [ ] **Step 5: Commit.**

---

### Task 5: The decisions of a pull request's life

**Files:**
- Modify: `factory/decide.py`, `factory/jobs.py` (only `SKILLS`, `is_revise`)
- Test: `factory/tests/test_decide.py`, `factory/tests/test_jobs.py`

**Interfaces:**
- Consumes: Task 4's types and `checks_state`.
- Produces:
  - `jobs.SKILLS` gains `"fix": "factory-fix"` and `"revise": "factory-revise"`; `jobs.is_revise(comment) -> str | None`: the instruction after `/factory revise` on the first non-blank line (any letter case), `""` when there is none, `None` when the line is not that command
  - `StartJob(issue: int, app: str, stage: str = "fix_issue", round: int = 0)`; `describe()` names the stage and, for a round above 0, the round
  - `HandOff(issue: int)`: `describe()` is `issue #<n>: hand the pull request over for review`
  - `PostNotice` keys gain `fix-rounds-exhausted`

The table under "How a pull request moves" is added to `decide` for an open trusted issue whose pull request is open and not merged, AFTER the job rows and the settling check and BEFORE today's `done` row; today's rows for an issue without an open pull request are unchanged. Details that decide ties:

- A run marker is one whose `kind` is `run`; its stage is `marker.data.get("stage")`. Notices and the hand-off marker have no stage. A fix marker's round is its `round` when that is an integer from 1 to 1,000, else `max_fix_rounds`.
- A review counts when its author is trusted, its state is `changes_requested` or `commented`, and its `submitted_at` is strictly later than the creation time of the newest revise job (times parsed strictly as `YYYY-MM-DDTHH:MM:SSZ`; text that does not parse never counts). An approval starts nothing.
- `reviews_to_answer(issue, config, bot)` and `revise_instruction(issue, config, bot)` are public and pure: the dispatcher builds a revise run's context with them.
- A start from this table goes through the same rules 5 to 7 as today (an app must be chosen, `factory:pause` queues it, halt, a live job and a usage limit block it).
- `usage_limit` from a `fix` or `revise` run restarts that stage when its time has come.
- A `fix-rounds-exhausted` notice carries outcome `failed`, so `/factory retry` after it starts `fix` at round 1.

- [ ] **Step 1: Write the failing tests**, one per row of the table and per detail above, with helpers that build a pull request with checks, a verdict and reviews: checks failed with zero, one and two fix runs behind (rounds 1, 2, 3); three behind (the notice, once: with the notice's marker in the stream nothing more happens); a revise marker between two fix markers restarts the count; pending checks do nothing; passed and draft hands off; passed and not a draft does nothing; a trusted changes-requested review starts `revise` even when checks failed; an untrusted review, an approval and a review older than the last marker start nothing; `/factory revise tidy the names` starts `revise`; `needs_input` from a `revise` run restarts `revise` on a trusted reply; a failure from `fix` restarts `fix` on `/factory retry`; a job, a settling job, pause and halt behave as for `fix_issue`; a verdict or check of an older head is ignored (the snapshot gives none, so checks are pending).
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement**, keeping each row a small named function.
- [ ] **Step 4: Run the suite and the checker.**
- [ ] **Step 5: Commit.**

---

### Task 6: Job files for fix and revise

**Files:**
- Modify: `factory/jobs.py`, `factory/compose.py`
- Test: `factory/tests/test_jobs.py`, `factory/tests/test_compose.py`

**Interfaces:**
- Produces in `factory.jobs`:
  - `MAX_LOG_CHARS = 20_000`, `MAX_FAILED_CHECKS = 5`
  - `@dataclass(frozen=True) class Thread: id: str; path: str; line: int; first_comment_id: int; comments: tuple[tuple[str, str], ...]` (author and body of each comment)
  - `context(issue, config, bot, *, sections: Sequence[tuple[str, str]] = ()) -> str`: as today, then each `(heading, text)` as `## <heading>` followed by the text quoted line by line with `> `, the whole still within `MAX_CONTEXT_CHARS` (sections are cut before comments are dropped)
  - `fix_sections(logs: Sequence[tuple[str, str]], review_text: str) -> list[tuple[str, str]]`: `Failed check: <name>` for each `(name, log tail)` (at most `MAX_FAILED_CHECKS`, each cut to `MAX_LOG_CHARS` from the end), then `Automated review` when the text is not blank
  - `revise_sections(reviews: Sequence[tuple[str, str]], threads: Sequence[Thread], instruction: str, config: Config) -> list[tuple[str, str]]`: `Instruction` for `/factory revise` first, then `Review (<time>)` for each `(submitted time, body)` whose body is not blank, then one `Review thread <id> (<path>:<line>)` per thread with the comments of trusted authors only (a thread with none, or with an id that is not a plain identifier, is left out)
  - `job_file` and `request_file` take `round: int = 0`, and `request_file` also `pull_request: int = 0`; the request gains the keys `round` (0 to 1,000) and `pull_request` (0 or a positive integer), and `validate_request` accepts exactly the new shape
  - `thread_index(threads: Sequence[Thread], config: Config) -> dict`: `{thread id: first comment id}` of the threads `revise_sections` shows, for `jobs/<id>/threads.json`
- Produces in `factory.compose`:
  - `thread_reply(body: str) -> str`: the neutralised reply (limit 4,000) under the lead-in `The agent replies:` as a block quote
  - `handoff_comment(head: str, verdict: str) -> str`: a fixed text ending with the marker `{"kind": "handoff", "head": head}`: for the verdict `pass`, the checks pass and the automated review found nothing blocking; for `unavailable` or none, the checks pass and no second model has read the commit; either way the pull request is ready for a person's review. Any other verdict is refused
  - `run_comment` takes `round: int = 0` and `head: str = ""` and puts both into the marker when set (and `round` into the header line as `round <n>`); `notice` gains `fix-rounds-exhausted` (outcome `failed`: three automated fix runs in a row did not make the checks pass; `/factory retry` starts again; or a person takes over)

- [ ] **Step 1: Write the failing tests**: sections appear after the comments, quoted, with planted headings and markers inside them unable to leave the quote; a 100,000-character log is cut to its last `MAX_LOG_CHARS`; a sixth failed check is left out with a line saying so; untrusted authors' thread comments are dropped; the request with `round` and `pull_request` validates and odd values are refused; `thread_reply`, `handoff_comment` and the new notice parse and are neutral; `run_comment` carries `round` and `head`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the suite and the checker.**
- [ ] **Step 5: Commit.**

---

### Task 7: Publishing on a pull request

**Files:**
- Modify: `factory/publish.py`
- Test: `factory/tests/test_publish.py`

**Interfaces:**
- Consumes: Tasks 3, 4 and 6.
- Produces in `Publisher`:
  - `publish` handles the stages `fix` and `revise` (from the job's request): the run comment goes on the PULL REQUEST (`request["pull_request"]`), with `round` and, after a push, the new `head`; no pull request is created; when the result holds `pull_request`, the existing one's title and body are replaced through compose; `done` without new commits is allowed and pushes nothing; the issue's status stays `status:building` after `done` and becomes `status:needs-human` otherwise. For `fix_issue` nothing changes except that the marker now carries `head`
  - for `revise` with outcome `done`: each entry of the result's `thread_replies` whose `thread_id` is in the job's `threads.json` is posted once with `POST /pulls/<n>/comments/<first comment id>/replies` (the body from `compose.thread_reply`), and a thread with `resolved: true` is resolved with the GraphQL mutation `resolveReviewThread`; replies already posted by this job are not posted again (a reply's body ends with a marker `{"kind": "reply", "job": …, "thread": …}`, found in a fresh listing of the pull request's review comments); unknown thread ids are ignored
  - `hand_off(issue: Issue) -> None`: reads the pull request afresh and stops when it is no longer open or its head is not the snapshot's `head_sha`; marks it ready with the GraphQL mutation `markPullRequestReadyForReview` (the pull request's `node_id`) when it is still a draft; requests a review from `issue.trigger_actor` (`POST /pulls/<n>/requested_reviewers`; a 422 is tolerated); and last posts `compose.handoff_comment(head, verdict)` on the pull request unless a hand-off marker for that head is already there. The comment is the last write, so a hand-off interrupted before it is done again in full on the next poll

The settled-once rule covers the new writes: thread replies and the pull request's new text are part of the stored decision, taken from the result before the first write.

- [ ] **Step 1: Write the failing tests**: a `fix` run that is `done` pushes to the existing branch, opens no pull request, comments on the pull request with `stage`, `round` and the new `head`; a `fix` run without commits comments and pushes nothing; `needs_input` and failures comment on the pull request and set `status:needs-human` on the issue; a `revise` run posts one reply per known thread, resolves only the resolved ones, ignores an unknown thread id, and a repeat after an interruption at each write posts no reply twice; a reply with a planted marker or mention is neutral; `hand_off` marks ready, requests the reviewer, comments once, and a repeat does none of it twice; a 422 from the reviewer request does not stop the hand-off; the hygiene scan covers thread replies.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the suite and the checker.**
- [ ] **Step 5: Commit.**

---

### Task 8: The dispatcher starts fix and revise runs and hands over

**Files:**
- Modify: `factory/dispatcher.py`
- Test: `factory/tests/test_dispatcher.py`

**Interfaces:**
- Consumes: everything above.

Applying `StartJob` with stage `fix`: the base is the work branch's head in the mirror after a fetch, and it must equal the pull request's `head_sha` (otherwise the action fails and is tried again next poll); for each failed check of the snapshot (at most `jobs.MAX_FAILED_CHECKS`) the log tail comes from `github.download_text(<repo>/actions/jobs/<job id>/logs, 200_000)` (a failed download gives the text `the log could not be read`); the context gets `jobs.fix_sections`. Stage `revise`: the reviews are `decide.reviews_to_answer` (none, for `/factory revise` alone) and the instruction is `decide.revise_instruction`; the threads come from one GraphQL query of the pull request's review threads (id, path, line, comments with database id, author login, body, and the review they belong to), keeping the unresolved threads in which a comment belongs to one of those reviews; the context gets `jobs.revise_sections`, and `threads.json` (`jobs.thread_index`) is submitted with the job. For `fix`, the failed checks that are not required names come first: they are the jobs whose logs show the failure, while a required name such as `apps` only sums them up. `HandOff` calls `publisher.hand_off`. Both stages put `round` and the pull request's number into the request and `job.json`.

- [ ] **Step 1: Write the failing tests**: a snapshot with failed checks leads to a job whose `context.md` holds the quoted log tail and the review text, whose request has stage `fix`, round 1 and the pull request's number, and whose base is the pull request's head; a branch head that differs from the pull request's head starts nothing; a log that cannot be downloaded still starts the job; a trusted review leads to a `revise` job with its threads in the context and in `threads.json`; `HandOff` reaches the publisher; `--dry-run` still writes nothing and makes no GraphQL call.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the suite and the checker.**
- [ ] **Step 5: Commit.**

---

### Task 9: Documents, skills and the guide

**Files:**
- Modify: `docs/factory/DESIGN.md`, `docs/factory/HOST_SETUP.md`, `factory/AGENT_CONTRACT.md`, `README.md`, `.claude/skills/factory-fix/SKILL.md`, `.claude/skills/factory-revise/SKILL.md`, `AGENTS.md` (only if a sentence is now untrue)
- Test: `factory/tests/test_deploy_files.py`, `factory/tests/test_harness_files.py`

What must be true afterwards: the design's build order marks step 3 as built and section 11 describes the two workflows as built (the prompt from the base commit, the read-only profile, the verdict comment, the repository variables `FACTORY_REVIEW_MODEL` and `FACTORY_REVIEW_FALLBACK_MODEL`, the review not being a merge requirement); the host guide's operating section has the new signals (a review, `/factory revise`, `/factory retry` on a pull request), the hand-off, the three-round limit and its notice, what the `apps` and `review` checks are, and that updating needs no new variable; the contract's sections on `fix` and `revise` match what a run is given (the quoted sections of `context.md`, `round`, the thread ids, where the comment goes); the two skills agree with the contract and say how to answer a thread; the README's status table and steering table show step 3 as built. Plain words, short sentences, present tense, no em dashes; nothing described as working that is not built (the epic track is still not built).

- [ ] **Step 1: Write the failing tests**: the guide mentions `/factory revise`, `fix-rounds-exhausted`'s wording, the two variables and the three check names; the harness tests pin the two skills' mention of `thread_replies` and of `round`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Write the changes.**
- [ ] **Step 4: Run the suite and the checker.**
- [ ] **Step 5: Commit.**

---

## After the tasks

1. A review of the whole branch, then one wave of fixes.
2. A pull request, merged when its checks are green; the two new workflows run on it for the first time.
3. Set the repository variables for the review model after a first run shows which model the key can use.
4. Redeploy on the host (pull, rebuild the image, restart both).
5. A rehearsal on a real issue: checks and review on the bot's pull request, at least one automatic fix round or a hand-off, and one revise run from a review.
