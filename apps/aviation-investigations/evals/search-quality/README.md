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
