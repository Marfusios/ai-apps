# Applied-filters evaluation (Task 29)

What a visitor gets after **one click on "Apply these filters"**, measured with the
production `rankEvidence` on `dev`. The live search runs the question as typed and only
suggests filters; this measures the same search with the suggested filters applied, next to
Elasticsearch alone and the live search, in one run on one generation.

## Question sets

Both sets' coded labels are **re-derived on the active dev generation** from their frozen
code sets and filters (the preflight prints every change). Automatic filters are `none`.

- `trackc-dev`: the 21 Track C development questions of `evals/retrieval/coded/dataset.json`
  (12 narrow, 9 broad), three samples each. Task 24 chose the reranker on these questions,
  so the `QH50` step here is a development figure.
- `confirmation`: Task 24's 48 fresh confirmation questions
  (`evals/search-quality/frozen/confirmation.json`; 24 narrow, 24 broad), one sample each.
  No configuration was chosen on them.

Every question in both sets names its constraints in words (a state, years, an aircraft
category), so the result applies to questions of that kind. Paraphrase pairs share a
connected group; the bootstrap resamples groups.

## Rows

| Row | What runs | Samples |
| --- | --- | --- |
| `Q0` | Elasticsearch alone: keywords and embeddings on the question as typed, no filters (`er-q-v1`, scope skipped: it cannot change this ranking) | 1 |
| `QH50` | the live search: the same, then Claude Haiku orders the top 50 (`er-q-h50-v1`); its filters are only suggested | set's |
| `QH50+F` | that search after one click on "Apply these filters": an edit of the `QH50` search with the filters its page showed, the same words, no scope stage, the AI ordering again, as the site runs it | set's |
| `Q0+F` | the same filters without the AI ordering (diagnostic) | set's |

A sample whose page shows no "Apply these filters" button (no suggested filter, a failed
or non-search scope) keeps its search: `QH50+F` scores the `QH50` ranking and `Q0+F` the
`Q0` ranking. The summary refuses a schedule where an edit exists without its button, or
ran other filters. The request merges filters, and the button appears, exactly as on the
page (`filters.ts`, checked against the web code by `tests/web/applied-filters-parity.test.ts`).

Only the question and the AI's own suggestion reach the pipeline: the production port
checks that the filters reaching Elasticsearch are exactly the request's. The answer
key's filters are read after the run, only for the match report (how often the
suggestion equals, includes or misses them). No row measures the answer-key-filtered
pipeline, so do not quote a share of the gap to an earlier evaluation's figure.

## Scores and checks

Task 24's coded metrics: narrow Recall@20 and @10, broad P@10 and nDCG@10. A question's
value is the mean over its samples; a row's is the mean over its stratum's questions.
Paired group bootstrap intervals (10,000 resamples, seed 29) compare narrow Recall@20
between rows: quote `ci95` with the number of questions and groups, not `lower95` (a
one-sided bound). These are coded-reference figures: they describe, they do not certify.

Task 24's provider rules apply: three consecutive infrastructure outcomes (timeouts,
overload, rate limits, provider errors) among the searches that call the AI stop the run,
and a set whose scope failure or rerank fallback rate exceeds 5% in any row, or whose
connected groups now share a case, is marked `publishable: false`. The summary
also reports the button rate, recall over clicked samples only, the answer-key match,
whether `Q0` equals each `QH50` search before ordering (and `Q0+F` each `QH50+F`), the
label changes and connected questions that now share a case.

## Run

```sh
pnpm eval:applied-filters --mode preflight --run-label <label> \
  --env-files <dev database dotenv>,<dev Elasticsearch dotenv> --keys-file "$PROVIDER_KEYS_FILE"
pnpm eval:applied-filters --mode run --confirm-cost --run-label <label> \
  --env-files <dev database dotenv>,<dev Elasticsearch dotenv> --keys-file "$PROVIDER_KEYS_FILE"
```

Use the environment the dev site serves, not the local-services stack. `preflight` is free:
it checks the database, generation and indices (passages-v2 required), re-derives the
labels, checks the ranking identities registered by Task 24, sizes the worst case and opens
the allocation without reserving. Commit first: both modes refuse a dirty tree. Avoid the
daily import window: a switched generation stops the run.

**Cost.** About $0.006 per sample (a scope and two reranks): about $0.36 for `trackc-dev`
and $0.27 for `confirmation`, about $0.63 in all. The allocation `eval-task29` has its own
advisory lock and a **$0.80 hard cap** on charged plus open reservations. A question starts
only when its remaining worst case (at most about $0.047) fits the cap and the evaluation
allowance, and the production gate checks every stage. Searches run one at a time.

The ignored output directory (`data/work/task29` by default) holds the manifest, the
journal (`results.jsonl`, every attempt written before dispatch), model outputs, stage
charges, the allocation journal, `summary-<set>.json` (written as each set completes) and
`summary.json`. `--mode summarize` (free) checks the frozen run's identity and summarizes
the sets its journal completed, without reserving or dispatching anything. A rerun with the same label resumes;
an attempt without a durable result, or a failed search, stops the run for
reconciliation and is never repeated under that label.
