# Aviation Casebook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Aviation Casebook beta locally. It covers:

- NTSB ingestion into PostgreSQL
- Elasticsearch keyword and hybrid retrieval with OpenAI embeddings
- the cost-gated, evidence-checked AI brief pipeline on Anthropic
- the "Sectional" React interface
- the public-beta controls

**Architecture:** This is one TypeScript package in `apps/aviation-investigations/`, with `shared/`, `server/`, `worker/`, `web/`, `tests/`, `evals/` and `fixtures/`.

- PostgreSQL holds canonical cases, identity, briefs and quotas.
- Elasticsearch holds two rebuildable, versioned, aliased indices: cases and passages.
- Fastify serves the API and the built Vite assets on one origin.
- A worker CLI runs ingestion, indexing and evaluations.
- Language-model calls go through a provider interface: Anthropic first, plus a deterministic fake for tests.

**Tech stack:**

| Layer | Choice |
| --- | --- |
| Runtime and tooling | Node 24 (v24.21.0), pnpm 12 (via corepack), TypeScript strict |
| Server | Fastify 5, Zod |
| Database | Drizzle ORM + `pg` on PostgreSQL 17 |
| Search | `@elastic/elasticsearch` 9 on Elasticsearch 9.5.5 |
| Language models | `@anthropic-ai/sdk` |
| Embeddings | `openai` |
| Token counting for chunking | `js-tiktoken` |
| Auth | Better Auth |
| Web | React 19, Vite, React Router, TanStack Query, Tailwind CSS 4, Radix primitives (shadcn/ui style), Lucide, `@fontsource` B612/B612 Mono/Source Serif 4 |
| Tests | Vitest, Testing Library, Playwright |
| Observability | Langfuse v4 OTel |

**Spec:** [DESIGN.md](DESIGN.md), [UI_DESIGN.md](UI_DESIGN.md),
[OBSERVABILITY_AND_EVALUATION.md](OBSERVABILITY_AND_EVALUATION.md),
[SECURITY_REVIEW.md](SECURITY_REVIEW.md), [DATA_REVIEW.md](DATA_REVIEW.md). Read
the sections a task cites before starting it.

## Global Constraints

- **Public-ready repo:**
  - No credentials, personal paths, private hostnames, LAN addresses or
    references to private infrastructure in committed files.
  - Credentials come only from the process environment or explicit dotenv files
    named in `AVIATION_ENV_FILES`. Load only allowlisted variable names, and
    never overwrite a nonempty process value.
- **Committed fixtures:** only synthetic data or public NTSB records (US
  government works). Downloads, extracted CSVs, databases and reports live in
  ignored `data/`.
- **Tests:**
  - `pnpm test` is offline and needs no provider keys.
  - `pnpm test:integration` needs only the local compose services.
  - Provider-backed jobs are explicit opt-in commands with their cost printed
    first.
- **Commits:**
  - Plain messages; **no `Co-Authored-By` or other AI attribution trailers.**
  - Commit after each task step that says so.
  - Run `python3 scripts/check_repo.py` (repo root) before every commit.
- **Corpus scope:**
  - The `avall.zip` 2008+ archive.
  - US events (`ev_country = 'USA'`) go into the cases index.
  - Only completed cases with probable-cause text (24,291 in the 2026-10-16
    snapshot) get passages, embeddings and AI answers.
  - The public case key and URL use the event `ntsb_no`. `ev_id` stays
    internal.
- **Embeddings:** `text-embedding-3-small`, 1,536 dimensions, cosine,
  `int8_hnsw`. Model, dimensions, normalization and chunking are versioned
  together in the index name.
- **Retrieval:**
  - BM25 + filtered kNN, 50 candidates each.
  - Fused in TypeScript with reciprocal rank fusion `sum(1/(60+rank))`.
  - At most 6 cases and 12 passages per answer.
  - No `query_string`, regex, wildcard or scripts built from user or model text.
- **AI defaults:**
  - Scope and check: `claude-haiku-5-5` with thinking disabled and effort `low`.
  - Answer: `claude-opus-5-5` with effort `low`.
  - `maxRetries: 0`.
  - A 60 s pipeline deadline.
  - Reservations: Opus $0.14, Sonnet $0.07, Haiku $0.01 (planned; now $0.31, $0.16 and $0.02, DESIGN §9). The startup check
    sums all stages plus cache-write premiums.
- **Budget defaults:**
  - $100/month total: $80 interactive and $20 indexing/evaluation, $3/day
    interactive.
  - The anonymous share is 25%.
  - Anonymous trial: 3 AI requests.
  - Signed-in users: 20/day and 150/month; new accounts 5/day for their first
    3 days.
- **Interface:**
  - Colour jobs: ink is NTSB text, blue is interactive, magenta is AI only.
  - AI content appears only inside the viewer's own live brief.
  - Copy is exactly as in UI_DESIGN §5.
  - Tokens are exactly as in UI_DESIGN §2.2. Muted is `#58616B`.
- **Network:** Fastify uses `trustProxy: false`. Network identity comes from
  one adapter; never use `request.ip` for buckets.

## Review Focus

1. **Real NTSB text quirks:**
   - text containing `\r\n`, smart quotes, `“ ”`, non-breaking spaces and
     trailing spaces
   - a probable cause that ends without a period

   Citation offsets and exact-quote checks must still match. Covered by Task 9
   (chunk offsets round-trip) and Task 16 (quote validation on CRLF/NBSP
   fixtures).
2. **Multi-aircraft events** (545 in the snapshot): one aircraft's
   make/category must not satisfy a filter while evidence comes from the other.
   Covered by Task 7 (nested query test) and Task 10 (same-aircraft retrieval
   test).
3. **Search input:** empty searches, 1,500-character questions, and Lucene
   syntax characters typed into the box (`"carb* AND (icing"`). These must be
   treated as plain text, never as errors or query syntax. Covered by Task 8.
4. **Concurrency:** two concurrent AI requests from one anonymous visitor with
   one free search left must not both run. Covered by Task 15.
5. **Provider failures:** a refusal, a truncation (`max_tokens`) or a timeout
   at the compose stage must withhold the summary, return case cards and
   settle the charge conservatively. Covered by Task 16.

## Data-review gates (owner requirement)

Before any task step that changes how real NTSB data is extracted, stored,
chunked, embedded, indexed or retrieved, the orchestrator sends the relevant
design and code to **GPT-6-Astra** and applies its findings first. GPT-6-Astra
is the Codex session in tmux session `ai2`. Gates:

| Gate | Before |
| --- | --- |
| G1 | Task 3 runs on real data: archive handling, extraction, allowlisted columns |
| G2 | Task 5's full load: canonical schema, normalization, completion mapping, invariants |
| G3 | Task 7's full index: cases mapping, analyzers, synonyms, document builder |
| G4 | Task 9's full embedding run: chunking, contextual headers, embedding inputs, passages mapping (this run costs money) |
| G5 | Task 10's defaults are locked: retrieval queries, fusion, diversification, and the evaluation results |
| G6 | Task 16: what the model sees, and the quote validation |

---

## Phase A — Foundation

### Task 1: Toolchain, package scaffold and configuration loader

**Files:**
- Create: `package.json`, `pnpm-lock.yaml`, `.node-version`, `tsconfig.json`, `vitest.config.ts`, `shared/config.ts`, `shared/env-files.ts`, `tests/unit/config.test.ts`, `.gitignore` additions (`data/`, `dist/`, `.env.local`, `test-results/`, `playwright-report/`)
- Modify: `README.md` (setup section), `.env.example` (add `AVIATION_ENV_FILES`, `POSTGRES_*`, `ELASTICSEARCH_*` local defaults)

**Interfaces:**
- Produces:
  - `readDotenvAllowlisted(path: string, names: readonly string[]): Record<string, string>`. It parses dotenv syntax without executing it and returns only nonempty allowlisted names.
  - `loadConfig(opts?: { env?: NodeJS.ProcessEnv; files?: string[] }): AppConfig`.
    - The process env wins over files.
    - Files are listed in `AVIATION_ENV_FILES`, separated by commas, in priority order.
    - Zod validates the result. Typed fields include `nodeEnv`, `appUrl`, `port`, `databaseUrl`, `elasticsearch { url, apiKey?, caFile?, indexPrefix }`, `ai { llmProvider: 'anthropic' | 'openai' | 'fake', anthropic {...}, openai {...}, budgets {...}, limits {...} }`, `auth {...}`, `turnstile {...}`, `tracing {...}`.
    - `'fake'` is allowed only when `nodeEnv === 'test'`.
  - The `AppConfig` type.

Toolchain:
- The orchestrator has installed Node v24.21.0 outside the repo. Prefix commands with the Node 24 bin directory on `PATH`.
- `package.json` has `"packageManager": "pnpm@12.10.1"` and `"engines": {"node": ">=24 <25"}`.

Scripts:

| Script | Runs |
| --- | --- |
| `test` | `vitest run --project unit` |
| `test:integration` | `vitest run --project integration` |
| `typecheck` | `tsc --noEmit` |
| `worker` | `tsx worker/cli.ts` |
| `dev:server` | `tsx watch server/main.ts` |
| `dev:web` | `vite` |
| `build` | `vite build && tsc -p tsconfig.server.json` |

- [ ] **Step 1: Write failing tests** in `tests/unit/config.test.ts`:
  - `reads only allowlisted names`: given a temp file with `A=1`, `B=2` and names `['A']`, the result is `{A:'1'}`.
  - `does not execute shell syntax`: the file `A=$(touch /tmp/x)` yields the literal string and creates no file.
  - `process env wins over file`: env `{DATABASE_URL:'postgres://env'}` and a file with `DATABASE_URL=postgres://file` give `databaseUrl === 'postgres://env'`.
  - `empty process value does not block file value`.
  - `rejects fake provider outside test`: `nodeEnv:'production'` with `AI_LLM_PROVIDER=fake` throws.
  - `budget defaults`: `ai.budgets` equals `{monthlyUsd:100, interactiveMonthlyUsd:80, interactiveDailyUsd:3, ingestionMonthlyUsd:20, anonymousShare:0.25}`.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `shared/env-files.ts` and `shared/config.ts`. Defaults come from `.env.example`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** "Scaffold TypeScript package and configuration loader".

### Task 2: Local services (PostgreSQL, Elasticsearch) and least-privilege credentials

**Files:**
- Create:
  - `compose.yaml` (project name `ai-aviation`; no `container_name`)
  - `scripts/es-setup.ts`
  - `scripts/pg-setup.sql`
  - `tests/integration/services.test.ts`
  - `tests/integration/helpers.ts`

**Interfaces:**
- Produces:
  - Compose services `postgres` (`postgres:17.6`) and `elasticsearch` (`docker.elastic.co/elasticsearch/elasticsearch:9.5.5`, single node, security on, 2 GB heap). Both publish on `127.0.0.1` with ports from `POSTGRES_PORT` (default 55432) and `ELASTICSEARCH_PORT` (default 59200).
  - `pnpm services:up|down|setup`.
  - `scripts/es-setup.ts`:
    - Reads the bootstrap `ELASTIC_PASSWORD` from the ignored `.env.local`, generating it on first run.
    - Creates the roles below.
    - Mints API keys into the ignored `.env.local` as `ELASTICSEARCH_READ_API_KEY` and `ELASTICSEARCH_WRITE_API_KEY`.
  - Elasticsearch roles:

    | Role | Privileges |
    | --- | --- |
    | `aviation_reader` | `read`, `view_index_metadata` on `aviation-*` |
    | `aviation_writer` | `create_index`, `write`, `manage`, `read` on `aviation-*`, plus cluster `monitor` |

  - `scripts/pg-setup.sql` creates database `aviation` and roles:

    | Role | Privileges |
    | --- | --- |
    | `aviation_migrator` | Owns the schema |
    | `aviation_ingest` | DML on corpus tables |
    | `aviation_app` | DML on product/control tables, SELECT on corpus tables |

    Passwords are generated into `.env.local`.
  - Helpers: `testDb(): Db` and `testEs(): Client`. They use database `aviation_test` and index prefix `aviation-test-`.

- [ ] **Step 1:** Write `tests/integration/services.test.ts`:
  - `reader key cannot write`: indexing into `aviation-test-x` with the read key throws a 403.
  - `writer key can create aviation-test-x and cannot touch other-index`: a 403 outside `aviation-*`.
  - `app role cannot create tables` (Postgres).
- [ ] **Step 2: Run** `pnpm services:up && pnpm services:setup && pnpm test:integration`. Expected: PASS after implementation (FAIL before).
- [ ] **Step 3: Commit** "Add local PostgreSQL/Elasticsearch services with least-privilege credentials".

## Phase B — Data

### Task 3: Archive intake and sandboxed MDB extraction  *(gate G1 before the real run)*

**Files:**
- Create:
  - `worker/ingest/archive.ts`
  - `worker/ingest/extract.ts`
  - `worker/ingest/tables.ts`
  - `docker/extract/Dockerfile`
  - `tests/unit/archive.test.ts`
  - `tests/unit/tables.test.ts`

**Interfaces:**
- Produces:
  - `verifyArchive(zipPath: string, expectedSha256: string): Promise<{ sha256: string; bytes: number }>`.
  - `extractMember(zipPath: string, member: 'avall.mdb', outDir: string, limits: { maxCompressed: number; maxExpanded: number }): Promise<string>`. It uses `yauzl` and rejects:
    - any member other than `avall.mdb`
    - traversal (`..`, absolute paths)
    - symlinks (external attributes)
    - nested archives
    - more than one entry
    - an expanded size over 1 GiB
  - `TABLE_SPECS: Record<TableName, { columns: readonly string[] }>`. Only the explicitly selected columns are kept:
    - `events`: identity, date/time, location (city, state, country, `dec_latitude`, `dec_longitude`), weather and light fields, `metar`, injury totals, `ev_highest_injury`, `ev_type`, `lchg_date`. No `lchg_userid`.
    - `aircraft`: `ev_id`, `aircraft_key`, `ntsb_no`, `regis_no`, make/model/series, `acft_category`, `far_part`, `type_fly`, `damage`, `homebuilt`, `num_eng`, `date_last_insp`, `afm_hrs`, `afm_hrs_last_insp`, `afm_hrs_since`, `acft_year`. **No owner or operator name, street, city, zip or contact fields.**
    - `engines`: `eng_type`, `carb_fuel_injection`.
    - `narratives`: `narr_accp`, `narr_accf`, `narr_cause`, `lchg_date`.
    - `findings`: all columns except `lchg_userid`.
    - `events_sequence`: all columns except `lchg_userid`.
    - `ntsb_admin`: `rec_stat`, `approval_date`, `lchg_date`.
    - Dictionaries: `ct_seqevt`, `eadmspub_datadictionary`.
  - `runMdbExport(mdbPath: string, outDir: string): Promise<Record<TableName, string>>`. It runs the `aviation-extract` image with: `--network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 --memory 1g --cpus 2 --pids-limit 64`. The MDB is mounted read-only and only `outDir` is writable. It runs `mdb-export -D '%Y-%m-%dT%H:%M:%S' -q '"' -X '"'` per table, then projects to the allowlisted columns in TypeScript.
- `docker/extract/Dockerfile`: `debian:bookworm-slim`, pinned `mdbtools=1.0.0+dfsg-1.1`, non-root, no network at runtime.

- [ ] **Step 1: Write failing tests** with synthetic zips built in-test:
  - `rejects traversal member ../evil.mdb`
  - `rejects symlink entry`
  - `rejects nested zip`
  - `rejects expanded size over limit` (fake header)
  - `accepts single avall.mdb`
  - `TABLE_SPECS aircraft has no owner_ or oper_ columns`: assert no key matches `/^(owner_|oper_)/` and `lchg_userid` is absent everywhere.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5 (gate G1):** Orchestrator only: send `archive.ts`, `extract.ts`, `tables.ts` and the Dockerfile to Astra and apply its findings.
- [ ] **Step 6: Real run.** `pnpm worker extract --archive data/research/avall.zip --sha256 bc74fefb1b39e1b86700a4be82b8ff6014bb1f6d81008524de73f2ddbd38b052 --out data/work/extract-<timestamp>`. Expected: CSVs for every table, and `events.csv` has 31,303 data rows.
- [ ] **Step 7: Commit** "Add archive validation and sandboxed MDB extraction".

### Task 4: Normalization, completion mapping and phase decoding

**Files:**
- Create:
  - `worker/ingest/normalize.ts`
  - `shared/codes.ts`
  - `shared/completion.ts`
  - `fixtures/ntsb/` (seed-case CSV rows: DFW08TA066, MIA08LA156, DEN08LA103 and NYC08LA106, plus one two-aircraft event and synthetic malformed rows)
  - `tests/unit/normalize.test.ts`
  - `tests/unit/codes.test.ts`

**Interfaces:**
- Produces:
  - `type PhaseGroup = 'prior_to_flight'|'standing'|'pushback'|'taxi'|'takeoff'|'initial_climb'|'en_route'|'maneuvering'|'approach'|'landing'|'emergency_descent'|'uncontrolled_descent'|'post_impact'|'after_landing'|'other'|'unknown'`.
  - `phaseGroupOf(phaseNo: number): PhaseGroup`. Mapping:

    | Phase code | Group |
    | --- | --- |
    | 100 | `prior_to_flight` |
    | 150–154 | `standing` |
    | 200–203 | `pushback` |
    | 250–253 | `taxi` |
    | 300–301 | `takeoff` |
    | 350 | `initial_climb` |
    | 400–405 | `en_route` |
    | 450–453 | `maneuvering` |
    | 500–509 | `approach` |
    | 550–553 | `landing` |
    | 600–601 | `emergency_descent` |
    | 650 | `uncontrolled_descent` |
    | 700 | `post_impact` |
    | 750 | `after_landing` |
    | 800 | `other` |
    | 990 and anything else | `unknown` |

  - `PHASE_LABEL: Record<PhaseGroup, string>`, for example `en_route → 'En route'`.
  - `type CompletionClass = 'completed'|'in_progress'|'status_unknown'|'other_status'`.
  - `COMPLETION_MAPPING_V1 = { version: 'v1-provisional', verified: false, completedStatuses: ['B'], inProgressStatuses: [] }`.
  - `completionClassOf(rawStatus: string | null, mapping)`. Returns `'completed'` for a completed status, `'in_progress'` or `'status_unknown'` only when `mapping.verified`, and `'other_status'` otherwise. Probable-cause availability is a **separate** boolean.
  - `isAnswerEligible(c): boolean`: the class is completed **and** the probable cause is nonblank.
  - `normalizeCorpus(tables: RawTables): { cases: CanonicalCase[]; quarantine: QuarantineRow[] }`. Rules:
    - Dates are parsed as ISO.
    - Coordinates use only `dec_latitude`/`dec_longitude`, validated to [-90, 90] / [-180, 180]. Out-of-range values become `null` with a quarantine note, never a dropped case.
    - Text is kept byte-for-byte as citation text, except that `\r\n` becomes `\n`. That rule is recorded as `TEXT_NORMALIZATION_VERSION = 'v1'`.
    - Aircraft resolve through the `ev_id` + `aircraft_key` parent relationship, never by stripping a trailing letter.
    - The `cm_inpc` field (`'T'`/`'F'`/blank) becomes `boolean | null`.
  - `CanonicalCase` holds `ntsbNo`, `evId`, fields, `aircraft[]`, `sections[]` (kind `'factual'|'analysis'|'probable_cause'`, `aircraftKey`, `text`, `sha256`), `findings[]`, `sequence[]` (phase code, group, event code, description, `isDefining`), `rawStatus`, `completionClass`, `hasProbableCause` and `sourceRevision`.

- [ ] **Step 1: Write failing tests:**
  - `phaseGroupOf(453) === 'maneuvering'`, `phaseGroupOf(601) === 'emergency_descent'` and `phaseGroupOf(990) === 'unknown'`.
  - `completed B with cause is answer-eligible`.
  - `B without cause stays completed but not eligible`.
  - `P is other_status while mapping unverified`.
  - `DFW08TA066 normalizes`: one aircraft (Hughes OH-6A, helicopter category); the defining event is in phase group `maneuvering`; there are two findings with `inProbableCause === true`; the probable cause starts with "The contract mechanic's failure".
  - `two-aircraft fixture keeps findings attributed to their aircraftKey`.
  - `CRLF converted, NBSP preserved`.
  - `owner fields absent from CanonicalCase`.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** "Normalize NTSB tables into canonical cases".

### Task 5: Canonical PostgreSQL schema and corpus load  *(gate G2 before the full load)*

**Files:**
- Create:
  - `server/db/schema/corpus.ts`
  - `server/db/schema/index.ts`
  - `server/db/client.ts`
  - `drizzle.config.ts`
  - `server/db/migrations/*`
  - `worker/ingest/load.ts`
  - `worker/ingest/verify.ts`
  - `worker/cli.ts` (commands `extract`, `load`, `verify`)
  - `tests/integration/load.test.ts`

**Interfaces:**
- Consumes: `normalizeCorpus`, `CanonicalCase` (Task 4); `runMdbExport` (Task 3).
- Produces:
  - Tables:
    - `ingestion_runs(id, archive_sha256, started_at, finished_at, status, counts jsonb, mapping_version, text_normalization_version)`
    - `cases(ntsb_no pk, ev_id unique, …, completion_class, raw_status, has_probable_cause, is_us, source_revision, run_id)`
    - `case_aircraft(ntsb_no, aircraft_key, aircraft_ntsb_no, …)`
    - `case_sections(id, ntsb_no, aircraft_key, kind, text, sha256, revision)`
    - `case_findings(…, in_probable_cause)`
    - `case_sequence(…)`
    - `code_dictionary(table_name, column_name, code, meaning)`
    - `quarantine(run_id, table_name, key, reason)`
  - `createDb(url: string): Db`.
  - `loadCorpus(db: Db, cases: CanonicalCase[], run: RunMeta): Promise<LoadReport>`. Upserts by `ntsb_no` in one transaction per 1,000 cases. A changed section sha marks dependent assertions stale; that is a no-op hook for now.
  - `verifyCorpus(db): Promise<VerifyReport>`. It asserts:
    - `ntsb_no` is unique and nonblank
    - every aircraft has a parent case
    - US counts and eligible counts are recorded

    It writes `data/work/verify-<run>.json`.

- [ ] **Step 1: Write failing integration tests** (fixtures into `aviation_test`):
  - `loads seed cases`
  - `reload is idempotent` (row counts unchanged)
  - `changed narrative updates section sha and revision`
  - `rejects duplicate ntsb_no` (the run fails and status is `'failed'`)
  - `app role can read corpus but not write it`
- [ ] **Step 2–4:** fail, implement, pass. Use `pnpm db:migrate` with the migrator role.
- [ ] **Step 5 (gate G2):** orchestrator sends the schema, normalization, completion mapping and load invariants to Astra and applies its findings.
- [ ] **Step 6: Full load.** `pnpm worker load --from data/work/extract-<ts>` then `pnpm worker verify`. Expected:

  | Measure | Value |
  | --- | --- |
  | Events | 31,303 |
  | US events | 25,407 |
  | Answer-eligible | 24,291 |
  | Completed without cause | 2 |
  | Unique `ntsb_no` | 31,303 |

- [ ] **Step 7: Commit** "Add canonical corpus schema and verified load".

### Task 6: Report links

**Files:**
- Create:
  - `shared/report-links.ts`
  - `worker/ingest/report-links.ts`
  - `fixtures/report-links-seed.json` (the four seed IDs verified on 2026-10-16: DFW08TA066→67493, DEN08LA103→68245, MIA08LA156→68586, NYC08LA106→67552)
  - `server/db/schema/corpus.ts` addition `report_links(ntsb_no, aircraft_ntsb_no, report_id, source, retrieved_at)`
  - `tests/unit/report-links.test.ts`

**Interfaces:**
- Produces:
  - `reportUrl(reportId: string): string | null`. It accepts `/^\d{1,9}$/` only and returns `https://data.ntsb.gov/carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/${id}/pdf`.
  - `AVIATION_SEARCH_URL = 'https://my.ntsb.gov/aviation'`.
  - `importAviationSearchExport(db, filePath): Promise<ImportReport>`. It maps by case/aircraft number and date and refuses unknown field layouts with a clear error.
  - The worker command is `report-links`.

- [ ] Tests:
  - `rejects non-numeric id`
  - `builds fixed-template url`
  - `seed import maps four cases`
  - `unknown export layout throws listing found headers`
- [ ] Commit "Add report-link mapping with verified seed IDs". The full Aviation Search export is an open owner/verification item; record it in the morning report.

## Phase C — Search

### Task 7: Cases index (keyword search projection)  *(gate G3 before the full index)*

**Files:**
- Create:
  - `server/search/es.ts` (client factory with CA and API key)
  - `worker/index/cases-index.ts`
  - `worker/index/synonyms.ts`
  - `worker/index/aliases.ts`
  - `tests/unit/cases-doc.test.ts`
  - `tests/integration/cases-index.test.ts`

**Interfaces:**
- Produces:
  - `CASES_INDEX_VERSION = 'cases-v1'`. The index name is `${prefix}-${version}-${timestamp}` and the alias is `${prefix}-cases`.
  - `CASES_MAPPING` with `dynamic: 'strict'`:
    - Keyword fields for every facet.
    - `aircraft` is `nested` (make, model, category, far_part, purpose, damage, eng_type, homebuilt, aircraft_ntsb_no).
    - Text fields `probable_cause`, `analysis`, `factual` and `findings_text` use the `english` analyzer, with search analyzer `english_aviation` (`synonym_graph` from `synonyms.ts`).
    - `location` is a `geo_point`.
    - `ev_date` is a `date`.
    - Also `completion_class`, `answer_eligible` and `phase_groups` (all) plus `defining_phase_group`.
    - One shard, zero replicas.
  - `AVIATION_SYNONYMS: string[]`, for example `carb, carburetor, carburettor`, `cfi, flight instructor`, `wx, weather`, `imc, instrument meteorological conditions`, `vmc, visual meteorological conditions`, `stall/spin` handling. The list is versioned in the index version.
  - `buildCaseDocument(c: CaseRecord): CaseDoc`.
  - `rebuildCasesIndex(es, db, opts): Promise<IndexReport>`. It creates a new index, bulk loads it, verifies the count equals the US case count, then atomically switches the alias and keeps the previous index.

- [ ] Tests:
  - `doc for DFW08TA066 has nested aircraft category helicopter and defining_phase_group maneuvering`.
  - `nested query: category=airplane AND make=Hughes on two-aircraft fixture does not match across aircraft`.
  - `carb matches carburetor via synonyms`.
  - `alias switch is atomic` (search during the switch never returns 0).
- [ ] Gate G3, then full index: `pnpm worker index cases`. Expected count: 25,407.
- [ ] Commit "Add versioned cases index with aliases and synonyms".

### Task 8: Fastify API — config, keyword search, cases, dashboard

**Files:**
- Create:
  - `server/app.ts` (`buildApp(deps): FastifyInstance`)
  - `server/main.ts`
  - `server/http/network-identity.ts`
  - `server/http/security-headers.ts`
  - `server/routes/config.ts`
  - `server/routes/search.ts`
  - `server/routes/cases.ts`
  - `server/routes/dashboard.ts`
  - `server/search/keyword.ts`
  - `server/search/dashboard.ts`
  - `shared/contracts/*.ts`
  - `tests/integration/api-search.test.ts`
  - `tests/unit/network-identity.test.ts`

**Interfaces:**
- Produces:

  | Endpoint | Request | Response |
  | --- | --- | --- |
  | `GET /api/config` | — | `{ turnstileSiteKey, googleEnabled, snapshotDate, datasetRevision }` |
  | `GET /api/search` | Zod `SearchRequest`: `q` ≤1,500 chars, `mentionedIn: 'anywhere'\|'probable_cause'`, facet arrays (phase, injury, conditions, light, category, far_part, purpose, state, completion), `yearFrom`/`yearTo`, `sort: 'newest'\|'oldest'\|'relevance'`, `page` ≤50, `pageSize` ≤50 | `{ total, rows: CaseRow[], facets: Record<Facet, {value,count}[]> }`. Facets are disjunctive (each facet's counts exclude its own selection). Highlights are the snippet from the matching section with the section label. |
  | `GET /api/cases/:ntsbNo` | — | NTSB-only `CaseDetail`, `Cache-Control: public, max-age=300` with an ETag that includes the dataset revision. A 404 for unknown numbers. |
  | `GET /api/dashboard?cohort=…` | — | Counts by year (eligible vs other), phase, injury, weather, category and coverage, plus dot-map points. The points are projected server-side to a 1000×637 lower-48 frame, and the cached response includes the dataset revision. |

  - `networkIdentity(req, mode: 'dev-loopback' | 'cloudflare-connector', connectorPeers: string[]): string`.
    - In connector mode, `CF-Connecting-IP` is accepted only when the socket peer is in `connectorPeers`. A missing or invalid header throws `401`.
    - IPv6 is normalized to /64, and IPv4-mapped addresses are unwrapped.

- [ ] Tests:
  - `q "carburetor icing" mentionedIn probable_cause on fixture returns expected ids`.
  - `Lucene syntax is literal`: `q='carb* AND (icing'` returns 200 with no exception.
  - `1,501-char q is 400`.
  - `unknown facet value is 400`.
  - `disjunctive phase counts ignore phase selection`.
  - `case endpoint never contains AI fields` (the schema forbids them).
  - `forged CF-Connecting-IP from non-connector peer rejected`.
  - `security headers present` (CSP without `unsafe-inline` scripts).
- [ ] Commit "Add API for config, keyword search, cases and dashboard".

### Task 9: Passages, chunking and embeddings  *(gate G4 before the paid run)*

**Files:**
- Create:
  - `worker/index/chunk.ts`
  - `worker/index/embed.ts`
  - `worker/index/passages-index.ts`
  - `server/db/schema/corpus.ts` additions `passages(id, ntsb_no, aircraft_key, scope, section_id, section_sha, start, end, token_count)` and `embedding_cache(text_sha256, model, dims, vector real[])` (as built: `server/db/schema/passages.ts`; the cache key is a SHA-256 of the input template version, model, dimensions and exact input, and the vector is stored as float32 `bytea`)
  - `server/ai/ledger-ingest.ts` (indexing spend metering)
  - `tests/unit/chunk.test.ts`
  - `tests/integration/passages-index.test.ts`

**Interfaces:**
- Produces:
  - `chunkSection(section: SectionText, opts = { targetTokens: 650, maxTokens: 800, minTokens: 200, overlapTokens: 80 }): PassageDraft[]`.
    - It splits on paragraph, then sentence boundaries, measured with `js-tiktoken` `cl100k_base`.
    - Probable-cause sections and sections of at most 800 tokens stay whole.
    - Offsets are UTF-16 code-unit indices into the stored section text; `text === section.text.slice(start, end)` always holds.
  - `passageEmbeddingInput(p: PassageDraft, c: CaseHeader): string` is `"${sectionLabel} · ${makeModel} · ${phaseLabel}\n${text}"`. Only the raw passage text is stored and cited; the header is embedding input only.
  - `Embedder` interface: `{ model; dims; embed(texts: string[]): Promise<{ vectors: Float32Array[]; tokens: number }> }`.
    - `createOpenAIEmbedder(cfg)` uses `maxRetries: 0` and its own bounded retry with backoff on 429/5xx only. Batches hold at most 96 inputs and at most 250k tokens.
    - `createFakeEmbedder(dims)` is deterministic (a hash-seeded vector).
  - `meterIndexingSpend(db, usd)` refuses when the $20 indexing/evaluation month would be exceeded.
  - `PASSAGES_INDEX_VERSION = 'passages-v1-te3s-1536-c650'` (as built: `'passages-v1'`; the model, dimensions, chunker and input-template versions go into the index `_meta` fingerprint instead of the name). Mapping, `dynamic: 'strict'`:
    - `passage_id`, `ntsb_no`, `aircraft_key`, `scope: 'aircraft'|'event'`, `section_kind`, `section_sha`, `start`, `end`, `text` (english + aviation synonyms)
    - `embedding` (`dense_vector`, 1536, cosine, `int8_hnsw`)
    - copied filters: `ev_year`, `state`, `answer_eligible`, `phase_groups`, `highest_injury`, `wx_cond`, `light`, and `aircraft` (nested: category, make, far_part, purpose, eng_type)
  - `rebuildPassagesIndex(es, db, embedder, opts)`.
    - It indexes only answer-eligible cases and reuses `embedding_cache`.
    - It prints the estimated tokens and cost and requires `--confirm-cost` before calling the paid embedder.

- [ ] Tests:
  - `offsets round-trip on CRLF/NBSP/smart-quote fixture text`
  - `probable cause never split`
  - `no chunk exceeds 800 tokens`
  - `overlap present between consecutive chunks`
  - `cache hit avoids embedder call`
  - `refuses without --confirm-cost`
  - `fake-embedder index has answer_eligible docs only`
- [ ] Gate G4 (send the chunk statistics from a dry run: passage count, token total, estimated $), then `pnpm worker index passages --confirm-cost`. Record the actual tokens and $ in the run report.
- [ ] Commit "Add section-aware chunking, embeddings and passages index".

### Task 10: Hybrid retrieval and retrieval evaluation  *(gate G5)*

**Files:**
- Create:
  - `server/search/hybrid.ts`
  - `server/search/filters.ts` (one compiler shared by both channels)
  - `evals/retrieval/dataset.json` (seed questions with expected case IDs; public data)
  - `evals/retrieval/run.ts`
  - `tests/unit/rrf.test.ts`
  - `tests/integration/hybrid.test.ts`

**Interfaces:**
- Produces:
  - `compileFilters(f: ValidatedFilters): { bool: … }`. It always includes `answer_eligible: true` and `country: US` for AI retrieval, and uses nested `aircraft` clauses for same-aircraft constraints.
  - `rrfFuse(lists: RankedHit[][], k = 60): FusedHit[]`.
  - `retrieveEvidence(es, embedder, q: RetrievalQuery): Promise<RetrievalResult>`.
    - BM25 `multi_match` over `text` (50 candidates) and `knn` with the same filter as a prefilter (50 candidates, `num_candidates` 200).
    - It fuses the two, then diversifies to at most 2 passages per case before filling, up to 6 cases and 12 passages.
    - It always attaches the case's probable-cause passage when the case is selected.
  - `pnpm eval:retrieval` (opt-in; costs only query embeddings, under $0.01). It prints Recall@20 for keyword, vector and hybrid and writes `data/work/eval-retrieval-<ts>.json`.

- [ ] Tests:
  - `rrf ranks item in both lists above single-list items`
  - `same filters applied to both channels` (inspect the request bodies)
  - `never more than 6 cases / 12 passages`
  - `two-aircraft fixture: airplane filter never returns helicopter-scoped passage`
- [ ] Gate G5: run the eval and send the metrics and query bodies to Astra; apply its findings.
- [ ] Commit "Add hybrid retrieval with application-side RRF and retrieval eval".

## Phase D — Web interface (NTSB-only parts)

### Task 11: Web scaffold and design system

**Files:**
- Create:
  - `web/index.html`
  - `web/src/main.tsx`
  - `web/src/routes.tsx`
  - `web/src/styles/tokens.css` (UI_DESIGN §2.2, day and `[data-theme="night"]`)
  - `web/src/styles/base.css`
  - `web/src/theme.ts`
  - `web/src/components/{Header,Footer,Button,Chip,AiChip,EvidenceGlyph,DataCaution,MonoChip,StatusBadge,FlightProfile,Placard,ThemeSwitch}.tsx`
  - `vite.config.ts`
  - `tests/web/components.test.tsx`

**Interfaces:**
- Produces:
  - The component props used by Tasks 12, 13 and 17. `EvidenceGlyph({ kind: 'causal'|'defect_not_causal'|'no_fault'|'insufficient' })` always renders its words:
    - "Causal fault established"
    - "Defect found, causal link not established"
    - "No fault identified"
    - "Insufficient evidence"
  - `AiChip` and every AI block always render an AI label.
  - `FlightProfile({ steps: {phaseGroup, eventLabel, isDefining, impact}[], size: 'mini'|'full' })` has `aria-label` "Schematic flight profile, not to scale: …".
  - `theme.ts` follows `prefers-color-scheme` until the user chooses, then stores the choice in `localStorage` with try/catch. An inline pre-paint script in `index.html` gets a CSP hash.
- Fonts come from `@fontsource/b612`, `@fontsource/b612-mono` and `@fontsource-variable/source-serif-4`. There are no Google Fonts requests.

- [ ] Tests:
  - `glyph renders words for each kind`
  - `AiChip has visible AI label`
  - `muted token is #58616B`
  - `night theme sets data-theme`
  - `print stylesheet hides graticule` (snapshot of the CSS rule)
- [ ] Commit "Add Sectional design system and web scaffold".

### Task 12: Home, Explore, case drawer, case page, compare (NTSB-only)

**Files:**
- Create:
  - `web/src/pages/{Home,Explore,CasePage,Compare,About,Privacy}.tsx`
  - `web/src/features/explore/{Facets,ResultRow,FiltersSheet,CompareTray}.tsx`
  - `web/src/features/case/{CaseDrawer,CaseStory}.tsx`
  - `web/src/api.ts`
  - `tests/e2e/explore.spec.ts`
  - `playwright.config.ts`

**Interfaces:**
- Consumes: Task 8 endpoints; Task 11 components.
- Produces: routes per UI_DESIGN §3, with URL state for `q`, facets, `case`, `cases`, `brief` and `step`.

Behaviour:
- **Home:** UI_DESIGN §4.1. Example chips only fill the box. Enter runs Search; Ctrl/Cmd+Enter is reserved for Ask AI (wired in Task 17).
- **Facets:** §4.2.
- **Drawer and case page:** story order (§4.5), NTSB-only.
- **Compare:** flight strips (§4.6) with NTSB columns, "Same in all", the sort options and "Print for class".
- **Phone layout:** §6.
- **Not-completed records:** the badge per §4.2.

- [ ] E2E tests (Playwright against `pnpm dev` with fixture index):
  - `search carburetor icing shows count line and rows`
  - `facet click updates URL and counts`
  - `drawer opens from row, Esc closes and focus returns`
  - `compare four cases shows strips; fifth tick shows "Compare holds four cases. Remove one first."`
  - `phone viewport shows Filters (n) sheet`
  - `night theme toggle persists`
- [ ] Commit "Add Explore, case views and compare".

### Task 13: Dashboard (Questions)

**Files:**
- Create:
  - `web/src/pages/Dashboard.tsx`
  - `web/src/features/dashboard/{QuestionPanel,BarList,YearChart,DotMap,CoveragePanel,CohortChips}.tsx`
  - `tests/web/dashboard.test.tsx`

**Behaviour:** UI_DESIGN §4.7, with sentences built from fixed templates over the API counts.
- Every bar is a button whose accessible name includes the count and percentage, and it opens Explore with the filter applied.
- The cohort chip reads "+ Include N other records".
- The coverage panel states "AI evidence classification: not used in these charts".

- [ ] Tests:
  - `landing sentence uses computed count`
  - `bar button navigates to explore with phase=landing`
  - `coverage panel says not in this data for flight hours`
- [ ] Commit "Add question-led dashboard".

## Phase E — AI briefs

### Task 14: Provider interface, Anthropic adapter, pricing and the startup reservation check

**Files:**
- Create:
  - `server/ai/provider.ts`
  - `server/ai/anthropic.ts`
  - `server/ai/fake.ts`
  - `server/ai/pricing.ts`
  - `server/ai/prompts/{scope,compose,check}.v1.ts`
  - `tests/unit/pricing.test.ts`
  - `tests/unit/anthropic-adapter.test.ts`

**Interfaces:**
- Produces:
  - `interface LlmProvider { name; models: { scope; answer; check }; scope(i: ScopeInput, c: StageCtx): Promise<StageResult<ScopeOutput>>; compose(i: ComposeInput, c): Promise<StageResult<ComposeOutput>>; check(i: CheckInput, c): Promise<StageResult<CheckOutput>> }`.
  - `StageResult<T> = { output: T; usage: { inputTokens; outputTokens; cacheWriteTokens; cacheReadTokens }; provider; model; promptVersion; stopReason }`.
  - `StageCtx = { signal: AbortSignal; timeoutMs: number; maxInputTokens; maxOutputTokens }`.
  - `ScopeOutput`, a Zod schema:
    - `intent`: `case_search | case_comparison | corpus_statistics | needs_clarification | out_of_scope | operational_advice`
    - `filters` and `terms`
    - `ambiguity?: { type: 'timing_window'|'aircraft_category'|'phase'|'failure_type'; values: string[] }`
    - `caseNumbers?: string[]`
  - `ComposeOutput`: `summary` (text with `[[case:NTSBNO]]` markers), `groups[]` (`kind` = an evidence glyph kind or `'examples'`, `caseNumbers`), `cases[]` (`ntsbNo`, `why`, `timing?`, `quotes[]` of `{ passageId, quote }`, `attribution?: 'investigators'|'pilot'|'witness'`), `gaps[]`.
  - `CheckOutput`: `{ supported: boolean; problems: {claimIndex; reason}[] }`.
  - `PRICE_TABLE` (USD per million tokens, from DESIGN §9):

    | Model | Input | Output | Cache write | Cache read |
    | --- | --- | --- | --- | --- |
    | `claude-haiku-5-5` | 0.10 | 0.50 | 0.125 | 0.01 |
    | `claude-sonnet-5-5` | 2 | 10 | 2.5 | 0.10 |
    | `claude-opus-5-5` | 4 | 20 | 5 | 0.20 |
    | `text-embedding-3-small` | 0.02 | — | — | — |

  - `STAGE_CAPS` (the values planned here; recalibrated with the provider's counter after
    the first paid end-to-end test, current values and measurements in DESIGN §9):

    | Stage | Input | Output |
    | --- | --- | --- |
    | scope | 2,600 | 400 |
    | answer | 16,000 | 3,000 |
    | check | 18,000 | 600 |
    | embed | 1,000 | — |

    `CACHED_PREFIX_MAX = 4000`.
  - `worstCaseRequestUsd(models): number` and `assertReservationCovers(models, reservationUsd)`. The latter throws when the sum exceeds the reservation or a model is unpriced.
  - `createAnthropicProvider(cfg)`:
    - `new Anthropic({ apiKey, maxRetries: 0 })`.
    - `client.messages.parse` with `output_config: { format: zodOutputFormat(schema), effort: 'low' }`.
    - `thinking: {type:'disabled'}` for Haiku stages; it is omitted for Opus.
    - The system prompt carries `cache_control`. A per-request `timeout` is set.
    - It checks `stop_reason` (`refusal`/`max_tokens` → `StageError`) and a null `parsed_output` → `StageError`.
    - No prefill, no sampling parameters.
  - `createFakeProvider(script)` is deterministic and drives tests.

- [ ] Tests:
  - `opus worst case ≈ 0.1307 and fits 0.14`, `sonnet ≈ 0.0667 fits 0.07`, `haiku ≈ 0.0059 fits 0.01`.
  - `unknown model throws`.
  - `adapter maps refusal to StageError` and `adapter never sends temperature or prefill` (mock SDK).
  - `adapter reads usage incl cache tokens`.
- [ ] Commit "Add LLM provider interface, Anthropic adapter and pricing gate".

### Task 15: Cost gate, quotas, leases and idempotency

**Files:**
- Create:
  - `server/db/schema/controls.ts` (`usage_buckets`, `cost_ledger`, `reservations`, `leases`, `idempotency`, `trial_identities`, `abuse_records`)
  - `server/quota/{admit,settle,pacing,buckets}.ts`
  - `tests/integration/quota.test.ts`

**Interfaces:**
- Produces:
  - `admitPaidRequest(db, a: AdmissionInput): Promise<Admission | Rejection>`. In one short transaction, it locks the principal, network and global buckets in a stable order, checks limits and idempotency, reserves the request reservation and acquires a lease with a fencing token. Rejection reasons:
    - `trial_exhausted`
    - `daily_cap`
    - `monthly_cap`
    - `anonymous_share_exhausted`
    - `global_paused`
    - `rate_limited` (with `retryAt`)
    - `concurrency`
  - `dailyAllowanceUsd(now, ledgerState, budgets)` takes the minimum of $3 and (remaining interactive money minus unsettled reservations) divided by the remaining days.
  - `settle(db, admission, usageUsd | 'uncertain', fencingToken)`. An uncertain usage settles at the full reservation.
  - `aiStatus(db, principal): AiStatus` returns `{ state, reason?, retryAt?, remaining }`.

- [ ] Tests:
  - `two concurrent admissions with one trial search left: exactly one admitted` (`Promise.all` against real Postgres).
  - `anonymous share 25% of paced daily allowance`.
  - `uncertain settles at reservation and is never refunded on lease expiry`.
  - `stale fencing token cannot settle`.
  - `idempotent retry returns same admission, different body same key is 409`.
  - `new account 5/day for first 3 days`.
- [ ] Commit "Add atomic cost gate, quotas and leases".

### Task 16: Brief pipeline, validation and refinements  *(gate G6)*

**Files:**
- Create:
  - `server/db/schema/briefs.ts` (`briefs(id, read_owner, created_at, expires_at)`, `brief_steps(id, brief_id, n, billing_principal, request jsonb, stage, status, result jsonb, provider, model, cost_usd)`)
  - `server/briefs/{pipeline,validate,clarify,static-replies,context}.ts`
  - `server/routes/briefs.ts`
  - `tests/unit/validate.test.ts`
  - `tests/integration/briefs.test.ts`

**Interfaces:**
- Produces:

  | Endpoint | Request | Response |
  | --- | --- | --- |
  | `POST /api/briefs` | `{ question, filters?, turnstileToken?, idempotencyKey }` | `{ briefId, stepN }`, or a static reply for scope outcomes |
  | `POST /api/briefs/:id/refine` | `RefinementRequest`, a Zod discriminated union of `{kind:'text', text}`, `{kind:'interpretation', field, value}` and `{kind:'filters', filters}` | — |
  | `GET /api/briefs/:id?step=n` | — | `{ stage: 'scope'|'retrieve'|'compose'|'validate'|'done'|'failed', checklist: {question?, searched?: {cases, passages}}, result? }`. `no-store`; the read owner only. |
  | `POST /api/briefs/:id/cancel` | — | — |
  | `GET /api/briefs/:id/steps/:n/cases/:ntsbNo` | — | AI context for that case |

  - `validateComposition(out: ComposeOutput, allow: { passages: Map<id,{ntsbNo,text,sha}>; cases: Set<string> }): { ok: true } | { ok: false; reasons }`.
    - Every quote must be an exact substring of its passage text after only whitespace-run collapsing on **both** sides. That rule is versioned.
    - Every case number in the summary, groups and `why` text must be in the allowlist (regex scan for NTSB number patterns).
    - The schema must be valid.
  - `runBriefStep(deps, stepId)`.
    - The stages run in order with a 60 s total deadline and per-stage timeouts (scope 10 s, retrieve 8 s, compose 35 s, check 12 s).
    - Results are written stage by stage.
    - A failed or inconclusive check withholds the summary and returns case cards.
    - There is no repair loop.

- [ ] Tests (fake provider):
  - `seed question returns groups and four seed cases in fixture corpus`
  - `quote not in passage → summary withheld, cards returned, step charged`
  - `unallowlisted case number in why → withheld`
  - `compose refusal → withheld and settled`
  - `timeout at compose → settled at reservation (uncertain)`
  - `out_of_scope and operational do not consume trial`
  - `fourth refinement rejected`
  - `refinement filters variant re-runs scope`
  - `clarification renders only server templates`
  - `CRLF/NBSP passage quote validates`
- [ ] Gate G6: send the prompts, the composition schema and the validator to Astra.
- [ ] Commit "Add evidence-checked brief pipeline with refinements".

### Task 17: AI interface

**Files:**
- Create:
  - `web/src/pages/Brief.tsx`
  - `web/src/features/brief/{Checklist,BriefingSheet,EvidenceGroup,CaseCard,RefineBox,StepSwitcher,WithheldNotice,ScopeReply}.tsx`
  - AI sections in `CaseStory`
  - AI columns in `Compare`
  - `web/src/features/ai/{AskAiButton,AiCounter,TurnstileGate}.tsx`
  - `tests/e2e/brief.spec.ts`

**Behaviour:** UI_DESIGN §4.3 to §4.6 and §5.
- The checklist uses polling every 1 s.
- Copy is exact.
- The `· uses 1` labels appear.
- AI context loads only through the private endpoint.

- [ ] E2E tests (fake provider):
  - `ask AI shows checklist then briefing sheet with magenta summary label`
  - `withheld notice copy exact`
  - `case number citation opens drawer at passage`
  - `refine uses 1 and adds step switcher`
  - `expired brief shows empty search`
- [ ] Commit "Add AI brief interface".

### Task 18: Observability and a live smoke test

**Files:**
- Create:
  - `server/observability/{tracing,attributes}.ts`
  - `tests/unit/tracing-attributes.test.ts`
  - `evals/answers/smoke.ts` (opt-in)

**Interfaces:**
- Produces:
  - `startTracing(cfg)`. It does nothing unless `AVIATION_TRACING_ENABLED=true` and the endpoint and keys are set.
  - `stageSpan(name, attrs: AllowedAttrs)`. `AllowedAttrs` is a closed set: stage, provider, model, promptVersion, token counts, usd, durationMs, outcome and brief hash.
  - The smoke test `pnpm eval:smoke --confirm-cost` runs the seed question once on real Anthropic plus real retrieval, and prints the cost (expected ≈ $0.09).

- [ ] Tests:
  - `no question or answer text in span attributes`
  - `tracing outage does not fail request`
- [ ] Run the smoke test once and record the result in the morning report.
- [ ] Commit "Add content-free tracing and opt-in live smoke test".

## Phase F — Public-beta controls

### Task 19: Trial identity, Turnstile and AI status

**Files:**
- Create:
  - `server/identity/{trial,turnstile,ip-hmac}.ts`
  - `server/routes/ai-status.ts`
  - `tests/integration/identity.test.ts`

Behaviour:
- **Trial cookie:** signed, HttpOnly, Secure (except in dev), SameSite=Lax, host-only. It is backed by `trial_identities` and created only after a successful Turnstile verification at the first Ask AI.
- **Turnstile:** verified server-side for every anonymous AI request (hostname/action checked; tokens single-use). Dev uses Cloudflare's documented test keys.
- **`GET /api/ai/status`** is per UI_DESIGN §5.

- [ ] Tests:
  - `missing token rejected before spend`
  - `reused token rejected`
  - `trial cookie not created on failed challenge`
  - `status returns signed_in_only when anonymous share exhausted`
- [ ] Commit "Add trial identity, Turnstile verification and AI status".

### Task 20: Google sign-in, account, brief handover and deletion

**Files:**
- Create:
  - `server/auth/{better-auth,handover,deletion}.ts`
  - `web/src/features/auth/{SignInDialog,Welcome}.tsx`
  - `web/src/pages/Account.tsx`
  - `tests/integration/auth.test.ts`

Behaviour:
- **Better Auth with Google:**
  - Scopes `openid email profile`; verified email required; identity is `sub`.
  - No password sign-up and no account linking.
  - Session cookie caching disabled.
  - Disabled (`googleEnabled:false`) when the client ID or secret is absent.
- **Handover:** per UI_DESIGN §5. Each step has a fixed billing principal, and read ownership moves by compare-and-set.
- **Deletion:** ends sessions and removes saved content. It keeps the HMAC(issuer, sub) anti-abuse record through the quota window plus 7 days.

- [ ] Tests (mocked OIDC):
  - `handover moves read owner once; concurrent callback no-op`
  - `old trial identity retry gets moved`
  - `post-signin refinement billed to account`
  - `re-registration reattaches usage`
- [ ] Commit "Add Google sign-in, account page, handover and deletion".

### Task 21: Hardening, container image and docs

**Files:**
- Create:
  - `Dockerfile` (multi-stage, non-root)
  - `compose.yaml` additions `app` and `ingest` profiles
  - `server/http/cache-headers.ts`
  - `docs/RUNBOOK.md`
- Modify: `README.md`, `.env.example`, `apps/README.md` (status)

Behaviour:
- **Response headers:** AI, auth and quota routes send `private, no-store`. Public routes are keyed by dataset revision. Errors are redacted.
- **Rate limit:** browsing is limited to 60 req/min per network identity.
- **Runbook:** setup, ingestion, reindex, costs of the opt-in commands, backup notes, and the Cloudflare Tunnel deployment steps for the owner. No private hosts.

- [ ] Tests:
  - `no-store on /api/briefs`
  - `public cache on /api/cases`
  - `61st request in a minute is 429`
- [ ] Commit "Harden HTTP layer and add container image and runbook".

## Phase G — Review

### Task 22: Whole-branch review and implementation security review

- [ ] Dispatch a fresh reviewer (most capable model) over the whole branch: correctness, then the DESIGN §12 implementation-review list.
- [ ] Fix findings. Re-run `pnpm test`, `pnpm test:integration`, the Playwright tests and `python3 scripts/check_repo.py`.
- [ ] Update `SECURITY_REVIEW.md` with the reviewer model, commit and findings.
- [ ] Write the morning report: data, embeddings, Elasticsearch composition, costs and open items.

---

## Amendments after review gate G0 (GPT-6-Astra, 2026-10-21)

Astra reviewed the data tasks against the raw exports before implementation. These
amendments are binding and override the task text above where they differ.

1. **Explicit allowlists and keys (T3/T4/T5).**
   - Every table lists its columns explicitly, including identity, ordering and
     revision fields.
   - Before loading, assert that required columns are present and that
     composite keys are unique:
     - events: `ev_id`
     - aircraft: `ev_id` + `aircraft_key`
     - engines: `ev_id` + `aircraft_key` + `eng_no`
     - narratives: `ev_id` + `aircraft_key`
     - findings: `ev_id` + `aircraft_key` + `finding_no`
     - events_sequence: `ev_id` + `aircraft_key` + `occurrence_no`
2. **Country (T7/T9/T10).**
   - One canonical `country` keyword (`ev_country` as published, e.g. `USA`)
     appears in both projections.
   - Passage construction enforces US membership.
   - Retrieval filters `country: 'USA'`.
   - Tests cover a US hit and the exclusion of a foreign case.
3. **Passage attribution (T4/T9/T10/T16).**
   - Sections come per narrative row (`ev_id`, `aircraft_key`). A section text
     repeated identically across one event's aircraft is stored once as
     **event-scoped**; otherwise it is **aircraft-scoped** to that row's
     aircraft.
   - An aircraft-scoped passage copies only its own aircraft's nested filter
     fields and builds its header from that aircraft only.
   - An event-scoped passage in a multi-aircraft event never satisfies an
     aircraft-specific filter. Retrieval excludes it whenever an aircraft
     filter is active, and it can never ground an aircraft-specific claim.
   - Each aircraft's own probable cause is attached.
   - Fixtures `SEA08LA057` (different defining phases per aircraft) and
     `DCA25MA108` (duplicated narratives covering both aircraft) are required.
   - **As built (ruling at gate G2a, tighter than the text above):** every
     narrative section of a multi-aircraft event, probable cause included, is
     **event-scoped**. The row it came from is kept as provenance, identical
     texts are stored once, and differing texts are kept as separate variants.
     Aircraft scope applies only to single-aircraft events. Structured
     per-aircraft rows keep their `aircraft_key`. An event-scoped passage lists
     the event's aircraft under the plain object `event_aircraft`, never the
     nested `aircraft`, so aircraft filters exclude it by construction. When
     such a case is selected, its distinct event-scoped probable-cause variants
     are attached instead of a per-aircraft cause.
4. **Quote provenance (T16).**
   - Validation follows the chain case → aircraft/scope → section id +
     revision hash → passage → quote.
   - It returns resolved UTF-16 citation spans through a whitespace-normalization
     offset map. Empty quotes are rejected, and a repeated match uses the first
     occurrence inside the cited passage and records that.
   - The semantic check enumerates every claim type: classifications, timing,
     attribution, summary sentences and "why" text.
5. **Completion mapping (T4/T5).**
   - Empirical check of the snapshot, US records:

     | Status | Probable cause | Count |
     | --- | --- | --- |
     | `B` | present | 24,291 |
     | `B` | absent | 2 |
     | `P` | absent | 1,040 |
     | `F` | absent | 18 |
     | blank | absent | 56 |

   - `COMPLETION_MAPPING_V1` becomes `{ version: 'v1-empirical', verified: false,
     completedStatuses: ['B'] }`. `verified` stays `false` until the mapping is
     confirmed with NTSB metadata.
   - The answer-eligible cohort is a **provisional development cohort** while
     unverified. Production launch is blocked until `verified: true`; this is
     recorded as an owner/launch item.
   - Completion status stays independent of probable-cause availability.
6. **Dataset generations (T5/T7/T9).**
   - Every load writes a new `generation_id`. Section rows are immutable
     revisions, never updated in place.
   - A generation is loaded and verified fully before it is published.
     Obsolete child rows belong to old generations and are never mutated.
   - Composite foreign keys apply within a generation.
   - A failed run leaves the active generation untouched.
   - `dataset_manifests(generation_id, cases_index, passages_index, published_at, active)`
     is flipped atomically only after both indices for that generation are built
     and verified.
   - The API reads the active manifest and pins each request (and each brief)
     to it.
   - The previous generation is kept for live citations; generations older than
     the last two are pruned.
7. **Indexing spend (T9).** T9 builds the shared ledger foundation that T15
   extends:
   - `cost_ledger` and `reservations` tables, with category
     `indexing|evaluation|interactive`.
   - Each embedding batch's maximum cost is reserved before dispatch; batch
     tokens are counted exactly with `cl100k_base`.
   - Each retry attempt is accounted for separately, and an uncertain attempt
     settles at its reservation.
   - Indexing and evaluation share the $20 allowance.
8. **Scalar contracts (T3/T4).**
   - `mdb-export` uses `-D %Y-%m-%d -T %Y-%m-%dT%H:%M:%S`. Dates are parsed
     without inventing time zones.
   - Blanks become `null` before any numeric conversion.
   - Each flag's actual vocabulary is decoded: `defining_ev` `0`/`1`,
     `afm_hrs_since` `Y`/`N`, and `cm_inpc` `T`/`F`/blank. JavaScript
     truthiness is never used on source strings, and neither is
     `Number('')`.
   - 75 US events have no coordinates; their `location` is `null`.
9. **Narrative markup (T4).**
   - Keep the original `source_text`. The citation `text` is canonical text
     produced by a deterministic HTML-to-text step (`CITATION_TEXT_VERSION =
     'v1'`).
   - That step preserves inline word continuity (`o<span>ne</span>` → `one`),
     maps block boundaries to newlines, decodes entities and converts CRLF to
     LF. It records which sections were transformed.
   - Required real fixtures: `CEN24FA064`, `ERA24LA303`, `WPR26LA114`.
10. **Embedding cache key (T9).** The key is sha256 of the exact embedding input
    (header plus text), the model, the dimensions and
    `EMBEDDING_INPUT_TEMPLATE_VERSION`. The citation-text hash stays separate,
    and a header change invalidates the cache. 652 cause texts are shared across
    events.
11. **Evidence packing (T10).**
    - Mandatory probable-cause passages count inside the limits from the start
      and are deduplicated.
    - The packed bundle must respect 6 cases, 12 passages and the compose input
      cap (16,000 tokens, measured).
    - Fewer, well-supported cases are preferred over six thin ones. The default
      is at most 3 passages per case, the cause included.
12. **Analyzers (T7/T9).**
    - A custom `aviation_english` analyzer: standard tokenizer → lowercase →
      english possessive stemmer → a stop filter using the English list
      **minus** negations (`no`, `not`, `nor`, `none`, `never`, `without`) →
      english stemmer.
    - The search analyzer is the same plus `synonym_graph` placed **before**
      stemming.
    - `stall` and `spin` are never synonyms.
    - Token-stream tests via `_analyze` cover negation, multiword synonyms,
      stemming and quoted phrases.
13. **Retrieval evaluation (T10).**
    - Separate stages:
      1. A case-candidate stage: unique cases with bounded overfetch (100
         passages per channel → deduplicated cases).
      2. Then packing.
    - Report case Recall@20 on candidates, and evidence coverage on the final
      bundle.
    - Build a held-out silver set of at least 40 questions covering negation,
      causal uncertainty, maintenance timing and multi-aircraft cases. Labels are
      derived from structured fields and keyword criteria and are marked for
      expert adjudication. The 4 seed cases alone never lock defaults.
14. **Facet semantics (T7/T8/T13).**
    - Every facet and dashboard count is a count of distinct events, using
      `reverse_nested` for aircraft facets.
    - The Phase facet and the dashboard use the **defining event's** phase
      group.
    - Multi-aircraft overlap is stated wherever aircraft facets can sum to more
      than the total.
    - Clicking a dashboard bar reproduces its count in Explore.
15. **Extraction limits (T3).**
    - Streamed byte limits per table.
    - A per-process deadline.
    - Container cleanup.
    - Bounded CSV record and field sizes (parser `max_record_size`).
    - Counts are parsed records, never physical lines.
16. **Oversized units (T9).**
    - A probable cause over 800 tokens, or a single sentence over 800 tokens,
      is split at the nearest clause or whitespace boundary into marked
      continuation passages.
    - Nothing is ever silently truncated, and the cases this affects are
      reported.
    - The cost report counts header and overlap tokens, and each input is
      limited to 8,192 tokens.
