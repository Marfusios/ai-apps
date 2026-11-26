# AirCase: notes for agents

Read this file before any change to the app, and keep it current with the code. AirCase is a
search site over NTSB aviation investigation reports (the directory and package keep the
older name `aviation-casebook`). For anything beyond this file read `README.md` and `docs/DESIGN.md`.

## Stack

- Node 24, TypeScript in strict mode, pnpm through corepack, one package with a committed lockfile.
- Web: React, Vite, React Router, TanStack Query, Tailwind. Server: Fastify with Zod contracts.
- Data: PostgreSQL with Drizzle migrations; Elasticsearch for search.
- Language models behind an app-owned provider interface (Anthropic, switchable to OpenAI); OpenAI embeddings.
- Tests: Vitest (projects `unit`, `web`, `integration`) and Playwright. Langfuse for tracing and evaluations.

## Module map and dependency direction

- `shared/`: types, contracts, vocabularies and pure rules. Imports nothing from the other directories.
- `server/`: Fastify app, routes, auth, evidence (AI search) and briefs pipelines, database, search. Imports `shared/`.
- `web/`: the React client (`web/src`) and the mock API (`web/mock`). `web/src` imports `shared/` only.
- `worker/`: command-line jobs (`worker/cli.ts`): ingestion, index building, the importer. Imports `shared/` and `server/`.
- `scripts/`: operator and build scripts (fixtures, compose, release, provisioning). Imports the four above.
- `evals/`: retrieval and ranking evaluations. Imports `shared/`, `server/`, `worker/`, and once `scripts/`.
- `tests/`: `unit/`, `web/`, `integration/`, `e2e/`, `e2e-real/`, `support/`. May import everything.
- `fixtures/`: public sample data, not code.

Not a clean layering, so do not add to it:

- `server/` and `worker/` import each other: the server uses worker modules (`worker/index/`,
  `worker/ingest/normalize.ts`, `worker/importer/status.ts`) and the worker uses 35 server files.
  Check for import cycles before adding a third edge.
- `server/http/security-headers.ts` imports `web/src/csp-hashes.ts`.
- `web/mock/` (not `web/src`) imports `server/briefs/*` and `worker/importer/status.ts`.

## Domain vocabulary

- NTSB: the US National Transportation Safety Board, the source of all case data.
- Case: one investigated event with its aircraft and report sections (`ntsb_no` identifies it).
- Event: the occurrence a case describes; a multi-aircraft event has several aircraft rows.
- Section: a narrative part of a case, such as the probable cause. `section_id` is `<ntsb_no>:<section_key>`.
- Probable cause: the NTSB's finding of why the event happened, kept as its own section.
- Finding: a coded item of the NTSB's analysis, shown apart from generated text.
- Evidence: the excerpts from case sections that answer a question, with citations.
- Passage: a chunk of section text indexed for retrieval.
- Generation: one imported corpus snapshot; an index and its manifest are pinned to a generation.
- Revision (`revision_id`): hash of a section's text; briefs and citations pin generation and revision.
- Snapshot: the NTSB's `avall` data download that a generation is built from.
- Quarantine report: value-level import problems that are listed instead of coerced.
- Answer eligibility: a US event with a completed status and probable-cause text (`COMPLETION_MAPPING_V1`).
- Applied filters: search filters actually used for a result; other suggestions stay unapplied.
- Brief: a stored AI-assisted case summary request (generated summaries are disabled).
- Spend gate: reserves and settles model cost on a ledger before a provider call.
- Q0 and top-50: the baseline ranking and the model re-ranking of the leading 50 results.

## Commands

Run from `apps/aviation-investigations` (setup: `corepack enable && pnpm install --frozen-lockfile`).

- `pnpm typecheck`: `tsc` on the server and web projects (the fast check).
- `pnpm test`: offline `unit` and `web` Vitest projects.
- `pnpm test:integration`: the `integration` project. Needs the local services from
  `compose.local-services.yaml`: `pnpm services:up`, `pnpm services:setup`, then `pnpm db:migrate`; `pnpm services:down` stops them.
- There is no linter and no formatter yet.

## Pitfalls

- Never run the release, provisioning, backup, restore, importer, shared-service migration or
  ingest commands: `app:release`, `app:up`, `app:down`, `app:migrate`, `app:backup`, `app:restore`,
  `provision:shared`, `importer`, `ingest`, `db:restore-drill`, `extract:image`. They act on deployed or shared services.
- Tests and development use only the local services; never point `DATABASE_URL` or the search
  variables at a shared server.
- Provider-backed runs cost money and are opt-in: the `eval:*` commands need an explicit flag such as `--confirm-cost`.
  Offline tests use the fake language-model provider.
- Fixtures under `fixtures/` are generated: rebuild them with `pnpm fixtures:build` and `pnpm fixtures:build-ui`, never by hand.
- Secrets live in ignored dotenv files; list new variable names with empty values in `.env.example`.
- The product name changed but directory, package, database and storage-key names did not; keep them.
