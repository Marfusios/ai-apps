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
