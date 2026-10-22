# Aviation Casebook: tracing and evaluation

**Decision, 2026-10-21.** Use self-hosted **Langfuse** for the developer dashboard,
tracing, scores, datasets, and experiments. Implement aviation-specific evaluators
in TypeScript. Keep Vitest, Fastify injection tests, and Playwright for ordinary
software behavior. A shared Langfuse v4 service exists with separate development
and production projects; the application is not implemented or instrumented yet.
See the [implementation design](DESIGN.md) for the application and launch gates.

Use Langfuse's existing UI. Jaeger and a custom Jaeger dashboard/plugin are outside
the first release. Promptfoo is optional future tooling if a concrete need emerges;
it is not required alongside Langfuse's experiment runner. LangChain and LangGraph
are also unnecessary for this bounded workflow. OpenTelemetry is the instrumentation
underneath the Langfuse integration, not an additional dashboard to operate.

## Features in this application

| Langfuse feature | Planned use |
| --- | --- |
| Traces and observations | Follow one question through scope checking, embedding, retrieval, composition, and verification |
| Token, cost, and latency views | Compare model usage and identify expensive or slow stages; preserve unknown usage |
| Scores | Record deterministic checks, expert assessments, model-judge assessments, and user feedback as separate signals |
| Datasets | Questions, expected case IDs/classifications, supporting evidence, and explicit unknowns |
| Experiments | Compare prompt, model, chunking, or retrieval changes on the same versioned dataset |
| Prompt versions | Associate each result with the exact instructions used; optionally manage prompt releases in Langfuse later |

Langfuse supports custom and model observations, including retrieval, and score
analytics in its [observability UI](https://langfuse.com/docs/observability/overview).
It has a [JS/TS experiment runner](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk)
that accepts local or hosted datasets and application/evaluator functions. We still
write the aviation pipeline, reference labels, and scoring rules.

## One request, one trace

Create a server-owned trace ID for each logical AI request. Idempotent retries
refer to that request rather than creating another model run. Suggested child
observations are:

| Step | Useful recorded fields |
| --- | --- |
| Admission | Accepted/rejected outcome and bounded reason code; no credential or quota identity material |
| Scope/plan | Intent enum, validated filters, model/prompt version, token usage, duration |
| Embedding | Model/dimensions, usage, duration; do not log the vector |
| Retrieval | Corpus/index revision, strategy, bounded case/passage IDs and ranks, duration |
| Composition | Model/prompt version, usage, duration, structured-output status |
| Verification | Citation-check results, support-check outcome, fallback/abstention reason |
| Settlement | Request accounting reference, reported cost or uncertainty status |

Example: if an answer confuses a pilot's suspicion with an investigator finding,
inspect whether the relevant case was retrieved, which passages reached composition,
and how the output was validated. Full inputs/outputs are useful for development
fixtures; the production capture policy below deliberately limits stored content.

Tag traces with environment, application commit, corpus revision, retrieval/chunking
configuration, model snapshot, and prompt hash/version. A small allowlist of tags
prevents arbitrary user text becoming metadata. Keep development, evaluation, and
production distinguishable; use separate Langfuse projects/credentials for production
and non-production, and a separate project for each future application.

Initialize tracing before the instrumented application code. Use the official
TypeScript integration, adding explicit observations around our Elasticsearch and
validation functions. Avoid duplicate observations from overlapping automatic and
manual instrumentation. Bound queues, payload sizes, export timeouts, and retries;
flush short-lived evaluation jobs before exit. Export failures must not cause a
second model call or stop public requests. Record dropped telemetry as an operational
metric. [Tracing setup](https://langfuse.com/docs/observability/get-started).

## What an evaluation measures

An evaluation is a repeatable assessment against defined criteria. Many AI
evaluations resemble integration tests or quality benchmarks; they complement
ordinary unit tests. Assess properties and evidence rather than require identical
answer wording.

| Layer | Example | Execution |
| --- | --- | --- |
| Software tests | Quota races, filter compilation, ownership checks, exact citation offsets | Vitest/integration tests; provider calls mocked, network-independent fixtures |
| Retrieval evaluation | Does the top 20 contain the reviewed relevant cases? | Fixed Elasticsearch corpus; keyword/vector/hybrid comparison |
| Component evaluation | Does a known passage support a causal fault, a negative examination, or an unproven defect? | Model call on a fixed passage; compare structured labels |
| End-to-end evaluation | Does a question produce a relevant, supported case comparison? | The same pipeline functions used by the API, including retrieval and validation |
| Production evaluation | Are sampled real answers supported and useful? | Asynchronous assessment after the response, within a separate budget allocation |

“Offline evaluation” in AI means evaluation on a prepared dataset, outside live
user traffic. It can still call a provider and incur charges. Keep that distinction
explicit in commands and CI: routine tests require no provider keys or Langfuse;
provider-backed experiments are opt-in.

## Development workflow

1. **Prepare reference cases.** Start with the four cases in [the data review](DATA_REVIEW.md),
   then build the design's 60–100-question set. An instructor/analyst reviews labels
   and evidence. Separate development and held-out cases, including all variants
   and chunks from each investigation, to prevent leakage between splits.
2. **Version inputs and expectations.** Keep redistributable fixtures, questions,
   expected case IDs, classification labels, citation references, and rubrics in
   `evals/` and `fixtures/` in this app. Pin dataset and source revisions. Expected
   labels belong to the evaluator and are never passed to the answer model.
   Sync reviewed sets to Langfuse when its shared dataset UI is useful; designate
   the Git revision as the release benchmark to avoid conflicting sources of truth.
3. **Execute a TypeScript task.** Add a future script such as `pnpm eval:aviation`
   that invokes the real search/answer functions through the Langfuse experiment
   runner. The command is proposed, not implemented. The script runs locally or
   on a controlled CI runner with private service access; it does not need a public
   evaluation endpoint. Creating a dataset in the UI does not execute our backend.
   Use read-only credentials on pinned evaluation indices and an authorized
   evaluation principal for the shared spend gate, without consuming a user's trial.
4. **Score each stage and the run.** Our evaluator functions execute in the script
   process and submit results. Record errors, missing scores, and skipped cases
   explicitly; none count as a pass. Apply deadlines, bounded concurrency, and the
   same paid-call accounting used by the application.
5. **Compare a baseline and candidate.** Change one factor where practical and hold
   the dataset, corpus, and other settings fixed. Record all versions when several
   factors change. Repeat selected cases to expose variation; report sample size,
   abstentions, and error rates alongside aggregate scores. Inspect individual
   regressions in Langfuse, not only the average.
6. **Apply release gates.** The script returns a failing exit status for violated
   thresholds or incomplete required measurements. Use the targets in design §12,
   keeping citation integrity, retrieval, and causal classification separate.
   A passing model-judge score does not waive security tests or expert review.

The experiment runner supports task functions, custom item/run evaluators, and
trace comparison; execution stays in our process. [SDK experiments](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk).
Code authored and executed inside the Langfuse UI is a separate feature requiring
a dispatcher for self-hosting. We do not need that execution service for version one.
[Code evaluators](https://langfuse.com/docs/evaluation/evaluation-methods/code-evaluators).

## Scores and reference labels

| Signal | How we produce it | Limit |
| --- | --- | --- |
| `retrieval_recall_at_20` | Compare the top 20 distinct candidate cases, before the final context limit, with reviewed relevant IDs | Depends on reference-set coverage; not all relevant cases in the entire archive |
| `causal_fault_precision` | Compare structured causal-fault claims with expert labels across the run | Cannot treat unknown ground truth as correct or as a negative |
| `citation_integrity` | Check allowed IDs, revisions, offsets, and exact text | Valid quotations can still be attached to unsupported claims |
| `claim_support` | Expert review or a calibrated model judge using claim/evidence pairs | Judge output is an assessment, not ground truth |
| `scope_decision_correct` | Compare intent/rejection with reviewed expectations | Measure valid-question false rejections as well as attack rejection |
| `user_helpfulness` | Validated feedback submitted through our API | Satisfaction does not establish factual accuracy |

Record evaluator name/version, source (`code`, `expert`, `model`, `user`), and a
bounded rationale where appropriate. Scores must distinguish `unsupported`,
`unknown`, and execution failure. Model judges receive a fixed rubric and untrusted
evidence, have no privileged tools, and are calibrated against independent human
labels. Do not reuse the inline verifier as the sole independent release judge.
Langfuse accepts [custom scores through its API/SDK](https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk).

For example, an aircraft defect that investigators did not establish as causal
should be classified as **defect found without established causal link**. An answer
calling it a confirmed causal failure should fail that fixture even if it retrieves
the right case and supplies a valid quotation. The seed labels remain provisional
until expert adjudication.

## Production feedback and evaluations

Retain deterministic validation outcomes and sampled operational traces. Start
model-judge monitoring disabled, then enable a capped sample only after costs and
judge quality are measured. Our worker evaluates approved samples within the
existing temporary-processing window and sends scores back to Langfuse. This
avoids copying all production question/answer content into the monitoring service.

Keep sampling rates and selection criteria visible. A failure-enriched review
sample is useful for debugging but does not estimate overall production accuracy.
Review a representative sample separately when reporting population-level metrics.
New regression fixtures must be reviewed and sanitized or rewritten as synthetic
examples before long-term retention or Git inclusion.

Feedback goes through an authenticated or trial-bound application endpoint that
checks ownership of the originating request, rate limits submissions, and assigns
the allowed feedback score itself. The browser cannot choose another trace or
submit an expert/correctness score. No Langfuse API credentials go to the browser.

Langfuse supports [online and offline evaluations](https://langfuse.com/docs/evaluation/overview).
For this app, inline scope/citation checks remain in the response path. Later
monitoring scores cannot retroactively protect an answer already shown to a user.

## Privacy, retention, cost, and availability

- **Private developer interface.** Keep the dashboard and ingestion endpoints
  separate from the public application, authenticated, with restricted operator
  access. Self-hosting alone does not establish an access boundary.
- **Explicit capture policy.** Development/benchmark traces may contain synthetic
  questions and sanitized public case passages. Production defaults to allowlisted
  metadata, timings, usage, IDs, and validation outcomes, with no question/answer
  bodies, email, raw IP, cookies, authorization headers, or credentials. Disable
  automatic input/output capture accordingly; filter error messages and third-party
  instrumentation too. If sanitization fails, drop the observation. Apply filtering
  before export, not only in the UI. [Masking](https://langfuse.com/docs/observability/features/masking).
- **Bounded retention.** Keep active production trace metadata/scores at most 30 days.
  Production content needed by an asynchronous evaluator remains in temporary app
  storage for at most the existing 24-hour window, with no longer-lived telemetry
  copy. Reviewed public/synthetic benchmark fixtures can persist. Apply deletion
  across tracing stores, object storage, and exports; backups follow the design's
  30-day backup expiry and restores must reapply deletions/expiry before access. Verify the
  deployed edition's deletion mechanism rather than assume a free automatic TTL.
  Adding content-rich production tracing later requires an explicit capture and
  retention design update and matching privacy notice.
- **One spending boundary.** The PostgreSQL ledger remains authoritative. All
  experiments and background model judges reserve/settle spend through the shared
  gate and consume the proposed $20/month indexing/evaluation allocation. Enforce the
  overall $100 ceiling and global concurrency. Sampling and Langfuse cost charts do
  not authorize spending or replace reconciliation. Missing usage remains unknown.
- **Evaluator execution.** Keep provider credentials in the application/evaluation
  worker, not in autonomous Langfuse judge configurations for version one. A direct
  Langfuse-triggered provider call would bypass our cost gate unless explicitly
  integrated. Disable automatic paid retries and deduplicate scheduled assessments.
- **Graceful outages.** Tracing is best-effort with bounded buffering. Requests
  continue if Langfuse is unavailable, while authoritative quota failures still
  deny paid calls. Required release experiment uploads/gates must report failure or
  incomplete status; do not silently approve a release without its evidence.

## Prompt management and hosting

Initially keep prompts in Git and attach their hashes/versions to traces. Langfuse
can later manage named prompt versions and release labels. Pin the evaluated
version in a release and retain a bundled fallback so a fresh instance can start
without reaching the prompt service. Do not silently fetch an unreviewed latest
prompt. [Prompt management](https://langfuse.com/docs/prompt-management/get-started).

Plan one reusable Langfuse deployment with separate projects for applications.
Use Compose project `ai-observability` to group its services; avoid fixed global
container names. The aviation app connects through configuration and remains
runnable with tracing disabled. Its README will document a portable local
observability option when implementation begins; no private host is required.

The shared deployment runs Langfuse v4 on its event-based ingestion path; legacy
`trace-create`/`generation-create` ingestion is rejected. Pin a compatible
OpenTelemetry-based TypeScript SDK, check the instance's published
`/api/openapi.yaml`, and verify one small trace and experiment early in milestone 2.
Its 30-day trace limit is applied by a scheduled cleanup job using the public
deletion API; deletion is asynchronous. [v4 migration](https://langfuse.com/integrations/native/opentelemetry/migration-to-v4).

Langfuse's current architecture includes web/worker services, PostgreSQL,
ClickHouse, Redis/Valkey, and S3-compatible object storage. It cannot use our
Elasticsearch index as a substitute for these components. A dedicated PostgreSQL
database/role may share a compatible server, with independently managed migrations.
Pin compatible versions and isolate service credentials. [Self-hosting architecture](https://langfuse.com/self-hosting).

The current VM guide recommends 4 cores and 16 GiB RAM. That is a planning reference,
not a measured requirement for this workload. Measure alongside the application
and search engine, budget disk/retention, and provide backups and restores.
Langfuse services' resource needs are additional to the application budgets in the
main design. [Docker Compose guide](https://langfuse.com/self-hosting/deployment/docker-compose).

The proposed environment contract adds `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`,
and `LANGFUSE_SECRET_KEY`, plus the application-owned `AVIATION_TRACING_ENABLED`
switch. When enabled, require an explicitly configured endpoint and project keys;
never fall back to a hosted-cloud endpoint implicitly. Keep both keys server-side.
No dependency installation, migrations, or service deployment is part of this doc.

## Implementation acceptance

- A synthetic query produces one correctly nested trace with retrieval IDs,
  versions, timing, and usage; retries do not duplicate the paid pipeline.
- Public request data and synthetic secrets do not appear in exported payloads,
  including errors, judge traces, or third-party spans.
- A TypeScript experiment compares a baseline and candidate on a pinned fixture
  set, with inspectable per-case scores and explicit failed/skipped cases.
- An intentionally incorrect causal classification fails evaluation despite a
  valid citation; uncertain evidence stays uncertain.
- Budget exhaustion stops experiment/judge calls; tracing outages preserve app
  availability and never bypass quota enforcement.
- Dashboard/project access, feedback ownership, deletion/retention, and backup
  handling are verified before public launch.

These additions postdate the initial Claude review; see the
[review scope addendum](SECURITY_REVIEW.md#design-addendum-2026-10-21).

## Implemented tracing

`server/observability/tracing.ts` exports spans over OTLP/HTTP to
`<LANGFUSE_BASE_URL>/api/public/otel/v1/traces` with the project keys, using a bounded
batch processor (256 queued spans, short export timeout). `startTracing` does nothing
unless `AVIATION_TRACING_ENABLED=true` and the base URL and both keys are set, and never
falls back to a hosted service. Export errors are swallowed into a counter.
`stageSpan(name, attrs, fn)` accepts only the closed `AllowedAttrs` set; a runtime guard
in `server/observability/attributes.ts` drops unknown keys, strings over 64 characters,
anything containing whitespace or a path separator (`/`, `\`) and enum attributes
outside their set, and replaces unsafe span names. Brief ids appear only as a salted
hash (`hashBrief`). `scripts/trace-smoke.ts` sends one synthetic span by hand.

**Approved metadata.** Nothing else is exported:

| Where | Keys |
| --- | --- |
| Resource (every span) | `service.name` = `aviation-casebook`; `deployment.environment` and `deployment.environment.name` = `APP_ENV` (`dev` or `live`). Set explicitly: the SDK default (`unknown_service:<node path>`) would export a filesystem path. |
| Span attributes | `stage`, `provider`, `model`, `promptVersion`, `inputTokens`, `outputTokens`, `cacheWriteTokens`, `cacheReadTokens`, `thinkingTokens`, `usd`, `durationMs`, `outcome`, `briefHash`, `datasetGeneration`, `indexVersion`, `passageCount`, `caseCount`, `failure`, `failureStage` |
| Instrumentation scope | `aviation-casebook` |

`failure` is the fixed category of a failed stage (`FAILURE_CATEGORIES`): from a provider
stage `timeout`, `refusal`, `truncated`, `invalid_output`, `cap_exceeded`,
`count_failed`, `invalid_input`, `rate_limited`, `overloaded`, `auth`, `bad_request`,
`network` or `provider_error`; from retrieval `unavailable`, `timeout`, `failed` or
`integrity`; for the step `claims_overflow`, `result_contract`, `shutdown`, `orphaned` or
`unexpected`. A failed stage span (`brief.scope`, `brief.retrieve`, `brief.compose`,
`brief.check`) carries `failure` and, for a provider stage, `promptVersion`; the
request span `brief.step` carries `outcome` with `failure` and `failureStage` (`scope`,
`retrieve`, `compose`, `validate`, `check` or `pipeline`). The same category and stage
are in the step's `meta.failure` and in its `brief step finished` log line
(`{status, charged, released, failure: {stage, category}}`), so a stage failing on
every request (as the first paid end-to-end test did at scope) is visible in Langfuse
and the logs, not only in the database. A reader's cancel is not a failure: the stage
span and `brief.step` carry `outcome: cancelled`, with no `failure` attribute, category
or log field.

`thinkingTokens` is the provider's reported reasoning share of a stage's output
(`usage.output_tokens_details.thinking_tokens`), when it reports one; it is also kept
per stage in the step's `meta.thinkingTokens`, to calibrate the answer stage's thinking
allowance. `outputTokens` stays the billed total.
