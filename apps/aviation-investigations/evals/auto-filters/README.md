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
`state`, `yearFrom`/`yearTo`, `category` (what a scope could emit), and `gold` (what a careful
reader would apply automatically, possibly `{}`). Neither `forced` nor `gold` is ever shown to a model.
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
lower bound; recall. A probe is a trap for a field when its `forced` value differs from gold, a
positive when it equals gold. Probes also report: question-level trap failure (an item fails when
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

## Run

```sh
pnpm eval:auto-filters --mode preflight --run-label <label> \
  --env-files <dev database dotenv>,<dev Elasticsearch dotenv> --keys-file "$PROVIDER_KEYS_FILE"
pnpm eval:auto-filters --mode run --part <part> --confirm-cost --run-label <label> \
  --env-files <dev database dotenv>,<dev Elasticsearch dotenv> --keys-file "$PROVIDER_KEYS_FILE"
pnpm eval:auto-filters --mode summarize --run-label <label> [--dev-label <development label>]
```

`preflight` (all parts, or one with `--part`) is free: it validates the inputs, prints identities,
file shas and sizing, freezes the confirmation probes' sha on its first confirmation preflight and
opens the allocation without reserving. The attribution parts need only the dev ledger and the
Anthropic key; `retrieval` also needs the dev database, Elasticsearch and the OpenAI key. Commit
first: every mode refuses a dirty tree. `--policy <version>` selects a registered variant with an
attribution check (default `attributed.v1`); each part freezes its policy at its first run.
`summarize` is free and offline; `--dev-label` names the label whose development runs provide the
review-24 veto.

**Cost.** Allocation `eval-task30`: its own advisory lock and an **$8.00 hard cap** on charged plus
open reservations; an item (a retrieval question) starts only when its remaining worst case fits,
and the production gate checks every stage. Worst cases per sample: a scope $0.002413, the check
$0.000625, an embedding $0.00002, a rerank $0.006538. A scripted-scope sample reserves $0.003058
and can be charged at most $0.000625; a scope.e3 sample at most $0.003038. Expected (conservative):
$0.0003 per scripted sample whose check runs, $0.0006 per scope.e3 sample, about $0.0125 per
retrieval sample (`QH50`, `QH50+A` and their edits).

Output (ignored, `data/work/task30/<label>/` by default): per part `manifest.json`, the journal
`results.jsonl` (every attempt written before dispatch), model outputs and stage charges;
`allocation.jsonl`; `summary-<part>.json`, `summary-decision.json` and `summary.md`. A rerun with
the same label resumes; an attempt without a durable result, a failed search, or three consecutive
infrastructure outcomes among the AI calls stops the run, and nothing is repeated under that label.
