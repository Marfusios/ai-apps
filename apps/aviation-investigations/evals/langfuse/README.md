# Ranking experiments in Langfuse

This TypeScript evaluator runs the production `rankEvidence` function and publishes
datasets, v4 experiment items, metadata-only application traces and deterministic
scores in `aviation-dev`. It does not change the deployed application or run a model
judge. Langfuse holds no provider credentials.

## Frozen learning exercise

The required dataset, `aircase-trackc-dev-v1`, contains the existing 21 Track C dev
questions (12 narrow, 9 broad, 9 connected groups). Each receives one independent
search under `er-q-v1` and `er-q-h50-v1`: **42 searches**. Scope and embedding run
normally; automatic filters are explicitly `none`. Configuration order alternates
by question. Only the question reaches the pipeline; gold filters and case numbers
are exclusively evaluator inputs. There is no scope-output or embedding reuse
between samples beyond caches already in the production path/provider.

Optional `aircase-task24-confirmation-v1` contains the frozen 48-question Task 24
set. Its 96 searches run only after the core finishes and the *entire remaining
block's maximum reservations* fit the task, category and global allowances. Core
reservations total at most $0.2415; optional reservations total $0.552. The optional
block therefore depends on released unused core reservations. It is never selected
based on which ranking scored better. These already-exposed data and single samples
are for learning; they cannot reverse the inconclusive Task 24 release decision.

All Task 25 batches together have a **$0.75 hard cap**, checked in integer
microdollars before every production ledger reservation, under advisory lock
`732500025`. Outstanding or inconsistent reservations stop dispatch. Uncertain
provider delivery charges the full reserved stage. Only the process-local
ingestion/evaluation category allowance is adjusted; global and interactive budgets
are preserved, and no budget setting is written to the database or environment files.
`aviation_dev` database identity and the `aviation-dev` Langfuse project are checked.

## Run and repeat

Install the app's locked dependencies. Supply generic paths to the dev app dotenv,
provider dotenv and the **aviation-dev host** Langfuse connection file. The launcher
parses the latter, refuses partial or conflicting process credentials and starts a
new Node process with its supplied `NODE_EXTRA_CA_CERTS`. TLS verification stays on.

```sh
pnpm eval:langfuse --mode prepare --env-files .env.local \
  --keys-file "$PROVIDER_KEYS_FILE" --langfuse-env "$LANGFUSE_DEV_FILE" \
  --run-label 2026-10-31 --out-dir data/work/task25 --include-confirmation

pnpm eval:langfuse --mode run --env-files .env.local \
  --keys-file "$PROVIDER_KEYS_FILE" --langfuse-env "$LANGFUSE_DEV_FILE" \
  --run-label 2026-10-31 --out-dir data/work/task25 --include-confirmation
```

`prepare` is free: it verifies the actual development corpus and recomputes coded
gold, uploads/verifies the datasets and score configs, then freezes a manifest.
`run` also prepares if needed, so the second command alone repeats the workflow.
Commit changes first. Use the same label/directory to resume: completed searches are
not repeated. A durable start without a result stops for reconciliation, even when
no reservation appears in the local file. The database independently rejects a
duplicate attempt. Use a new label/directory for a genuinely new experiment; it
still consumes the same cumulative Task 25 $0.75 allowance. A future separately
funded task needs a separately reviewed allocation, not a reset of this ledger.

`--mode publish` only reads saved results and publishes/verifies scores; it loads no
provider keys and never calls a provider. This recovers score-upload interruptions.
Completed outgoing spans are archived without content or credentials in
`spans.jsonl`. Missing trace uploads are reported as incomplete and require upload
reconciliation, never a repeated inference. No legacy trace/dataset-run-item
ingestion endpoint is used: the app's `startTracing` and `startRequestSpan` export
OTLP with `langfuse.experiment.*` identity attached to every relevant span.

The ignored output directory contains the manifest, attempt/results journal,
ledger journal, completed-span archive, score verification and run summaries.
Synthetic model outputs are local only. Treat any raw unexpected error as private;
the CLI prints only fixed failures and counters.

## Scores and UI

- `narrow_R20` and `narrow_R10`: fraction of the complete coded gold set retrieved
  in the first 20 or 10 positions, on narrow questions only.
- `broad_P10`: coded gold hits in the first 10 divided by 10; missing positions
  count as zero, on broad questions only.
- `broad_nDCG10`: Task 24's binary coded relevance (gain 3 for a hit), discounted
  by `log2(rank + 1)`, divided by the ideal top-10 value, on broad questions only.

Scores are numeric 0–1. Unrelated strata have no score, not zero. Item scores attach
to the root observation with both observation and trace IDs. Four experiment-level
scores are arithmetic means over their applicable questions. These are coded
reference metrics, not narrative evidence judgments, causal correctness or safety
certifications. Connected questions are correlated; means are descriptive.

Open **aviation-dev → Datasets**, choose the named dataset, and open its experiment
runs. Depending on the v4 UI layout, use **Experiments** and filter to that dataset.
Select the dated `er-q-v1` and `er-q-h50-v1` runs and **Compare**, with Q0 as baseline.
Review scores, cost and latency; inspect individual regressions, then open an item's
trace to see scope, retrieval/embedding and optional rerank stages. Question text and
gold live in the linked dataset item. Trace input/output fields intentionally remain
empty under the app's content-free tracing policy. No private visitor searches are
uploaded or turned into dataset items.

Dataset item IDs stay stable by dataset name and question ID. Re-upload compares
input, expected output, metadata, status and all hashes before making changes; an
edit, unexpected item or conflicting score fails. New fixture versions need new
dataset names. The Git fixtures remain authoritative. API acceptance alone is not
success: the evaluator checks stored traces, items, scores and aggregates by reading
them back.

References: [Langfuse v4 OTLP](https://langfuse.com/integrations/native/opentelemetry/migration-to-v4),
[experiment attributes](https://langfuse.com/integrations/native/opentelemetry/experiments),
[comparison UI](https://langfuse.com/docs/evaluation/experiments/compare-experiments),
[score API](https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk).
The deployment's `/api/openapi.yaml` is authoritative for endpoint and field versions.
