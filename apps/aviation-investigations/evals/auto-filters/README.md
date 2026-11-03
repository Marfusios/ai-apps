# Automatic-filters evaluation (Task 30)

Measures the automatic filter policy `attributed.v1` (or another registered variant chosen with
`--policy`): a question search applies the scope's suggested state, years and aircraft category on
its own only when deterministic candidate rules let the field through and a separate AI check says
it describes the accident itself. Every paid call goes through the production `rankEvidence` and the
evaluation allocation's spend gate.

## Probe families

Two frozen files, each validated strictly before any call (`probes.ts`):
`frozen/probes-dev.json` (sources `writer-a`, `writer-b`, `review-24`, `codex`, `controller`) and
`frozen/probes-confirm.json` (sources `c1` to `c6`, never used for any change). Both have
`{ version: 'task30-probes-v1', probes: [{ id, question, forced, gold, field, kind, pattern, source }] }`:
questions of at most 300 characters, unique ids and questions, `forced` with at least one of
`state`, `yearFrom`/`yearTo`, `category` (what a naive scope might emit: codes from its vocabulary,
years as the question writes them), and `gold` (what a careful reader would apply automatically,
possibly `{}`). Neither `forced` nor `gold` is ever shown to a model. A forced value the scope schema
cannot carry (a year 1500 from "1500 hours") makes the scripted answer invalid, and the search falls
back as it would for a real scope's (`scope:invalid_output`).
The first preflight of a confirmation part freezes the confirmation file's sha for the run label;
confirmation runs refuse a missing or changed freeze.

## Parts

| Part | Input | Scope | Samples | Retrieval |
| --- | --- | --- | --- | --- |
| `dev-forced` | development probes | scripted: returns `forced`, zero usage, settled at $0 through the gate | 3 | offline, no cases |
| `dev-e2e` | development probes | scope.e3 | 3 | offline |
| `state-replay` | `tests/fixtures/state-field-replay.json` (1,040 recorded scope.e3 answers) | scripted: the recorded intent and states; a recorded failure as an unbilled error | 1 | offline |
| `c2` | `evals/search-quality/part5/frozen/fields.json` (1,600 year and category questions) | scope.e3 | 1 | offline |
| `confirm-forced` | confirmation probes | scripted | 3 | offline |
| `confirm-e2e` | confirmation probes | scope.e3 | 1 | offline |
| `retrieval` | Task 29's sets on dev (`trackc-dev` x3, `confirmation` x1) | scope.e3 | set's | production |

The attribution parts run ranking `er-q-v1` (no rerank) with no request filters; the attribution
check is always the real adapter. The offline retriever returns no cases and checks that only the
policy's automatic filters reached it. The state replay checks its `observationsSha256` against
part 5's exclusion audit and its questions and gold against Task 24's frozen field set; C2 checks
its sha against its field manifest.

`retrieval` re-derives Task 29's labels on the active dev generation (Task 29's `verifyTarget`) and
records the current identities of `er-q-v1` and `er-q-h50-v1` (never Task 24's frozen hashes) and the
policy's. Rows: `Q0` (Elasticsearch alone), `QH50` (the live search, suggestions only), `QH50+F` (its
"Apply these filters" edit), `QH50+A` (the live ranking with the policy: what a visitor gets on the
first search) and `QH50+A+F` (the "Apply these filters" edit of `QH50+A`: its applied filters plus
the remaining suggestion's, only when its page shows the button; otherwise it keeps the `QH50+A`
ranking). It refuses to dispatch from 03:30 to 06:00 Europe/Prague.

## Scores

Per field (state; years as one field, both bounds; category) and part: TP (applied exactly gold),
FP (anything else applied: `wrong_value`, or `applied_on_trap` when gold lacks the field), FN, TN;
precision with Wilson one-sided 95% (z 1.6449) and simultaneous (z 1.96) lower bounds and the exact
lower bound; recall. A probe is a trap for a field when its `forced` value differs from gold; a
positive when it equals gold (scripted parts) or when gold holds the field at all (scope.e3 parts). Probes also report: question-level trap failure (an item fails when
any sample applied a value gold does not hold) and pooled samples, with one-sided 95% exact
(Clopper–Pearson) upper bounds; the model-only rate (samples whose check answered for the field)
beside the policy-level rate; how each trap ended (`not_candidate:*`, `attribution:*`, `bad_quote`,
`attribution_unavailable`); question-level precision with the exact lower bound; positive recall
with candidate coverage; the whole filter object per sample and question; breakdowns by pattern,
source, kind and field; unsafe applications on review-24 probes. The replay compares with v1.3's
recorded 365/0/35 (and 363/0/37 behind the search gate); C2 applies its registered clearing rule to
the applied fields. Retrieval reports Task 29's coded metrics per row, paired group bootstrap
intervals of narrow Recall@20 (10,000 resamples, seed 30) for `QH50+A - QH50` and
`QH50+A - QH50+F`, fallback rates per stage including attribution, how often `QH50+A` applied each
field, and per-question losses.

**Decision per field** (spec.md, registered before any result), from the confirmation forced run:
trap upper bound at most 1% (needs at least 299 trap items), question-level precision lower bound
at least 98% (at least 149 applications), no unsafe application on a review-24 probe in either
development run; end-to-end confirmation recall below 50% is reported as not useful. A missing or
incomplete run, an insufficient denominator or a straddling bound keeps the field off.

## Lanes

A part can run as up to nine parallel lanes: `--shard <i>/<k>` (default `1/1`) runs the items whose
index in the part's seeded order is `i - 1` modulo `k`. Every lane is its own process with its own
allocation, advisory lock, cap and journal, and makes one reservation at a time like any allocation.

| Part | Budget | Lock keys (`733000100 + 10 x index + i`) |
| --- | --- | --- |
| `dev-forced` | $0.80 | 733000101-109 |
| `dev-e2e` | $1.40 | 733000111-119 |
| `state-replay` | $0.40 | 733000121-129 |
| `c2` | $1.20 | 733000131-139 |
| `confirm-forced` | $1.30 | 733000141-149 |
| `confirm-e2e` | $1.50 | 733000151-159 |
| `retrieval` | $1.40 | 733000161 (one lane only) |

The budgets sum to the **$8.00** hard cap. A lane's ledger prefix is `eval-task30-<part>-<i>of<k>`
and its cap the part's budget divided by `k`, rounded down. A lane opens with an evaluation
allowance covering the whole family's remaining liability (every `eval-task30-` lane), so lanes
never starve each other while each stops at its own cap. The part manifest (code commit, policy,
input and order shas, `k`) is frozen by the first lane to start; every other lane must match it, so
all lanes of a part share one commit and one `k`. The last lane to finish writes the part's summary;
`summarize` merges every lane journal and refuses a part with a missing, extra or foreign lane, an
attempt journaled twice or an unreconciled lane. A part with any lane unfinished is reported
incomplete, never scored or used for the decision.

## Run

```sh
pnpm eval:auto-filters --mode preflight --run-label <label> [--shard 1/<k>] \
  --env-files <dev database dotenv>,<dev Elasticsearch dotenv> --keys-file "$PROVIDER_KEYS_FILE"
pnpm eval:auto-filters --mode run --part <part> --shard <i>/<k> --confirm-cost --run-label <label> \
  --env-files <dev database dotenv> --keys-file "$PROVIDER_KEYS_FILE"     # one process per lane
pnpm eval:auto-filters --mode summarize --run-label <label> [--dev-label <development label>]
```

`preflight` is free: it validates the inputs and prints identities, file shas, and sizing per part
and per lane for the given `k` (for scripted parts it runs the candidate rules, so their chargeable
worst case is exact). The first preflight of a confirmation part freezes the confirmation probes'
sha. With `--part`, it also opens that lane's allocation without reserving; without `--part`, it
reads the family's ledger totals.

The attribution parts need only the dev ledger and the Anthropic key; `retrieval` also needs the
dev database, Elasticsearch and the OpenAI key, and refuses to dispatch from 03:30 to 06:00
Europe/Prague. Commit first: every mode refuses a dirty tree. `--policy <version>` selects a
registered variant with an attribution check (default `attributed.v1`); each part freezes its
policy at its first lane. `summarize` is free and offline; `--dev-label` names the label whose
development runs provide the review-24 veto.

**Cost.** Each item (a retrieval question) starts only when its remaining worst case fits its
lane's cap and the allowance, and the production gate checks every stage. Worst cases per stage:
a scope $0.002413, the check `attributionWorstCaseUsd` ($0.000625 at a 3,000-token input cap), an
embedding $0.00002, a rerank $0.006538. A scripted-scope sample reserves the scope, the check and
the embedding but can be charged only for the check; a scope.e3 sample for the scope and the check.
Expected (conservative): $0.0003 per scripted sample whose check runs, $0.0006 per scope.e3 sample,
about $0.0125 per retrieval sample (`QH50`, `QH50+A` and their edits).

Output (ignored, `data/work/task30/<label>/` by default): `<part>/manifest.json`, and per lane
`<part>/<i>of<k>/` with `lane.json`, the journal `results.jsonl` (every attempt written before
dispatch), model outputs, stage charges and `allocation.jsonl`; `retrieval/questions.json`;
`summary-<part>.json`, `summary-decision.json` and `summary.md`. A rerun of a lane resumes; an
attempt without a durable result, a failed search, or three consecutive infrastructure outcomes
among the AI calls stops that lane, and nothing is repeated under its label.
