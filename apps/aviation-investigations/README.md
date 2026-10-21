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

The canonical corpus lives in PostgreSQL 17 (the loader needs the `MAINTAIN`
privilege added in 17). The Drizzle schema is in `server/db/schema/`; SQL
migrations generated by drizzle-kit are in `server/db/migrations/`, with grants in
a hand-written migration because drizzle-kit does not generate them.

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
pnpm worker generations
```

- **Dataset generations.** Every load writes a new generation in one transaction;
  a failure rolls it back and marks the ingestion run `failed`, leaving earlier
  generations untouched. Primary keys start with `generation_id` and foreign keys
  are composite, so rows only reference rows of their own generation. The ingest
  role can insert and delete corpus rows but never update them; old generations
  are only removed whole by `pruneGenerations` (the last two published are kept).
- **Load input.** `load` rejects a directory without a valid `manifest.json`, or
  whose manifest disagrees with its CSV files (tables, byte sizes, columns,
  mdb-export flags), before writing anything. Row counts read must equal the
  manifest's.
- **Sections.** `section_id` is `<ntsb_no>:<section_key>`; `revision_id` is a
  sha256 over the case number, section key, text hash and citation-text version,
  so unchanged text keeps its revision across generations. Each narrative row
  behind a section is kept in `case_section_sources`. Its exported text is stored
  only when it cannot be rebuilt from the section text (HTML, whitespace variants,
  mixed line ends); otherwise `source_form` says whether it was identical or the
  same text with CRLF line ends. Either way it reproduces `source_sha256`.
- **Verification.** `verify` refreshes planner statistics, checks generic
  invariants (unique nonblank case numbers, parents within the generation, section
  and source hashes, revision ids, event-scoped sections only in multi-aircraft
  events, the answer-eligibility and completion-mapping rules), reconciles stored
  counts with the normalization stats and with every source row in the extraction
  manifest, and marks the generation `verified` or `failed`. It writes
  `data/work/verify-gen-<id>.json` with aggregate counts only. Snapshot-specific
  expectations live in `worker/ingest/verify-profiles/` and apply automatically to
  the archive whose hash they name.
- **Manifests.** `publishManifest` (called once both search indices of a generation
  exist) activates that generation in one transaction; at most one manifest is
  active, and the API reads it through `getActiveManifest`.
