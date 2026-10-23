# Aviation Casebook

Find and compare NTSB aviation investigations using their evidence, findings, and
probable causes. For flight instructors preparing case-based lessons and safety
analysts exploring similar events.

**Status: Experimental.** Keyword search, case pages and the dashboard are live on the
dev environment (API server, web client, container deployment, trial identity and AI
status); AI briefs are in progress and there is no public deployment.

- [Implementation design](docs/DESIGN.md): TypeScript stack, retrieval, UI,
  authentication, cost controls, deployment, and delivery milestones.
- [Interface design](docs/UI_DESIGN.md): visual language, screens, states and
  copy, night mode, phone layout, print, and accessibility.
- [Tracing and evaluation](docs/OBSERVABILITY_AND_EVALUATION.md): Langfuse dashboard,
  TypeScript experiments, development/production workflows, and privacy boundaries.
- [Data assessment](docs/DATA_REVIEW.md): measured archive contents, schema traps,
  real cases, and dashboard opportunities.
- [Aggregate data profile](docs/data-profile-2026-10-16.json): source identifiers
  and observed counts; no raw personal records.
- [Security review](docs/SECURITY_REVIEW.md): independent design review and the
  separate implementation review required before public launch.

The initial slice is completed US investigations from 2008 onward. Earlier records
need additional source adapters; the UI must show actual coverage. Findings and
generated interpretations will be distinguishable and linked to NTSB evidence.

The proposed app uses React/Vite, Fastify, PostgreSQL, Elasticsearch, the Anthropic
API for language models (switchable to OpenAI at deployment), OpenAI embeddings,
and self-hosted Langfuse for tracing and evaluations. Custom TypeScript
evaluators complement Vitest and other software tests. Langfuse supplies the
developer UI; Jaeger/custom dashboard work and Promptfoo are not initial dependencies.

`.env.example` lists every configuration variable with empty or default values.
Machine-specific connections belong in ignored local files.

Documentation checks run from the repository root:

```bash
python3 scripts/check_repo.py
```

Research working files and source downloads are under ignored `data/`. Only
aggregate observations and public source links belong in the documentation.

This is an independent educational project, not an NTSB service or a source of
operational flight or maintenance instructions.

## Setup

Requires Node 24 (see `.node-version`) and pnpm via corepack.

```sh
corepack enable
pnpm install
pnpm test            # offline unit and web component tests
pnpm typecheck       # server/worker and web projects
```

`pnpm test:integration` runs the integration project and needs the local
services described later in this README.

### Configuration

Copy variable names from `.env.example`. Configuration comes from the process
environment and from explicit dotenv files listed in `AVIATION_ENV_FILES`
(comma-separated, absolute or app-relative, highest priority first). Nonempty
process values win over files, and only the variable names in `.env.example`
are read from them. The dotenv parser does no shell expansion or command
substitution. Keep real values in ignored files such as `.env.local`.

### Local services

Deployments use shared PostgreSQL, Elasticsearch and Langfuse (see
[Deployment with Docker Compose](#deployment-with-docker-compose)). For
contributors without them and for the offline integration tests,
`compose.local-services.yaml` (Compose project `ai-aviation-local`) runs pinned
PostgreSQL 17.6 and Elasticsearch 9.5.5 (single node, security on, 2 GB heap, ML
disabled). Both bind to loopback only, for development; HTTP TLS is disabled for
this local profile. Ports come from `POSTGRES_PORT` (default 55432) and
`ELASTICSEARCH_PORT` (default 59200). Earlier checkouts ran them as project
`ai-aviation`: stop it once with `docker compose -p ai-aviation down` before
`pnpm services:up` (the [runbook](docs/RUNBOOK.md#local-services-mode) has details).

```sh
pnpm services:up      # generate bootstrap passwords, start services, wait until healthy
pnpm services:setup   # roles, databases aviation_dev and aviation_test, scoped API keys
pnpm db:migrate       # aviation_dev (the integration tests migrate aviation_test)
pnpm test:integration
pnpm test:pg16        # migrations and integration tests on PostgreSQL 16.2
pnpm services:down    # stop; data volumes are kept
```

Secrets are generated on first run into the ignored `.env.local` (mode 0600),
which `services:up` also passes to Compose via `--env-file`. Values are never
printed. `services:setup` is idempotent and uses the same role model as the shared
servers ([runbook](docs/RUNBOOK.md#role-model)) for two local environments:

- `dev`: `DATABASE_URL`, `DATABASE_MIGRATOR_URL` and `DATABASE_INGEST_URL` for
  database `aviation_dev` (logins `aviation_dev_app`, `_migrator`, `_ingest`, each
  acting as group role `aviation_app`, `aviation_migrator` or `aviation_ingest`
  through `?options=-c role=...` in its URL); `ELASTICSEARCH_READ_API_KEY` (HTTP
  process) and `ELASTICSEARCH_WRITE_API_KEY` (ingestion) limited to
  `ai-aviation-dev-*`.
- `test`: the same as `TEST_DATABASE_*` for `aviation_test` and
  `TEST_ELASTICSEARCH_*_API_KEY` for `aviation-test-*`, used by the integration
  tests, which create only `aviation-test-*` indices and clean them up.

Each database and its schema `public` belong to a memberless owner role
(`aviation_dev_owner`, `aviation_test_owner`); the group roles hold the grants and
`aviation_migrator` owns the schema objects. Default privileges give both runtime
roles SELECT on future tables and migrations grant DML explicitly. Each login can
connect only to its own database and cannot grant itself access to another. `pnpm test:pg16` provisions the `test`
environment on a throwaway PostgreSQL 16.2 container (the shared server's version)
and runs the migrations and the integration suite against it.

### NTSB fixtures and normalization

`fixtures/ntsb/` holds the projected-CSV rows of 16 public NTSB events (US
government works) from the 2026-10-16 `avall.zip` snapshot, exactly as extracted
(including CRLF inside narratives): the four seed cases, multi-aircraft,
HTML-narrative, non-US and P/blank/B-without-cause examples.
`fixtures/ntsb-malformed/` is synthetic. `pnpm fixtures:build --from <extraction dir>`
regenerates both; the event list and the reason for each is in
`scripts/build-fixtures.ts`. `fixtures/ntsb-ui/` adds 11 public events the interface
examples and end-to-end tests search for (carburetor icing in and outside the
probable cause, status P records, traffic-pattern stalls); `pnpm fixtures:build-ui
--from <extraction dir>` regenerates it (`scripts/build-ui-fixtures.ts`).

`worker/ingest/normalize.ts` turns projected tables into canonical cases. It fails
on missing columns, duplicate composite keys and blank or duplicate case numbers,
and lists value-level problems (invalid coordinates, unknown flag values) in a
quarantine report instead of coercing them. Citation text is the narrative as
exported with line ends normalized to LF; narratives containing HTML are converted
to text (`CITATION_TEXT_VERSION`) and the original is kept. In a multi-aircraft
event every narrative section is event-scoped: the row that carried a text is
recorded as provenance, not as the aircraft it describes. Answer eligibility means
a US event with a completed status and probable-cause text under the provisional,
unverified `COMPLETION_MAPPING_V1` (status `B` is completed).

### Database schema and corpus load

The canonical corpus lives in PostgreSQL (16 on the shared server, 17 locally;
`MAINTAIN` grants are version-guarded). The Drizzle schema is in
`server/db/schema/`; SQL migrations generated by drizzle-kit are in
`server/db/migrations/`. Grants, lifecycle triggers and functions are in
hand-written migrations, because drizzle-kit does not generate them.

```sh
pnpm db:migrate          # as aviation_migrator, on the database in DATABASE_MIGRATOR_URL
pnpm db:migrate --test   # aviation_test (integration tests also migrate it automatically)
pnpm db:generate         # after a schema change: writes a new SQL migration
```

Worker commands read `AVIATION_ENV_FILES`, or the app's ignored `.env.local` when
that variable is unset, and connect as `aviation_ingest`:

```sh
pnpm worker load --from data/work/<extraction-dir>
pnpm worker verify --generation <id> [--profile <file>]
pnpm worker generations                              # generations, plus runs still marked running
pnpm worker fail-stale-runs --older-than-minutes <n> # close runs left running by a dead process
pnpm worker prune-generations [--dry-run] [--grace-hours <n>]  # retention by publication, see "Retention"
pnpm worker prune-controls                           # lease expiry and control-data retention (also run by the API)
pnpm worker brief-diagnose <brief-id> [--step <n>] [--include-expired]  # why a withheld summary was withheld (by hand; docs/RUNBOOK.md)
```

`prune-controls` and `brief-diagnose` connect as `aviation_app` (`DATABASE_URL`)
instead: the briefs and control tables are the app's, and `aviation_ingest` cannot
read them.

- **Dataset generations.** Every load writes a new generation in one transaction:
  it inserts the generation as `loading`, inserts every row, records its ingestion
  run as `succeeded` and seals the generation (`loaded`) before committing. A
  failure rolls all of it back and the run is marked `failed`, leaving earlier
  generations untouched. Primary keys start with `generation_id` and foreign keys
  are composite, so rows only reference rows of their own generation.
- **Sealing.** Database triggers reject any insert, update or delete of corpus
  rows whose generation is not `loading`, for every role including the schema
  owner. `aviation_ingest` can only insert corpus rows; it cannot update or delete
  them, nor change generations, manifests or finished runs directly. Status changes
  go through migrator-owned functions: `seal_generation`, `record_verification`,
  `publish_manifest`, `prune_generation` and `analyze_corpus`. Generation statuses
  are `loading` → `loaded` → `verified`/`failed` → `published` ↔ `retired`.
- **Load input.** `load` rejects a directory without a valid `manifest.json`, or
  whose manifest disagrees with its CSV files (tables, byte sizes, columns,
  mdb-export flags), before writing anything. Row counts read must equal the
  manifest's.
- **Sections.** `section_id` is `<ntsb_no>:<section_key>`; `revision_id` is a
  sha256 over the case number, section key, text hash and citation-text version,
  so unchanged text keeps its revision across generations. Event section keys are
  ordinals (`probable_cause/event-2`) that can shift when narratives change, so a
  brief or citation must pin the generation **and** the `revision_id`, never a bare
  `section_id`. Each narrative row behind a section is kept in
  `case_section_sources`. Its exported text is stored only when it cannot be
  rebuilt from the section text (HTML, whitespace variants, mixed line ends);
  otherwise `source_form` says whether it was identical or the same text with CRLF
  line ends. Either way it reproduces `source_sha256`.
- **Verification.** `verify` holds the lifecycle lock (shared with publication and
  pruning) and reads one REPEATABLE READ snapshot. It checks generic invariants
  (unique nonblank case numbers, parents within the generation, section hashes and
  revision ids, section keys against scope, event-scoped sections only in
  multi-aircraft events, phase summaries against aircraft and sequence rows, the
  answer-eligibility and completion-mapping rules, a succeeded ingestion run). It
  rebuilds every source text and re-derives the citation text with the
  normalization code (`toCitationText`), so a section must be exactly, or for
  whitespace variants whitespace-equivalently, what its sources produce. It also
  reconciles stored counts with the normalization stats and with every source row
  in the extraction manifest. The outcome is recorded with the verifier version and
  the sha256 of its report, written atomically under the content-addressed name
  `data/work/verify-gen-<id>-<sha256>.json` before the hash is recorded (a failed
  attempt never replaces the recorded report). Reports hold aggregate counts only.
  If the generation changed meanwhile, nothing is recorded and the command reports
  a conflict. Snapshot-specific expectations live in `worker/ingest/verify-profiles/`
  and apply automatically to the archive whose hash they name.
- **Manifests.** `publishManifest` (`pnpm worker publish`, see
  [API server](#api-server)) activates a generation and its indices in one
  transaction; at most one manifest is active, and the API reads it through
  `getActiveManifest`. The passages index may be null: a keyword-only manifest
  serves search, case pages and the dashboard, and AI routes stay off until a
  manifest names a passages index (migration 0011). Publishing, including a
  rollback to a retired generation, requires the generation's latest verification
  to be successful and made by the current verifier version (`VERIFIER_VERSION`).
- **Retention.** `pruneGenerations` keeps the last two published generations by
  publication time (the active one first) and deletes other published or retired
  ones. Never-published generations are deleted when `failed`, or when they were
  sealed or last verified more than 24 hours ago (configurable), so a load that
  committed late or a generation awaiting its indices stays. `loading`, active and
  pinned generations are never deleted: `pinGeneration`/`unpinGeneration` write
  `generation_pins` (for example for generations live briefs cite) only through
  `pin_generation`/`unpin_generation`, which take the lifecycle lock, so a pin
  renewed during pruning either protects the generation or fails because pruning
  removed it first.

### Cases index (keyword search)

```sh
pnpm worker index cases --generation <id>          # aviation_ingest + ELASTICSEARCH_WRITE_API_KEY
pnpm worker index reconcile --alias <alias> [--declare-abandoned <attempt-id> --reason <text>]
pnpm worker index delete-unused --older-than <hours> [--alias <alias>] [--yes]
pnpm worker index cleanup-builds --older-than <hours>
```

- **Build.** Each run has a random build id, part of its index name
  `<prefix>-cases-v3-g<generation>-<UTC timestamp>-<build id>` and of its generation
  pin `index-build:<build id>`, and is recorded in `index_builds` before its index
  exists. While it runs it holds an advisory lock on that id. Under the lifecycle
  lock it checks that the generation is `verified` (or already `published`) with a
  latest verification `ok` by the current verifier, and pins it without expiry, so
  pruning cannot remove it mid-build; a generation without US events is refused. The
  US events are read in batches of 500 from one repeatable-read snapshot
  (`server/db/queries/case-records.ts`) into the new index (one shard, no replicas,
  refresh off while loading), which is refreshed and checked against the database:
  documents equal the generation's US events, nested aircraft equal its aircraft, and
  the answer-eligible, multi-aircraft and non-US counts match. The build removes only
  its own pin when it ends. If it fails before its index was part of any alias
  request, it deletes that index: the only index the system deletes on its own.
- **Alias.** `<prefix>-cases` means "the cases index built last", for operators.
  The API never reads it: it uses the index names of the active `dataset_manifests`
  row, published separately with `pnpm worker publish`.
  Switches are serialized per alias with a PostgreSQL advisory lock. Under it, a
  build refuses to publish if its pin has gone, appends a `pending` row to
  `index_switch_attempts`, and sends one `_aliases` request (no client retries) that
  removes every current target and adds the new index. A response resolves the
  attempt (`committed`, or `rejected`); a transport failure or timeout leaves it
  `unknown`, whatever the alias shows afterwards, because Elasticsearch may still
  complete a queued request and its master timeout does not bound execution. The new
  index is then kept, and the alias accepts no further switch until
  `worker index reconcile` reads the alias and finds the index there (`committed`).
  Time never resolves an attempt: if the index is absent, only an operator's
  `--declare-abandoned <attempt-id> --reason <text>` (recorded with the reason)
  unblocks switching, and it deletes nothing. Previous indices are kept. The
  database allows only forward transitions of an attempt, and a committed attempt
  stays committed.
- **Cleanup is explicit.** `worker index delete-unused --older-than <hours>` lists
  (and with `--yes` deletes) indices of stopped builds that are older than the
  threshold, are no alias target, appear in no `dataset_manifests` row (active or
  retained), and have no committed, pending or unknown switch attempt. Every
  candidate is rechecked just before deletion while holding its build lock (free),
  its alias lock and the lifecycle lock. `worker index cleanup-builds --older-than
  <hours>` removes the pins of builds that are no longer running and nothing else.
- **Documents.** One per US event, keyed by case number (`ev_id` is never indexed).
  Event fields are keywords (`country` is `ev_country` as published, always `USA`),
  `ev_date` a date, `location` a geo point (absent without coordinates). Aircraft are
  `nested`, so one clause matches one aircraft: an airplane filter and a Sikorsky
  filter in one nested query never match an event whose Sikorsky is the helicopter.
  `probable_cause`, `analysis`, `factual` and `findings_text` are arrays with one
  value per section (or finding description) and a position gap of 100 between
  values, so a phrase never spans two sections. Blank source values are null; facets
  show them with a `missing` aggregation.
- **Facets count events.** Aircraft facets aggregate inside `nested` and count with
  `reverse_nested`. An event whose aircraft differ counts once in each of their
  buckets, so aircraft buckets can sum to more than the total (405 US events have
  several aircraft in the 2026-10-16 snapshot). The Phase facet uses
  `defining_phase_groups`, every aircraft's defining phase group (140 US events have
  several); with an aircraft filter active, filter the phase on
  `aircraft.defining_phase_group` inside the same nested clause.
  `sequence_phase_groups` lists every phase in the sequence. Make, model and city use
  a normalizer (whitespace collapsed, ASCII-folded, upper case), so "Cessna" and
  "CESSNA" are one value.
- **Text analysis** (`worker/index/analysis.ts`). Indexing: a char filter that
  separates headings glued to their text ("AIRCRAFT INFORMATIONThe" → "AIRCRAFT
  INFORMATION The"; plurals such as "METARs", case numbers and acronyms untouched,
  offsets exact), standard tokenizer, lowercase, possessive stemmer, English stop words minus negations (`no`, `not`
  and the other negations are always kept), a few stem overrides (icing → ice,
  conditions → condition, ...), then the conservative light English (KStem) stemmer,
  which keeps generator/general and engine/engineer apart. Searching adds a small
  `synonym_graph` list (`worker/index/synonyms.ts`) before stop words and stemming:
  spelling variants (carb/carburetor/carburettor, plurals included) and unambiguous
  abbreviations (IMC, VMC, ATC, IFR, VFR, AGL, MSL, CFIT, CFI) are equivalent to their
  long forms; wx and mx expand one way only. Stall and spin are never synonyms.
  Quoted phrases match their own words and never expand synonyms. Changing the
  mapping, analysis, synonyms or overrides needs a new `CASES_INDEX_VERSION`; a unit
  test pins the definition's fingerprint.

### Passages index (passages and embeddings)

```sh
pnpm worker index passages --generation <id>                 # dry run (default): writes nothing, calls nothing
pnpm worker index passages --generation <id> --confirm-cost  # paid: OPENAI_API_KEY, aviation_ingest, ELASTICSEARCH_WRITE_API_KEY
pnpm worker index passages --generation <id> --cache-only    # every vector from embedding_cache; no OpenAI client, fails if one is missing
```

The dry run prints "to embed"; when it is 0 every input is cached and `--cache-only`
builds the index without an embedder: it needs neither `--confirm-cost` nor
`OPENAI_API_KEY`, and it stops before creating an index if any input is missing.

- **Scope and builds.** Only answer-eligible US cases of a verified generation get
  passages. A build works like the cases build: it is recorded in `index_builds`,
  holds its liveness lock, pins the generation as `index-build:<build id>` until it
  finishes, switches the alias only while that pin exists and records the attempt,
  and deletes its index on its own only if the index never reached an alias request.
  One passages build per generation runs at a time (an advisory lock), and a build
  needs a connection pool of at least 3.
- **Chunking** (`worker/index/chunk.ts`, `CHUNKER_VERSION`). Each section is chunked on
  its own; exact `cl100k_base` token counts (`js-tiktoken`). A section of at most 800
  tokens, probable causes included, is one passage. Longer sections are cut into
  paragraphs (line breaks; hard-wrapped lines are joined) and sentences (abbreviations,
  initials and decimals do not end one), then packed into passages of even size
  around a 650-token target, between 200 and 800, preferring paragraph ends and never
  ending on a heading line. A heading glued to its text by HTML conversion
  ("AIRCRAFT INFORMATIONThe airplane") counts as a paragraph start, so a cut can fall
  right before it; the text itself is never changed. Each passage after the first
  repeats up to 80 tokens of whole trailing sentences of the previous one. A sentence
  or probable cause over 800 tokens is split at the nearest clause boundary below an
  even share (else a word boundary) into passages marked `continuation`; nothing is
  truncated. Offsets are UTF-16 indices into the section text (never inside a
  surrogate pair) and `text === section.text.slice(start, end)`.
- **Attribution.** In a single-aircraft event passages are aircraft-scoped and
  aircraft-specific, with their aircraft in the nested `aircraft` field. In a
  multi-aircraft event every section is event-scoped: its passages say "Event (n
  aircraft)" in their header, have `aircraft_specific: false` and `aircraft_key`
  null, leave `aircraft` empty and list every aircraft of the event in the nested
  `event_aircraft` field, with `event_aircraft_count` (the event's `case_aircraft`
  rows) and `event_aircraft_complete: true`. The dry run and the build compare each
  event-scoped passage's set with the event's aircraft keys read separately from
  PostgreSQL and refuse to build on any difference. A nested `aircraft` filter never
  matches an event-scoped passage; retrieval may qualify the whole event instead
  (see "Evidence retrieval").
- **Embedding input** is `"<section> · <make model | Event (n aircraft)> · <defining
  phase(s)>"` + newline + passage text; only the raw text is stored and cited.
  `text-embedding-3-small` at 1,536 dimensions, through the official SDK with SDK
  retries off; our own retry handles 429, 408, 5xx and connection failures, at most 3
  attempts. Provider deadlines (`Retry-After`, and the token and request limits'
  resets, after successful and failed responses alike; the latest wins) are waited
  out in full, only the local backoff is capped, and a deadline over 10 minutes stops
  the run with the time to rerun it. Requests hold at most 96 inputs and 250,000
  tokens; an input is at most 8,192 tokens. Errors keep only the HTTP status, a
  provider error code and the request id: no provider message (a 401 message quotes
  part of the key), no input text, no wrapped SDK error. A malformed successful
  response is reported by a fixed category, never by a value from it.
- **Cache.** `embedding_cache` is keyed by sha256 of the exact input, model,
  dimensions and `EMBEDDING_INPUT_TEMPLATE_VERSION`; a changed header misses it.
  Identical inputs are embedded once, vectors are cached as they arrive, and a rebuild
  pays only for misses. Reports count cache hits (inputs cached before the build) and
  deduplicated passages separately.
- **Spend.** Every attempt reserves its maximum cost (exact tokens × $0.02/M × 1.1)
  on the indexing ledger (`reserveSpend`) before it is sent, and settles
  (`settleSpend`): the reported usage, zero after a 4xx other than 408, or the whole
  reservation when the outcome is uncertain (408, 5xx, timeout, lost connection). A
  busy ledger is retried a few times, then the attempt is refused. The paid run
  refuses when the planned reservations exceed what is left of the indexing and
  evaluation allowance (`remainingCategoryUsd`).
- **Storage.** `passages` (PostgreSQL, migration 0012 with `embedding_cache`) holds
  one row per passage of a generation, keyed `(generation_id, passage_id)`, with
  `passage_id` = sha256(revision id, start, end, chunker version). Triggers accept rows only for a verified generation and a
  matching section of an answer-eligible US case, with offsets inside the section
  text, reject updates, and delete a generation's passages when pruning deletes the
  generation. An insert locks its generation row until it commits, so pruning waits
  for it (or the insert fails once pruning has removed the generation).
- **Index.** `<prefix>-passages-v2-g<generation>-<UTC timestamp>-<build id>`, alias
  `<prefix>-passages`. Strict mapping: passage and section ids, kind, scope,
  `aircraft_specific`, offsets, `part`/`parts`/`continuation`, `text` with the cases
  analyzers, `embedding` (`dense_vector`, 1,536, cosine, `int8_hnsw`, kept out of
  `_source`), the event filters (`country`, `ev_year`, `ev_date`, `state`,
  `answer_eligible`, `defining_phase_groups`, `highest_injury`, `wx_cond`, `light`),
  nested `aircraft`, nested `event_aircraft`, `event_aircraft_count` and
  `event_aircraft_complete`. The build checks the loaded index and the stored rows
  against what it built before the alias moves, including the nested event aircraft
  against the PostgreSQL counts. `passages-v2` changed only those event aircraft
  fields: chunks and embedding inputs are those of `passages-v1` (`chunk-v2`,
  `input-v1`), so a generation indexed as v1 rebuilds as v2 from the cache.

Integration test files run one at a time: they share `aviation_test` and the
`aviation-test-*` indices, and some of them reset both.

### Evidence retrieval (hybrid search)

`server/search/hybrid.ts` retrieves the evidence an AI brief is written from
(DESIGN §5; amendments A2, A3, A11, A13; review gate G5). It reads the passages index
the active manifest names and refuses (`RetrievalUnavailableError`) when there is
none or when the index breaks the passages contract
(`server/search/passages-contract.ts`; the same check `worker publish` and the API's
dataset loader use). The contract is checked before the query is embedded, within
the request's deadline. There is no keyword-only fallback for AI answers.

- **One filter.** `compileFilters` (in `server/search/filters.ts`, the compiler
  keyword search uses too) always adds `country: USA` and `answer_eligible: true`.
  With any aircraft facet the aircraft clause depends on the index version, which
  the passages contract reports:
  - `passages-v2` (event-level qualification, review gate G5): a passage whose own
    nested aircraft satisfies every active aircraft facet, or an event-scoped passage
    whose event qualifies as a whole: `event_aircraft_complete: true`, a non-empty
    nested `event_aircraft`, and no event aircraft failing the full conjunction of
    the facets (`must_not nested(must_not conjunction)`). A missing value fails its
    facet (`blank` does not count there). So two helicopters qualify under a
    helicopter filter, a helicopter and an airplane do not, and two facets met by
    different aircraft do not. The passage stays event-scoped: `scope: event`,
    `aircraftKey: null`, never attributed to one aircraft.
  - `passages-v1`: `aircraft_specific: true` and the nested aircraft clause, so an
    event-scoped passage never satisfies an aircraft filter.

  The filter is compiled once per request; the BM25 query, the kNN prefilter and the
  evidence fetch use the same clauses, so a qualifying event brings every
  event-scoped probable-cause variant it has.
- **Complete answers only.** Every search sets `allow_partial_search_results: false`;
  a response that timed out, has a failed shard or reports fewer `successful` shards
  than `total` fails retrieval (`IncompleteSearchError`). Shards skipped by the
  pre-filter are already counted in `successful`.
- **Stage 1, case candidates.** The question is embedded once
  (`queryEmbeddingInput`, template `query-v1`: whitespace collapsed, no header, at
  most 1,000 tokens). BM25 (`multi_match` over `text`) and kNN (`num_candidates` =
  4 × k) each return `perChannel` passages (50 live; the evaluation also runs 100).
  Reciprocal rank fusion in TypeScript (`sum 1/(60 + rank)`) and deduplication to
  cases at their best passage give the case ranking.
- **Stage 2, packing** (`server/search/evidence.ts`). At most 6 cases, 12 passages,
  3 passages per case and 10,000 passage-text tokens. Each selected case first
  reserves its justification: its best retrieved passage and every probable-cause
  variant it has under the filters. A case whose reservation does not fit is skipped,
  so the bundle holds fewer cases rather than cases without the passage that ranked
  them. Then each case adds its next best passages (2 retrieved in all), the
  lowest-ranked of those extras are trimmed to the budgets, and free room is filled in
  fused order. `RETRIEVAL_DEFAULTS` holds every value; all remain provisional.
- **Cost.** Retrieval embeds through the `Embedder` it is given and hands the query
  embedding's usage (model, tokens, USD, `billing: reported | uncertain`) to
  `onQueryEmbedding` before any search, so a later failure cannot lose a paid stage.
  It never reserves money: an AI request's admission reservation covers one query
  embedding. `createOpenAIQueryEmbedder` takes exactly one input, makes one attempt,
  and reports a missing usage report as uncertain; a `QueryEmbeddingError` says
  whether the attempt was billed (`none`, `usage` with its tokens, or `uncertain`).

The retrieval evaluation measures candidate case Recall@20 and, on the packed bundle,
case coverage, question-specific evidence coverage (do the bundle's passages for an
expected case satisfy the question's own text criterion), bundle precision and
nDCG@6, for BM25 alone, kNN alone and the hybrid, at 50 and 100 passages per channel.
Probable-cause coverage is reported as a structural check only.

```sh
pnpm eval:retrieval:silver --dry-run          # derive the silver set from the active generation (DATABASE_URL); prints the split groups
pnpm eval:retrieval:silver                    # write evals/retrieval/dataset.json; --check compares instead
pnpm eval:retrieval                           # checks, then plan only: question count, tokens, estimated cost
pnpm eval:retrieval --confirm-cost            # embed the questions (about $0.00002) and write data/work/eval-retrieval-<UTC>.json
pnpm eval:retrieval --fake-embedder           # free pipeline check; non-gating, vector and hybrid numbers mean nothing
```

Both commands take `--env-files a,b` (otherwise `AVIATION_ENV_FILES`, otherwise
`.env.local`). `eval:retrieval` evaluates the active manifest's passages index or
`--passages-index <name>`, takes `--sizes`, `--split dev|holdout` and `--out-dir`,
and meters the embeddings on the ledger under `evaluation` (`DATABASE_INGEST_URL`).
It fails closed before embedding anything: dataset problems, a target generation
other than the one the silver set was built from, or an index that breaks the
passages contract stop the run. Generation ids are per-database sequences, so each
dataset also records its generation's identity (`source`: archive sha256, completion
mapping, field normalization and citation text versions), and every run re-derives
the labels on its target, read-only, before paying for anything: a different identity,
or any question whose labels differ there, stops it (the silver set's 76 rules take
about 25 seconds; the coded set's about 1 second). So do questions tagged `multi_aircraft_filtered`
(an aircraft filter over multi-aircraft events) on a `passages-v1` index, which cannot
reach their cases. `--exploratory` continues past these problems (without those
questions) and marks the report `gating: false`. The report holds every ranking, bundle and
Elasticsearch body, query vectors elided.

The silver set (`evals/retrieval/dataset.json`) has public NTSB case numbers derived
by committed rules (`evals/retrieval/questions.ts`): structured fields plus explicit
PostgreSQL regular expressions over one section at a time, each recorded as
`derivation.rule` and `derivation.criteria` for an expert to re-check. Every label is
`pending-expert`, and every question keeps its rule's full positive set. Independently
worded paraphrases (`paraphrase_of`) reuse their original's rule and expected set.
Questions sharing a case, and paraphrases with their originals, form groups that are
assigned whole to `dev` or `holdout`: first so that every required tag spread over
several groups reaches both splits, then stratified by primary tag. A question with
an aircraft category filter has a single-aircraft rule of that category or an
every-aircraft rule (`categoryEvery`) of it; the latter derives multi-aircraft events
only the `passages-v2` qualification reaches (tag `multi_aircraft_filtered`). Three
questions answered by inspection dates and hours are kept as `section: "structured"` and are
not run by the RAG evaluation. A unit test fails when `dataset.json` no longer matches
the rules.

**Coded-reference track** (Track C of the task 10c evaluation protocol). Its scores are
labelled `coded-reference`: they measure retrieval of coded facts, not adjudicated
relevance. Each question in `evals/retrieval/coded/questions.ts` is defined by a frozen
code set: ten-digit `case_findings` codes (the modifier is always explicit), optionally
required to be cited in the probable cause (`in_probable_cause`), and/or three-digit
`case_sequence` occurrence codes. Each question also states its aircraft attribution
(one aircraft carries every clause, or each clause some aircraft) and its filters
(years, state, aircraft category, phase group). Under an aircraft filter the carrying
aircraft must match, and a multi-aircraft event counts only when every aircraft matches;
coded events the filter cannot reach are recorded as `unreachable`. Question text
follows the code's meaning ("conditions conducive to carburetor icing", never
"confirmed carburetor icing"), paraphrases avoid the code vocabulary and keep the
labels, and `cause_factor` and the " - C"/" - F" description suffixes are never labels.
The builder derives the labels from every answer-eligible US case in one read-only
snapshot and records, per question, the codes, the description text seen, case counts
and the class:

- **narrow** (1 to 20 coded cases): gated on candidate Recall@20 (target 90%);
- **broad** (more than 20): gated on strict P@6 and nDCG@6 of the bundle (gains
  0/1/2 → 0/1/3); Recall@20 is a diagnostic with its ceiling.

Absence of a code is not a negative judgement, so precision is reported as coded
precision. The metric module (`evals/retrieval/metrics.ts`) also computes the bounds
the model-judged track will need for unknown grades (exact P@6 bounds; nDCG@6 bounds
by enumeration, or the protocol's sound relaxation beyond 12 unknowns; zero-IDCG
flags). Questions sharing a case, and paraphrases with their originals, are split
together, and every area and class reaches both splits.

```sh
pnpm eval:retrieval:coded --generation 1 --check   # rebuild evals/retrieval/coded/dataset.json in memory and compare (DATABASE_URL, read-only)
pnpm eval:retrieval:coded --generation 1           # write it; --dry-run prints the questions and split groups only
pnpm eval:retrieval --track coded                  # checks, then plan only (43 questions, about $0.00002)
pnpm eval:retrieval --track coded --confirm-cost   # embed and write data/work/eval-retrieval-coded-<UTC>.json
```

The coded run takes the same options and fails closed in the same way, including the
label re-derivation on the target, and also stops when the dataset was built from other
question specs than the committed ones. Its report holds the metric definitions, the
summary per split, class, area and tag (each also per class), a per-question table, the
target generation's identity, and every ranking, bundle and Elasticsearch body (query
vectors elided).

The coded set's splits are frozen (`splitsFrozen`, protocol section 6): a rebuild keeps
every committed question in its split and places only new questions, and a spec edit
that would join questions frozen in both splits fails the build (and `--check`).
`--freeze-splits` freezes a set, and `--reassign-splits` deliberately places every group
afresh. Code sets taken from what generation 1 holds ("every modifier seen", "every code
with the Maintenance personnel modifier") are frozen too: the builder and the run warn
when a generation holds a code of the same kind outside the frozen list
(`CODE_FAMILIES`), and never add it.

**Retrieval experiments** (`evals/retrieval/experiments/`, task 10d). Experiments over
the coded-reference dev questions, registered before they run: `PREREG.md` explains
them and `grid.json` freezes the baseline, every variant with its target metric, the
selection rule, the bootstrap, and the latency and cost limits. They cover fusion and
depth (passage- or case-level reciprocal rank fusion, passages per channel, kNN
candidates, the RRF constant, channel weights), case-level BM25 over the cases index
(narratives, or narratives and `findings_text`) as a third channel or instead of
passage BM25, bounded candidate pools, and the scope stage's keyword text as BM25 text.
Every knob is a parameter whose default is today's retrieval: the experiments call the
production stages with parameters and never change them, and a test holds that the
default configuration sends exactly the production request bodies. Runs are read-only
against the target (the ledger records paid calls), refuse a target or dataset other
than the frozen one, and write their reports to `--out-dir`.

```sh
pnpm eval:retrieval:experiments preflight                  # free: target, contract, frozen identity, labels re-derived, filter consistency
pnpm eval:retrieval:experiments scope                      # free dry run: scope-stage input tokens and reservations per question
pnpm eval:retrieval:experiments scope --confirm-cost       # take the scope samples, every attempt reserved on the ledger
pnpm eval:retrieval:experiments dev --scope-samples <file> --confirm-cost       # every variant on dev, diagnostics, the rule
pnpm eval:retrieval:experiments holdout --dev-results <file> --confirm-cost     # once: the selected configuration against the baseline
```

`--keys-file <file>` reads only `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from a dotenv
file and never replaces a nonempty process value.

**Narrative-relevance track** (Track N of the task 10c protocol, `evals/retrieval/narrative/`).
It measures what the codes cannot express: negation, maintenance chronology, causal
uncertainty, pilot-versus-investigator attribution, paraphrases, multi-aircraft events
and aircraft filters. Its scores are **model-judged**: two judges from different providers
grade each case against the question's written rubric, and an adjudicator settles their
disagreements. Nothing is expert-adjudicated, and no label waits for a person.

- **Questions** (`questions.ts`, built into `dataset.json` by `build`): 25 development
  questions in 21 families, each with filters, a type, a lure for hard negatives and a
  rubric that defines grade 2 (relevant), 1 (partially relevant) and 0 with edge cases.
  Six are **bounded cohorts** (their filters reach 83 to 107 answer-eligible cases), judged
  completely so Recall@20 is defined; paraphrases keep their family's rubric and
  judgments. Questions were written from general knowledge, with filters chosen from
  aggregate cohort counts only.
- **Judge input** (`evidence.ts`): the case's complete record from PostgreSQL (every
  narrative section and variant with its revision and scope, the coded findings and
  occurrences by row identity), checked against the stored hashes and fingerprinted by
  content. Cases above 12,000 `cl100k` tokens are judged part by part with carried notes
  and a consolidation step; nothing is truncated, and an uncovered case is `unknown`.
  Bundle answerability reads only the passages a retrieval bundle delivered.
- **Judges** (`config.ts`, `clients.ts`, `judging.ts`): `claude-haiku-5-5` (adaptive
  thinking) and `gpt-5.6-luna` (reasoning effort low) grade independently, blind to method
  and rank; `claude-sonnet-5-5` adjudicates a disagreement after recording its own blind
  grade, and may abstain. Quotes are checked with the brief validator's quote rule
  (`quote-ws-v2`) against the stored text; an invalid output gets one retry, then is
  unjudgeable. Unresolved pairs stay `unknown` in every denominator. The OpenAI client is
  evaluation-only, outside the production provider path.
- **Calibration** (`calibration.json`, labels frozen by hash): code-reading items (Track
  C questions with the codes visible) and synthetic narrative controls (negation,
  chronology, pilot versus investigator, cross-aircraft attribution); every label is
  `constructed`.
- **Pools** (`pool.ts`): per family, the union of the first 100 unique cases of
  `p50-kt`, `c200+n-kt` and `c200+nf-kt` (the experiment harness, cached scope outputs),
  every bounded-cohort case, related-code positives, lure hard negatives and a seeded tail
  sample, versioned by content. **Metrics** (`score.ts`): Recall@20 on exhaustive bounded
  cohorts only, strict P@6 and nDCG@6 with bounds over unknowns, supported P@6 (relevant and
  answerable in the delivered passages), group bootstrap, judge agreement (kappa with
  intervals, confusion matrices per tag and grade) and candidate code-narrative
  discrepancies.

```sh
pnpm eval:retrieval:narrative build --generation 1 --check        # the question set (DATABASE_URL, read-only)
pnpm eval:retrieval:narrative calibration --generation 1 --check  # the calibration sets; refuses changed labels
pnpm eval:retrieval:narrative plan --keys-file <file>             # free dry run: preflight, inventory, token counts and cost
pnpm eval:retrieval:narrative pools --confirm-cost                # scope samples and query embeddings, then the pools
pnpm eval:retrieval:narrative judge --set calibration --confirm-cost
pnpm eval:retrieval:narrative judge --set relevance --pools <file> --confirm-cost
pnpm eval:retrieval:narrative answerability --pools <file> --confirm-cost
pnpm eval:retrieval:narrative report --pools <file> --judgments <a,b>   # free
```

Paid commands print their plan and send nothing without `--confirm-cost`. Each attempt
reserves its worst case on the evaluation ledger (`DATABASE_INGEST_URL`) and settles; a
command stops before a reservation would exceed its limit or what remains of the monthly
indexing and evaluation allowance. Outputs, the spend log and the judgment cache go to
`--out-dir` (default `data/work/narrative`).

### Checker calibration

`evals/checker/` calibrates the evidence checker (Task 16c, gate G6): which model,
thinking and prompt judge claims well enough to show a summary. Every check input is
rendered by the production code from real retrieval bundles, so the checker reads what
it reads in a brief.

```sh
pnpm eval:checker retrieve                    # plan only; --confirm-cost embeds 9 questions (about $0.000005) and writes evidence.json
pnpm eval:checker build                       # evidence.json + items/ → dataset.json (labels hashed); --check compares instead
pnpm eval:checker inventory --config haiku-think --split dev   # free: provider token counts, expected and worst-case cost
pnpm eval:checker run --config haiku-think --split dev --confirm-cost   # paid, on the evaluation ledger
pnpm eval:checker select data/work/checker/*-dev-*.summary.json        # the frozen selection rule → selection.json
```

All take `--env-files a,b` and `--keys-file <file>` (only `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY` are read from it, never over a nonempty process value). A run reserves
each call's worst case on the evaluation ledger (`DATABASE_INGEST_URL`), settles it,
appends it to `data/work/checker/spend.jsonl` and stops before a call that would take the
logged total above `CALIBRATION_LIMIT_USD` ($3); trials and a counts-only summary go to
`data/work/checker/`, and `--resume <trials.jsonl>` continues a run a crash interrupted.
The held-out split runs once, for the configuration frozen in `selection.json`.

- **Evidence** (`evidence.json`): nine real hybrid-retrieval bundles from the served
  passages index, verified like a brief's (`verifyBundle`); five development and four
  held-out bundles, split by case (no case in both).
- **Items** (`items/`): the first paid brief's 35 claims, verbatim, as regressions
  (`paid-run.ts`; the six known critical errors marked); controls by family and mutation
  (`dev.ts`, `holdout.ts`: negations, the wrong aircraft in multi-aircraft events, hours
  and days, before and after, wrong anchors, "the day before" as 24 hours, the first
  flight as a window, causal overstatement, unsupported additions, compound claims,
  correct statements with the wrong citation, misleading and context-losing excerpts, the
  wrong speaker or actor); and complete briefs (`briefs.ts`), each wholly supported, with
  reading variants and with exactly one known error (an edit the builder proves changes
  exactly one rendered claim). 51 check inputs, 487 distinct claims over 46 cases.
- **Labels** are `constructed` (by how a claim was made, checked against the complete
  supplied passages) or `model-reviewed`; none is expert ground truth, and three
  unresolved ones are `unknown` and count nowhere. `labels.sha256` froze them before any
  checker output was compared; `protocol.ts` froze the configurations, trials, targets and
  selection rule with them.
- **Figures** (`metrics.ts`, judged by the production `judgeCheck`): whole-brief false
  withholding on wholly supported briefs (target at most 10%), detection per family
  (timing, attribution, contradiction, unsupported addition; at least 95%), critical
  regressions withheld in every trial, false flags by claim kind, `chronology_missed`,
  cost and latency, with Wilson 95% intervals. Run summaries are in
  `evals/checker/results/`.

**Result** (2026-10-23, $1.98 of the $3 limit): no configuration met every target. Eight
development runs (Haiku 5.5 without thinking, with adaptive thinking, and Sonnet 5.5
without thinking; prompts `check.v4` to `check.v6`) went through the fallback order, which
froze Haiku 5.5 with adaptive thinking on `check.v5` (every critical regression and all 92
development errors withheld; 7 of 21 supported-brief trials withheld). The held-out split
did not confirm it: 17 of 21 supported-brief trials withheld (81%), detection 81 of 86
(attribution 15 of 18). Production runs that configuration; most summaries will be
withheld until a better checker passes the gate (DESIGN §12).

### Web client

`web/` is a React 19 single-page app built with Vite, React Router, TanStack Query
and Tailwind CSS 4. It implements the "Sectional" design system from
[UI_DESIGN.md](docs/UI_DESIGN.md) §2: tokens in `web/src/styles/tokens.css` (day on
`:root`, night "Panel" on `[data-theme="night"]`), mapped into the Tailwind theme in
`web/src/styles/index.css`, which clears Tailwind's default palette, type scale and
breakpoints. Components never use raw colours.

Pages (UI_DESIGN §3–§7): Home ("Clear sky"), Explore (keyword search with facet
counts, the case drawer and the compare tray), the full case page and Compare
(flight strips with NTSB columns, "Same in all", sort and Print for class), plus
About and Privacy. They show NTSB data only; Ask AI is present but disabled until
briefs arrive. View state is in the URL: the search keys of `SearchRequest`
(`q`, `mentionedIn`, the facet names, `yearFrom`, `yearTo`, `sort`, `page`), the
open case (`case`) and the compare selection (`cases`). Phones get a "Filters (n)"
sheet, a full-screen case sheet and a compare bar.

```sh
pnpm dev:web          # Vite dev server; /api is proxied to the API server
WEB_MOCK_API=1 pnpm dev:web   # no API server: /api answered by MSW from web/mock
pnpm build:web        # production build into dist/web
pnpm test:web         # component tests (jsdom, offline, MSW)
pnpm test:e2e         # Playwright against the dev server in mock mode
pnpm test:e2e:real    # Playwright against the real API server and the fixture index
```

### API contracts and the mock API

`shared/contracts/{config,search,cases,dashboard,ai,briefs}.ts` are the Zod contracts of the
public API (`GET /api/config`, `/api/search`, `/api/cases/:ntsbNo`,
`/api/dashboard`, `/api/ai/status`, and the [AI brief](#ai-briefs) routes). Every object is strict, `ev_id` never appears, and the case
detail is NTSB-only by construction (a test walks the schema for AI fields). The
web client validates every response against them. `shared/case-view.ts` builds the
deterministic headline, finding text and data cautions; `shared/vocab.ts` holds the
code labels from the NTSB data dictionary.

`pnpm mock:build` normalizes `fixtures/ntsb` and `fixtures/ntsb-ui` with
`normalizeCorpus` and writes contract-valid responses to `web/mock/*.json` (config,
both dashboard cohorts, every case detail, a search index and sample searches).
`web/mock/engine.ts` answers any search over that index with the real counting
rules (distinct events, disjunctive facets, defining-event phase, aircraft facets
matched on one aircraft, multi-aircraft overlap, "remove one filter" totals) and a
simple stand-in for the analyzer.
`web/src/mocks/handlers.ts` serves it through MSW, in the dev mock mode and in tests;
production builds contain no mock code. `GET /api/ai/status` answers one of the
hand-written samples in `web/mock/ai-status.ts` (a fresh anonymous visitor by
default; `createHandlers({ aiStatus })` picks another). The brief routes are answered by
`web/mock/briefs.ts`: an in-memory brief server with hand-written readings of the four
seed cases whose quotes are located in the fixture texts, the server's own static
replies and reading templates, a checklist that moves one row per poll
(`createHandlers({ briefPolls })`), and question keywords that select the other outcomes
(withheld, out of scope, operational, counting, comparison, clarification, no results).
A unit test fails when the committed mock files are out of date.

`pnpm test:e2e` starts `pnpm dev:web` in mock mode on `E2E_PORT` (default 5180).
It needs Playwright's Chromium (`pnpm exec playwright install chromium`, plus
`--with-deps` on a fresh Linux machine).

`WEB_DEV_PORT` (default 5173) and `WEB_DEV_API_URL` (default
`http://localhost:3000`) are read from the process environment by `vite.config.ts`
only; they are not `VITE_`-prefixed, so they never reach browser code. In
development, `/dev/components` shows every component in both themes; production
builds leave it out.

Fonts (B612, B612 Mono, Source Serif 4) are self-hosted Latin-subset WOFF2 files
from the `@fontsource` packages; the build writes their SIL OFL notices to
`dist/web/licenses/fonts.txt`. The theme follows `prefers-color-scheme` until the
user picks Day or Night, and the choice is kept in `localStorage`. A small inline
script in `web/index.html` applies it before first paint; its CSP hash is in
`web/src/csp-hashes.ts`, and the build fails if the two disagree.

### API server

```sh
pnpm dev:server       # the API on HOST:PORT (default 127.0.0.1:3000), restarted on change
pnpm dev:web          # the web client; /api is proxied to the API server
pnpm worker publish --generation <id> --cases-index <name> [--passages-index <name>]
```

`server/main.ts` starts `buildApp(deps)` (`server/app.ts`): Fastify 5 with
`trustProxy: false`, serving the API and the built web client (`dist/web`, with an
SPA fallback) on one origin. It reads configuration like the worker (`AVIATION_ENV_FILES`,
otherwise `.env.local`), connects as `aviation_app` (`DATABASE_URL`) and reads
Elasticsearch with `ELASTICSEARCH_READ_API_KEY` only. With `APP_ENV=live` it refuses to
start unless `TRUSTED_PROXY_CIDRS` is set (tunnel mode). The API answers 503 until
a dataset is published: load, verify and index a generation, then `pnpm worker
publish` it (for the local `aviation_dev`, the fixture corpus is enough).

| Endpoint | Response | Caching |
| --- | --- | --- |
| `GET /api/health` | `{status, database, search}` states only; 200, or 503 when either check fails; one probe shared for 2 s | `no-store`; rate limited except over loopback |
| `GET /api/config` | `ConfigResponse`: snapshot date, dataset revision, coverage, the Turnstile site key once the anonymous gate is configured | `public, max-age=300`, ETag |
| `GET /api/search` | `SearchResponse` | `public, max-age=60`, keyed by the full URL |
| `GET /api/cases/:ntsbNo` | `CaseDetail` from PostgreSQL; 404 for unknown numbers | `public, max-age=300`, ETag |
| `GET /api/dashboard?cohort=default\|all` | `DashboardResponse`, computed once per dataset revision and cohort | `public, max-age=300`, ETag |
| `GET /api/ai/status` | `AiStatusResponse` for this visitor ([anonymous gate](#anonymous-gate-and-ai-status)) | `no-store` |
| `POST /api/briefs`, `POST /api/briefs/:id/refine` | `StartBriefResponse` ([AI briefs](#ai-briefs)) | `no-store` |
| `GET /api/briefs/:id?step=n`, `GET /api/briefs/:id/steps/:n/cases/:ntsbNo`, `POST /api/briefs/:id/cancel` | the step, the case context, 204; read owner only | `no-store` |

Every response is validated against its contract before it is sent. ETags are the
dataset revision plus a hash of the body, and a matching `If-None-Match` gets 304.
Search uses a short public cache rather than `no-store`: results change only when a
new manifest is published, and the canonical query string makes equal searches share
an entry. Errors are `ErrorResponse` bodies with fixed messages and `no-store`; a
missing index, an unreachable database or search engine, or a search that ran out of
its 5-second Elasticsearch `timeout` (`timed_out`, partial counts) is a 503, never a
404, partial data or an internal message. The router's own refusals (a malformed URL)
get the same headers and a JSON 400, and the static files' refusals are 404 or 400.
The log has one line per API request (method, route pattern, status, duration),
without client addresses or query strings; an unmatched `/api` path is logged with
the route `unmatched` and nothing of the request target. Per-visitor routes
(`/api/ai`, `/api/briefs`, `/api/auth`, `/api/account`, chosen from the matched route
prefix, so later routes are covered) answer `Cache-Control: private, no-store`; public
data routes are cacheable and keyed by the dataset revision; errors are `no-store`.
Requests the HTTP parser itself refuses (400, or 408 for a request timeout and 431 for
oversized headers; 403 for a non-connector peer in tunnel mode) get the same security
headers and a JSON body, and the connection is closed.

- **Dataset pinning (A6).** Each request resolves the active `dataset_manifests` row
  (reused for 5 seconds) and reads only that generation and its cases index, never
  the alias. Before serving a manifest the server checks the index `_meta` (same
  generation, and a version and mapping fingerprint it serves) and otherwise answers
  503. It serves the current `CASES_INDEX_VERSION` and the earlier versions listed in
  `EARLIER_SERVABLE_CASES_VERSIONS` with their exact fingerprints: only versions with
  the same fields qualify. `cases-v2` (without the glued-heading char filter) stays
  servable until every environment has published a `cases-v3` index. The dataset
  revision is `g<generation>-<index version>-<8 hex of the index names>`. The
  snapshot date is the newest source change (`lchg_date`) in the generation, i.e.
  the date the data is current to; the archive's own date is not recorded.
- **Publishing.** `pnpm worker publish` checks that the cases index is a concrete
  index (not an alias) built for that generation with a version and fingerprint the
  server serves (see above), and that it holds exactly the generation's US events. A
  passages index, when given, must meet the passages contract of its version
  (`server/search/passages-contract.ts`): this generation, version `passages-v2` (or
  `passages-v1`, still servable without the event-level qualification), that
  version's approved mapping fingerprint for the configured `OPENAI_EMBEDDING_MODEL`
  and `OPENAI_EMBEDDING_DIMENSIONS`, chunker `chunk-v2` and input template
  `input-v1`; and it must hold exactly the generation's `chunk-v2` passage rows. It then calls
  `publishManifest`, which also requires the generation's current verification. The
  API applies the same contract when it loads the manifest: an unservable passages
  index leaves keyword search working and marks the dataset's passages unservable
  with a fixed code (`not_configured`, `incompatible` or `unavailable`) and a fixed
  failure category (`timeout`, `transport`, `http_<status>`, `incompatible:<fields>`,
  …), never upstream error text, in the status and in the log. A broken
  contract is kept until the manifest changes; a transient failure (a timeout or an
  Elasticsearch error) is checked again after 30 s, in the background.
- **Keyword search** (`server/search/keyword.ts`, `filters.ts`, `facets.ts`). The
  words of `q` must all occur in the report: one `multi_match` (`cross_fields`,
  operator `and`) over `probable_cause`, `analysis`, `factual` and `findings_text`
  with the index's search analyzer (synonyms, negations kept). Each "quoted phrase"
  (up to 8) is a `match_phrase` within one section. No `query_string`, wildcard,
  regular expression or script is ever built, so Lucene syntax is plain text.
  "Mentioned in the probable cause" applies the same clauses to `probable_cause`.
  The query carries only the text; filters are a `post_filter`, and facet counts,
  the `mentionedIn` totals, the year chart, the multi-aircraft count and the "remove
  one filter" totals are filter aggregations of one request. Facets count distinct
  events and are disjunctive. Aircraft facets (phase, category, engine, operation,
  purpose) form one `nested` clause, so one aircraft must match all of them, and
  count with `reverse_nested`; phase is that aircraft's defining-event phase group.
  An aircraft with no engine type recorded is the engine facet's blank. Codes the
  snapshot uses but the data dictionary does not define (state `OF`, category
  `RCKT`, engine `HR` and `LR`) are selectable and labelled with the raw code; a
  value outside the vocabulary is left out of the buckets and logged once. Rows come
  from PostgreSQL for the page's case numbers. Snippets come from the section
  highlights (private-use markers turned into offsets): the probable cause, which
  Elasticsearch returns whole, when the words match there; otherwise the analysis or
  factual passage (one best passage of about 300 characters, so long sections never
  come back whole) with the most marks, shown as an excerpt with ellipses on both sides
  (`shared/snippet.ts`, shared with the mock API).
- **Dashboard** (`server/search/dashboard.ts`). Bars are the facet counts of the
  cohort's empty search, from the same code, so a bar opened in Explore shows its
  count. METAR coverage and coordinates come from PostgreSQL for the same generation;
  points are projected to the 1000×637 lower-48 frame on the server, and Alaska,
  Hawaii, territories and waters count as outside the frame. A response carries at
  most `MAX_MAP_POINTS` (60,000; the corpus has about 25,400 US events).
- **Access by route** (`server/app.ts`). The checks follow the route the router
  matched on the decoded path, never the raw request target, so `/%61pi/search` and an
  absolute-form `GET http://host/api/search` are treated exactly like `/api/search`.
  Default deny: every matched route needs a network identity and is rate limited,
  except the web client's routes (`ASSET_ROUTES`: the page and the static files) and
  the not-found handler (the page or a 404), which need no client address and are not
  limited, and `GET /api/health` over loopback (the container's health check). Whether
  a 404 is JSON or the page also follows the decoded path (`/%61pi/nope` is a JSON 404).
- **Network identity** (`server/http/network-identity.ts`). Without trusted proxies
  the bucket key is the socket address. With `TRUSTED_PROXY_CIDRS` (tunnel mode) only
  peers inside those networks are served (403 `forbidden` otherwise, static files
  included), and the API requires one valid `CF-Connecting-IP` from them (400 when
  missing or invalid); nothing falls back to a shared bucket. IPv4-mapped addresses
  are unwrapped and IPv6 is reduced to its /64.
- **Rate limit.** 60 API requests a minute per network identity (an in-memory token
  bucket); the 61st gets 429 with `Retry-After` and `retryAfter` in the body.
- **Security headers** (`server/http/security-headers.ts`). `default-src 'self'`;
  `script-src 'self'` plus the hash of the inline theme script; `style-src 'self'`;
  `img-src 'self' data:`; `connect-src 'self'`; `frame-ancestors 'none'`; no
  `unsafe-inline` or `unsafe-eval`. The dialogs' scroll lock (Radix) inserts a
  `<style>` element with computed values, so each HTML page gets a fresh style nonce
  in its CSP and as the `nonce` attribute of `<meta property="csp-nonce">` (read
  through the element's `nonce` property, since browsers hide the attribute), which
  `web/src/csp-nonce.ts` hands to that library; scripts never accept it. When
  anonymous AI is configured (the page gets a Turnstile site key), `script-src` and a
  `frame-src` directive allow `https://challenges.cloudflare.com`, exactly what
  Cloudflare's Turnstile CSP reference lists for policies without script nonces;
  otherwise neither appears. Zod runs without compiled parsers
  (`web/src/zod-config.ts`), which would otherwise probe `new Function`. Also
  `X-Content-Type-Options`, `Referrer-Policy: same-origin`, `Permissions-Policy`,
  `X-Frame-Options`, and HSTS when `APP_URL` is HTTPS.

`tests/integration/api-search.test.ts` runs the API against the fixture corpus
(`fixtures/ntsb` and `fixtures/ntsb-ui`) published as the active dataset of
`aviation_test`. `pnpm test:e2e:real` builds the web client and starts the real server
on that dataset (`tests/e2e-real/server.ts`, port `E2E_REAL_PORT`, default 5181). Both
reset `aviation_test`'s corpus, so do not run them at the same time.

### Language-model provider

`server/ai/` holds the provider interface (`provider.ts`) that the scope, compose
and check stages call, the Anthropic adapter (`anthropic.ts`), a deterministic fake
for tests (`fake.ts`, allowed only with `NODE_ENV=test`) and versioned prompts
(`prompts/scope.v2.ts`, `compose.v6.ts`, `check.v5.ts`; earlier versions are in the git
history, each file's header says what changed). The scope stage
returns the intent, validated filters, a `keywordText` query for the keyword channel
and at most one ambiguity as allowlisted tokens. Each stage validates its bounded input, sends the question and
passages as delimited untrusted data in the user turn, and returns a Zod-validated
object with normalized usage (input, output including thinking, cache write, cache
read), provider, model and prompt version. The OpenAI adapter is not built yet.

Anthropic calls use `messages.parse` with structured outputs, effort `low`, no
retries, a cached system prompt, and no prefill, sampling parameters or refusal
fallbacks. Thinking is a stage's setting (`STAGE_THINKING`): off for scope and
compose, adaptive for the check (the checker calibration's choice). Off is `disabled`
on Haiku 5.5 and `between_tools` on Sonnet 5.5; Opus 5.5 cannot turn it off. Thinking
counts against the stage's output cap, the only allowance there is. Each stage first counts its input
with `messages.countTokens` on the identical request (`countInputTokens` exposes the
same count for evidence packing) and sends nothing above the stage cap. The whole
call is bounded by the caller's deadline signal and the stage's `timeoutMs`. A
refusal, `max_tokens`, unparsed output, a failed count or input above the cap fails
the stage with a `StageError` that says whether the call was billed.

`pricing.ts` holds the allowlisted prices, the hard token caps per stage and the
per-request reservations ($0.36 Opus, $0.19 Sonnet, $0.03 Haiku answer model, with the
calibrated Haiku checker). The caps were measured with the provider's own counter
(free) against real passages (DESIGN §9 "Hard caps"): scope 6,500 in / 600 out, answer
28,000 / 11,000, check 40,000 / 21,500 (15,000 of it the checker's thinking allowance),
in provider tokens, so the measured stress cases fit: a full
12-passage bundle with the longest question and refinement without re-packing, and a
check of a full bundle's complete evidence whole. `startupAiCheck(config)` enables AI only when the
provider has an adapter, its keys are set, every reachable model is priced and the
worst-case request (all stages at their caps plus cache-write premiums) fits the
reservation. Change a price, cap or model only together with the expected sums in
`tests/unit/pricing.test.ts`, and run the preflight below. Adapter tests run the real
SDK client against a stubbed `fetch`; nothing is sent.

**AI preflight** (`worker/ai-preflight.ts`; mandatory before paid tests and
deployments, docs/RUNBOOK.md):

```sh
pnpm worker ai-preflight      # needs ANTHROPIC_API_KEY; free (token counts only)
```

It counts, with the configured provider and models, each stage's fixed request (system
prompt and structured-output schema) and a synthetic worst case at the server's input
bounds (the longest refinement in English and in dense text at the query-embedding
cap; a full bundle of 12 chunker-maximum passages within the 10,000-token evidence
budget, with every claim the composition schema allows), each stage's output at its
schema bounds (the answer stage with 1,500 tokens left for thinking, the check stage
with 15,000) and each stage's
cached prefix (system prompt and schema) against `CACHED_PREFIX_MAX`, and exits 1 when
anything is over its cap. Its client refuses generation. Between preflights,
`tests/unit/ai-preflight.test.ts` sizes the same requests offline with `cl100k_base`
times measured factors (2.2 for system prompt plus schema, 1.8 for Latin-script text).

### Cost gate and quotas

`server/quota/` meters every paid call (DESIGN §7–§9). Its tables are in
`server/db/schema/controls.ts`; grants, row-level security, guard triggers and
retention are in migrations 0008 and 0009.

- **Admission.** `admitPaidRequest` runs one short transaction before any provider
  call. It checks the kill switch, locks the principal, network and global usage
  buckets in a fixed key order, and checks idempotency: keys are scoped to the
  principal, the same key and canonical request hash (`canonicalRequestHash`) replays
  the original admission, and the same key with another body is a 409 conflict. Then
  come the attempt rate limits and the monthly and paced daily budgets. A principal
  whose previous request is still in flight gets `concurrency` (never a quota verdict
  that request may still change); otherwise its quota, the anonymous share and the
  total in-flight limits follow. An admitted request reserves
  its maximum cost, takes one unit of quota and gets a 90-second lease with a fencing
  token. Rejections: `trial_exhausted`, `daily_cap`, `monthly_cap`,
  `anonymous_share_exhausted`, `global_paused` (`daily_budget`, `monthly_budget`,
  `maintenance`), `rate_limited` (with `retryAt`), `concurrency`,
  `idempotency_conflict`, and `busy`. Lock waits in admission, settlement and spend
  reservation are bounded at 2 seconds; a timeout rolls back and returns `busy`
  (503, fail closed).
- **Limits.** A trial has 3 searches and lasts 30 days. Signed-in users get 20 a day
  and 150 a month, 5 a day during their first 3 days. Attempts are limited to 2 a
  minute anonymously and 5 signed in, and per network identity and class to 10 an
  hour and 20 a day anonymously, 30 an hour and 100 a day signed in. One request per
  principal, two in total and one anonymous request can be in flight.
- **Quota units.** The unit is taken at admission, so concurrent requests can never
  both use the last trial search. `releaseQuota` gives it back for a reply that must
  not count (off-topic, operational, nothing spent); the attempt still counts.
  `recordAttempt` counts an attempt that makes no paid call.
- **Settlement.** `settle` (interactive) and `settleSpend` (indexing, evaluation) need
  the reservation's fencing token and a live lease. They charge the reported usage,
  optionally itemized by provider, model, stage and token counts, or the full
  reservation when the usage is uncertain. A lease that runs out first is charged in
  full and never refunded (`expireLeases` sweeps; a late settlement is refused). Expiry
  frees the concurrency slot, not the money.
- **Budgets.** Spend is the append-only `cost_ledger` plus the full amount of every
  open reservation, counted by the UTC day the reservation was made. The daily
  interactive allowance is fixed at the start of each UTC day: the lower of $3 and
  (interactive budget − earlier charges − still-open earlier reservations) / days left
  in the month (`dailyAllowanceUsd`). Anonymous trials may use 25% of it. Indexing and
  evaluation reserve with `reserveSpend` against their shared $20 month
  (`remainingCategoryUsd`), and every category is bounded by the $100 total.
- **Identities.** Only HMACs are stored: trial ids and Google issuer and `sub` under
  `IDENTITY_HMAC_SECRET`, network identities under `IP_HMAC_SECRET`. Both are required
  (at least 32 characters; `pnpm services:setup` generates them into `.env.local`),
  and AI stays off without them. An account's quota key is
  the anti-abuse HMAC(issuer, sub), so its usage survives account deletion and
  returns on re-registration.
- **Roles.** `aviation_app` admits and settles interactive requests; it cannot change
  or delete ledger lines or flip the kill switch. `aviation_ingest` reads, reserves
  and settles indexing and evaluation spend only (row-level security). It gets the
  cross-category monthly totals for the shared budget from `spend_totals()`, which
  returns sums only, and has no access to interactive rows (principal HMACs, fencing
  tokens) or to quota, trial and abuse records. Triggers stop every role,
  the schema owner included, from rewriting ledger lines or reopening a reservation.
- **Status and retention.** `aiStatus` returns `available`, `signed_in_only` or
  `paused`, a coarse reason, a retry time only when it is known, and the principal's
  own remaining searches, never amounts. While a request of the principal is in
  flight, only global pauses are reported. `pruneControls` deletes idempotency records
  after 24 hours, buckets and anti-abuse records after their window plus 7 days, trial
  identities after 30 days, redeemed Turnstile tokens after 15 minutes, AI briefs once
  they expire (24 hours), and ledger lines and closed reservations after 90 days. The API server runs `expireLeases`,
  `failOrphanedSteps` (brief steps whose process died) and `pruneControls` itself
  about every 10 minutes, under a PostgreSQL advisory lock
  (`server/quota/maintenance.ts`; the app role already holds the grants);
  `pnpm worker prune-controls` runs them once by hand.

The kill switch pauses interactive AI only. Its second flag is the login-required
emergency mode (DESIGN §7): anonymous trials are refused (admission `login_required`,
403; status `signed_in_only` with reason `login_required`) and signed-in AI goes on.

```sh
pnpm worker ai-switch                                   # show both
pnpm worker ai-switch --off --note "<why>"              # pause (reason: maintenance)
pnpm worker ai-switch --on
pnpm worker ai-switch --anonymous off --note "<why>"    # login required
pnpm worker ai-switch --anonymous on
```

### Anonymous gate and AI status

`server/identity/` admits anonymous visitors to AI (DESIGN §7–§8); `server/ai/runtime.ts`
builds it at startup with the provider check and the quota policy, and lists in the
log what keeps any part off (setting names only). The tables are in migration 0013.

- **Gate.** An AI route calls `ctx.ai.gate.check(request, reply, body.turnstileToken)`
  before `admitPaidRequest` for a visitor who is not signed in, and sends a refusal
  with `sendGateRefusal`. In order, and before any reservation, quota or spend: the
  login-required mode (403 `sign_in_required`); availability for the cookie's trial or
  a new visitor, from `aiStatus`, before any token work: the kill switch and budgets
  (503 `ai_paused`), a used-up trial (429 `trial_used`) and the anonymous share (429
  `free_searches_paused`), so such a request never claims a token or creates a trial;
  a token is required (403
  `challenge_required`) and claimed once under a keyed HMAC, so a reused token is
  refused without calling Cloudflare (403 `challenge_failed`); Cloudflare's siteverify
  checks it with an idempotency key, and the server requires the hostname of
  `APP_URL`, the action `ask-ai` (`TURNSTILE_ACTION`) and a challenge at most 5
  minutes old (403 `challenge_failed`). An unreachable, slow (4 s per attempt, two
  attempts with the same idempotency key) or failing siteverify is 503 `unavailable`
  (fail closed). Then the visitor's trial comes from the cookie, or, the first time,
  a trial is created and its cookie set. A failed check never creates a trial or
  sets a cookie. The pass carries the trial principal and the network identity for
  admission.
- **Trial cookie.** A random 32-byte value with an HMAC-SHA256 signature
  (`v1.<value>.<mac>`, base64url), keys derived from `IDENTITY_HMAC_SECRET` with HKDF,
  one per purpose. HttpOnly, SameSite=Lax, Path=/, no Domain; Secure and named
  `__Host-aviation_trial` when `APP_URL` is https (required in live), otherwise
  `aviation_trial` for local http. Max-Age is the trial's remaining 30 days. Only an
  HMAC of the value is stored (`trial_identities.cookie_hash`); a malformed, tampered
  or expired cookie is ignored as if absent. Responses that set it are `no-store`.
- **Creation limits.** New trials are capped at 5 an hour and 10 a day per network
  identity (its HMAC; IPv6 per /64) and 500 a day in total
  (`TRIAL_CREATION_LIMITS`); over a cap the gate answers 429 with `Retry-After`.
- **Turnstile keys.** `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`; without both,
  anonymous AI is off. `pnpm services:setup` writes Cloudflare's public test keys to
  `.env.local` when none are set: every check passes, the widget's fixed dummy token
  is accepted repeatedly (other tokens stay single-use) and the hostname and action
  checks do not apply. `APP_ENV=live` refuses test keys, mixed test and real keys, and
  an http `APP_URL`.
- **`GET /api/ai/status`** (UI_DESIGN §5) reads the trial cookie and `aiStatus`:
  `state`, a `reason` (paused: `daily_budget`, `monthly_budget`, `maintenance`,
  `dependency`, `daily_cap`, `monthly_cap`; signed in only: `trial_used`,
  `anonymous_share`, `login_required`), `retryAt` only when known, and `remaining`
  (`{kind: 'trial', left, limit, started}`, `started` once the browser holds a trial,
  or the account's day and month counts). It never carries amounts and never sets a
  cookie. It reports `paused`/`dependency` when the provider check, a language-model
  provider, the quota secrets, quota storage, an evidence index (the active manifest
  names no passages index, or evidence retrieval is not bound or refuses it) or (for
  anonymous visitors) Turnstile are missing.

### AI briefs

`server/briefs/` runs a brief (DESIGN §2, §5; UI_DESIGN §4.3–§4.6): one question plus
at most three refinements, each a step through the anonymous gate, admission, and
the pipeline (`pipeline.ts`, `runBriefStep`):

1. **Scope** (10 s): the planner's intent. Anything but a case search ends with a
   static reply from server templates (`static-replies.ts`; clarification readings
   from `clarify.ts`, never model text) and gives the free search back.
2. **Retrieve** (8 s): the `EvidenceRetriever` port (`evidence.ts`; at most 6 cases
   and 12 passages, query-embedding usage reported through a callback), bound to
   [hybrid retrieval](#evidence-retrieval-hybrid-search) in `retriever.ts`. The bundle
   is then checked, fail closed: every passage against its canonical `passages` row
   under the chunker of the served index's passages contract (v1 or v2, as the port
   reports it; id derivation, section kind, scope, aircraft, offsets) and section revision
   (`resolvePassage`), at most 6 cases and 12 passages, and every case holding its best
   retrieved passage and all its probable-cause passages. A violation fails the step;
   nothing is dropped or cut.
3. **Compose** (35 s): the full input is counted with the provider's own counter;
   above the answer input cap (28,000 tokens; a synthetic full bundle measures 22,547,
   DESIGN §9) the candidates are packed again under a smaller budget, and the re-packed
   bundle is checked like the first. The compose and check stages read passages under short
   aliases (`P1`..`P12`, `aliases.ts`): a 64-character passage id costs about 42 tokens
   wherever a model reads or writes it. The composition is validated against the
   aliases (any other id fails as `unknown_passage`, or as `gap_foreign_passage` in a gap
   note; an alias of the bundle in the summary, a `why` line or a gap note fails as
   `alias_in_text` unless the reader's question or a passage of the bundle uses the same
   complete token, so "P210", "P2.5", "J1/P1" or a taxiway the reader named stays) and only then
   mapped back to canonical ids.
   The answer model may abstain
   (`no_supported_match`): the case cards and its checked gap notes are shown, with
   server copy saying that none of the retrieved cases supports the question as asked
   (not that no such investigation exists); it counts as a search.
4. **Validate**: `validateComposition` (`validate.ts`, rule `quote-ws-v2`: a quote of at
   least three words is a substring of its passage after collapsing whitespace runs on
   both sides; it resolves to at most 600 code units of source text, shown whole; UTF-16
   spans through an offset map; the first of repeated matches is used and the count
   recorded; every claim cites passages of its own case; every summary sentence ends
   with the `[[case:…]]` markers of the cases it is about, immediately before or after
   its final punctuation (`uncited_summary` without one, `misplaced_citation` with one
   mid-sentence). The summary check withholds what it cannot split (`sentences.ts`),
   because a split can only withhold while a merge could let an uncited sentence borrow a
   citation: the summary uses an allow-list of characters (printable ASCII except
   Markdown and decoration, `“ ” ‘ ’ – — ° ± × ½ ¼ ¾ §` and Latin-1 letters with
   diacritics; HTML entities fail too, `summary_format`), so only `.`, `!` and `?` can end
   a sentence and U+0020 is the only space; a sentence ends at a run of `.`, `!` or `?` (with any
   closing quote or parenthesis) before whitespace or the end of the text, markers
   after the punctuation included, and a period is not an end only in six declared
   contexts ("No. 2", "approx. 5", "Mr. Smith", "U.S. operator", "49 U.S.C. 1154",
   "e.g. a school", an accepted residual); no other `.`, `!` or `?` may remain inside a
   sentence except a decimal point (`ambiguous_boundary`), so "1,000 ft.", "St. Louis",
   "a.m." or ".3" withholds the summary (the compose prompt asks for words written out);
   each stated
   chronology fact (compose v6: the relevant maintenance named once, each fact with its
   anchor, relation, value and bound, and passages; `chronology_shape` when a fact's parts
   do not fit its relation) cites its own passages, with one decimal place for flight
   hours and whole days; every NTSB-number-shaped token in generated text must be
   allowlisted). Then the reader's criteria in code (`criteria.ts`, the timing rules
   `chronology-rules-v1`, DESIGN §3: only facts from the relevant maintenance decide,
   bound-aware; "the day before" and "immediately before" are calendar dates, never
   hours; the first flight never settles a window; an approximate value or wording
   without a number decides nothing; a presented case outside the criteria withholds the
   summary). Every decision is then a server-template claim, including "under the timing
   rules, the supplied passages of this case do not settle whether…", so a fact the
   composition left out settles nothing. The check stage (`check.v5`, 45 s; Haiku 5.5
   with adaptive thinking, the configuration the checker calibration froze, below) gives
   every claim, by its server-issued id, exactly one verdict (`supported`, `contradicted`
   or `not_established`) against every verified passage of each case. Code judges the
   answer (`verdicts.ts`): only a `supported` verdict for every claim, naming passages the
   claim cites (none for an absence claim, which cites every passage of its case), shows
   the summary; a missing, duplicate or unknown id, an invalid passage or quote, and any
   other verdict withhold it (`CHECK_CODES`), and a contradicted "do not settle" claim is
   recorded as `chronology_missed`. A check input over its cap withholds too (recorded in
   the step's `meta`, the evidence never cut to fit). A case whose passages do not settle
   a criterion is shown labelled unconfirmed, on its card and its summary citations: this
   analysis could not establish it from the supplied passages. There is no repair loop.
   A withheld summary is diagnosable: the step's `meta` lists each validation reason
   with its path (`summary.2`, `cases.1.why`) and the summary's sentence count, the
   judged check's codes per claim id, the criteria's rules and reasons, and each stage's
   stop reason; the rejected composition itself is kept
   server-side with the checker's verdicts (`brief_steps.diagnostics`, migration 0016;
   never in a response, trace or log; deleted with the brief by the maintenance pass after
   it expires) for `pnpm worker brief-diagnose` (docs/OBSERVABILITY_AND_EVALUATION.md).

The step has a 90-second deadline. Every stage enforces its own input cap with the
provider's counter. Stage results are written as they complete (`brief_steps`), and
only stage status and counts are visible until the end. Each stage's usage is settled
as itemized ledger lines with one request id; a call without reliable usage (timeout,
abort) settles the full reservation as uncertain. Scope replies (settled before they
are sent), empty results and failures before any spend give the free search back;
withheld summaries, abstentions, cancellations and failures after spending keep it.
A step still running 150 s after it started has lost its process: it reads as failed,
no longer blocks a refinement, and the maintenance pass marks it failed once its
reservation is closed. Closing the server runs within one 9 s deadline (the process
exits by force at 10 s): first, before the HTTP drain, running steps are aborted (they
fail and settle), paid requests still in the gate, admission or step creation are
refused with 503 `unavailable` (an admission is given back and settled at zero) or
stop before any provider call, and closing waits for both; requests that arrive
meanwhile get 503 `unavailable`. Then Node's `server.close()` closes idle keep-alive
connections, responses sent while closing close their connection, and anything still
open at the deadline is closed. The keep-alive timeout is 95 s, above the Cloudflare
Tunnel connector's 90 s idle timeout to the origin.

Paid requests check, before any token work or spend: a cross-site request (by
`Sec-Fetch-Site`, or `Origin` when the browser sends no fetch metadata) is 403; the
body is strict; a question (with the text refinement in effect) over the query
embedding cap is 400; AI must be able to run (503 `unavailable`; a refinement on the
evidence index its brief is pinned to); a refinement needs the read owner, a free
refinement slot (409 `refinement_limit`) and no running step (429 `in_flight`).
Admission (`admitPaidRequest`) then applies the kill switch, rate limits, the monthly
budget and the paced daily allowance (at most $3, counting every open reservation),
the quota, the anonymous share and concurrency, and reserves the request's maximum
cost. Admission refusals map to `trial_used`, `quota_exhausted`,
`free_searches_paused`, `ai_paused`, `rate_limited`, `in_flight` and `conflict`; a
trial that expired since the gate asks for a new check (403 `challenge_required`).

`POST /api/briefs` waits for the scope stage only: a static reply comes back at once
(200 `scope_reply`), an in-scope question answers 202 `started`, and the page polls
`GET /api/briefs/:id` (its own limit of 150 a minute per network identity). Briefs
belong to their read owner (the trial in the cookie; 404 for anyone else), pin the
generation and passages index they started on, and expire after 24 hours. The app
role cannot update a brief: the read owner moves once, from a trial to an account,
through `move_brief_read_owner()` (compare-and-set, for the sign-in handover). A
step's billing principal, reservation and request never change, and a finished step
is immutable. Migration 0014 holds the tables, guards, grants and retention; 0015 adds
the `no_match` step status; 0016 the server-side `diagnostics` of a withheld step.

**Evidence binding** (`retriever.ts`, wired in `server/main.ts` with the OpenAI query
embedder):

- The dense channel embeds the question (with the text refinement in effect); the
  BM25 channel searches the scope stage's `keywordText`. The routes refuse a question
  over the 1,000-token query cap before any spend; `fitQueryText` (the longest prefix
  that fits) remains as a fallback.
- The query embedding is settled exactly once, from retrieval's `onQueryEmbedding`
  callback, which runs before any search: an Elasticsearch, packing or provenance
  failure afterwards keeps that one `embed` line, and `billing: uncertain` settles
  the step at its full reservation. A failed embedding is settled by its
  `QueryEmbeddingError` billing (`none`, the billed `usage`, or `uncertain`); an
  embedding aborted mid-request (cancel or deadline) is `uncertain`. A usage callback
  arriving after `retrieve` returned or threw is ignored.
- A re-pack for the compose cap packs the same candidates again; nothing is embedded
  twice.
- Failures become a `RetrievalFailure` with a fixed kind (`unavailable`, `timeout`,
  `failed`) and reason (`index_mismatch`, `incomplete_search`, `embedding`, …) in the
  step's `meta`; the underlying message (index names, contract values, upstream text)
  is dropped.

AI is available only while the dataset reports the active passages index servable
(`PinnedDataset.passages`, the passages contract for `OPENAI_EMBEDDING_MODEL` and
`OPENAI_EMBEDDING_DIMENSIONS`) and the retriever accepts it. Otherwise, or without
`OPENAI_API_KEY`, or when no dataset can be served at all, the brief routes answer 503
`unavailable` and `GET /api/ai/status` reports `dependency`, never saying why.

## Deployment with Docker Compose

`compose.yaml` runs the application once per environment, as Compose projects
`ai-aviation-dev` and `ai-aviation-live` (`APP_ENV`), connected to the shared
PostgreSQL, Elasticsearch and Langfuse through their Docker networks. Each
environment has its own database (`aviation_dev`, `aviation_live`) and logins,
index prefix (`ai-aviation-dev`, `ai-aviation-live`) and Langfuse project
(`aviation-dev`, `aviation-live`). It runs no database or search engine itself;
`pnpm provision:shared` creates an environment's roles, database and API keys on
the shared servers and writes its connection files outside the repository.

- `aviation-app` (profile `app`): the API and web client from the multi-stage `Dockerfile`
  image `ai-aviation/app:${APP_VERSION:-dev}`; non-root, read-only root, no
  capabilities. Dev publishes `127.0.0.1:${PORT:-3000}`; tunnel mode publishes
  nothing.
- `aviation-ingest` and `aviation-migrate` (profile `tools`): the same image running the worker CLI
  one-shot with the ingestion or migrator database role; `extract-image` builds
  the extraction image.
- `tunnel` (profile `tunnel`): the pinned Cloudflare Tunnel connector, sharing only
  the `edge` network with `aviation-app`.

It needs Docker Compose 2.24 or later. `live` always runs behind the Cloudflare
Tunnel with an explicit `APP_VERSION`, and only peers in its pinned edge subnet
are trusted as proxies (`TRUSTED_PROXY_CIDRS`).

Configuration comes from env files outside the repository, named in
`AVIATION_ENV_FILES`; Compose uses them for interpolation only and each container
gets just the variables it needs. `compose.tunnel.yaml` removes the app port and
`compose.tracing.yaml` joins the shared observability network.

```sh
export AVIATION_ENV_FILES=<connection files and app secrets, comma-separated>
pnpm app:migrate          # schema migrations
pnpm app:up               # build and start (tunnel mode when TUNNEL_TOKEN is set)
pnpm ingest generations   # any worker command, in a one-shot container
pnpm app:ps               # this environment's containers
pnpm app:down
```

The [runbook](docs/RUNBOOK.md) covers provisioning, the role model, each container's
credentials, the networks, tunnel and tracing modes, ingestion and the
local-services mode.
