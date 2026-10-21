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

`fixtures/ntsb/` holds the projected-CSV rows of 15 public NTSB events (US
government works) from the 2026-10-16 `avall.zip` snapshot: the four seed cases,
multi-aircraft, HTML-narrative, non-US and P/blank/B-without-cause examples.
`fixtures/ntsb-malformed/` is synthetic. `pnpm fixtures:build --json <dir>` (research
JSON exports) or `--csv <dir>` (an extraction directory) regenerates both; the
event list and the reason for each is in `scripts/build-fixtures.ts`.

`worker/ingest/normalize.ts` turns projected tables into canonical cases. It fails
on missing columns, duplicate composite keys and blank or duplicate case numbers,
and lists value-level problems (invalid coordinates, unknown flag values) in a
quarantine report instead of coercing them. Citation text is the narrative as
exported with CRLF converted to LF; narratives containing HTML are converted to
text (`CITATION_TEXT_VERSION`) and the original is kept. Completion uses the
provisional, unverified `COMPLETION_MAPPING_V1` (status `B` is completed).

### Web client

`web/` is a React 19 single-page app built with Vite, React Router, TanStack Query
and Tailwind CSS 4. It implements the "Sectional" design system from
[UI_DESIGN.md](docs/UI_DESIGN.md) §2: tokens in `web/src/styles/tokens.css` (day on
`:root`, night "Panel" on `[data-theme="night"]`), mapped into the Tailwind theme in
`web/src/styles/index.css`, which clears Tailwind's default palette, type scale and
breakpoints. Components never use raw colours. Pages are placeholders until the
API exists.

```sh
pnpm dev:web          # Vite dev server; /api is proxied to the API server
pnpm build:web        # production build into dist/web
pnpm test:web         # component tests (jsdom, offline)
```

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

### Language-model provider

`server/ai/` holds the provider interface (`provider.ts`) that the scope, compose
and check stages call, the Anthropic adapter (`anthropic.ts`), a deterministic fake
for tests (`fake.ts`, allowed only with `NODE_ENV=test`) and versioned prompts
(`prompts/*.v1.ts`). Each stage validates its bounded input, sends the question and
passages as delimited untrusted data in the user turn, and returns a Zod-validated
object with normalized usage (input, output including thinking, cache write, cache
read), provider, model and prompt version. The OpenAI adapter is not built yet.

Anthropic calls use `messages.parse` with structured outputs, effort `low`, no
retries, a cached system prompt, and no prefill, sampling parameters or refusal
fallbacks. Thinking is disabled on Haiku 5.5, turned off with `between_tools` on
Sonnet 5.5, and cannot be disabled on Opus 5.5. Each stage first counts its input
with `messages.countTokens` on the identical request (`countInputTokens` exposes the
same count for evidence packing) and sends nothing above the stage cap. The whole
call is bounded by the caller's deadline signal and the stage's `timeoutMs`. A
refusal, `max_tokens`, unparsed output, a failed count or input above the cap fails
the stage with a `StageError` that says whether the call was billed.

`pricing.ts` holds the allowlisted prices, the hard token caps per stage and the
per-request reservations ($0.14 Opus, $0.07 Sonnet, $0.01 Haiku answer model).
`startupAiCheck(config)` enables AI only when the provider has an adapter, its keys
are set, every reachable model is priced and the worst-case request (all stages at
their caps plus cache-write premiums) fits the reservation. Change a price, cap or
model only together with the expected sums in `tests/unit/pricing.test.ts`.
Adapter tests run the real SDK client against a stubbed `fetch`; nothing is sent.
