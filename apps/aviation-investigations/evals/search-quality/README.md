# Task 24 search-quality evaluation

The registered study separates ranking selection/confirmation (A/B) from exact-field
confirmation (C). Protocol and operational reports live outside version control. No
production configuration or automatic filter is enabled by these evaluation files.

`frozen/` contains 48 fresh coded confirmation questions, their complete gold sets and
24 connected groups, 1,040 field questions, historical exclusions, provenance and
leakage checks. State has 400 positive questions and 400 no-apply controls. Year range,
category, phase, injury, conditions and light each have a diagnostic 20+20 screen.
The independent verifier uses the existing Track C coded-predicate implementation.
No narrative judgment or model output supplies field gold. Gold filters are evaluation
labels: A/B execution always passes an empty filter object.

`shared/state-eligibility.ts` exports the pure `state-explicit.v1` guard. It requires
an explicit positive event-location reading and exact agreement with all states
named in the question. Full names and qualified city/postal forms are supported;
negation, ambiguous place names, cross-field alternatives, instruction-like wording,
unsupported geography and incomplete state sets abstain. It never invents a state.
This intentionally restrictive policy needs controller review before production use.
Raw and guarded results are scored separately; abstentions remain recall misses.

## Free construction and verification

Run from the application directory using Node 24. Local environment paths are
explicit CLI arguments; files are parsed as data and secrets are never displayed.
Snapshots and run outputs belong under ignored `data/work/task24/`.

```sh
node --import tsx evals/search-quality/verify-data.ts
node_modules/.bin/vitest run tests/unit/state-eligibility.test.ts tests/unit/task24-allocation.test.ts tests/unit/task24-fields.test.ts
node_modules/.bin/tsc --noEmit -p tsconfig.json
```

`snapshot.ts` reads coded development metadata in a read-only repeatable-read
transaction. `exclusions.py` inventories previously exposed questions/cases/families;
`construct.py` rejects whole overlapping predicates, never removes inconvenient
positives from their gold. The manifests retain hashes and portable source labels.

Commit reviewed construction before invoking `freeze-fields.ts --env-files FILES
--keys-file FILE`. It performs only free Anthropic token counts and a development
ledger preflight, then writes an immutable source/data/settings manifest. Commit that
manifest before paid execution. Do not overwrite it after observing responses.
The completed C freeze belongs to its recorded commit. A later server merge can make
its runtime-file hashes differ at HEAD; that must refuse a fresh field dispatch. Use
the recorded commit for an audit, and the retained observations for a free rescore.

## Explicit field execution

`fields.ts` is a dry run by default. Paid C execution requires `--confirm-cost`, explicit
development connection files and the frozen manifest. It calls unchanged scope.e3
once per question, with no retries. No retrieval, embeddings, narrative judges, HTTP
route, user quota or tracing exporter is involved.

```sh
node --import tsx evals/search-quality/fields.ts
node --import tsx evals/search-quality/fields.ts --env-files FILES --keys-file FILE --confirm-cost
```

All Task 24 paid runners must use `money.ts`: development database only, advisory lock
`732400024`, reservation prefix `eval-task24:<phase>:<freeze-hash>:<attempt>`, production
spend gate and ledger, and integer-microdollar accounting. Caps are $30 total, $9
selection, $12 confirmation, $3 fields and $5 narrative. Each block must fit its full
worst-case reservations before starting. Every subsequent reservation rechecks spend.
The ingestion monthly allowance is run-local: current category spend plus $30, capped
at $50. No shared configuration file is changed.

Dispatch and result journals are durable and content-bearing outputs stay ignored.
An uncertain response charges its full reservation. Resume never repeats a reserved
attempt. Missing billed observations, lost locks, inconsistent accounting or dependency
failures stop the run; an incomplete run cannot clear a field. No field result can
clear A/B. Paid A/B execution separately requires the controller's GATE 24-R clearance
and the reviewed production ranking entry point.

## Ranking runner

`ab.ts` calls `server/evidence/pipeline.ts` through `ab-production.ts`. The adapter
adds timing and durable observations and injects the common Task 24 gate; it does not
implement retrieval or reranking. Every question gets three independent scope/search
attempts, with empty execution filters and the original question as the vector query.
The six-arm core must fit as a whole. Optional depth and Sonnet blocks are admitted by
the registered development-only rule and full-block reservation cost. Confirmation
requires the single frozen development winner and runs exactly 288 searches.

`ab-score.ts` measures full-gold R@20/R@10 and ranking P/nDCG at 6/10, averaging samples
within questions before paired connected-group bootstrap. It applies the registered
5-point primary improvement, secondary margins, latency/cost/fallback limits and
stronger confirmation lower bounds. It never selects from an incomplete arm.

`freeze-ab.ts` performs read-only gold/index checks and free provider counts, and pins
the code, server commit, all configuration hashes, input/output bounds, price source,
source/index identities, dataset hashes and random seeds. It needs the registered
protocol and field-design files as explicit arguments, plus the full server commit.
The manifest remains marked pending controller review. Paid execution additionally
requires a gate certificate and its matching GATE 24-R report; neither is created by
construction. A dry run loads no provider keys and sends no requests.

```sh
node --import tsx evals/search-quality/ab.ts
node --import tsx evals/search-quality/ab.ts --phase selection --env-files FILES --keys-file FILE --gate-certificate CERT --gate-report REPORT --confirm-cost
node --import tsx evals/search-quality/ab.ts --phase confirmation --selection-file SELECTION --env-files FILES --keys-file FILE --gate-certificate CERT --gate-report REPORT --confirm-cost
```

Stage timings include the shared pipeline's preparation and ledger overhead; embedding
time is nested inside retrieval time and must not be added twice. Cache counts, actual
settled charges, complete cold reservations, fused pools, final ranks, executed query
texts, scope/rerank outcomes and configuration identities are retained in ignored run
outputs. A full-search/safety failure or three consecutive infrastructure failures
stops an incomplete run. Resume cannot replace a paid or uncertain observation.

`frozen/narrative-plan.json` fixes the optional eight-question, two-provider first-page
diagnostic, its rubrics and calibrated Track N identities. Its actual case union and
complete-record chunk inventory can only be constructed after qualifying A/B
confirmation. That entire inventory must fit the separate $5 allocation before any
judge call; otherwise skip it in full. No narrative calls are part of construction.
