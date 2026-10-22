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
pnpm worker index cases --generation <id>          # aviation_ingest + ELASTICSEARCH_WRITE_API_KEY
pnpm worker index reconcile --alias <alias> [--declare-abandoned <attempt-id> --reason <text>]
pnpm worker index delete-unused --older-than <hours> [--alias <alias>] [--yes]
pnpm worker index cleanup-builds --older-than <hours>
```

- **Build.** Each run has a random build id, part of its index name
  `<prefix>-cases-v2-g<generation>-<UTC timestamp>-<build id>` and of its generation
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
  row, published separately once the passages index of the same generation exists.
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
```

### API contracts and the mock API

`shared/contracts/{config,search,cases,dashboard}.ts` are the Zod contracts of the
public API (`GET /api/config`, `/api/search`, `/api/cases/:ntsbNo`,
`/api/dashboard`). Every object is strict, `ev_id` never appears, and the case
detail is NTSB-only by construction (a test walks the schema for AI fields). The
web client validates every response against them. `shared/case-view.ts` builds the
deterministic headline, finding text and data cautions; `shared/vocab.ts` holds the
code labels from the NTSB data dictionary.

`pnpm mock:build` normalizes `fixtures/ntsb` and `fixtures/ntsb-ui` with
`normalizeCorpus` and writes contract-valid responses to `web/mock/*.json` (config,
both dashboard cohorts, every case detail, a search index and sample searches).
`web/mock/engine.ts` answers any search over that index with the real counting
rules (distinct events, disjunctive facets, defining-event phase, multi-aircraft
overlap, "remove one filter" totals) and a simple stand-in for the analyzer.
`web/src/mocks/handlers.ts` serves it through MSW, in the dev mock mode and in tests;
production builds contain no mock code. A unit test fails when the committed mock
files are out of date.

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
  identities after 30 days, and ledger lines and closed reservations after 90 days.

The kill switch pauses interactive AI only:

```sh
pnpm worker ai-switch                        # show it
pnpm worker ai-switch --off --note "<why>"   # pause (reason: maintenance)
pnpm worker ai-switch --on
```

## Deployment with Docker Compose

`compose.yaml` runs the application once per environment, as Compose projects
`ai-aviation-dev` and `ai-aviation-live` (`APP_ENV`), connected to the shared
PostgreSQL, Elasticsearch and Langfuse through their Docker networks. Each
environment has its own database (`aviation_dev`, `aviation_live`) and logins,
index prefix (`ai-aviation-dev`, `ai-aviation-live`) and Langfuse project
(`aviation-dev`, `aviation-prod`). It runs no database or search engine itself;
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

The API server entry (`server/main.ts`) is not built yet, so `app:up` stops with a
message until it exists; the image and the tools already work. The
[runbook](docs/RUNBOOK.md) covers provisioning, the role model, each container's
credentials, the networks, tunnel and tracing modes, ingestion and the
local-services mode.
