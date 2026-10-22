# Aviation Casebook

Find and compare NTSB aviation investigations using their evidence, findings, and
probable causes. For flight instructors preparing case-based lessons and safety
analysts exploring similar events.

**Status: Design.** No application server or public deployment exists yet.

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

`.env.example` is a proposed configuration contract, not a working
runtime configuration. Setup/run commands will arrive with implementation.
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
pnpm test            # offline unit tests
pnpm typecheck
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

`compose.yaml` (Compose project `ai-aviation`) runs pinned PostgreSQL 17.6 and
Elasticsearch 9.5.5 (single node, security on, 2 GB heap, ML disabled). Both
bind to loopback only; HTTP TLS is disabled for this local profile. Ports come
from `POSTGRES_PORT` (default 55432) and `ELASTICSEARCH_PORT` (default 59200).

```sh
pnpm services:up      # generate bootstrap passwords, start services, wait until healthy
pnpm services:setup   # create database roles, Elasticsearch roles, and scoped API keys
pnpm test:integration
pnpm services:down    # stop; data volumes are kept
```

Secrets are generated on first run into the ignored `.env.local` (mode 0600),
which `services:up` also passes to Compose via `--env-file`. Values are never
printed. `services:setup` is idempotent and writes:

- `DATABASE_URL` (`aviation_app`), `DATABASE_MIGRATOR_URL` (`aviation_migrator`,
  owns the schema) and `DATABASE_INGEST_URL` (`aviation_ingest`) for the
  `aviation` database; integration tests use `aviation_test` with the same roles.
  Default privileges give both runtime roles SELECT on future tables; migrations
  grant DML explicitly.
- `ELASTICSEARCH_READ_API_KEY` (read-only on `aviation-*`, for the HTTP process)
  and `ELASTICSEARCH_WRITE_API_KEY` (ingestion; `aviation-*` only).

Integration tests create only `aviation-test-*` indices and clean them up.

### NTSB fixtures and normalization

`fixtures/ntsb/` holds the projected-CSV rows of 16 public NTSB events (US
government works) from the 2026-10-16 `avall.zip` snapshot, exactly as extracted
(including CRLF inside narratives): the four seed cases, multi-aircraft,
HTML-narrative, non-US and P/blank/B-without-cause examples.
`fixtures/ntsb-malformed/` is synthetic. `pnpm fixtures:build --from <extraction dir>`
regenerates both; the event list and the reason for each is in
`scripts/build-fixtures.ts`.

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

The canonical corpus lives in PostgreSQL 17. The Drizzle schema is in
`server/db/schema/`; SQL migrations generated by drizzle-kit are in
`server/db/migrations/`. Grants, lifecycle triggers and functions are in
hand-written migrations, because drizzle-kit does not generate them.

```sh
pnpm db:migrate                          # as aviation_migrator, on the database in DATABASE_MIGRATOR_URL
pnpm db:migrate --database aviation_test # integration tests also migrate it automatically
pnpm db:generate                         # after a schema change: writes a new SQL migration
```

Worker commands read `AVIATION_ENV_FILES`, or the app's ignored `.env.local` when
that variable is unset, and connect as `aviation_ingest`:

```sh
pnpm worker load --from data/work/<extraction-dir>
pnpm worker verify --generation <id> [--profile <file>]
pnpm worker generations                              # generations, plus runs still marked running
pnpm worker fail-stale-runs --older-than-minutes <n> # close runs left running by a dead process
```

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
- **Manifests.** `publishManifest` (called once both search indices of a generation
  exist) activates that generation in one transaction; at most one manifest is
  active, and the API reads it through `getActiveManifest`. Publishing, including a
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
pnpm worker index cases --generation <id>   # aviation_ingest + ELASTICSEARCH_WRITE_API_KEY
```

- **Build.** Under the lifecycle lock the command checks that the generation is
  `verified` (or already `published`) with a latest verification `ok` by the current
  verifier, and pins it (`pin_generation`, two hours) so pruning cannot remove it
  mid-build; the pin is released at the end. A generation without US events is
  refused. It reads the US events in batches of 500 from one repeatable-read
  snapshot (`server/db/queries/case-records.ts`), creates
  `<prefix>-cases-v2-g<generation>-<UTC timestamp>` (one shard, no replicas, refresh
  off while loading), bulk-loads it, refreshes it and checks it against the database:
  documents equal the generation's US events, nested aircraft equal its aircraft, and
  the answer-eligible, multi-aircraft and non-US counts match. Any failure up to here
  deletes the new index.
- **Alias.** `<prefix>-cases` means "the cases index built last", for operators.
  The API never reads it: it uses the index names of the active `dataset_manifests`
  row, published separately once the passages index of the same generation exists.
  Switches are serialized per alias with a PostgreSQL advisory lock; one `_aliases`
  request removes every current target and adds the new index, and the outcome is
  read back. The new index is deleted only when the read-back shows the alias does
  not include it; if the outcome cannot be read, the index is kept and the command
  fails naming it. Previous indices are kept.
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
- **Text analysis** (`worker/index/analysis.ts`). Indexing: standard tokenizer,
  lowercase, possessive stemmer, English stop words minus negations (`no`, `not`
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

Integration test files run one at a time: they share `aviation_test` and the
`aviation-test-*` indices, and some of them reset both.
