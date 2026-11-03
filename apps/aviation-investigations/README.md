# AirCase

AirCase, an aviation casebook, finds and compares NTSB aviation investigations using
their evidence, findings, and probable causes. For flight instructors preparing
case-based lessons and safety analysts exploring similar events.

The product was named Aviation Casebook until 2026-10-24 (UI_DESIGN §10). Only the name
users see was changed: the directory `apps/aviation-investigations`, the package name
`aviation-casebook`, database and index names, Compose projects, environment variables
and the `casebook-*` keys in browser storage keep their names.

**Status: Experimental.** Keyword search, case pages and the dashboard are live on the
dev environment (API server, web client, container deployment, trial identity and AI
status). The evidence view is implemented, server and interface (the interface tested
against the mock API); a run of the two together with AI on, and the view's narrower G6
clearance, remain pending. Generated summaries stay disabled.
The live deployment is at `https://aircase.app` (public, with Google sign-in and the
published privacy notice; AI features are not enabled yet).

- [Implementation design](docs/DESIGN.md): TypeScript stack, retrieval, UI,
  authentication, cost controls, deployment, and delivery milestones.
- [Interface design](docs/UI_DESIGN.md): visual language, screens, states and
  copy, night mode, phone layout, print, and accessibility.
- [Tracing and evaluation](docs/OBSERVABILITY_AND_EVALUATION.md): Langfuse dashboard,
  TypeScript experiments, development/production workflows, and privacy boundaries.
- [Data assessment](docs/DATA_REVIEW.md): measured archive contents, schema traps,
  real cases, and dashboard opportunities.
- [Snapshot importer](docs/IMPORTER.md): disabled-by-default scheduled acquisition,
  certification, artifact spending cap, recovery and installation gate.
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
PostgreSQL 16.2 (the shared server's version, so the integration tests run on the
version the deployments use) and Elasticsearch 9.5.5 (single node, security on,
2 GB heap, ML disabled). Both bind to loopback only, for development; HTTP TLS is
disabled for this local profile. Ports come from `POSTGRES_PORT` (default 55432)
and `ELASTICSEARCH_PORT` (default 59200). A PostgreSQL data directory cannot be
reused across major versions: a volume another major version made has to be removed
once (the [runbook](docs/RUNBOOK.md#local-services-mode) says how).

```sh
pnpm services:up      # generate bootstrap passwords, start services, wait until healthy
pnpm services:setup   # roles, databases aviation_dev and aviation_test, scoped API keys
pnpm db:migrate       # aviation_dev (the integration tests migrate aviation_test)
pnpm test:integration
pnpm test:pg16        # the same suite after checking the server is PostgreSQL 16
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
connect only to its own database and cannot grant itself access to another.

`pnpm test:pg16` runs the integration suite on PostgreSQL 16, the shared server's
major version. The local PostgreSQL is 16.2, so it is the same run as
`pnpm test:integration` (which migrates `aviation_test` through every migration),
preceded by a check that the test database's server is PostgreSQL 16; it refuses
to run on another major version. The command keeps its name from the time it
started a throwaway 16.2 container (profile `pg16`, `POSTGRES16_PORT`), which no
longer exists, so that existing instructions keep working.

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

The canonical corpus lives in PostgreSQL (16.2 on the shared server and locally;
`MAINTAIN` grants are version-guarded for later servers). The Drizzle schema is in
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

**Connection timeouts** (`server/db/client.ts`). Every PostgreSQL pool and client the
app, the worker and the tools open has a finite connect timeout. For a pool it bounds
both opening a connection (an attempt that stalls in the handshake is cut off and its
slot freed) and waiting for a free one (the acquisition fails, also while the pool shuts
down), so a server that accepts TCP and never answers cannot hold a slot, the queue or
`pool.end()`. It is 5 s for the API's pool, every tool's pool and every single client
(migrations, provisioning, the evaluation readers), and 120 s for the worker's pools,
whose long locks and snapshot streams are sized never to queue an acquisition.
Request-path reads keep their own, shorter bound (the cases index lookup: 2 s).

- **Dataset generations.** Every load writes a new generation in one transaction:
  it inserts the generation as `loading`, inserts every row, records its ingestion
  run as `succeeded` and seals the generation (`loaded`) before committing. A
  failure rolls all of it back and the run is marked `failed`, leaving earlier
  generations untouched. Primary keys start with `generation_id` and foreign keys
  are composite, so rows only reference rows of their own generation.
- **Sealing.** Database triggers reject any insert or update of corpus rows whose
  generation is not `loading`, for every role including the schema owner, and any
  delete too, except in a session that has set `aviation.pruning_generation` to that
  generation, as `prune_generation` does in its transaction. Any session may set it,
  so the owner could delete a sealed generation's rows by hand; the runtime roles hold
  no DELETE on the corpus. `aviation_ingest` can only insert corpus rows; it cannot update or delete
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
  sealed, last verified and last indexed (an index build whose index still exists)
  more than 24 hours ago (configurable), so a load that committed late or a
  generation awaiting its indices or their publication stays. `loading`, active and
  pinned generations are never deleted, nor generations that an unexpired AI brief
  cites (`generations_cited_by_live_briefs()`, migration 0021: a brief's later steps
  read its generation for up to 24 hours). `pinGeneration`/`unpinGeneration` write
  `generation_pins` (an index build's pin, or an operator's) only through
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
  retained), are used by no unexpired AI brief, and have no pending or unknown switch
  attempt (a committed one does not keep an index the alias has since moved away from). Every
  candidate is rechecked just before deletion while holding its build lock (free),
  its alias lock and the lifecycle lock. A deletion is recorded as requested before
  Elasticsearch is asked; from then on no brief, publication or alias switch takes the
  index, and a later `--yes` run completes a deletion an earlier one could not confirm
  (docs/DATA_PIPELINE.md, 2.10). `worker index cleanup-builds --older-than
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
  several aircraft in the 2026-10-16 snapshot). The Phase facet counts and filters on
  each aircraft's defining phase group, the nested `aircraft.defining_phase_group`
  (inside the same nested clause as any other aircraft filter), so its `blank` bucket
  counts events with an aircraft that has no defining phase; the top-level
  `defining_phase_groups` lists every aircraft's group (140 US events have several).
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
the brief is pinned to (`EvidenceQuery.dataset`: the active manifest's for a new brief, the
brief's own for a refinement) and refuses (`RetrievalUnavailableError`) when there is
none or when the index breaks the passages contract
(`server/search/passages-contract.ts`; the same check `worker publish` and the API's
dataset loader use). The contract is checked before the query is embedded, within
the request's deadline. There is no keyword-only fallback for AI answers.

**Retrieval versions** (task 10e, `server/search/retrieval-config.ts`). How retrieval
works is one frozen configuration per version, chosen by `AVIATION_RETRIEVAL_VERSION`
(empty: `retrieval.v2`), logged at start, recorded in every brief step's
`meta.retrievalVersion` and on its `brief.retrieve` span, and named (with the
configuration's sha256) in evaluation reports. Index mappings do not depend on it.

| Version | What it does | Status |
| --- | --- | --- |
| `retrieval.v1` | passage BM25 and passage kNN, 50 passages each (kNN `num_candidates` 200), passage-level fusion, cases at their best passage | the rollback: the behaviour before task 10e |
| `retrieval.v2` | passage BM25 (200), passage kNN (200, `num_candidates` 800) and BM25 over the cases index's narratives (200 cases), fused at case level; cases no passage channel returned are mapped to their own passages | the default (task 10d's `c200+n-kt`) |
| `retrieval.v2-nf` | `retrieval.v2` with `findings_text` in the cases channel | experimental: `dev` only, `live` refuses it |

Every version searches the scope stage's keyword text with BM25 and embeds the
question (with the text refinement in effect); packing is the same. The bullets below
describe `retrieval.v1`'s stage 1 and both versions' filter and packing; the
case-level stage 1 follows them.

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
  4 × k) each return `perChannel` passages (50 under `retrieval.v1`, the rollback this
  paragraph describes; the evaluation also runs 100; `retrieval.v2`, the default, runs
  200 a channel, below).
  Reciprocal rank fusion in TypeScript (`sum 1/(60 + rank)`) and deduplication to
  cases at their best passage give the case ranking.
- **Stage 1 under `retrieval.v2`** (`server/search/case-retrieval.ts`). Both index
  contracts are checked before anything is embedded: the passages contract, and the
  cases index the manifest of the brief's generation pairs with its passages index
  (same generation, and `cases-v3`, the version the validation covered; `cases-v2`
  makes AI retrieval unavailable). The manifest lookup is a bounded read
  (`server/db/bounded-read.ts`: acquisition and statement within the retrieval's
  lookup bound and its cancel, a server-side `statement_timeout`, and a connection that
  may still run a statement is destroyed, never returned to the pool); a lookup that
  fails or times out fails retrieval (`cases_index_lookup`) before anything is
  embedded. The step records the cases index it read (name and version) in its private
  `meta.retrieval`. The query embedding, passage BM25 and the cases channel start
  together; kNN starts when the vector arrives. A failed
  search aborts the other searches but never the paid embedding, which is awaited and
  settled exactly once before retrieval fails; a failed or incomplete channel always
  fails retrieval (no bundle from the other channels).
  - **The cases channel** (`server/search/cases-channel.ts`) is BM25 over
    `probable_cause`, `analysis` and `factual` of the cases index. Its filter reaches
    exactly the cases the passages filter can (US, answer-eligible, with aircraft
    rows; event facets and years as the passages compiler emits them; the passages
    contract's aircraft semantics on the nested `aircraft`, never keyword search's
    "some aircraft matches"). It only nominates cases: its hits carry no text. A case
    scores by its best single field (`best_fields`).
  - **Cutoffs.** Both BM25 channels sort by `_score`, then `passage_id` or `ntsb_no`,
    inside Elasticsearch, so equal scores at the 200th place are decided by the id
    while the top 200 are collected, not by Lucene's document order. kNN is
    approximate discovery: its set and scores belong to one index state (HNSW, int8
    quantization per segment), and no sort applies to it.
  - **Fusion** (`server/search/case-fusion.ts`): each channel's returned hits in a
    total order (score, then id), collapsed to unique cases, then reciprocal rank
    fusion over the case lists, compared as exact fractions, with a total tie order
    (best rank, the ranks channel by channel, the case number). Each case's passages
    follow exact passage-level fusion of the two passage lists. Fusion is exact over
    what the channels returned; with the kNN's approximation it is reproducible for one
    index state, not across rebuilds.
  - **Mapping** (`server/search/case-mapping.ts`): each of the leading 12 cases that
    no passage channel returned gets its best 3 passages by the same in-memory query
    vector, under the passages filter, case by case: the count `n` of its passages
    first, then an exact kNN that returns all `n` (`k` = `num_candidates` = `n`), cut
    to the best 3 by score, then passage id. An answer that is not exactly those `n`
    passages of that case, each once and scored, fails the whole retrieval
    (`IncompleteSearchError('mapping')`); the first failed mapping request cancels the
    others. A case is reported unmapped, and never packed, only when it has no
    passages under the filter (`no_passages`) or more than 1,000, the mapping-size
    limit (`too_many_passages`; the largest `dev` case holds 63). A re-pack reuses the
    mapped candidates: nothing is embedded or mapped twice.
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

The experiments' `applyRule` ranks qualifying variants by the improvement on each
variant's own declared target metric (task 10e); phase A's variants all declared
narrow Recall@20, so its selection is unchanged. Its zero comparisons (the rule's lower
bound and the pool recommendation) count a bound within 1e-9 of zero as zero, as Track N
does (`PREREG.md`, amendment 2). Re-scored offline from phase A's saved dev and holdout
runs, no conclusion changes. Case-level fusion in the experiments
uses production's comparator (`exactRrf`: exact fractions, the same total tie order),
with fractional channel weights scaled to integers (at most six decimals), so a
variant orders tied cases exactly as the adopted code would; a case-level variant
needs an integer RRF constant.

```sh
pnpm eval:retrieval:experiments preflight                  # free: target, contract, frozen identity, labels re-derived, filter consistency
pnpm eval:retrieval:experiments scope                      # free dry run: scope-stage input tokens and reservations per question
pnpm eval:retrieval:experiments scope --confirm-cost       # take the scope samples, every attempt reserved on the ledger
pnpm eval:retrieval:experiments dev --scope-samples <file> --confirm-cost       # every variant on dev, diagnostics, the rule
pnpm eval:retrieval:experiments holdout --dev-results <file> --confirm-cost     # once: the selected configuration against the baseline
```

`--keys-file <file>` reads only `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` from a dotenv
file and never replaces a nonempty process value.

**Adoption validation** (`evals/retrieval/adoption/`, task 10e). `retrieval.v2` (and the
experimental `retrieval.v2-nf`) against `retrieval.v1` through the production stages,
on phase A's frozen target and the coded development questions only, with phase A's
cached scope samples: identical keyword texts, filters and query vectors for every
arm, under the evaluation filters and under the scope stage's own filters as the
pipeline resolves them. It reports narrow Recall@20 and broad P@6/nDCG@6 with paired
group-bootstrap intervals, per-question changes, delivered coded cases by the channels
that brought them, and the regression cases (`REGRESSION_CASES`). `load` measures
p50/p95/p99 over individual requests through the production binding at up to 8
concurrent requests, with a cold pass, cancellations, injected search failures while
the embedding is in flight and the mapping at its bound. Read-only; the only paid
step is one embedding per question (refused above $0.10 in all), and `dev --vectors
<file>` reuses the query vectors an earlier run saved (no paid call). Both reports
name the target they read (generation, both indexes with version and fingerprint).
The load test's limits: the arms run in consecutive blocks per concurrency, not
interleaved, so cluster noise during one block is attributed to its arm; "cold" is the
first pass of a fresh process, each distinct request once, with the remembered index
checks forgotten once per arm (only an arm's first request checks the indexes cold;
Elasticsearch's and the OS caches stay warm); and no measured request tail includes a
mapping (the dev questions never map; the mapping at its bound is timed apart).

```sh
pnpm eval:retrieval:adoption preflight --scope-samples <phase A dev scope file>             # free: target, labels, filter parity
pnpm eval:retrieval:adoption dev --scope-samples <file> [--phase-a <dev run>] --confirm-cost # embed (about $0.00001), run every arm
pnpm eval:retrieval:adoption dev --scope-samples <file> --vectors <file from dev>          # free: the saved vectors again
pnpm eval:retrieval:adoption load --scope-samples <file> --vectors <file from dev> [--embed-delay-ms 200]
```

**Narrative-relevance track** (Track N of the task 10c protocol, `evals/retrieval/narrative/`).
It measures what the codes cannot express: negation, maintenance chronology, causal
uncertainty, pilot-versus-investigator attribution, paraphrases, multi-aircraft events
and aircraft filters. Its scores are **model-judged**: two judges from different providers
grade each case against the question's written rubric, and an adjudicator settles their
disagreements. Nothing is expert-adjudicated, and no label waits for a person.

- **Questions** (`questions.ts`, built into `dataset.json` by `build`): 25 development
  benchmark questions in 21 families, and one diagnostic question (below), each with
  filters, a type, a lure for hard negatives and a rubric that defines grade 2 (relevant),
  1 (partially relevant) and 0 with edge cases.
  Rubrics and prompts decide in a fixed order: first what is stated (a condition the
  record states and then contradicts is not stated; the later or more specific finding
  stands), then grade 2 when every condition is stated, then grade 0 when the record
  states the contrary the rubric's grade 0 names (unless its grade 1 names that
  situation), then grade 1 when its description fits, otherwise 0. Intervals keep their
  clock (flight, Hobbs, tachometer or engine hours, never converted or worked out from
  days or flight counts): an hour window holds when one clock gives the interval inside
  the limit (or the first flight after the work has a stated flight time inside it) and
  no clock gives more; clocks that disagree, or that give no interval, are partial. Six
  are **bounded cohorts** (their filters reach 82 to 107
  answer-eligible cases, 581 in all), judged completely so Recall@20 is defined;
  paraphrases keep their family's rubric and judgments. Questions were written from
  general knowledge, with filters chosen from aggregate cohort counts only.
- **Judge input** (`evidence.ts`): the case's complete record from PostgreSQL (every
  narrative section and variant with its revision and scope, the coded findings and
  occurrences by row identity, header facets as descriptions with their codes), checked
  against the stored hashes and fingerprinted by content. Cases above 12,000 `cl100k`
  tokens are judged part by part with carried notes and a consolidation step; nothing is
  truncated, and an uncovered case is `unknown`. Bundle answerability reads the passages
  a retrieval bundle delivered under the case header, which identifies the case and its
  aircraft but is not evidence: only a delivered passage, quoted, establishes a condition.
- **Judges** (`config.ts`, `clients.ts`, `judging.ts`): `claude-haiku-5-5` (adaptive
  thinking) and `gpt-5.6-luna` (reasoning effort low) grade independently, blind to method
  and rank; `claude-sonnet-5-5` adjudicates a disagreement after recording its own blind
  grade (cached on its own, so a budget stop never makes a later run buy it again), and
  may abstain. Quotes are checked with the brief validator's quote rule (`quote-ws-v2`)
  against the stored text; an invalid output gets one retry, then is unjudgeable.
  Unresolved pairs stay `unknown` in every denominator. Every request format, the output
  schemas and the facet vocabularies the header renders are hashed into each cache key
  (the vocabularies into every fingerprint too), and a test pins the hashes to their
  version strings (`identity.ts`). The OpenAI client is evaluation-only, outside the
  production provider path.
- **Calibration** (`calibration.json`, labels frozen by hash; `criteria.ts`): 60
  code-reading items (Track C questions with the codes visible) and 142 synthetic
  narrative controls for negation, chronology (both hour windows at and just past the
  limit, clocks that disagree, first flights with and without their flight time),
  pilot versus investigator, cross-aircraft attribution (with aircraft-scoped sections),
  causal uncertainty, answerability (bundles that support less or more than the complete
  record) and long records judged in parts, most of them needing reading rather than a
  lookup of a rubric edge case. The records' filler never describes the accident, and
  their coded rows, analyses and probable causes agree with their narratives. Every
  family has at least 8 holdout items; every label is `constructed`. Configurations are
  chosen on the dev split; the holdout runs once for a frozen configuration and passes
  only when complete and when the frozen criteria hold (accuracy as correct over
  expected, unknown and missing counted wrong). A holdout run records its items, labels
  and configuration in `holdout-runs.jsonl` next to the calibration file (commit it after
  the run), whatever `--out-dir` is used; another configuration on any case already held
  out, or a changed label of an item already run, is refused. **Result (2026-10-23):**
  the configured judges were selected on dev (99 of 99 final labels; `frozen-configuration.json`)
  and the holdout ran once (`holdout-runs.jsonl`): 102 of 103 final labels (Wilson lower
  bound 0.947), judge A 96 and judge B 101 of 103, no failed or unjudgeable outcome, every
  family above its floor, so the frozen criteria pass. The labels are constructed
  (synthetic controls and coded rows): this measures the judges, not retrieval, and is
  never an expert's validation. The calibration cost $0.38 in all.
- **Pools** (`pool.ts`, `inputs.ts`): built through the production retrievers,
  `retrieval.v1`, `retrieval.v2` and `retrieval.v2-nf` (`retrieveCandidatesWith` and
  `fetchAndPack`: exact case-level fusion, the score-then-id cuts in Elasticsearch, the
  individually counted and validated mapping), each version's configuration sha256
  recorded. Every version runs on identical cached inputs: each member's scope-stage
  keyword texts and its query vector, taken once by the paid `pools` run and saved
  (`narrative-pool-inputs-*.json`; `pools --inputs <file>` rebuilds for free). Per family,
  the union of the versions' first 100 unique cases, every bounded-cohort case,
  related-code positives, lure hard negatives (the production cases channel's order), the
  mapping diagnostic's cases and a seeded tail sample, versioned by their complete content
  with every case's evidence fingerprint and each case-level run's mapping outcomes
  (which leading cases needed the mapping, mapped or not). `pools` freezes the pool
  identity in `frozen-pools.json`, which is committed before any judging; relevance and
  answerability judging refuse any other pool file, and a different identity is not
  frozen over the committed one. Pairs are judged in a frozen priority schedule
  (`track-n-schedule-v2`): delivered cases (the mapping diagnostic's included), then
  first-20 cases, then bounded cohorts, then the rest, lure and tail cases last;
  `--stage 1` judges the first three tiers and finishes their escalations. A bounded
  cohort counts for the Recall@20 gate only without unknowns, so stage 1 is rerun until
  no failed pair is left (failed outcomes are never cached).
- **Diagnostics**, reported apart from the benchmark (never in its values, comparisons,
  agreement figures or audit samples): task 10e's regression question
  `per-pilot-decision-cause-weight-shift` (Track C's question, filter and code set with
  a narrative rubric; it runs with phase A's cached scope output, frozen with it, so its
  runs are the ones that showed the regression; pass task 10e's saved vectors with
  `--vectors` to reuse its query vector too), under comparison rules frozen before any
  judging: `retrieval.v2` and `retrieval.v2-nf` against `retrieval.v1` on nDCG@6 (P@6
  and supported P@6 reported), a regression only when the upper bound of the difference
  is below zero, the displaced and admitted cases listed, and the coded values checked
  against task 10e's (65.8% and 25.9%); and the **mapping diagnostic** (labelled,
  forced), because development questions do not reach the mapping (none of task 10e's
  development runs did): each case-level run's first two cases that only the
  cases channel returned are mapped and packed by the production code, and the report
  sets their relevance against the answerability of what was delivered for them,
  including whether a supported bundle rests on a mapped passage or only on the
  attached probable cause.
- **Metrics** (`score.ts`, `report`): Recall@20 on exhaustive bounded cohorts only, strict
  P@6 and nDCG@6 with bounds over unknowns, supported P@6 (relevant and answerable in the
  delivered passages); comparisons bootstrap bounds on each question's improvement
  (jointly over shared unknowns for P@6, cross-endpoint for nDCG@6) and name a better
  method only when the interval clears zero (a bound within 1e-9 of zero, which is
  floating-point residue, counts as zero). Diagnostics: judged coverage (in
  case–question-family pairs, with the distinct investigations behind them), judge agreement
  (kappa with intervals, confusion matrices per tag and grade), candidate code-narrative
  discrepancies (final and per judge), and two disjoint audit samples (an AI audit and a
  non-expert owner audit) stratified by tag, label and agreement class. The report
  refuses judgment files made under another experiment identity, records that no longer
  match the dataset, pool or calibration, and conflicting records; it merges the records
  of resumed runs.
- **Pooled result (2026-10-23)**, a provisional evaluation (`results/pooled-2026-10.json`;
  model-judged, development questions only, never a release evaluation; read it with
  `results/annotations-2026-10.json`). `retrieval.v2` stays the provisional default and
  `retrieval.v2-nf` experimental. The pools hold 4,024 case–question-family pairs (a case
  judged for one question family; 3,494 distinct investigations) in 22 families and 449
  delivered bundles, built through the production retrievers and frozen in
  `frozen-pools.json`. Stage 1 (1,397 pairs) and the answerability of every delivered
  bundle were judged in full. In stage 2 both judges graded the other 2,627 pairs; the
  $12 allocation's cap then stopped the escalations after one, leaving 455
  disagreements unknown: 443 of the 3,893 benchmark pairs (3,368 investigations), none
  in a bounded cohort. A later run on the same frozen pools pays only those escalations
  (about $9.70), because every judge grade is cached.

  On the 25 benchmark questions, `retrieval.v2` improves first-six relevance over
  `retrieval.v1`; improved supported P@6 is unproven, and the pilot-decision regression
  below stands:
  - strict P@6 39.6% against 35.1–35.8%: better (+3.8 to +4.4 points across the
    unknowns; one-sided 95% lower bound +1.4);
  - nDCG@6 49.6–50.1% against 41.0–41.8%: better (+7.9 to +9.1 points; lower bound +3.6);
  - supported P@6 33.6% against 31.1%: +2.4 points, unproven (the one-sided lower bound
    is exactly zero; the two-sided interval is [−0.5, +5.1]);
  - Recall@20 on the five questions whose bounded cohorts hold 1–20 relevant cases
    66.4% against 68.1%: −1.8 points, inconclusive (of the six cohorts, one holds 23
    relevant cases and one none).

  `retrieval.v2-nf` has no demonstrated incremental advantage over `retrieval.v2`: every
  comparison between them is inconclusive, which does not make them equivalent. Against
  `retrieval.v1`, `retrieval.v2-nf` is better on all three precision measures, supported
  P@6 only just (+2.7 points; lower bound +0.3). The intervals condition on the frozen
  grouping, 14 groups of questions joined by the fully relevant cases they are known to
  share; unresolved labels could join more. Treating every unresolved label as a possible
  join leaves 5 groups, under which the P@6 and nDCG@6 advantages hold. That is a
  sensitivity check, not a replacement for the frozen analysis.

  Of the fully relevant cases each version delivered (158, 178 and 179), 88.6%
  (`retrieval.v1`), 84.8% (`retrieval.v2`) and 84.9% (`retrieval.v2-nf`) are answerable
  from their delivered passages. Judge agreement is κ 0.70 [0.61, 0.78] (85.2%) on
  relevance and κ 0.76 (85.3%) on answerability. The tags with κ below 0.7 are negation,
  causal uncertainty, maintenance chronology, mechanical and aircraft filters. The
  unknown-label bounds do not cover erroneous known labels, and agreement and calibration
  support the labels without proving them. The annotations record one agreed-label error:
  WPR23FA044, graded 2 by both judges although both rationales conclude partial
  relevance. It is in no delivered bundle and changes no reported value.

  The pilot-decision regression holds on narrative labels: nDCG@6 is 72.1% under
  `retrieval.v1` and 36.6% under both v2 versions (P@6 66.7% against 33.3%), with the
  same runs in every sample. The three cases the v2 versions displace are relevant and
  coded; of the three they admit, one is relevant, one partly relevant and one not. The
  coded values reproduce task 10e's. The forced mapping result is encouraging but small.
  Of the 118 bundles the mapping diagnostic delivered, 15 are of relevant cases: 13 are
  answerable, one is partly answerable and one is unknown, and every answerable bundle
  rests on a mapped passage, never only on the attached probable cause. It shows neither
  that the mapping is reliable in general nor how often production maps; no ordinary
  retrieval run needed it.

  The audit packet (`results/audit-2026-10.json`) holds the stratified AI and owner
  samples and two targeted selections: 107 pairs of the hour-window families (18
  adjudicated) and 20 pilot-versus-investigator bundles. Three bundles of fully relevant
  cases hold the investigation's finding but not the pilot's report: one is graded 1 and
  two 0, the ambiguity behind the calibration holdout's one miss; supported P@6 counts
  neither grade. The pooled run cost $11.57; with the calibration, the month's total is
  $11.94 of the $12 allocation.
- **Next run.** The 455 escalations resume with the same pools, prompts, model
  configuration, cache and priority order under a fresh bounded allocation, re-planned
  from the measured adjudication cost and at concurrency 3 or lower until the ledger's
  connection pressure is fixed; unresolved outcomes are kept, and a completion report is
  published beside October's snapshot. A revised answerability rubric for
  examination-only bundles is versioned separately (both required sides supported 2; one
  supported and the other absent 1; an explicit contradiction or neither supported 0;
  failed or incomplete judging unknown), with new controls, recalibration and rejudging
  under a new identity, never mixed into the frozen run.

```sh
pnpm eval:retrieval:narrative build --generation 1 --check        # the question set (DATABASE_URL, read-only)
pnpm eval:retrieval:narrative calibration --generation 1 --check  # the calibration sets; refuses changed labels
pnpm eval:retrieval:narrative plan --keys-file <file> --allocation-usd <usd>   # free dry run: inventory, cost, the month's sequence
pnpm eval:retrieval:narrative plan --keys-file <file> --allocation-usd <usd> --measured <dev judgments>   # re-plan from measured output tokens and disagreement
pnpm eval:retrieval:narrative plan --keys-file <file> --allocation <name> --measured <judgments>   # what remains of the month, set against the allocation's spend
pnpm eval:retrieval:narrative judge --set calibration --split dev --max-pairs 1 --max-usd 0.11 --concurrency 1 --confirm-cost --allocation <name> --allocation-usd <usd>   # the canary
pnpm eval:retrieval:narrative judge --set calibration --split dev --concurrency 1 --confirm-cost --allocation <name>
pnpm eval:retrieval:narrative judge --set calibration --split holdout --confirm-cost --allocation <name>   # once; commit holdout-runs.jsonl
pnpm eval:retrieval:narrative pools [--vectors <saved vectors>] --confirm-cost --allocation <name>   # commit frozen-pools.json
pnpm eval:retrieval:narrative pools --inputs <file>   # free: the same pools from the saved inputs (the frozen identity, or a refusal)
pnpm eval:retrieval:narrative judge --set relevance --pools <file> --stage 1 --confirm-cost --allocation <name>
pnpm eval:retrieval:narrative answerability --pools <file> --confirm-cost --allocation <name>
pnpm eval:retrieval:narrative report --pools <file> --judgments <a,b>   # free
pnpm eval:retrieval:narrative recover --allocation <name> --run <id> [--confirm]   # an interrupted run's lock: reconcile, then remove
```

Paid commands print their plan and send nothing without `--confirm-cost`. Each attempt
reserves its worst case on the evaluation ledger (`DATABASE_INGEST_URL`) and settles; a
run stops before a reservation would take its own spend above its limit (`--max-usd`),
its allocation above the cap fixed when the allocation was created (`--allocation`,
shared by the runs of one phase or month, one run at a time), or the ledger below what
remains of the monthly indexing and evaluation allowance. Every paid command
(calibration, relevance and answerability judging, `pools`) holds its allocation's
lock from before its first reservation until its books balance: each paid operation's
charge written to the allocation's log (before the run's own spend log), and no
accounting step failed (a log write, a ledger settlement, a ledger connection's close).
Otherwise the run keeps the lock, sends nothing more, and its error names the `recover`
command. A lock is never removed automatically: a run refuses any existing lock, and
the lock of an interrupted run stays until `recover` removes it. `recover` refuses while
that run's process still runs on this host or one of its ledger reservations is still
within its lease, and takes an exclusive claim, so two recoveries cannot both proceed.
It reconciles the run's ledger charges (settled costs, full reservations of uncertain,
expired and lease-expired ones) with what the allocation's log holds for the run, and
the run's own spend log with them on its own, prints both, and with `--confirm` appends
each log's difference before it removes the lock, so a charge a log already holds is
never counted twice. A budget stop keeps the run's records, and
the judgment cache, shared by every run and allocation, lets the next run (or month)
continue without paying again. A rejected request stops the run: its own attempt is not
billed, but the other judge's concurrent attempts are, so the canary runs one pair with
`--concurrency 1`. The canary is the first dev item in the judge's order; `plan` prints
its cost and the limit that lets one full escalation finish (both judges, the
adjudicator's blind step and decision, each at its caps): about $0.11 on generation 1.
It reaches the adjudicator only if its judges disagree. Outputs, spend logs, allocations
and the cache go to `--out-dir` (default `data/work/narrative`).

### Checker calibration

`evals/checker/` calibrates the evidence checker (Tasks 16c, 16d and 16e, gate G6): which
model, thinking, effort and prompt judge claims well enough to show a summary, and, since
Task 16d, what the display projection would show with that judgement. Every check input is
rendered by the production code from real retrieval bundles, so the checker reads what it
reads in a brief.

```sh
pnpm eval:checker retrieve --questions 16e    # plan only; --confirm-cost embeds the 16 Task 16e questions and writes evidence-16e.json (retrieval.v2 only, with channel ranks)
pnpm eval:checker headers                     # free: the case header of every 16c and 16d calibration case (read-only), into evidence-16d.json
pnpm eval:checker build                       # evidence + items → dataset.v3.json (labels hashed per split, frozen hashes checked); --check compares instead
pnpm eval:checker simulate --write            # free: the 16c and 16d recordings through the current projection → results/16e-simulation.json
pnpm eval:checker excerpts --write            # free: the excerpt-context rule on its labelled corpora → results/16e-excerpts.json
pnpm eval:checker inventory --candidate haiku-think-v9-low --split dev   # free: provider token counts, expected and worst-case cost
pnpm eval:checker run --candidate haiku-think-v9-low --split dev --concurrency 3 --confirm-cost   # paid, charged to allocation checker-16e-2026-10
pnpm eval:checker select data/work/checker16e/dev-*.summary.json     # the frozen selection rule → selection.v3.json
```

All take `--env-files a,b` and `--keys-file <file>` (only `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY` are read from it, never over a nonempty process value). A run is bound
to a manifest (`manifest.ts`: the candidate's complete configuration, the frozen rule
versions, the protocol file's sha256, the dataset and label hashes and the planned
slots), reserves each call's worst case on the evaluation ledger (`DATABASE_INGEST_URL`),
settles it and charges it to the allocation `checker-16e-2026-10` (its log and lock under
`data/work/checker16e/`, one run at a time); a call whose reservation would take the
allocation over $2.50, or the ledger's evaluation allowance below the $12 protected for
another track's allocation, is not sent. `--resume <manifest>` continues only an identical
run. The candidates run the production adapter with the production prompt, schema, caps
and maximum claim count at their own effort; each call's transport timeout (90 s)
measures the latency past the production check timeout, and every figure counts a call
over that timeout as a failed call, as production would. The held-out split runs once,
for the candidate frozen in `selection.v3.json`, and a unit test holds production to
that selection. The 16d runner (`run.ts`, protocol v2) stays as the record.

- **Protocol v3.1** (`protocol.v3.ts`, Task 16e, committed before any paid 16e call and
  before the 16e held-out set existed; amended once, before any checker call (after only
  the $0.000004 embedding of the 16e questions for their evidence), when authoring
  the held-out set showed the ordinal rule reading "had not flown in 22 years" as a
  count): two candidates, `check.v9` at effort `low` and at effort `medium`; the frozen
  rule versions (`quote-ws-v2`, `excerpt-context-v1`, `ordinal-evidence-v2`,
  `chronology-rules-v3`, `display-deps-v2`, `check-judgement-v2`, `checker-metrics-v3`,
  `checker-labels-v3`); the trials per batch; the targets with M4 in the eligibility; the
  selection code; the derivation of the production check timeout from the measured
  latency (1.25 × the slowest development call, 30 to 45 s); the held-out rules and the
  money.
- **Dataset v3** (`dataset.v3.json`; `dataset.json` and `dataset.v2.json` stay frozen):
  every 16c and 16d item is development now (the 16d held-out pilot included), with labels
  v3 (labels v2 and the errata overlay `checker-errata-v1` in `labels.v3.ts`, each
  correction with its source and reason; disputed labels flagged for sensitivity figures).
  The held-out split is new (`items/v3-holdout.ts`, `evidence-16e.json`): the first nine
  `retrieval.v2` bundles of the 16e questions with no case of an earlier split, each with
  a brief as compose.v8 would write it, one-error and two mixed-error variants, reading
  variants and a claim batch (92 batches, 105 trials); its label hash, the development
  label hash and the evidence hash are frozen in the builder.
- **Protocol v2** (`protocol.v2.ts`, committed before any paid 16d call): the complete
  candidate definitions (model, thinking, effort, prompt and its hash, output schema and
  its hash, caps, timeout, maximum claims), the trials per batch, the targets and the
  selection code. `protocol.ts` and `v1.ts` keep 16c's protocol and selection as the
  record.
- **Dataset v2** (`dataset.v2.json`; `dataset.json` stays the frozen 16c set): both 16c
  splits are development now, with the labels corrected in `labels.v2.ts` (each with its
  reason), the 16d context-loss regressions (`items/v2-dev.ts`) and three maximum-size
  inputs (60 claims, for latency and caps, kept out of the accuracy figures). The
  held-out split is new (`items/v2-holdout.ts`, `evidence-16d.json`): nine bundles whose
  cases are in neither 16c split, each with a brief as compose.v7 would write it, one-error
  and mixed-error variants, reading variants and a claim batch; every critical timing
  mutation is in at least two bundles. Labels are `constructed` or `model-reviewed`, never
  expert ground truth; a claim review cannot settle is `unknown`, and a brief with one is
  never wholly supported. `retrieve` runs the configured retrieval version
  (`AVIATION_RETRIEVAL_VERSION`) and records it in `source.retrievalVersion`; both
  committed evidence files predate retrieval versions and were retrieved under
  `retrieval.v1`.
- **Figures** (`metrics.ts`, `checker-metrics-v3` since Task 16e). Verdicts: semantic
  detection per family (failed calls and missing verdicts apart, as blocked output, never
  as detections), false flags by claim kind, critical regressions, `chronology_missed`.
  Display, through the production projection (`display-deps-v2`, `claims` mode, and
  `whole` for comparison): M1 supported claims shown and M2 wholly supported briefs shown
  with minimum useful content, both as answer retention against the static floor (what
  the deterministic rules allow; their abstentions are reported apart) and as displayed
  retention; M3 error claims shown per family, M4 error briefs showing an error, M5
  dependency violations, and the exposure figures. Intervals are clustered by source
  bundle. Latency and output size are reported by claim count and for the maximum-size
  inputs. Run summaries are in `evals/checker/results/`.

**Task 16c result** (2026-10-23, $1.98 of its $3 limit): no configuration met every target.
Eight development runs (Haiku 5.5 without thinking, with adaptive thinking, and Sonnet 5.5
without thinking; prompts `check.v4` to `check.v6`) went through the fallback order, which
froze Haiku 5.5 with adaptive thinking on `check.v5`: every critical regression withheld,
and 91 of the 91 development errors it judged detected (the published "92 of 92" counted
one more error claim whose call failed: blocked output, not a detection; 16c review I2); 7
of 21 supported-brief trials withheld. The held-out split did not confirm it: 17 of 21
supported-brief trials withheld (81%), detection 81 of 86 (attribution 15 of 18).

**Task 16d result** (2026-10-23, $0.76 of its $1.50 limit; summaries in
`evals/checker/results/16d-*.json`): the checker measured through the display projection
(`display-deps-v1`, claim-level display). Neither development candidate (Haiku 5.5 with adaptive
thinking on `check.v7`, then on `check.v8`) met every target, and the pre-registered fallback
froze `haiku-think-v8`, which production runs: in development it showed 19 of 21 supported-brief
trials (12 of 21 under the whole-brief rule), 82.2% of their supported claims, one of 11 critical
regressions, no error in 30 error briefs and no unsupported claim among 1,244 shown. The held-out
pilot (nine new bundles, 123 calls, run once) is inconclusive by design and is not a pass: 32 of
39 supported-brief trials shown (22 under the whole-brief rule), 74.5% of their supported claims,
2 of 171 errors shown (both critical context-losing excerpts; every timing error withheld), 2 of
75 error briefs showing an error, 2 unsupported claims among 1,961 shown; p50 15.7 s, p95 23.3 s.
Production keeps whole-brief display (`AI_PARTIAL_DISPLAY` off) until gate G6 reviews these
results (DESIGN §12).

**Task 16e result** (2026-10-23, $1.47 of its $2.50 allocation; summaries in
`evals/checker/results/16e-*.json`): two deterministic rules now decide, whatever the checker
says, what is never shown (`excerpt-context-v1`, `ordinal-evidence-v2`; DESIGN §3). On a blind
sample drawn from the 16e evidence after the excerpt rule was frozen, it left out 7 of 166
sentences that stand alone (4.2%; 95% interval 2.1–8.4%) and caught 18 of 34 that need their
context. Neither development candidate (`check.v9` at effort `low`, then `medium`; 179 calls
each over every 16c and 16d item, labels v3) met every target, and the pre-registered fallback
froze `haiku-think-v9-medium`, which production runs: in development it kept 84.9% of the
supported claims the rules allow (target 90%) and 32 of 36 supported-brief trials (target
90%), and showed 3 of 396 errors (at most 1.3% in a family), no critical regression (69
items), no error in 108 error briefs and no unsupported claim among 1,993 shown. The held-out
pilot (nine new `retrieval.v2` bundles, 105 calls, run once) is inconclusive by design and is
not a pass: it showed none of 158 errors (every one of 44 critical items withheld) and no
unsupported claim, but kept only 183 of 770 supported claims (23.8%) and 7 of 26
supported-brief trials. A reading after the run found several of the eleven claims that carry
most of its false flags mislabelled, and a defect in the display rules that only removes more:
a model number before "case" ("the Cessna 175 case") is read as a count of cases (DESIGN §12).
The pilot's checks took 23.3 s at p50 and 31.7 s at p95; the 60-claim development checks took
39 to 51 s, one over the 45 s check timeout. Production keeps whole-brief display
(`AI_PARTIAL_DISPLAY` off) until gate G6 reviews these results.

### Web client

`web/` is a React 19 single-page app built with Vite, React Router, TanStack Query
and Tailwind CSS 4. It implements the "Sectional" design system from
[UI_DESIGN.md](docs/UI_DESIGN.md) §2: tokens in `web/src/styles/tokens.css` (day on
`:root`, night "Panel" on `[data-theme="night"]`), mapped into the Tailwind theme in
`web/src/styles/index.css`, which clears Tailwind's default palette, type scale and
breakpoints. Components never use raw colours.

Pages (UI_DESIGN §3–§7): Home ("Clear sky"), Explore (keyword search with facet
counts, the case drawer and the compare tray), the full case page and Compare
(flight strips with NTSB columns, "Same in all", sort and Print for class), the AI
evidence search (`/ai/:id`), AI briefs that exist (`/briefs/:id`; the interface starts
none), the admin page for admin accounts (`/admin`), plus About and Privacy. View state is in the URL: the search
keys of `SearchRequest` (`q`, `mentionedIn`, the facet names, `yearFrom`, `yearTo`,
`sort`, `page`), the open case (`case`), the compare selection (`cases`), for an
evidence search the pages shown (`pages`) and the search Compare was opened from
(`evidence`, `pages`) and, for briefs, the step (`step`) and the brief a case or compare
page was opened from (`brief`, `step`). Phones get a "Filters (n)" sheet, a full-screen case sheet and a
compare bar. The footer gives the snapshot's real age once it is more than 45 days old
(DESIGN §4: monthly full snapshots), and carries the owner's credit under it, "Built by
Mariusz Kotas · mkotas.cz" with the website as a link (a new tab), on every page and in
print, the plain fallback page of a failed frame included (`CreditLine`; the name,
website, e-mail address and product name are in `shared/brand.ts`, which the server shares
and `web/src/brand.ts` re-exports; the About page has a
"Built by" section with the name, the website and the e-mail address as a `mailto:`
link). A page that fails unexpectedly (a render error, or
code that could not load) shows "Something went wrong." with Try again (a reload) and
Home inside the header and footer, never the router's developer page; if the frame
itself fails, a plain frame with the header's lockup does the same (`web/src/pages/ErrorPage.tsx`).

The header (UI_DESIGN §3) starts with the AirCase mark and the wordmark, one link home named
"AirCase" (the mark, `BrandMark`, is decorative; its geometry is in `shared/brand-mark.ts`,
its colours are the `mark-tile` and `mark-glyph` tokens), and the line "Plane crash &
accident investigations" (`PRODUCT_DESCRIPTOR` in `shared/brand.ts`) as plain text outside
the link (`BrandLockup`): beside the wordmark from 1024px, and below that, on tablets and
phones, on a second line under the wordmark, running under the navigation or the AI counter.
The link's box, and so its focus ring, holds the mark and the wordmark at every width. The
line keeps the desktop and phone headers as tall as they were (a tablet's grows by it), and it
does not print. At night the wordmark is plain blue text like by day, not an engraved placard.

The AI interface (UI_DESIGN §4.3–§4.6, §4.9, §5; `web/src/features/{ai,brief,evidence}`):

- **Ask AI and the counter** read `GET /api/ai/status` before anyone clicks ("Ask AI ·
  10 free", "AI searches left: 9 of 10", "AI left 9 of 10" below 700px, "AI back
  tomorrow"). Every allowance the copy states (the first check's "Up to ten free AI
  searches a day", the welcome's "20 AI searches a day for your first three days, then
  50", the trial's "Free AI searches return at 00:00 UTC.") comes from `/api/config`'s
  `aiLimits` and the visitor's status; a number the API does not report is left out. Ask AI needs a click or
  Ctrl/Cmd+Enter; Enter runs the free Search. While the status cannot be read the
  controls say "AI temporarily unavailable" and the status is read again every 15 s and
  when the tab gets focus. Where Google sign-in is not configured nothing says "sign in":
  the signed-in-only states read "Free AI searches used" or "Free AI searches paused for
  today", and Ask AI is off with the same words. While the first read of `/api/config`
  (which says whether sign-in is offered) is on its way, those states say nothing; if it
  fails they read the same way, and the configuration is read again after 5 s, doubling up
  to 60 s, and when the tab gets focus, until it answers.
- **Turnstile** (`TurnstileGate`): every anonymous AI request takes a fresh token from a
  new widget, which is removed as soon as its token is taken. Each request holds a check
  session: a second control waits its turn ("Checking…"), and ending one session never
  cancels another. The first request of a trial identity (`started: false`) shows "Quick
  check before your first AI search"; later ones run invisibly while the button reads
  "Checking…", then "Starting…" while the request is on its way (the server answers once
  the scope stage is done), and for an AI search "Searching…" once its checklist shows. Each request's idempotency key is kept for the tab right
  before the request leaves (write-ahead, `web/src/features/ai/unsettled.ts`:
  `sessionStorage`, or memory when storage is unavailable) under a hash of the normalised
  request (question and canonical filters, or brief and change), so a reload or Back
  while it is in flight loses nothing and the same request from any page or control
  replays the key. Closing the tab loses it, with the tab's session storage. When no
  answer comes back (a network or server error), the notice does not claim the search was
  free, and Try again replays the same request under the same key; if that replay is a
  409 `conflict` (the earlier attempt never completed), it is sent once more under a new
  key. The key is kept until the page has taken over from a 2xx (an evidence search once
  its page is on screen; a new brief once the
  brief page, which may still be loading after the answer, is on screen; a refinement
  once its step is shown; a second ask in that gap replays the key) or that 409 settles
  it: a refused retry (a failed or cancelled check, a paused or used-up status, a known
  refusal of the replay) leaves it for the next ask. A known refusal of a first send (a
  4xx, or a 503 `unavailable` or `ai_paused`, which release the admission) spent nothing:
  its key is taken back, the notice says why, and the next ask uses a new key. Keys
  expire after 24 hours, with the server's idempotency record. A rate limit of two
  minutes or more (the per-network hourly and daily limits) reads "AI searches from this
  network are limited for now." with the wait in minutes or as a UTC time. The site key
  comes from `/api/config`, and Cloudflare's script loads only when an AI request needs
  it. The server's Content-Security-Policy allows `https://challenges.cloudflare.com` as
  a script and frame source whenever anonymous AI is configured (see "Security headers"
  under API server).
- **The evidence view** (`/ai/:id`, UI_DESIGN §4.9; contract `evidence.v3`): Ask AI on Home or
  Explore sends `POST /api/evidence` (`kind: "question"`). Nothing
  blocks a search: the answer is always results, which open the search's page, seeded from the
  answer; a question about something else, or asking for operational advice, gets the contract's
  fixed capability note (`EVIDENCE_NOTE_TEXT`) calmly above its results. Results come from the
  question as asked (with what the server's policies added to it, said as such), or from the
  reader's own words and filters. The page shows the question, then "Your search" (the question as
  asked or the reader's words; the terms the AI added to keyword search, `query.keywords`, under
  "Also searched" or "Keywords searched" with a magenta "AI" tag; and the applied filters from
  `appliedFilters`, each a removable chip, a state applied because the question names it,
  `automaticFilters`, tagged "from your question"), then what is left of the AI's suggestion,
  magenta and dashed under the contract's label "Suggested filters and terms — not applied" (its
  terms only while keyword search has not read them): "Apply these filters · uses 1" sends an
  edited search with the search's filters plus those and no `terms`, so the query stays, and only
  "Apply filters and terms · uses 1" sends the suggested terms. A search whose scope stage failed
  has no suggestion and nothing else changes. An explicit counting or comparison request adds a hint
  above the results (the dashboard; the cases found and Compare). Then the contract's heading and
  notice, the count ("21 retrieved · highest-ranked first · not every matching investigation", or
  "leading results ordered by AI for relevance" when a reranker ordered them, `order`) and the cards:
  Explore's case facts, every aircraft of a multi-aircraft event, every probable-cause
  variant with its scope, and up to three whole paragraphs with their section and scope; a
  probable-cause paragraph among them is marked inside its statement instead of shown twice
  (`web/src/features/evidence/fold.ts`; the drawer and Compare do the same).
  Literal matches are marked with a solid underline and fill, synonyms with a dotted
  underline, with a legend and words for screen readers, never colour alone; the legend and
  the relevance line say whose terms are marked, from the server's `marks` (the suggested terms,
  the reader's words, or "the words searched" when AirCase added terms).
  The relevance line gives only the applied filters met, the marked terms' occurrences in the
  shown paragraphs ("Suggested terms in these excerpts: “icing” appears 3 times") and the
  retrieval channels ("found by keyword and similarity search"). "Show the full analysis
  section" reads the section from `GET /api/evidence/:id/cases/:ntsbNo` (the search's
  generation, never the public case endpoint) and marks the excerpt's paragraph at its
  offsets; a paragraph over 3,000 characters folds and opens whole, never cut. "Show 10
  more" reads the next saved page for free (`?pages=n` keeps them on a reload) under the
  total. Typing words, removing a chip or adding a filter is free until "Search again · uses
  1" sends `kind: "edited"`, a new 24-hour search that keeps the question, with exactly the
  filters left, `terms` only when the reader typed new words and `keywords: "question"` when they
  removed the added terms. While the page says the search's one free undo is there (`undo:
  "available"`), a draft that only removes what AirCase added (the whole automatic state, the
  added terms, or both) reads "Search again · free", by the server's rule
  (`web/src/features/evidence/undo.ts`, held to `server/evidence/undo.ts` by
  `tests/unit/evidence-undo.test.ts`); it runs with the visitor's own searches used up and through
  the usual check, and the searches it came from then say `used`. The created page's `freeUndo`
  decides: a page that says it was not free says "This search used one of your AI searches.". "Show keyword
  results" opens Explore with the draft's words (or the question) and filters, free. An empty or
  tiny result shows its filters (an automatic state tagged, the added terms said) and a free
  keyword search without them; a gone search (a 404) says so
  and offers to ask again. The drawer, Compare (`?evidence=:id&pages=n`) and print show
  the same projection under the heading and notice. Nothing on these surfaces is written
  by AI: only NTSB text, coded data, the contract's fixed copy, the reader's own question and
  edits, and the AI's terms only quoted under their label and as labelled counts and marks (a
  component test checks every text node). Model text is always rendered as text, never markup.
- **The search checklist** (UI_DESIGN §4.10, Task 25): while `POST /api/evidence` runs, a
  question's or an edit's, a cockpit checklist card shows where the visitor waits (under the box or
  nudge Ask AI was pressed in, or under "Your search" for an edit): the question, "Search 24,291
  investigations" (the default cohort from `/api/config`) and the order of the leading results, each
  filling in its result with a magenta ✓ as its stage ends, read from `GET
  /api/evidence/progress/:key` (`EvidenceProgressSchema`) under the POST's own idempotency key about
  every 500 ms (`web/src/features/evidence/checklist.ts`). A 404 is normal until the server has
  registered the search and is read through for the whole wait (once a second after ten in a row);
  a 429 is waited out for its whole `Retry-After`, and one over 30 s ends the reading, the card as it
  is (nothing reads sooner: not focus, a reconnect or a reset, `web/src/features/evidence/progress.ts`);
  until the first answer the card is unticked. Reading stops when the POST settles, and the card goes;
  meanwhile the control that asked says "Searching…". The card also goes, and nothing more is read
  for it, as soon as the visitor changes (sign-out, deletion, another account): its progress is read
  only for the visitor who sent the search (`PendingSearch.visitor`). Completions are announced
  politely, each once (several that end between two reads together, in order); a stage that ended
  without its result says READ or DONE, never a result the server did not send; statuses and counts
  only, never model text. The card and its client load with the first AI request, never with the
  home page (`SearchWait`): the card's code starts loading as the search starts, before its
  Turnstile check, and the control says "Searching…" only once it has loaded (otherwise
  "Starting…").
- **Rating a search** (UI_DESIGN §4.11): "Was this search useful?" under the results, "Useful" and
  "Not useful" (`POST /api/evidence/:id/feedback`, `EvidenceFeedbackRequestSchema`; no AI search used);
  "Thanks — noted." with the choice chosen once the server has it, changeable (the latest counts); kept
  per search in this tab's memory only (`web/src/features/evidence/ratings.ts`, forgotten with the
  visitor), so a reload shows it unrated; a failure says so with Try again. Not printed.
- **Admin** (UI_DESIGN §4.12): for an account `/api/account` says is an admin (`isAdmin`), the header
  links `/admin` (the phone menu too): users, usage (a 30-day chart of small multiples with its
  table, the ratings), costs (budgets as meters, the daily one against `costs.interactiveToday`) and
  the system, all from `GET /api/admin/overview`
  (`AdminOverviewSchema`; the private `admin` query), times in the viewer's own zone. Everyone else,
  and an admin the API answers 404, sees the ordinary not-found page; when who is signed in cannot
  be read (the account read and its retry failed), the page says it didn't load, with Try again. The
  page is not indexed. Its System section's “Automatic import” and the top alert are the
  importer's only notification channel: Working, Delayed, Needs a fix or Off, with fixed
  words about the data serving and what happens next. Facts show serving file, last check
  or last good check, waiting file and next check. Recent runs show changes and costs;
  technical IDs appear only in alert details, with Copy details. Routine import processing
  requires no approval or recovery command (docs/IMPORTER.md).
- **Briefs that exist**: the interface starts none. While the server has briefs off
  (`aiLimits.briefsEnabled: false`, its default) a brief is read-only: no Refine, and a
  failed step offers New search, not Try again.
- **The brief page** polls the running step once a second and shows the answer
  checklist (completions announced politely, once each). Polling stops on a 404 (the
  expired view never polls) or another refusal, waits for `Retry-After` on a 429, and
  backs off exponentially (up to 30 s) after other failures; a read that gets no answer
  within 15 s (headers and body) is such a failure (POSTs never time out: an aborted paid
  request stays an unknown outcome). As soon as a read of a running step fails or gets no
  answer within those 15 s (before its one retry), the checklist says "Still checking…
  connection trouble." until a read gets through. The chips stay on top
  while a step runs: the scope stage's `checklist.interpretation` once it is sent,
  else, for a refinement, the previous step's. Then the briefing sheet:
  the AI summary with case citations, evidence groups, case cards with WHY IT
  MATCHED, timing chips and UNCONFIRMED labels, gap notes, the step switcher and
  REFINE. Two citations in a row are separated ("DFW08TA066, MIA08LA156"). In a
  multi-aircraft event, cards, the drawer and compare say whose evidence it is: an
  aircraft, or the event narrative, which is never attributed to one aircraft.
  Withheld summaries, the explicit abstention, scope replies, failures and
  cancels use the server's or UI_DESIGN's copy. Every control that runs the AI on a
  brief says "· uses 1" before the click. Try again after a failed step sends the same
  request: a first step as a new brief with the reader's filters, a refinement with its
  change (text and filters from the step, an edited or picked reading from the page's
  memory); where that is impossible (no refinements left, a reading sent before a
  reload, an earlier answer) there is no Try again, only a note and New search. A Try
  again that fails too is said in the same card. The drawer's "‹ n of N ›" follows the
  order the sheet shows the cards in.
- **AI context** for a case (the drawer, the case page, compare's AI columns) comes
  only from `GET /api/briefs/:id/steps/:n/cases/:ntsbNo` (an evidence search's, from its
  pages and `GET /api/evidence/:id/cases/:ntsbNo`), never merged into the
  public case data. A citation opens the drawer at the cited passage, with the quoted
  spans highlighted from their UTF-16 offsets; all AI and NTSB text is rendered as
  text.

```sh
pnpm dev:web          # Vite dev server; /api is proxied to the API server
WEB_MOCK_API=1 pnpm dev:web   # no API server: /api answered by MSW from web/mock (AI searches take live's time)
pnpm build:web        # production build into dist/web
pnpm test:web         # component tests (jsdom, offline, MSW)
pnpm test:e2e         # Playwright against the dev server in mock mode
pnpm test:e2e:real    # Playwright against the real API server: the fixture index, AI evidence search with offline fakes (and, on E2E_REAL_V3_PORT, the reviewed state policy; on E2E_REAL_LIVE_PORT, what live runs, with sign-in and an admin), signing in and out
```

### API contracts and the mock API

`shared/contracts/{config,search,cases,dashboard,ai,briefs,evidence}.ts` are the Zod contracts of the
public API (`GET /api/config`, `/api/search`, `/api/cases/:ntsbNo`,
`/api/dashboard`, `/api/ai/status`, and the [AI evidence](#ai-evidence-view) and [AI brief](#ai-briefs) routes). Every object is strict, `ev_id` never appears, and the case
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
default; `createHandlers({ aiStatus })` picks another) and changes like the server's:
the trial is `started` after the first accepted request, a running search uses one, and
an anonymous request without a Turnstile token is refused. `/api/config` offers
Cloudflare's documented always-passing test site key. The brief routes are answered by
`web/mock/briefs.ts`: an in-memory brief server with hand-written readings of the four
seed cases whose quotes are located in the fixture texts, the server's own static
replies and reading templates, a checklist that moves one row per poll
(`createHandlers({ briefPolls })`) and carries the step's readings and filters after the
scope row, replays of a request key, and question keywords that select the other
outcomes (withheld, no match, a two-aircraft "midair" answer with adjacent citations, out
of scope, operational, counting, comparison, clarification, no results) or, the first time
a question is asked, a failure: "unavailable" (503, its key then a 409), "lost before
start" (no answer, its key then a 409) and "lost response" (no answer, its key then
replays the started brief).
The evidence routes are answered by `web/mock/evidence.ts` (`evidence.v3`), standing in for one
ranking configuration and automatic-filter policy, like a server (`createHandlers({ evidence })`;
in the dev mock mode and the end-to-end tests, session storage `casebook-mock-evidence` as JSON
`{"ranking": "er-qt-h50-v1", "autoFilters": "state-explicit.v1.3"}`; the server's defaults,
`er-q-v1` and `none`, otherwise; `MOCK_EVIDENCE_RELEASE` is what live runs, `er-q-v1` with
`state-explicit.v1.3`):
retrieval over the fixture index from the question's own words, plus or instead of the suggested
terms as the configuration says, with a state the question names applied through the server's own
guard and the leading cases put in order by a fixed stand-in for a reranker's grades (an edit:
exactly the filters sent, with the real filter rules, and the reader's words when sent, the
question's when it restores them, else the earlier query), the one free undo by the server's rule
(it uses none of the visitor's searches and passes a used-up quota; every page says whether it is
still there, `undo`, as the server computes it from its claim), a stand-in scope
stage that suggests filters and terms (rules for a few words, phases and states), hints for
explicit counting and comparison requests, capability notes for questions about something else or
asking for operational advice (results still come), whole paragraphs located
in the fixture texts and chosen by the query (a probable-cause paragraph among them, as the server's
retrieved passages can be), with literal and declared-synonym highlights of the
suggested terms (else the query's words), saved pages of 10 (past the last, a 404), 24-hour
ownership handed over on sign-in, and idempotency keys (a replay answers the same search, another
body under the same key is a 409). `MOCK_EVIDENCE_QUESTIONS` names the questions the tests ask:
21 results, suggested filters that leave 2 and none once applied, a midair, multi-byte text, a
failed scope stage ("scope failure"), the hints and both notes; a question with "nothing"
retrieves none, one with "expire" makes a search that is gone at once, one with "undo fails" makes
a search whose first free undo is admitted, takes the undo's one-use claim and then fails (a 503,
the claim kept, as the server keeps it), and the brief's failure keywords work here too; "Carb icing
on approach in Texas", "Carb icing on approach in Missouri" (whose cases hold the suggested terms)
and "Engine power loss in California or Nevada" name states. Every answer, in each configuration, is checked against the contract in
`tests/unit/evidence-mock.test.ts`, which also checks that an unapplied suggestion changes no
ranking, filter or excerpt, what each configuration discloses, and the free-undo rule.
`/api/config` reports `aiLimits` (`MOCK_AI_LIMITS` in `web/mock/ai-status.ts`: 10 a day
anonymous, 50 per account, 20 in an account's first 3 days, 600 a month; briefs on, so the
brief pages stay testable; `createHandlers({ aiLimits })` changes them) and `aiAutomaticFilters`
(`["state"]` when the mock's evidence policy applies states, else `[]`; `createHandlers({
aiAutomaticFilters })` sets it, and `null` leaves it out as a server without the field would), which
words Explore's AI nudge and the About page's AI line (a missing field reads as nothing applied).
A unit test fails when the committed mock files are out of date.

An AI search's progress (`GET /api/evidence/progress/:key`) is answered by
`web/mock/evidence-progress.ts`: the search's stages timed like live's (the key registered after
0.8 s, the question about 1.5 s, the search 1.7 s, the configuration's reranker 2.7 s for Haiku on
the top 50; an edit skips the question, a configuration without a reranker the order), each ending as
the mock's search did (`MockStageOutcome`; a search lost after admission fails at retrieval), read
only by its asker, and the POST's answer waits for them. The stage times are scaled by
`createHandlers({ evidenceTiming })` (default 0: no wait, for the component tests), in the dev mock
mode by `WEB_MOCK_EVIDENCE_TIMING` (default 1, as live; `pnpm test:e2e` runs with 0), and in a tab by
its session storage `casebook-mock-evidence-timing`, which wins. `POST /api/evidence/:id/feedback` keeps
the owner's latest rating on the mock's search (a question with "rating fails" fails its first one).
`/api/account` says `isAdmin: true` for the signed-in mock account when `createHandlers({ admin })` or
this tab's session storage `casebook-mock-admin` (`1`) says so, and `GET /api/admin/overview`
(`web/mock/admin.ts`) answers that admin, and only that admin, with a synthetic overview: 37 made-up
accounts at the example domains, 30 days of use with a weekly rhythm, a small beta's costs, the
ratings the mock was given and the configuration it stands in for. Its automatic importer
(`web/mock/imports.ts`) has deterministic states selected by `createHandlers({ imports })`
or the tab's `casebook-mock-admin-imports`: `healthy` (default), `published`, `delayed`,
`fix`, `disabled`, `never_run`, `overdue`, `unreadable`, `disabled_unreadable`, plus every current failure cause,
legacy history, manual rollback, baseline changes and checked/unverified restoration,
post-success and dev-held-live examples. `MOCK_IMPORT_STATES` is the full list.
The server sends severity, serving facts, waiting state, durable incidents and recent runs;
the client only renders fixed words. Tests validate the contracts and tie the displayed
$2 per-file limit to the worker. See [the automatic policy](docs/IMPORTER.md).

`pnpm test:e2e` starts `pnpm dev:web` in mock mode on `E2E_PORT` (default 5180).
It needs Playwright's Chromium (`pnpm exec playwright install chromium`, plus
`--with-deps` on a fresh Linux machine). The AI specs install a local stand-in for
Cloudflare's widget before the app loads (`tests/e2e/fake-turnstile.ts`), so the AI tests
make no network requests. `tests/e2e/evidence.spec.ts` runs the evidence view on a desktop
by day and a phone at night; `tests/e2e/search-checklist.spec.ts` the search checklist (with
live's stage times) and ratings, and `tests/e2e/admin.spec.ts` the admin page, likewise.

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

### Brand assets

The icons, the web app manifest and the share card in `web/public` are generated by a
development script, and the results are committed; the production build only copies them:

| File | What it is |
| --- | --- |
| `favicon.svg` | The mark at its small optical size, the browser-tab icon |
| `favicon.ico` | The same at 16, 32 and 48 px (PNG images in one ICO), for browsers without SVG icons |
| `apple-touch-icon.png` | 180×180, the folder 80 % of the width across on a full-bleed paper square, no transparency |
| `icon-192.png`, `icon-512.png` | The mark as drawn, transparent around the folder |
| `icon-maskable-512.png` | The folder on a full-bleed paper square, inside the safe zone that any mask leaves visible |
| `manifest.webmanifest` | Name, description (`SITE_DESCRIPTION`), colours and the three icons above |
| `social/card.png` | The share card (1200×630) that every page's `og:image` names |

`web/index.html` links the icons and the manifest and sets the browser bar's colour
(`theme-color`: the paper by day, the header's charcoal by night). They are built from the
mark (`shared/brand-mark.ts`), the day values of the colour tokens (`web/src/styles/tokens.css`:
`mark-tile`, `mark-glyph` and `paper` for the icons, and `ink`, `blue`, `muted` and `magenta` too
for the share card), the words in `shared/brand.ts` and the share card's template
(`scripts/brand-assets/card.html`, set in the app's own fonts from the `@fontsource` packages).
After changing any of them, rebuild and commit the files:

```sh
pnpm brand:build   # scripts/build-brand-assets.ts; renders offline with Playwright's Chromium
```

With the same sources and the same Chromium it writes the same bytes again. It also writes
`scripts/brand-assets/digest.json`: the SHA-256 of what each file was built from (its SVG, the
filled card page with its fonts, the manifest's text) and of the file itself.
`tests/unit/brand-assets.test.ts` recomputes the first and hashes the committed files, so a
change to any source without a rebuild, or an edit to a file after it, fails the unit tests; it
also checks the image sizes and the manifest's fields. The server serves the manifest as
`application/manifest+json`, and revalidates these files hourly like every file without a
content hash.

### API server

```sh
pnpm dev:server       # the API on HOST:PORT (default 127.0.0.1:3000), restarted on change
pnpm dev:web          # the web client; /api is proxied to the API server
pnpm worker publish --generation <id> --cases-index <name> [--passages-index <name>]
```

`server/main.ts` starts `buildApp(deps)` (`server/app.ts`): Fastify 5 with
`trustProxy: false`, serving the API and the built web client (`dist/web`, each page with a
head and status built for its route, see
[Search engines and link previews](#search-engines-and-link-previews)) on one origin.
It reads configuration like the worker (`AVIATION_ENV_FILES`, otherwise `.env.local`),
connects as `aviation_app` (`DATABASE_URL`) and reads
Elasticsearch with `ELASTICSEARCH_READ_API_KEY` only. With `APP_ENV=live` it refuses to
start unless `TRUSTED_PROXY_CIDRS` is set (tunnel mode) to private, narrow networks only:
RFC 1918 IPv4 at /16 or narrower, unique-local IPv6 at /64 or narrower (the tunnel overlay
sets it from `EDGE_SUBNET`); a wider or public network would let any peer in it forge the
client address. The API answers 503 until
a dataset is published: load, verify and index a generation, then `pnpm worker
publish` it (for the local `aviation_dev`, the fixture corpus is enough).

| Endpoint | Response | Caching |
| --- | --- | --- |
| `GET /api/health` | `{status, database, search}` states only; 200, or 503 when either check fails; one probe shared for 2 s | `no-store`; rate limited except over loopback |
| `GET /api/config` | `ConfigResponse`: snapshot date, dataset revision, coverage, enabled `aiAutomaticFilters`, the Turnstile site key once the anonymous gate is configured | `public, max-age=300`, ETag |
| `GET /api/search` | `SearchResponse` | `public, max-age=60`, keyed by the full URL |
| `GET /api/cases/:ntsbNo` | `CaseDetail` from PostgreSQL; 404 for unknown numbers | `public, max-age=300`, ETag |
| `GET /api/dashboard?cohort=default\|all` | `DashboardResponse`, computed once per dataset revision and cohort | `public, max-age=300`, ETag |
| `GET /api/ai/status` | `AiStatusResponse` for this visitor ([anonymous gate](#anonymous-gate-and-ai-status)) | `no-store` |
| `POST /api/evidence` | 201 `results` (page 1), with an optional fixed capability note; [evidence view](#ai-evidence-view) | `private, no-store` |
| `GET /api/evidence/:id?page=n` | `EvidencePage`, read owner only; free paging | `private, no-store` |
| `GET /api/evidence/:id/cases/:ntsbNo` | full `CaseDetail` at the pinned generation, canonical section revision IDs; read owner only | `private, no-store` |
| `POST /api/briefs`, `POST /api/briefs/:id/refine` | `StartBriefResponse` only with `AI_BRIEFS_ENABLED=true`; otherwise 404 ([AI briefs](#ai-briefs)) | `no-store` |
| `GET /api/briefs/:id?step=n`, `GET /api/briefs/:id/steps/:n/cases/:ntsbNo`, `POST /api/briefs/:id/cancel` | the step, the case context, 204; read owner only | `no-store` |

Every response is validated against its contract before it is sent. ETags are the
dataset revision plus a hash of the body, and a matching `If-None-Match` gets 304.
Search uses a short public cache rather than `no-store`: results change only when a
new manifest is published, and the canonical query string makes equal searches share
an entry. Errors are `ErrorResponse` bodies with fixed messages and `no-store`; a
missing index, an unreachable or stalled database (no connection free within 5 s, a
connection that broke, a statement the server ended at its timeout) or search engine,
or a search that ran out of its 5-second Elasticsearch `timeout` (`timed_out`, partial
counts) is a 503, logged as a warning, never a 404, partial data or an internal message. The router's own refusals (a malformed URL)
get the same headers and a JSON 400, and the static files' refusals are 404 or 400.
The log has one line per API request (method, route pattern, status, duration),
without client addresses or query strings; an unmatched `/api` path is logged with
the route `unmatched` and nothing of the request target. A logged error carries its name,
code and (Elasticsearch's) error type, never its message or stack, and any message string
loses the query string of a path it quotes (Fastify's own warnings quote the request URL).
The static files never include a dotfile or a dot directory (404). Per-visitor routes
(`/api/ai`, `/api/evidence`, `/api/briefs`, `/api/auth`, `/api/account`, chosen from the matched route
prefix, so later routes are covered) answer `Cache-Control: private, no-store`; public
data routes are cacheable and keyed by the dataset revision; errors are `no-store`.
Requests the HTTP parser itself refuses (400, or 408 for a request timeout and 431 for
oversized headers; 403 for a non-connector peer in tunnel mode) get the same security
headers and a JSON body, and the connection is closed. A request must arrive whole,
headers and body, within 60 s (`REQUEST_TIMEOUT_MS`; every body here is at most 16 KB):
one that stalls or trickles in is answered 408 and closed within about 65 s, since
stalled connections are checked every 5 s.

- **Database connections** (`server/db/client.ts`). The API's pool (8 connections, as
  `aviation_app`) bounds every wait: opening a connection or waiting for a free one 5 s;
  each statement 15 s on the server (`statement_timeout`; the maintenance pass raises its
  own to 30 s), an idle transaction 30 s (`idle_in_transaction_session_timeout`), and the
  connection itself 45 s: a connection on which nothing moves that long (a stalled server
  or network) is destroyed and its statement fails, so its slot is free again and the pool
  can still close. A connection that fails, idle or in use (a PostgreSQL restart), is
  logged with its error's name and code only (`database connection failed`) and replaced;
  it never ends the process. One that fails in use leaves the pool at once, even if its
  holder never gives it back. The health probe's database check is a bounded read (2 s)
  that destroys the connection it abandons. The worker's and tools' pools keep only the
  connect timeout (their long statements are expected) and the same failure handling.
- **Dataset pinning (A6).** Each request resolves the active `dataset_manifests` row
  (reused for 5 seconds) and reads only that generation and its cases index, never
  the alias. Before serving a manifest the server checks the index `_meta` (same
  generation, and a version and mapping fingerprint it serves) and otherwise answers
  503. It serves the current `CASES_INDEX_VERSION` and the earlier versions listed in
  `EARLIER_SERVABLE_CASES_VERSIONS` with their exact fingerprints: only versions with
  the same fields qualify. `cases-v2` (without the glued-heading char filter) stays
  servable for keyword search until every environment has published a `cases-v3`
  index; AI retrieval's cases channel reads `cases-v3` only. The dataset
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
  come back whole) with the most marks, shown as an excerpt (`shared/snippet.ts`, shared
  with the mock API), with an ellipsis on each side where its section goes on. The
  highlighter does not say where a passage sits, so the search also asks for the first and
  last 120 characters of each analysis and factual section (`script_fields`, never the
  whole text) and compares them with the passage.
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
  except the web client's routes (`ASSET_ROUTES`: the pages, robots.txt and the static
  files) and the not-found handler (the 404 page or a plain 404), which need no client
  address and are not limited, and `GET /api/health` over loopback (the container's health
  check). A case page (`/cases/:ntsbNo`) and the sitemaps read the database, so they are
  limited too, each by a limit of its own apart from the API's 60 a minute, so a crawler cannot
  use up a visitor's API allowance: the sitemaps, served from memory, a burst of 600 then 10 a
  second (`SITEMAP_ROUTES`; under the API's limit a sitemap was one a search engine "couldn't
  fetch"); a case page, one database read, a burst of 120 then 5 a second per network identity.
  Whether a 404 is JSON or the page also follows the decoded path
  (`/%61pi/nope` is a JSON 404).
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
  otherwise neither appears. Zod runs without compiled parsers: Zod probes `new Function`
  when it builds an object schema, and a browser reports that blocked probe as a CSP
  violation even though Zod catches the error. The production build puts Zod and the
  shared contracts in a chunk that the entry imports, and that chunk runs before the
  entry's own code, so the client's `zod` imports are mapped (vite.config.ts) to
  `web/src/zod-jitless.ts`, which sets `jitless` between Zod and every schema.
  `tests/unit/web-bundle-eval.test.ts` builds the client and starts it in jsdom with
  `Function` recording its callers, and the real-server end-to-end tests fail on any
  CSP violation. Also
  `X-Content-Type-Options`, `Referrer-Policy: same-origin`, `Permissions-Policy`,
  `X-Frame-Options`, and HSTS when `APP_URL` is HTTPS.

`tests/integration/api-search.test.ts` runs the API against the fixture corpus
(`fixtures/ntsb` and `fixtures/ntsb-ui`) published as the active dataset of
`aviation_test`. `pnpm test:e2e:real` builds the web client and starts the real server
on that dataset (`tests/e2e-real/server.ts`, port `E2E_REAL_PORT`, default 5181). Both
reset `aviation_test`'s corpus, so do not run them at the same time. That server has AI
evidence search on, offline: the production pipeline (admission, quotas, ledger,
retrieval, projection, storage) with the fake language-model provider and a scripted scope
stage (`tests/e2e-real/evidence-fakes.ts`), the fake embedder of the fixture passages index,
Cloudflare's always-passing Turnstile test keys answered by a local siteverify stand-in
(`tests/support/fake-siteverify.ts`) and `AI_BRIEFS_ENABLED=false`; it empties the control
tables when it starts and raises only the per-minute, per-network and in-flight AI limits,
since every browser of the run is 127.0.0.1. `tests/e2e-real/evidence.spec.ts` drives the
evidence view through it, with the mock suite's Turnstile stand-in in the browser, and
replays the known context-loss examples (`tests/support/context-loss.ts`) on the initial
card, drawer, Compare and print; `E2E_SCREENSHOTS=<dir>` keeps its screenshots. The same process
serves the reviewed state policy (`er-q-v1` with `state-explicit.v1.3`) as a second app
on `E2E_REAL_V3_PORT` (default `E2E_REAL_PORT` + 3), sharing the database, for
`tests/e2e-real/evidence-v3.spec.ts`, and what live runs (`er-q-h50-v1` with `none`, the fake
reranker) as a third on `E2E_REAL_LIVE_PORT` (default `E2E_REAL_PORT` + 4), with Google sign-in
through the stand-in below and `AIRCASE_ADMIN_EMAILS` naming its `e2e-admin@example.com`, for the
search checklist, ratings and the admin page (`tests/e2e-real/search-checklist.spec.ts`,
`admin.spec.ts`): its fake scope stage and reranker each take about a second and its search
answers wait a little longer, so the checklist's reads see each stage under way and then the
finished search. The admin tests run after the rest (project `chromium-real-admin`), since their
sign-ins add sessions that `sign-in-out.spec.ts` counts. It also starts a
second real server with Google sign-in (`tests/e2e-real/auth-server.ts`, on 127.0.0.1 at
`E2E_AUTH_PORT`, default 5182) and an offline stand-in for Google on another site
(localhost at `E2E_GOOGLE_PORT`, default 5183), so that Chromium applies `SameSite` to the
callback as it would with Google; that server empties `aviation_test`'s control and auth
tables when it starts.

### Search engines and link previews

AirCase renders in the browser, but the server builds each page's head
(`server/seo/head.ts`, `server/routes/pages.ts`), so search engines and link previews read
the page's own title and description before any script runs: `<title>` (the text the client
then shows: every route's title is built once, in `shared/page-titles.ts`), the meta
description, `robots`, a canonical URL on `APP_URL`, Open Graph and Twitter tags with the
share image, and JSON-LD (a `WebSite` on `/`, a `BreadcrumbList` AirCase → Explore → the case
on a case page). Descriptions are plain text by fixed rules, never AI: fixed ones for the
pages without data (`shared/brand.ts`), and for a case "NTSB accident investigation
DFW08TA066, 8 Feb 2008: N66372 (Hughes OH-6), minor injuries. Probable cause: The contract
mechanic's failure …", cut at a word to 200 characters (`server/seo/case-description.ts`). A
record without probable-cause text ends with its status instead: "Probable-cause text
unavailable." when it is completed, otherwise "Investigation in progress (NTSB status P).",
"Investigation status unknown (…)" or "Other investigation status (…)" with its raw NTSB
status. NTSB text is escaped for HTML, and JSON-LD for its script element. The case page's tab
title is "{headline} ({event year}) · NTSB {ntsbNo} · AirCase".

| Path | Status | robots | canonical |
| --- | --- | --- | --- |
| `/`, `/dashboard`, `/about`, `/privacy` | 200 | index, follow | itself |
| `/explore` | 200 | index, follow; with any query parameter noindex, follow | `/explore` |
| `/compare`, `/account`, `/briefs/:id` | 200 | noindex, nofollow | itself, no query |
| `/cases/:ntsbNo`, a case `GET /api/cases/:ntsbNo` serves | 200 | index, follow | `/cases/{ntsbNo}` |
| `/cases/:ntsbNo`, no such case (a number too long for the router included) | 404 | noindex | none |
| any other path without a file extension | 404 | noindex | none |

The client renders every page (a 404 shows its not-found page). Redirects (301) drop the query
string: a served case number not in canonical form (`/cases/dfw08ta066`), a page path with a
trailing slash, a page path in the wrong letter case (`/About` to `/about`) and `/index.html`
(to `/`). The page goes to GET and HEAD requests whose `Accept` is absent or takes `text/html`
or `*/*`; other requests, and a path with a file extension that no route serves, get a
plain-text 404. A case page reads the database: it counts against the case pages' own rate limit
(a burst of 120, then 5 a second per network identity, apart from the API's) and needs a network identity. A page request that is refused (429) or fails (500, 503) gets the
page with that status, noindex, without a canonical URL, and with the `Retry-After` the API
would send; the API keeps its `ErrorResponse`. Explore's and Compare's titles read the query
string with bounded work (`shared/page-params.ts`), as those pages are not rate limited.

- **robots.txt**: on `APP_ENV=live`, `Allow: /` and `Sitemap: {APP_URL}/sitemap.xml` (Cloudflare
  prepends its comment-only content-signals block); elsewhere `Disallow: /`. The API is not
  disallowed: search engines call it to render the pages. Outside live every response carries
  `X-Robots-Tag: noindex, nofollow`; on live, API responses carry `X-Robots-Tag: noindex`.
- **Sitemaps**: `/sitemap.xml` lists `/sitemaps/pages.xml` (`/`, `/explore`, `/dashboard`,
  `/about`, `/privacy`) and `/sitemaps/cases-{n}.xml`, at most 10,000 URLs each: the canonical
  page of every case in the active dataset's default cohort (US, completed, with probable-cause
  text), by NTSB number, with the snapshot date as `<lastmod>`. They are built once per active
  manifest and kept in memory; without a servable dataset the index lists the pages only. Other
  records keep their indexable pages but are not listed.
- **Share image**: `og:image` and `twitter:image` are `{APP_URL}/social/card.png` (1200×630),
  served from `web/public/social/card.png` ([Brand assets](#brand-assets)).

Registering live with Google Search Console and Bing Webmaster Tools:
[runbook](docs/RUNBOOK.md#search-engines).

### Language-model provider

`server/ai/` holds the provider interface (`provider.ts`) that the scope, compose
and check stages call, the Anthropic adapter (`anthropic.ts`), a deterministic fake
for tests (`fake.ts`, allowed only with `NODE_ENV=test`) and versioned prompts
(`prompts/scope.v2.ts`, `compose.v8.ts`, `check.v9.ts`; `check.v7.ts` and `check.v8.ts` stay as the record of the 16d calibration's candidates; earlier versions are in the git
history, each file's header says what changed). The scope stage
returns the intent, validated filters, a `keywordText` query for the keyword channel
and at most one ambiguity as allowlisted tokens. Each stage validates its bounded input, sends the question and
passages as delimited untrusted data in the user turn, and returns a Zod-validated
object with normalized usage (input, output including thinking, cache write, cache
read), provider, model and prompt version. The OpenAI adapter is not built yet.

Anthropic calls use `messages.parse` with structured outputs, an effort per stage
(`STAGE_EFFORT`: `low` for scope and compose, `medium` for the check since Task 16e's
selection), no retries, a cached system prompt, and no prefill, sampling parameters or refusal
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
28,000 / 11,000, check 40,000 / 24,500 (15,000 of it the checker's thinking allowance),
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
  its maximum cost, takes one unit of quota and gets a 120-second lease with a fencing
  token. Rejections: `trial_exhausted`, `daily_cap`, `monthly_cap`,
  `anonymous_share_exhausted`, `global_paused` (`daily_budget`, `monthly_budget`,
  `maintenance`), `rate_limited` (with `retryAt`), `concurrency`,
  `idempotency_conflict`, `uncertain_limit` (DESIGN §9, "Uncertain calls") and `busy`.
  Lock waits in admission, settlement, spend
  reservation, giving a search back and counting an attempt are bounded at 2 seconds; a
  timeout rolls back and returns `busy`
  (503, fail closed).
- **Limits.** A trial gets 10 searches per UTC day; its identity lasts 30 days. Signed-in users get 50 a day
  and 600 a month, 20 a day during their first 3 days. Attempts are limited to 2 a
  minute anonymously and 5 signed in, and per network identity and class to 10 an
  hour and 20 a day anonymously, 30 an hour and 100 a day signed in. One request per
  principal, two in total and one anonymous request can be in flight. A principal whose
  calls of unknown usage today (cancelled or timed out mid-call, each charged at its own
  worst case) add up to one reservation skips advisory scope for evidence searches
  until 00:00 UTC, with no suggestion or note; other limits remain enforced. The
  disabled generated-summary pipeline instead refuses with 429 `quota_exhausted`
  (DESIGN §9, "Uncertain calls"). A full charge after a server failure
  (lease expiry, a step that broke outside its stages) is not counted there.
- **Quota units.** The unit is taken at admission, so concurrent requests can never
  both use the last trial search. `releaseQuota` gives it back for a reply that must
  not count (a failed evidence search, or a static reply in the disabled summary
  pipeline); the attempt still counts. Evidence results always count, with or without
  a capability note. `recordAttempt` counts an attempt that makes no paid call.
- **Settlement.** `settle` (interactive) and `settleSpend` (indexing, evaluation) need
  the reservation's fencing token and a live lease. They charge the reported usage,
  optionally itemized by provider, model, stage and token counts. A call whose usage is
  not known is an uncertain line at its own worst case (never past the reservation);
  usage uncertain as a whole is the full reservation. A lease that runs out first is charged in
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
  (`server/quota/maintenance.ts`; the app role already holds the grants), and deletes
  expired sign-in rows (`pruneAuth`); `pnpm worker prune-controls` runs the same pass once
  by hand, under the same lock.

The kill switch pauses interactive AI only. Its second flag is the login-required
emergency mode (DESIGN §7): anonymous trials are refused (admission `login_required`,
403; status `signed_in_only` with reason `login_required`) and signed-in AI goes on.
After a restore, a separate hold stops every paid operation, interactive and indexing or
evaluation alike, until `pnpm worker restore-reconcile` has charged the spend the restored
ledger lacks (`server/quota/hold.ts`; RUNBOOK, "Paid operations after a restore"); the
switch cannot release it.

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

### AI evidence view

The backend contract is `evidence.v3` (`shared/contracts/evidence.ts`): it discloses
executed keywords, automatic state filters, ordering and mark source, plus `freeUndo`
for the created search and the current `undo: available | used | none` hint.
The hint is read from the claim column on every page read or replay, never stored
in the immutable result; admission remains authoritative if another tab uses it.
With the default question-only ranking and no automatic filters, `scope.e3` filters
and terms remain unapplied suggestions. Render remaining suggestions as text under
`EVIDENCE_SUGGESTION_LABEL`; never render model text as HTML. All surfaces keep `EVIDENCE_NOTICE`. This beta has no
specific unchecked readings or generated factual prose.

`POST /api/evidence` accepts either:

- `{kind: "question", question, idempotencyKey, turnstileToken?}`: at most one scope attempt,
  then one query embedding and retrieval using the configured ranking and automatic
  filter policy (defaults: question words and no automatic filters). Scope error,
  timeout, invalid or over-cap output returns
  ordinary results with `suggestion: null`, `note: null` and settles any scope spend.
- `{kind: "edited", from, filters, terms?, keywords?: "question", idempotencyKey, turnstileToken?}`: an owned,
  unexpired search's original question, with exactly the user-supplied filters. Omitted
  `terms` retains the parent's executed query; present `terms` explicitly accepts or
  types a replacement; `keywords: "question"` instead restores the original question's
  words and cannot be combined with `terms`. Applying suggested filters alone never
  accepts suggested terms.
  A removed filter stays removed. Edits skip scope, have `note: null`, and use the
  current publication.

Questions and edited terms containing NUL or lone UTF-16 surrogates are rejected with
400 before identity, admission or provider calls; valid astral characters are accepted.

A synchronous 201 returns `{kind: "results", search: EvidencePage}`. The page records
`query: {source: "question", keywords} | {source: "edited", terms}`; `keywords` identifies
`question`, `question+terms` or `terms`, with the added terms when used. It also reports
`appliedFilters`, nullable `suggestion: {filters, terms}`, nullable `hint` and nullable
`note`. It has no
`interpretation` or `edited` response field. A filter-only edit may still have
`query.source: "question"`. A validated scope intent selects only a fixed capability note:
`out_of_scope` → `note: "scope"`; `operational_advice` → `note: "operational_advice"`;
every other intent, invalid/missing output, timeout or skipped scope → `note: null`.
Render the fixed `EVIDENCE_NOTE_TEXT[note]`, never model-written policy text. Notes are
general reminders, not judgments about this question; absence of a note assures nothing.
The research-only boundary and `EVIDENCE_NOTICE` stay visible unconditionally. No intent
blocks search or changes ranking, filters, pagination, admission or accounting.

The server's `evidence-hints.v3` grammar supplies navigation hints only:
`{kind: "corpus_statistics"}` links to the dashboard without filters;
`{kind: "case_comparison", found, notFound}` links up to four case numbers captured
by that exact comparison match. A single ID, a negated comparison or an injected ID
list is insufficient. Hints and notes are independent. Every successful search returns
201 `results`, including off-topic and operational questions. There is no generated
answer or clarification fallback. Retrieval/projection failures still return 503;
normal validation, identity, quota and budget checks remain enforced.

`retrieval.v2` fuses passage BM25, passage similarity and cases narrative BM25, 200
candidates per channel with the existing fusion and tie ordering. All three channels,
cohort, ranking, excerpts and pagination use the executed query and applied filters,
including any disclosed state accepted by the configured automatic policy.
The baseline keeps Task 23 highlights and occurrence labels: suggested terms when
a suggestion is retained, otherwise executed query words. Non-baseline configurations
use executed lexical words. These occurrences do not establish question satisfaction.
`evidence.v3` maps at most 100 cases with eight concurrent requests inside the shared deadline.
It stores that ranking, concrete
indices, canonical generation, retrieval seed spans, channels and result projection.
It has 10 cases/page and at most 10 pages; `total` is the saved candidate count, not
the number of relevant investigations in the corpus. Zero results is page 1 with
`pages: 0`. Beyond the last page is 404. Pages never re-rank, embed or call a model.

Every card has coded facts, every canonical probable-cause variant and up to three
**whole-paragraph previews** (`paragraphs.v2`). The shared `ntsb-paragraphs.v1` rule
uses single newlines, joins hard-wrapped sentences and attaches heading lines to the
following paragraph. Paragraphs are not shortened; UTF-16
spans are checked against canonical sections and the stored passage rows. Multi-aircraft
narratives stay event-scoped. Literal and explicitly declared analyzer-synonym matches
are distinguished; stemming or semantic similarity is never presented as a word match.
Relevance fields contain only satisfied coded filters, occurrence counts in the shown
paragraphs and retrieval-channel enums. They establish no causal or timing relationship.

For authoritative context use `GET /api/evidence/:id/cases/:ntsbNo`, **not the current
public case endpoint**: it reads this search's generation. Its section `revision` is
the canonical revision ID used by the excerpts (the public case endpoint uses a text
hash). Both paragraphs and full sections must be rendered as text, with validated
highlights, never HTML. Search creation/expiry timestamps are UTC instants ending in Z.

Ownership is checked in the query reading private content. Unowned, missing and expired
searches are indistinguishable 404s. The 24-hour lifetime never extends on read, retry or
sign-in. The canonical results page is `/ai/:id` (private, no-store, noindex/nofollow;
head title “AI search · AirCase”). Sign-in from it, or a signed-in edit/retry from the
owning trial browser, moves read ownership once; original charges stay on the original
principal. Account deletion removes searches and their idempotent results. Maintenance
deletes expired searches. Backup and restore checks exclude `evidence_searches` data.
Page reads select only the requested ten cases; context membership is checked in SQL
without loading the stored ranking. A search has an 8 MiB UTF-8 JSON budget, checked
before storage and enforced by the database. Oversized results fail without truncation,
returning the quota unit and settling actual spend.
Generation and index cleanup honor the live-search references, including after republish.

The ordinary result is projected and byte-checked before the optional suggestion is added.
If that metadata and its baseline suggestion highlights would exceed the storage
budget, the suggestion is omitted and the executed lexical highlights remain. Canonical text and selection never change to make room.

Each finished, replayable results search counts once; edits count again; paging and
idempotent retries are free. Failures before a replayable result return the quota unit,
while actual or uncertain provider spend remains charged. A lost HTTP response can be
replayed with the original key. Disconnecting does not cancel admitted work; only
shutdown, account deletion or the 30-second server deadline stops it. A new anonymous POST (including replay) needs a fresh
Turnstile token. Signed-in step-up, network limits, concurrency, restore hold and the
existing $3/day / $80 interactive / $20 indexing+evaluation / $100 total monthly gates
are retained. Daily limits reset at 00:00 UTC: 10/trial, 50/account, 20/account during
the first 3 days; accounts also have 600/month. `/api/config.aiLimits` and
`/api/ai/status` report the configured limits and the visitor's remaining allowance.
The legacy setting name `AI_ANONYMOUS_TRIAL_REQUESTS` now means per UTC day.

The evidence scope caps are separate from the disabled summary pipeline: 10,000 input
and 2,500 output tokens, plus a cache-write premium on up to 6,500 prefix tokens and
1,000 embedding tokens. With the repository's Haiku/OpenAI price rows this costs at most
**$0.0024325**, rounded up to a **$0.0025 reservation**. Edits keep that conservative
reservation and settle only their embedding. No generation retries run. A scope failure
removes both the suggestion and note; successful retrieval still consumes one search unit.
Once this principal's uncertain named-call charges reach one reservation in a UTC day,
new evidence searches skip scope and any configured reranker instead of refusing
search: no suggestion or note, `skipped_uncertain_allowance` for the enabled reranker,
the same full reservation, only embedding spend and all other limits still enforced.
This decision is made under admission's lock and resets at UTC midnight; the disabled
summary pipeline retains its refusal rule.

`scope.e3` uses the revision1 suggestion prompt, with unchecked readings removed and
advisory wording. It retains the single-value enum discriminator inside the strict
`{result: ...}` wire envelope. The adapter unwraps it and validates the inner union;
counting and generation share the same schema. The free provider preflight measured
5,701 fixed input tokens, 5,674 cached prefix, 6,192 Latin / 7,190 dense question input
and 1,118 bounded-output tokens; all fit. Run it again for the deployed configuration.
These are sizing checks, not interpretation-quality clearance.

Pre-v2 saved searches are not re-labelled or reused as edit parents: reads return 404
and those private rows expire normally. Migration `0024_evidence_query` makes the stored
version, query and applied filters immutable even while scope is running. Idempotency
hashes include the contract version. Earlier v2 results remain readable with a null note
and filter-free statistics hints; old blocking policy replies return 404 rather than
being re-labelled as results or automatically dispatched again.

`scope.e3` is frozen at its evaluated prompt, wire schema, model and settings. The gate
accepted the recorded confirmation for fixed capability notes, replacing the old
blocking-policy routing condition; this is not a pass of the earlier failed scope
quality gate. No new paid suggestion threshold is required for this design. Offline
regressions must keep retrieval and accounting independent of every intent, invalid
output, timeout and the recorded injection examples. Before public launch, the final
server, excerpt/provenance/UI, security, budget and lifecycle gates must still clear.
Track C/N is regression material. Generated summaries remain separately gated.

`AI_BRIEFS_ENABLED=false` is the default and must stay off while G6 for generated
summaries is closed. It disables create/refine with 404 even with provider keys present;
legacy reads and cancel still work until expiry. Re-enabling briefs would inherit the
same daily evidence-sized anonymous allowance, so quotas and costs must be reviewed
together before doing so. `AI_PARTIAL_DISPLAY` stays off too.
See [RUNBOOK](docs/RUNBOOK.md#enabling-the-evidence-view) for enabling evidence after review.

### AI briefs

The following describes the experimental generated-summary pipeline. Its writes are
disabled by default (`AI_BRIEFS_ENABLED=false`); it is not the evidence-view flow.

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
   chronology fact (compose v7: the relevant maintenance named once, each fact with its
   anchor, relation, value and bound, and passages, hours a passage does not call flight
   hours as `operating_hours`; `chronology_shape` when a fact's parts do not fit its
   relation, `zero_interval` for a zero number of days or hours) cites its own passages,
   with one decimal place for hours and whole days; every NTSB-number-shaped token in
   generated text must be allowlisted). Then the reader's criteria in code
   (`criteria.ts`, the timing rules `chronology-rules-v3`, DESIGN §3: only facts from the
   relevant maintenance decide, one aircraft at a time; facts that cannot hold together
   decide nothing, checked before any decision; "the day before" and "immediately
   before" are calendar dates, never hours; operating hours never decide flight hours; the
   first flight never settles a window; an approximate value or wording without a number
   decides nothing; a presented case outside the criteria withholds the summary). Every
   decision is then a server-template claim, including "under the timing rules, the
   supplied passages of this case do not settle whether…", so a fact the composition
   left out settles nothing. Before the check, two deterministic rules decide what can
   never be shown (DESIGN §3): `excerpt-context-v1` omits a quote whose words depend on
   text outside it, and `ordinal-evidence-v2` keeps a flight ordinal only on explicit
   evidence; what they abstain from is still checked. The check stage (`check.v9`, 45 s, at most 60 claims;
   Haiku 5.5 with adaptive thinking at effort `medium`, the configuration the checker
   calibration froze, below) reads a server-built header per case (aircraft, place, date) and gives every
   claim, by its server-issued id, exactly one verdict (`supported`, `contradicted` or
   `not_established`) against every verified passage of each case. Code judges it
   (`verdicts.ts`): a claim is confirmed only by a valid `supported` verdict naming
   passages it cites (none for an absence claim, which cites every passage of its case);
   a missing, duplicate or unknown id, an invalid passage or quote, or a failed call
   withholds everything (support named from an uncited passage of the case rejects that
   claim only), and a contradicted "do not settle" claim is recorded as
   `chronology_missed`. What is shown is then decided by the display projection
   (`display.ts`, `display-deps-v2`, DESIGN §5): with `AI_PARTIAL_DISPLAY` unset (the
   default until gate G6 clears partial display), any claim the check did not confirm or
   a rule abstained from withholds the summary, as before; with it set, only those claims
   and what depends on them are removed, whole sentences only, and the step says how many
   statements were removed ("Evidence check completed · 2 statements removed"). A check input over its cap withholds too (recorded in the step's `meta`, the
   evidence never cut to fit). A case whose passages do not settle a criterion is shown
   labelled unconfirmed, on its card and its summary citations: this analysis could not
   establish it from the supplied passages. There is no repair loop.
   A withheld summary is diagnosable: the step's `meta` lists each validation reason
   with its path (`summary.2`, `cases.1.why`) and the summary's sentence count, the
   judged check's codes per claim id, the criteria's rules and reasons, and each stage's
   stop reason; the rejected composition itself is kept
   server-side with the checker's verdicts (`brief_steps.diagnostics`, migration 0016;
   never in a response, trace or log; deleted with the brief by the maintenance pass after
   it expires) for `pnpm worker brief-diagnose` (docs/OBSERVABILITY_AND_EVALUATION.md).

The step has a 100-second deadline (`PIPELINE_DEADLINE_MS`, inside the 120-second lease).
Every stage enforces its own input cap with the
provider's counter. Stage results are written as they complete (`brief_steps`), and
until the end a read shows only stage status and counts, plus, once the scope stage has
sent the step on to search, the readings and filters it settled on
(`checklist.interpretation`: chips rendered from the stored intent with the server's
templates, and the validated filters, the same as the finished result's; a cancelled or
failed step keeps them, a static reply has none). Each stage's usage is settled
as itemized ledger lines with one request id; a call without reliable usage (a timeout,
a cancel, a shutdown, a provider 5xx) is charged at its own stage's worst case, as an
uncertain line (DESIGN §9, "Uncertain calls"); only a step that fails outside its stages
settles the full reservation. Scope replies (settled before they
are sent), empty results and failures before any spend give the free search back;
withheld summaries, abstentions, cancellations and failures after spending keep it.
A step still running 150 s after it started has lost its process: it reads as failed,
no longer blocks a refinement, and the maintenance pass marks it failed once its
reservation is closed. Closing the server runs within one 9 s deadline (the process
exits by force at 10 s): first, before the HTTP drain, running steps are aborted (they
fail and settle), paid requests still in the gate, admission or step creation are
refused with 503 `unavailable` (an admission is given back, settled at zero and its
idempotency record forgotten, so the same request can be sent again) or
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
  failure afterwards keeps that one `embed` line, and `billing: uncertain` charges the
  embedding at its 1,000-token cap as an uncertain line. A failed embedding is settled by its
  `QueryEmbeddingError` billing (`none`, the billed `usage`, or `uncertain`); an
  embedding aborted mid-request (cancel or deadline) is `uncertain`. A usage callback
  arriving after `retrieve` returned or threw is ignored.
- A re-pack for the compose cap packs the same candidates again; nothing is embedded
  (or mapped) twice.
- The binding runs the configured retrieval version (`AVIATION_RETRIEVAL_VERSION`) and
  reports it as the port's `version`: the step's `meta.retrievalVersion`, the
  `retrievalVersion` attribute of `brief.retrieve`, and under `retrieval.v2` the cases
  index read and the mapping counts in `meta.retrieval` (`{casesIndex,
  casesIndexVersion, mapped, unmapped}`; private: `stepResponse` never returns `meta`).
  For the cases channel it reads the cases index the brief's generation was published
  with together with the brief's pinned passages index (`manifestCasesIndex` over
  `manifest_pairings`, every pair a generation was published with; a bounded read: 2 s,
  and the request's signal), before anything is embedded; none (the generation never had
  that pair, or is gone) is `unavailable` with reason `no_cases_index`, and a lookup that
  fails or times out is `failed` or `timeout` with reason `cases_index_lookup`.
  `available()` bounds the same lookup by its check deadline. Republishing the passages
  index leaves the briefs made from the old one working until they expire (`index
  delete-unused` keeps the indices of unexpired briefs); republishing only the cases
  index can change what later retrieval returns, which `meta.retrieval.casesIndex`
  shows.
- Failures become a `RetrievalFailure` with a fixed kind (`unavailable`, `timeout`,
  `failed`) and reason (`index_mismatch`, `no_cases_index`, `cases_index_lookup`,
  `incomplete_search`, `embedding`, …) in the step's `meta`; the underlying message
  (index names, contract values, upstream text) is dropped. An aborted request ends at
  once: retrieval's requests skip the transport's retry backoff once their signal
  aborted.

AI is available only while the dataset reports the active passages index servable
(`PinnedDataset.passages`, the passages contract for `OPENAI_EMBEDDING_MODEL` and
`OPENAI_EMBEDDING_DIMENSIONS`) and the retriever accepts it. Otherwise, or without
`OPENAI_API_KEY`, or when no dataset can be served at all, the brief routes answer 503
`unavailable` and `GET /api/ai/status` reports `dependency`, never saying why.

### Google sign-in and accounts

`server/auth/` adds Google sign-in with [Better Auth](https://better-auth.com) (pinned,
1.7.7), the account page's routes, the brief handover and account deletion (DESIGN §7,
UI_DESIGN §4.8 and §5). The tables (`auth_users`, `auth_accounts`, `auth_sessions`,
`auth_verifications`), their grants and the deletion function are in migration 0017;
the used-state and deletion-confirmation tables, the brief lock, the operator's
signed-in check switch and the locking deletion function in migration 0018; retention's
lock order in migration 0019.

- **Configuration.** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (a Google OAuth client
  of type *Web application* whose authorized redirect URI is
  `<APP_URL>/api/auth/callback/google`), `BETTER_AUTH_SECRET` (at least 32 characters;
  `pnpm services:setup` generates one into `.env.local`) and `IDENTITY_HMAC_SECRET`.
  Without any of them sign-in is off: `GET /api/config` says `googleEnabled: false`,
  the page offers no sign-in, every `/api/auth` route answers 404 and the startup log
  names the missing setting. `APP_ENV=live` also needs an https `APP_URL` and the final
  privacy notice (`shared/privacy.ts`; RUNBOOK, "Google sign-in", step 0).
- **The flow.** The page posts `POST /api/auth/sign-in/social` (Google, the page to come
  back to, `disableRedirect`; any other field is refused, and so is a return path with a
  dot segment or an encoded slash) and opens the URL it gets: scopes
  `openid email profile`, PKCE (S256), a state bound to the browser by a signed cookie
  and stored for 10 minutes, and a nonce the server adds to the request and checks in
  the ID token. The OAuth state rides in an encrypted, HttpOnly cookie
  (`__Host-aviation_oauth_state`, 10 minutes), so starting a sign-in writes nothing to the
  database and a flood of starts cannot block anyone else's sign-in. Google sends the
  browser to `GET /api/auth/callback/google`, which signs in and returns to the page,
  with `welcome=1` after a first sign-in (the welcome dialog) or `signin=failed` (the
  dialog again, saying so). A callback is accepted once: the first to get through the
  code exchange and the ID-token checks claims its state atomically, and a second one,
  even arriving at the same time, is refused before a user or session is made.
  `POST /api/auth/sign-out` ends the session, and says so only once it is gone: when the
  database cannot end it, the answer is 503 `sign_out_pending` (`Retry-After: 5`), the
  browser is signed out all the same, and the sign-out is kept for a retry in a sealed,
  HttpOnly `__Secure-aviation_signout` cookie under `/api` (never a session) that the
  browser's next sign-out or account read finishes. It is `SameSite=Lax`, like the OAuth
  state cookie, because Google's redirect back to the callback is a navigation from another
  site, which carries no `Strict` cookie. No new session is issued while one is pending: a
  sign-in finishes it first, at its start and at Google's callback, and is refused (503
  `sign_out_pending`) while it cannot. The page forgets everything private it held, in every
  tab, whatever the sign-out's answer: as soon as the sign-out starts, nothing started for
  the visitor is kept or sent, and once the answer is in (or none can come), everything
  private goes. Anything but the server's success, read in full, reads the account again and
  says the server has not confirmed the sign-out. A page that reads another account than the
  one it had, or none, with no sign-out of its own (the session ended, or another account
  signed in from another tab; also a page back from the back/forward cache) forgets the
  previous one the same way before it shows the new account, without telling the other tabs,
  which each find the change at their own next read; every return to a page reads the account
  again. Another account means another application id (`user.id`), whatever the e-mail: a
  deleted account's e-mail can belong to a new account next, so the page never compares
  e-mails, and the same id under a new e-mail is the same visitor. Signing in where the page
  was signed out forgets nothing (the trial's work moves to the account). No other Better Auth
  endpoint is served.
- **What is accepted and kept.** An ID token from Google's token endpoint (the only
  source: ID-token sign-in is off) whose header says RS256 and carries a signature, for
  this client and no other audience, with finite `exp` (not passed) and `iat` (not in
  the future), this flow's nonce and an email Google reports as verified. The account is
  the Google `sub`; a second Google account with an email already in use is refused,
  never linked. Kept: the subject, the name and the email. Never kept (database hooks
  clear them and CHECK constraints refuse them): the picture, provider tokens and scopes,
  a password, and the session's IP address and user agent. Sessions last 7 days and are
  never extended; there is no session cookie cache, so sign-out and deletion take effect
  on the next request.
- **Cookies.** `__Host-aviation_session` and the OAuth state's encrypted
  `__Host-aviation_oauth_state`: Secure, HttpOnly, SameSite=Lax, Path=/, host-only (plain
  names without Secure on a local http `APP_URL`).
- **Requests.** `/api/auth/*` passes Better Auth a rebuilt request: the `APP_URL` origin,
  the allowlisted path, the cookies, origin and fetch metadata, and the network identity
  as its rate limiter's address (10 sign-ins and 10 callbacks per minute per identity,
  besides the API's own limit). Cross-site and non-JSON posts are refused before Better
  Auth, which checks the `Origin` itself when cookies are sent. Its log lines go to the
  server log as their message only, email addresses replaced, and nothing of Better
  Auth's goes to the console; telemetry is off. A callback that fails unexpectedly (its
  account deleted while it completes, say) lands on the sign-in error page.
- **Signed in, AI.** A signed-in visitor's AI requests are billed to the account: its
  quota key is HMAC(issuer, sub) (`abuse_records`, usage buckets), its daily allowance 20
  for the first 3 days (from the account's creation), then 50, and 600 a month.
  `GET /api/ai/status` reports the account's counts. Ordinary use takes no Turnstile
  check; a request takes one when the account made 3 AI attempts this minute, has used
  half of today's allowance, or its network made 10 signed-in attempts this hour, and
  every request does while an operator sets `pnpm worker ai-switch --account-check
  always` (`server/identity/step-up.ts`, DESIGN §8). The status then says `check: true`,
  so the page takes the check at click time.
- **The account lifecycle** (`server/auth/lifecycle.ts`). Deleting an account, and every
  transaction that writes rows the account owns (its admission, which takes the lock
  before anything accounts share, its new brief or step, a takeover of the browser's
  trial brief, the callback's handover), hold one lock per account and first check that
  the request's session and user still exist. A request paused while its account was
  deleted creates nothing, takes nothing over, calls no model and gives back any
  admission (403 `signed_out`). Every writer, the maintenance pass included, takes rows
  in one order: a brief, its steps, the account's idempotency records, its anti-abuse
  record, then its sign-in rows (sessions before their deletion confirmations, the user
  last; migration 0019 for retention). The pass's orphaned-step update, the one step out
  of that order, skips rows another transaction holds, so deletion and the maintenance
  pass never wait for each other in a cycle.
- **Handover** (`server/auth/handover.ts`). Signing in from `/briefs/<id>` while this
  browser's trial owns that live brief moves the brief's read owner to the account, by
  one compare-and-set, at the callback, when the same browser's trial cookie still
  proves that trial; a second or concurrent callback changes nothing. Steps keep the
  billing principal they were admitted under; refinements after sign-in bill the
  account. A signed-in refinement, or a signed-in retry of the trial's request, of a
  brief the browser's trial still owns moves it the same way. Reads check the read owner
  in the statement that reads the step; a refinement or a cancel locks the brief and
  checks its owner before it writes, so a handover cannot slip in between. After a move
  the trial cannot read the brief, and a retry of its request from the trial alone (which,
  like every anonymous AI request, takes a fresh Turnstile check) answers 403 `moved`
  (sign in to view it): never a replay or a new run.
- **Account** (`GET /api/account`, `POST /api/account/delete/start`,
  `POST /api/account/delete`, `server/auth/deletion.ts`). The account read shows the signed-in
  browser its account's random application id (`auth_users.id`, never the Google subject), name
  and e-mail, `isAdmin` for an admin and any live deletion confirmation; the page tells one
  account from another by that id (`acceptAccount`, `web/src/features/auth/visitor.ts`). Deleting needs a recent Google
  sign-in: within 5 minutes of signing in, `start` gives the session a 5-minute,
  single-use confirmation; otherwise the page signs in with Google again
  (`/account?delete=confirm`, Google asked for the same account), which confirms the new
  session only when it is the same account and ends the old session. Deletion (a JSON
  `{"confirm": true}` with that confirmation, refused cross-site) removes, in one
  locked transaction, the account's briefs with every step (also those billed to the
  trial that signed in) and its idempotency records, and the user with its sessions and
  Google link; it stops the steps that were running; it keeps the anti-abuse record until
  the current month's quota window ends plus 7 days. Charges, reservations and usage
  buckets stay (HMACs and amounts only); signing up again with the same Google account
  finds the same counts. The response expires this browser's session cookie; every other
  session ends with the user. The page then forgets everything private it held
  (`web/src/features/auth/visitor.ts`), as it does on sign-out, in every open tab of the
  site (a `BroadcastChannel`, with a random marker in local storage for browsers without
  one, for a tab that starts listening late and for a page restored from the
  back/forward cache, which forgets anyway when it cannot read local storage; such a tab
  then reads the account again); an AI request still under way is discarded without
  restoring a question, a retry key or a navigation. As with signing out, the page forgets
  whatever the deletion's answer: nothing started for the visitor is kept or sent from the
  moment the deletion starts, and once the answer is in (or none can come) everything
  private goes. Anything but the server's success, read in full, reads the account again
  and says the server has not confirmed the deletion. The exception is a refusal read in
  full that asks for the Google confirmation first (403 `reauth_required`): nothing was
  deleted and the session stands, so the page goes on to that confirmation. A deletion's
  re-authentication is counted per account (5 starts and 5 callbacks an hour), not per
  network.
- **Backups** never hold the rows of the sign-in tables, the briefs or the idempotency
  records (`server/db/backup.ts`; RUNBOOK, "Backups"), so a restore cannot bring back a
  deleted account, its content, a session or OAuth state; `pnpm worker restore-check`
  checks a restored database before the service opens, and paid operations stay held
  until `pnpm worker restore-reconcile` has charged the spend since the backup.
- **Retention.** The API's control maintenance also deletes expired sessions, OAuth
  state, used states and deletion confirmations (`pruneAuth`).

Tests run against a mocked Google (`tests/support/mock-google.ts`: the authorization
endpoint the browser visits and the token endpoint the server calls), offline. The races
with the handover and with deletion are reproduced with PostgreSQL locks held by the test
(`tests/integration/auth.test.ts`).

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
  the extraction image; `aviation-backup` and `aviation-restore` run the PostgreSQL 16
  client tools one-shot as the migrator login (`pnpm app:backup`, `pnpm app:restore`).
- `tunnel` (profile `tunnel`): the pinned Cloudflare Tunnel connector, sharing only
  the `edge` network with `aviation-app`.

It needs Docker Compose 2.24 or later. `live` always runs behind the Cloudflare
Tunnel with an explicit `APP_VERSION`, and only peers in its pinned edge subnet
are trusted as proxies (`TRUSTED_PROXY_CIDRS`). On `dev` every `app:up`, `app:migrate`
and `ingest` rebuilds the image from the checkout; on `live` each release tag is built
once and never rebuilt implicitly, so a rollback to an earlier tag starts the image it
was built as (RUNBOOK, "Deploying an environment"). For the importer's private dev canary,
`AVIATION_DEV_RELEASE_IMAGE=true` with `APP_VERSION` reuses an existing verified release
by immutable image ID, without building or pulling; see [Dev canary app](docs/RUNBOOK.md#dev-canary-app).
With an importer installed, every backup/restore sets `AVIATION_MAINTENANCE_LOCK` to its
maintenance lock file; bounded contention exits 75 without starting the operation
([Maintenance lock](docs/RUNBOOK.md#maintenance-lock)).

Configuration comes from env files outside the repository, named in
`AVIATION_ENV_FILES`; Compose uses them for interpolation only and each container
gets just the variables it needs. `compose.tunnel.yaml` removes the app port and
`compose.tracing.yaml` joins the shared observability network.

```sh
export AVIATION_ENV_FILES=<connection files and app secrets, comma-separated>
pnpm app:migrate          # schema migrations
pnpm app:up               # start, building the image as above (tunnel mode when TUNNEL_TOKEN is set)
pnpm ingest generations   # any worker command, in a one-shot container
pnpm app:ps               # this environment's containers
pnpm app:backup           # dump the database into AVIATION_BACKUP_DIR (RUNBOOK, "Backups")
pnpm app:down
```

The [runbook](docs/RUNBOOK.md) covers provisioning, the role model, each container's
credentials, the networks, tunnel and tracing modes, ingestion and the
local-services mode.


Task 24 adds a separate `AVIATION_EVIDENCE_RANKING` setting for evidence searches.
The default is `er-q-v1` (question-only retrieval, no rerank); live also allows
`er-q-h50-v1`, the Haiku rerank of the top 50 (owner's decision, 31 October 2026).
Dev alternatives use validated scope terms in BM25 and/or a bounded Haiku/Sonnet
reranker. See [Evidence ranking](docs/RUNBOOK.md#evidence-ranking) for configurations,
reservations, evaluation entry points and rollback. The server records executed
lexical/vector texts and the configuration hash privately; `evidence.v3` exposes the
corresponding keyword and ordering disclosures.
The hashed highlight policy preserves Task 23 suggestion highlights for the baseline;
every alternative uses executed lexical words. The web client discloses applied terms and
AI ordering (`evidence.v3`, "Web client" above and UI_DESIGN §4.9); independent clearance is
still required before any alternative is allowed on live.


Evidence.v3 adds server-owned disclosures for executed keywords, automatically applied
state, ordering, mark source and a one-use quota-free undo. The page's `undo` is
`available` for an unexpired original v3 question with automatic additions and no
claim, `used` after its claim is consumed, and `none` for edits, v2 rows or questions
without additions; expired searches return 404. Automatic filtering is
independent of ranking: `AVIATION_EVIDENCE_AUTO_FILTERS=none` is the default;
`state-explicit.v1.3` is an explicit opt-in on dev or live. No other scope field
is applied automatically. See
[the v3 rollout](docs/RUNBOOK.md#evidence-automatic-filters-and-v3-rollout) for migration
0025, the matching client, rollback and accounting. Existing v2 records upgrade on
read; the original scope.e3 wire schema and all evaluated ranking hashes are unchanged.

### Search progress, ratings and administration

`GET /api/evidence/progress/:key` returns the real scope, retrieval (including embedding),
and rerank stages from `EvidenceProgressSchema`. The key is the POST's idempotency key.
Progress is bound to the account or valid trial presented at POST arrival, or to the
HMAC'd network identity when neither is presented. The latter lets the first anonymous
search show progress before its trial cookie arrives. Poll with the same identity;
404 means unknown, expired or mismatched. A changed network during that first search
falls back to the generic loading card. No poll creates an identity or starts work.
Entries last five minutes after completion, with a process-local 1,000-entry LRU.

`POST /api/evidence/:id/feedback` accepts `{rating: "useful" | "not_useful"}` and returns
204. Only the current owner may rate an unexpired result. Changing a rating replaces
it; repeated submissions do not add votes. This costs no search or provider request.
The private rating expires with its search; identity-free daily counts remain. With
tracing enabled, a best-effort background score updates that search's trace.

Set `AIRCASE_ADMIN_EMAILS` to comma-separated verified Google email addresses to allow
`GET /api/admin/overview`. The default grants nobody access. Administrators receive
`isAdmin: true` from `/api/account`; other responses omit the flag. The overview shows
names/emails, session activity, charged evidence-search counts over 1/7/30/90 UTC days, daily
usage, feedback, settled costs, budgets and system state. It returns at most 1,000 users,
uses private no-store responses and never traces the overview. Non-admins receive 404.
The endpoint has no administrative write operations. It has a 15-second overall deadline
and refuses to process more than 10,000 accounts. Search metrics exclude AI briefs;
settled costs include all categories. `costs.interactiveToday` isolates today's interactive
spend for its daily budget meter. Older reservations without outcome metadata are
counted as neither known failures nor free undos.

Before enabling tracing for a release, mirror the frozen prompt templates with
`pnpm -s worker langfuse-prompts --sync` using that environment's project credentials.
The command creates version 1 of `aircase-scope.e3` and `aircase-rerank.r1`, or verifies
the existing content hash. A mismatch stops it; prompts are never fetched by searches.
Generation spans link these versions and export model names. Export failures remain
non-blocking, produce at most one sanitized warning every five minutes, and appear
with the last successful export time in the admin overview.
