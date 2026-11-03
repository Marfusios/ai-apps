# Applied-filters evaluation (Task 29)

What a visitor gets after **one click on "Apply these filters"**, measured with the
production `rankEvidence` on `dev`. It answers one question: how much of the gap between
the live search's coded recall and the filtered pipeline's comes from the filters the AI
already suggests but does not apply.

## Rows

Every row runs on the 21 Track C development questions (12 narrow, 9 broad, 9 connected
groups) of `evals/retrieval/coded/dataset.json`, with their coded labels **re-derived on
the active dev generation** from the frozen code sets and filters. Automatic filters are
`none` throughout.

| Row | What runs | Samples |
| --- | --- | --- |
| `Q0` | Elasticsearch alone: keywords and embeddings on the question as typed, no filters (`er-q-v1`, scope skipped: it cannot change this ranking) | 1 |
| `QH50` | the live search: the same, then Claude Haiku orders the top 50 (`er-q-h50-v1`); its filters are only suggested | 3 |
| `QH50+F` | that search after one click on "Apply these filters": an edit of the `QH50` search with the filters its page showed, the same words, no scope stage, the AI ordering again, as the site runs it | 3 |
| `Q0+F` | the same filters without the AI ordering (diagnostic) | 3 |

A sample whose page shows no "Apply these filters" button (no suggested filter, a failed
or non-search scope) keeps its search: `QH50+F` scores the `QH50` ranking and `Q0+F` the
`Q0` ranking. The request merges filters exactly as the page does
(`filters.ts`, checked against `web/src/features/evidence/display.ts` by
`tests/web/applied-filters-parity.test.ts`).

Only the question and the AI's own suggestion reach the pipeline: the production port
checks that the filters reaching Elasticsearch are exactly the request's. The answer
key's filters are read after the run, only for the match report (how often the
suggestion equals, includes or misses them).

Scores are Task 24's coded metrics: narrow Recall@20 and @10, broad P@10 and nDCG@10. A
question's value is the mean over its samples; a row's is the mean over its stratum's
questions. Paired group bootstrap intervals (10,000 resamples, seed 29) compare narrow
Recall@20 between rows. These are coded-reference figures on development questions,
already used during development: they describe, they do not certify.

## Run

```sh
pnpm eval:applied-filters --mode preflight --run-label <label> \
  --env-files <dev app dotenv> --keys-file "$PROVIDER_KEYS_FILE"
pnpm eval:applied-filters --mode run --confirm-cost --run-label <label> \
  --env-files <dev app dotenv> --keys-file "$PROVIDER_KEYS_FILE"
```

`preflight` is free: it checks the dev database, indices and generation, re-derives the
labels (and prints how they changed from the frozen ones), checks the ranking identities
registered by Task 24, sizes the worst case and opens the allocation without reserving.
Commit first: both modes refuse a dirty tree.

**Cost.** About $0.006 per question and sample (a scope and two reranks), about $0.35 for
the run. The allocation `eval-task29` has its own advisory lock and a **$0.60 hard cap**
on charged plus open reservations; each question starts only when its whole worst case
(about $0.047) fits the cap and the evaluation allowance. Searches run one at a time.

The ignored output directory (`data/work/task29` by default) holds the manifest, the
journal (`results.jsonl`, every attempt written before dispatch), model outputs, stage
charges, the allocation journal and `summary.json`. A rerun with the same label resumes;
an attempt without a durable result, or a failed search, stops the run for
reconciliation and is never repeated under that label.
