# Task 10d phase A: pre-registration of the retrieval experiments

Registered on 2026-10-23, before any experiment ran. `grid.json` is the
machine-readable form of everything below; the runner (`cli.ts`) reads it, refuses a
grid whose baseline is not the production baseline, and refuses a target or dataset
other than the frozen ones. The harness is the commit before this one. Scores are
**coded-reference** (Track C of the task 10c protocol): they measure retrieval of
coded facts, never adjudicated relevance, and absence of a code is not a negative
judgement.

## 1. Question

Hybrid retrieval loses most coded positives of the narrow questions: on the dev
questions, Recall@20 is 47.4% while the union of both channels' candidates holds 73.9%
of the positives at 50 passages per channel and 91.0% at 100, and hybrid's own first
50 cases hold 66.4%. Phase A asks which changes that need **no new index, prompt or
embedding model** recover them: fusion and depth (E7), case-level lexical retrieval on
the existing cases index including its `findings_text` (E5 on the existing field), and
the scope stage's keyword text as BM25 text (E3). It also diagnoses every lost
positive, and measures bounded candidate pools as the input of a later reranker.

## 2. Frozen data, target and software

- **Dataset:** `evals/retrieval/coded/dataset.json` (coded-v1, sha256 `5d1746bd…b3a4`,
  specs sha256 `9410da39…5e49`), generation 1 (archive `bc74fefb…b052`, mapping
  `v1-empirical`, normalization `v1`, citation text `v1`). The preflight re-derives
  every question's labels on the target and stops on any difference.
- **Target:** passages index `ai-aviation-dev-passages-v2-g1-20261022185219373-e0c815e5`
  (passages-v2, fingerprint `ed335f46…3dd2`) and cases index
  `ai-aviation-dev-cases-v3-g1-20261022143728115-f0d0e84d` (cases-v3, fingerprint
  `2a6f1f58…45e9`), both named by the active manifest. Read-only: the read key, and
  the app role for the label checks. The only writes are ledger reservations.
- **Models:** query embeddings `text-embedding-3-small` at 1,536 dimensions; scope stage
  `claude-haiku-5-5` with the reviewed prompt `scope.v2`, unchanged.
- **Questions:** only the 21 **dev** questions: 12 narrow (1 to 20 coded cases; seven
  connected case groups) and 9 broad (three groups, one of which holds six questions).

| Class | Question | Group |
| --- | --- | --- |
| narrow | `env-carb-icing-cause-michigan`, `para-carb-icing-cause-michigan` | g12 |
| narrow | `sys-fuel-selector-misuse-2023-2026`, `occ-fuel-starvation-minnesota`, `para-fuel-starvation-minnesota` | g4 |
| narrow | `sys-recip-power-section-arizona` | g10 |
| narrow | `sys-magneto-failure-2014-2016` | g21 |
| narrow | `per-maintenance-personnel-cause-hawaii`, `para-maintenance-personnel-cause-hawaii` | g1 |
| narrow | `occ-midair-nevada`, `para-midair-nevada` | g9 |
| narrow | `occ-midair-helicopters` | g17 |
| broad | `env-carb-icing-texas`, `sys-fuel-system-failure-airplanes-2008-2012`, `sys-gear-not-operated-2023-2026`, `per-preflight-cause-alaska`, `para-preflight-cause-alaska`, `occ-fuel-starvation-takeoff` | g4 |
| broad | `per-pilot-decision-cause-weight-shift` | g18 |
| broad | `occ-cfit-utah`, `para-cfit-utah` | g6 |

## 3. Baseline

Today's retrieval (`RETRIEVAL_DEFAULTS`): passage BM25 and passage kNN, 50 passages
each, kNN `num_candidates` 200, reciprocal rank fusion with k = 60 and equal weights
over the passage lists, each case at its best passage, packing into at most 6 cases
and 12 passages; BM25 searches the question, as Track C measured it. In code this is
`BASELINE_CONFIG`; a unit test holds that it sends exactly the production request
bodies and returns the production ranking and bundle.

The brief pipeline passes the scope stage's keyword text to BM25 (falling back to the
question when it is empty), so E3 is what the pipeline searches today; the registered
comparison is still with the Track C baseline.

Reference numbers from the saved Track C run of this index (dev, 50 per channel):
narrow Recall@20 47.4% (no question at 90%), broad coded P@6 27.8%, coded nDCG@6 27.3%.
Every comparison below uses the baseline re-measured in the same run, paired by
question.

## 4. Metrics

- **Narrow Recall@20** (the gate metric of the 90% target): coded positives among the
  first 20 unique cases of the candidate ranking / all coded positives, mean over the
  12 narrow questions.
- **Broad coded P@6** and **coded nDCG@6** (gains 0/1/3): on the packed bundle, mean
  over the 9 broad questions.
- A variant that uses the scope keyword text runs once per scope sample; a question's
  value is its mean over the samples.
- **Pool ceiling** (pools only): the share of a narrow question's positives inside the
  bounded pool, the best a reranker of that pool could reach.
- Reported, not part of the rule: narrow questions at 90% or more, latency, failures,
  run stability over the repetitions, single-channel Recall@20 and union ceilings.

## 5. The grid

37 selectable variants. Every one declares **narrow Recall@20** as its target metric;
the broad metrics are regression checks. `N` is case-level BM25 over the cases index's
narratives (probable cause, analysis, factual), `NF` the same plus `findings_text`,
`@d` its depth in cases; a third channel keeps passage BM25, a replacement drops it.
Case-level RRF collapses each channel to its unique cases before fusing, so agreement
on a case through different passages counts. Unlisted knobs stay at the baseline.

| id | family | change from the baseline | target |
| --- | --- | --- | --- |
| `p100` | E7-depth | 100/ch | narrow R@20 |
| `p200` | E7-depth | 200/ch | narrow R@20 |
| `p50-nc10` | E7-candidates | nc factor 10 | narrow R@20 |
| `p50-nc20` | E7-candidates | nc factor 20 | narrow R@20 |
| `p100-nc10` | E7-candidates | 100/ch, nc factor 10 | narrow R@20 |
| `p50-k10` | E7-rrf-k | k 10 | narrow R@20 |
| `p50-k30` | E7-rrf-k | k 30 | narrow R@20 |
| `p50-k120` | E7-rrf-k | k 120 | narrow R@20 |
| `p50-w12` | E7-weights | w kw:vec 1:2 | narrow R@20 |
| `p50-w21` | E7-weights | w kw:vec 2:1 | narrow R@20 |
| `c50` | E7-case-fusion | case-level RRF | narrow R@20 |
| `c100` | E7-case-fusion | 100/ch, case-level RRF | narrow R@20 |
| `c200` | E7-case-fusion | 200/ch, case-level RRF | narrow R@20 |
| `c100-k10` | E7-case-fusion | 100/ch, k 10, case-level RRF | narrow R@20 |
| `c100-k30` | E7-case-fusion | 100/ch, k 30, case-level RRF | narrow R@20 |
| `c100-w12` | E7-case-fusion | 100/ch, w kw:vec 1:2, case-level RRF | narrow R@20 |
| `c100-w21` | E7-case-fusion | 100/ch, w kw:vec 2:1, case-level RRF | narrow R@20 |
| `c50+n` | E5-case-lexical | case-level RRF, +N@50 | narrow R@20 |
| `c50+nf` | E5-case-lexical | case-level RRF, +NF@50 | narrow R@20 |
| `c50-nv` | E5-case-lexical | case-level RRF, replaces passage BM25: N@50 | narrow R@20 |
| `c50-nfv` | E5-case-lexical | case-level RRF, replaces passage BM25: NF@50 | narrow R@20 |
| `c100+n` | E5-case-lexical | 100/ch, case-level RRF, +N@100 | narrow R@20 |
| `c100+nf` | E5-case-lexical | 100/ch, case-level RRF, +NF@100 | narrow R@20 |
| `c100-nv` | E5-case-lexical | 100/ch, case-level RRF, replaces passage BM25: N@100 | narrow R@20 |
| `c100-nfv` | E5-case-lexical | 100/ch, case-level RRF, replaces passage BM25: NF@100 | narrow R@20 |
| `c200+n` | E5-case-lexical | 200/ch, case-level RRF, +N@200 | narrow R@20 |
| `c200+nf` | E5-case-lexical | 200/ch, case-level RRF, +NF@200 | narrow R@20 |
| `c200-nv` | E5-case-lexical | 200/ch, case-level RRF, replaces passage BM25: N@200 | narrow R@20 |
| `c200-nfv` | E5-case-lexical | 200/ch, case-level RRF, replaces passage BM25: NF@200 | narrow R@20 |
| `p50-kt` | E3-scope-keywords | scope keyword text | narrow R@20 |
| `p100-kt` | E3-scope-keywords | 100/ch, scope keyword text | narrow R@20 |
| `c100-kt` | E3-scope-keywords | 100/ch, case-level RRF, scope keyword text | narrow R@20 |
| `c200-kt` | E3-scope-keywords | 200/ch, case-level RRF, scope keyword text | narrow R@20 |
| `c100+n-kt` | E3-scope-keywords | 100/ch, case-level RRF, +N@100, scope keyword text | narrow R@20 |
| `c100+nf-kt` | E3-scope-keywords | 100/ch, case-level RRF, +NF@100, scope keyword text | narrow R@20 |
| `c200+n-kt` | E3-scope-keywords | 200/ch, case-level RRF, +N@200, scope keyword text | narrow R@20 |
| `c200+nf-kt` | E3-scope-keywords | 200/ch, case-level RRF, +NF@200, scope keyword text | narrow R@20 |

**Case-level channel.** BM25 (`multi_match`, `best_fields`, operator `or`, the passage
channel's form) over the existing cases index. Its filter is composed from the shared
compiler: `country: USA`, `answer_eligible: true`, the event facets and years, and the
passages-v2 aircraft qualification restated on the cases index's nested aircraft (a
single aircraft meets the facets; in a multi-aircraft event every aircraft does, and a
missing value fails). The preflight stops unless, for every question, it reaches
exactly the cases the passages filter reaches. A case only this channel found, among
the first 12 candidates, gets its passages from one exact kNN request restricted to
those cases; the existing fetch then attaches every probable cause and packs as usual.
In E3 variants the scope keyword text replaces the question in every BM25 channel; the
vector channel always embeds the question. `findings_text` holds the coded finding
descriptions, so on Track C the `NF` variants are coded retrieval of codes: their gains
say nothing about whether the narrative passages support an answer (Track N measures
that).

**Pools** (diagnostic for phase B, never adopted in phase A; target: pool ceiling).
`balanced` takes the channels' unique cases in turn, in the order listed.

| id | drawn from | method | size |
| --- | --- | --- | --- |
| `pool-hyb50@50` | baseline | ranking | 50 |
| `pool-hyb50@100` | 100/ch | ranking | 50 |
| `pool-hyb50@200` | 200/ch | ranking | 50 |
| `pool-case50@100` | 100/ch, case-level RRF | ranking | 50 |
| `pool-case50@200` | 200/ch, case-level RRF | ranking | 50 |
| `pool-bal50@100` | 100/ch | balanced: vector, keyword | 50 |
| `pool-bal50@200` | 200/ch | balanced: vector, keyword | 50 |
| `pool-bal50+nf@100` | 100/ch, case-level RRF, +NF@100 | balanced: vector, keyword, cases | 50 |
| `pool-bal50+nf@200` | 200/ch, case-level RRF, +NF@200 | balanced: vector, keyword, cases | 50 |
| `pool-case+nf50@200` | 200/ch, case-level RRF, +NF@200 | ranking | 50 |
| `pool-hyb100@200` | 200/ch | ranking | 100 |
| `pool-case100@200` | 200/ch, case-level RRF | ranking | 100 |
| `pool-bal100@200` | 200/ch | balanced: vector, keyword | 100 |
| `pool-bal100+nf@200` | 200/ch, case-level RRF, +NF@200 | balanced: vector, keyword, cases | 100 |

A pool is **recommended as reranker input** when its ceiling beats `pool-hyb50@50` by
at least 5 percentage points with a one-sided 95% group-bootstrap lower bound above
zero. A 100-case pool doubles a reranker's input and is reported as such.

**Single channels** (diagnostic): passage BM25 and passage kNN at 50, 100 and 200
passages, and `N` and `NF` at 50, 100 and 200 cases; each with its own Recall@20 and
the share of positives anywhere in its list; union ceilings per depth.

## 6. Selection rule

A variant **qualifies** when all of these hold on the dev questions:

1. its paired improvement in narrow Recall@20 over the baseline is at least
   **+5.0 percentage points** (point estimate);
2. the one-sided 95% group-bootstrap lower bound of that improvement is above zero;
3. broad coded P@6 and broad coded nDCG@6 each fall by at most **2.0 points** (point
   estimates);
4. its p95 added retrieval latency is at most **200 ms** and its p95 total retrieval
   latency at most **1,000 ms** (section 8);
5. it adds no paid call to a production request (every phase A variant: E3 reuses the
   keyword text every brief's scope stage already produces);
6. none of its runs failed, and, for E3 variants, no scope sample failed after its
   retry.

The **selected configuration** is the qualifying variant with the largest narrow
Recall@20 improvement; variants within **1.0 point** of it are ordered by broad nDCG@6
improvement, then lower p95 added latency, then fewer changed knobs, then id. When no
variant qualifies, the baseline stays and nothing is confirmed on the holdout. The
rule is implemented in `stats.ts` (`applyRule`) and applied by the runner.

With 37 variants compared on 12 narrow questions, the selected variant's dev
improvement is biased upwards (the winner's curse); the holdout confirmation (section
10) is the less biased estimate.

## 7. Uncertainty

Paraphrases and questions that share coded cases are not independent. Intervals come
from a **paired bootstrap by connected case group** (the dataset's `group`): 10,000
resamples, seed 20261023, mulberry32. Each resample draws as many groups as the metric
has, with replacement, and averages the per-question differences of every question in
the drawn groups. Narrow Recall@20 resamples its seven groups; the broad metrics their
three groups, so their intervals are coarse and are reported, not used by the rule.
Intervals are percentile intervals (linear interpolation); the rule uses the 5th
percentile.

## 8. Latency

Each configuration runs every dev question **three times**, interleaved: each
repetition and question rotates the configuration order. A run's latency is its
retrieval time excluding the query embedding, which every variant shares: stage 1
(both passage channels and the case channel in parallel), the mapping request when
there is one, and the evidence fetch. Per question, the median over repetitions (and
scope samples); the added latency is the variant's median minus the baseline's; p95 is
the nearest-rank 95th percentile over the 21 questions. Scores come from the first
repetition; the later ones must return the same ranking and bundle, and differences
are reported. Production would also pay the scope stage before retrieval, which every
brief already does.

## 9. Cost

Paid calls in phase A, all reserved per attempt on the evaluation ledger:

- query embeddings: 21 dev questions once (about $0.00001), and the holdout questions
  once for the confirmation;
- E3: **three scope samples per dev question** (63 calls), each attempt reserved at the
  scope stage's worst case ($0.000525) and settled at its billed cost; one retry per
  failed sample with its own reservation; the run stops before an attempt that would
  take it above $0.10. A free dry run (the provider's token counter) prints questions,
  tokens and price first. Holdout samples are taken only if the selected configuration
  uses the scope keyword text.

**Phase A total: at most $0.50**, enforced by the runner from its spend log before
each paid step.

## 10. Holdout

The existing holdout (22 questions) has been inspected before, so it is never a
selection set. After the dev run, the selected configuration and the baseline run
**once** on it, with the same procedure, and the result is reported as a documented
confirmation, whatever it shows. A disappointing confirmation does not lead to
another variant being tried on it. It does not replace the release evaluation, which
needs fresh questions and unseen case groups. The runner refuses a second holdout run
and any configuration other than the one the dev run selected.

## 11. Diagnostics

For every coded positive of the 12 narrow dev questions, from the baseline run:

- `excluded_by_filters`: no passage of the case matches the compiled passages filter;
- `absent_from_representation`: outside the candidate pool (neither channel returned a
  passage of it) and not representable (below);
- `outside_pool`: outside the pool but representable, through the narrative passages
  or only through the coded findings text;
- `ranked_below_20`: in the pool, case rank above 20;
- among Recall@20 hits: `lost_in_packing` (the packer passed over it), `beyond_bundle`
  (ranked 7 to 20 behind six packed cases) or `delivered`.

**Representability heuristic.** Three signals per case, each compared with a seeded
random background of up to 300 non-positive cases reachable under the same filters
(seed 1023): the best BM25 score of the case's passages for the production BM25 query;
the best cosine similarity of its passages to the question's embedding (exact kNN over
its passages); and the BM25 score of the question against its `findings_text`. A case
is representable when a signal is above zero and at least the background's 90th
percentile; the 75th and 95th are reported as sensitivity. Limits: the threshold is
relative to the cohort; the BM25 signals include filter words and generic words; text
that resembles the question need not state the coded fact; the background is a sample.
The heuristic is checked on in-pool positives, which it should call representable.
Counts are reported per class and per question.

## 12. Stops and failures

- A failed preflight stops a command before anything is paid.
- A failed run is recorded, never retried, and disqualifies its variant.
- A step whose reservations would exceed the phase A limit is refused.

## 13. Seen before registration

The saved Track C run of this index (aggregates, per-question scores and coded ranks)
and the reviewer's ceilings computed from it; the free preflight on the dev split
(labels re-derived on the target, identity, contracts, the case channel's filter
consistency); offline tests on fixtures. No variant, pool or single channel was run on
the target, no scope sample was taken, and the holdout was not touched.

## 14. Amendments

Any change after this commit (a harness bug fix, a stopped step) is recorded with its
reason and time in the task report; a change to the grid, the rule, the limits or the
questions after any variant has run invalidates the selection.
