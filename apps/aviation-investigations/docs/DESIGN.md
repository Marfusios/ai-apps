# Aviation Casebook: implementation design

**Draft, updated 2026-10-21.** Initial data research: 2026-10-16. Design only;
the application is not built. Tracing/evaluation decision: self-hosted Langfuse.
Working assumptions: English-first public beta, all completed US investigations
as the eventual scope, and a **$100/month AI-provider ceiling**, set by the owner
on 2026-10-21 while $200 of Anthropic credits are available. These are proposed
defaults pending owner feedback, not deployed limits. Language-model calls start
on the Anthropic API, behind a provider interface that operators can switch to
OpenAI at deployment (§9). Embeddings stay on OpenAI.

Build a small TypeScript application that finds relevant investigations, explains
why they match, and compares supporting evidence. Start with the 2008-onward
dataset and add historical coverage later. The experience is search with an
evidence-based answer and comparison table, alongside browsable cases and a modest
dashboard. The first implementation should be a complete, small vertical slice.

## 1. Recommended stack

| Concern | Recommendation | Reason |
| --- | --- | --- |
| Runtime/tooling | Node.js 24 LTS, TypeScript strict mode, pnpm, committed lockfile | Supported runtime; TypeScript practice across the app |
| Frontend | React + Vite, React Router, TanStack Query | Explicit client/server boundary and straightforward deployment |
| UI | Tailwind CSS, shadcn/ui, Lucide icons, Recharts | Restrained visual system, accessible components, simple charts |
| Backend | Fastify, Zod contracts, OpenAPI | Small explicit API; shared types plus runtime validation |
| Authentication | Better Auth + Google OIDC + database sessions | Avoid writing OAuth/session cryptography ourselves |
| Relational data | PostgreSQL + Drizzle queries/migrations | Identity, quotas, ingestion state, canonical cases; consent records later |
| Search | Elasticsearch 9.x Basic + official JS client | Keywords, filters, aggregations, and vector search |
| Language models | Official Anthropic TypeScript SDK (Messages API) behind an app-owned provider interface; an OpenAI Responses API adapter only when a switch is needed (§9) | Direct control over schemas, prompts, tokens, and accounting; provider chosen by deployment configuration |
| Embeddings | Official OpenAI TypeScript SDK, embeddings endpoint | Anthropic offers no embedding model; pinned to the index version, independent of the language-model provider |
| Jobs | Separate TypeScript worker from the same codebase/image | Imports do not block the HTTP process; no broker needed initially |
| Public access | Docker Compose + Cloudflare Tunnel + Turnstile | Suitable for one Linux host |
| Observability | Self-hosted Langfuse + OpenTelemetry-backed TypeScript integration | Existing AI dashboard for traces, usage, latency, and scores |
| AI evaluations | Langfuse experiments + custom TypeScript evaluators | Versioned datasets, retrieval/classification metrics, and regression comparisons |
| Software tests | Vitest, Fastify injection tests, Playwright | Deterministic logic, auth, quotas, and user journeys |

Node 24 is supported in the [Node release schedule](https://github.com/nodejs/Release).
Fastify documents [TypeScript](https://fastify.dev/docs/latest/Reference/TypeScript/)
and [runtime validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/);
Better Auth documents its [Fastify integration](https://better-auth.com/docs/integrations/fastify).
Pin compatible versions, including the Zod/Fastify adapter, when implementing.

Prefer the explicit frontend/backend split for learning. Next.js is a reasonable
alternative if server rendering and indexed public case pages become priorities;
the initial search interface does not need its rendering/cache conventions.
A client-rendered beta is acceptable; case and filter URLs must survive direct
navigation and refresh.
Use one application package with `web/`, `server/`, `worker/`, `shared/`, `tests/`,
`evals/`, and `fixtures/`. Application orchestration remains plain TypeScript;
LangChain/LangGraph are not required for version one. The app needs no Redis,
Kafka, or graph database; the separate Langfuse deployment has its own storage
dependencies. Keep repository tooling framework-neutral.

Use Langfuse's dashboard and experiment runner. No Jaeger plugin/custom AI dashboard
is planned, and Promptfoo is optional future tooling rather than a first-release
dependency. The [tracing and evaluation guide](OBSERVABILITY_AND_EVALUATION.md)
defines instrumentation, development experiments, production assessment, and hosting.

## 2. First-release behavior

An instructor can ask:

> Find completed investigations involving engine power loss shortly after
> maintenance. Separate confirmed mechanical failures from cases where
> investigators found no mechanical fault.

Return a bounded set of cases, the interpretation of “shortly,” supporting
passages, and explicit gaps. Preserve unknown causes rather than forcing every
case into two categories. Reading, filtering, and comparing underlying records
should remain useful even when AI is unavailable.

Include keyword/filter browsing, natural-language search, case details, comparison
of up to four cases, citations, three anonymous AI requests, Google sign-in, and
a basic corpus dashboard. Ordinary browsing requires neither an LLM nor login.
Saved collections and generated lesson packs can follow.

A **brief** is one question plus at most three **Refine this search** steps, not an
open chat. Each refinement is another metered AI request through the full
admission, scope, retrieval, and validation pipeline; anonymous trial requests
count across the sequence. The client sends only the brief ID and one bounded
refinement: a Zod discriminated union of free `text`, an allowlisted
`interpretation` edit, or a validated `filters` edit
([interface design](UI_DESIGN.md) §4.3).
The server keeps a bounded representation of the search intent, including any
clarified meaning of “shortly,” plus validated filters and earlier case IDs. It
treats that intent as untrusted input in every scope check and retrieves afresh
rather than automatically restricting a refinement to earlier results. Earlier
generated answers never become evidence. Briefs expire within the 24-hour
processing window.

Filters: completion, date, location/state, aircraft category/make/model, engine
type, FAR part, flight purpose, flight phase, VMC/IMC/unknown, light, and injuries.
Define general aviation as a documented source-based preset; do not silently
treat every Part 91 flight as the same training population. Show unknown values.

Scope is historical study. Exclude unrestricted chat, uploaded documents, public
write tools, live-flight advice, maintenance procedures, and airworthiness
decisions. Operational/emergency requests get a short static redirect to
appropriate authoritative assistance, not generated instructions.

## 3. Evidence and classification

Keep independent dimensions instead of a single “mechanical failure” flag:

| Dimension | Values/examples |
| --- | --- |
| Symptom | Total/partial power loss, rough running, failure to climb |
| Mechanical evidence | Causal fault established; no relevant fault identified within examination scope; defect found without established causal link; insufficient/conflicting evidence |
| Maintenance relationship | Investigator-attributed contribution; preceding maintenance without established causality; no evidence; unknown |
| Timing | Stated facts from the relevant maintenance: calendar days, flight hours, the same or the previous calendar day, immediately before the event flight, which flight, completed flights in between, qualitative wording; unknown |
| Attribution | Pilot/witness statement, examination, analysis, probable cause, application interpretation |

“No fault identified” does not prove a fault was impossible. An undetermined cause
does not itself establish a negative examination. Physical breakage, an incorrect
adjustment, fuel exhaustion, and icing are distinct mechanisms.

Each extracted assertion retains event/aircraft identity, source revision,
section, exact span offsets, supporting text, model/prompt version, and review
status. Display **AI-derived** separately from **NTSB finding**. Prefer “established
in the investigation” over absolute certainty. Store unknown/needs-review rather
than an uncalibrated confidence percentage.

For “shortly,” suggest a visible, editable interpretation such as **within 30
calendar days OR 10 flight hours**, plus an optional first-flight constraint.
Qualitative intervals remain a separate “timing not quantified” group. Never
silently substitute inspection date or hours since inspection for maintenance.

**Chronology** (compose v6 and later, Tasks 16c and 16d, gate G6). A case's chronology
names its relevant maintenance once and lists each stated time relation that ends at the
event flight as its own fact, stored as parts: the anchor (the relevant maintenance, or
another event in the passage's own words, so "the accident flight was conducted 2 days
later" after the second test flight keeps that flight as its antecedent), the relation and
its value and bound (`exact`, `about`, `at_most`, `at_least`), and the passages that
state it. Hours a passage does not call flight hours (engine, tachometer or Hobbs time,
time in service, plain "hours") are their own relation, `operating_hours`, never flight
hours. The attribution (one aircraft, or the whole event) is never written by the model:
the server derives it from the cited passages' verified scope. A fact no passage states
is left out, and leaving one out never makes a case match. The reader's criteria are
decided in code by the versioned timing rules **`chronology-rules-v3`**
(server/briefs/criteria.ts; the check prompt states the same rules). Each fact is read as
a constraint on one quantity (calendar days, flight hours, operating hours, completed
flights):

- **Anchor and aircraft.** Only a fact from the relevant maintenance to the event flight
  decides anything; a bound worked out from a time measured from something else decides
  nothing. The server cannot tell such a derived bound from a stated one: `compose.v8`
  encodes it with its own anchor and `check.v9` asks the checker to hold every time to what
  it is measured from, and nothing else enforces it (the residual case is a composition that
  anchors a derived bound on the maintenance anyway, as 16d's development brief `holdout.b5`
  did; labels v3 mark that fact `unknown`; 16d review m2). In an event with more than one aircraft, only a fact cited from one aircraft's
  passages counts, facts about different aircraft are never compared or combined, and
  facts naming more than one aircraft decide nothing. Since version 3 a fact about the
  whole event still takes part in the conflict test with one aircraft's fact: "2 days" for
  one airplane and "40 days" for the event leave the days unsettled (16d review m1).
- **Conflicts first.** Before any decision, all the facts on one quantity (one anchor,
  one aircraft, one unit) must hold together: their ranges must overlap, or the quantity
  decides nothing whatever the window ("exact 20 days" and "at least 40 days" conflict
  under a 50-day window as under a 30-day one). Units are never mixed.
- **Approximation.** "About N" decides nothing; for the conflict test it counts as exactly
  N, with no tolerance, so it can only turn a decision into `unknown`.
- **Numbers.** With the facts consistent, the non-approximate ones narrow a quantity to one
  range: within the limit when the whole range is, outside when all of it is beyond, else
  undecided. Days counted from dates the passages state are exact; a date only in the
  case header is never combined with a passage date. Wording without a number decides
  nothing, and zero calendar days, flight hours or operating hours are refused at
  validation (the same day is `same_day`, just before the flight `immediately_before`).
- **Calendar dates.** "The same day" and "the day before" are one calendar date (0 or 1):
  within any calendar-day window, never a number of hours. Maintenance completed
  immediately before the event flight is within any calendar-day window and establishes
  the first flight; it is never a zero-day or zero-hour interval.
- **Operating hours** decide no flight-hour window.
- **Which flight** (the first flight, or zero completed flights in between) decides only
  the first-flight criterion, and calendar days or flight hours never decide which flight
  it was. The first flight alone never establishes a calendar-day or flight-hour window.
  Since version 3 an ordinal or a count of flights decides only with explicit evidence in
  the passages it cites (rule O-1, `ordinal-evidence-v2`, below): a narrated sequence ("the
  first flight …, the second flight …, the accident flight was conducted 2 days later")
  does not make the accident flight the third. Without that evidence the fact can still
  conflict with another, never settle one, and its timing statement is never shown.
- A window matches when either unit is within; it fails only when every unit it names is
  outside; a conflict on a quantity it reads decides nothing. Anything else is `unknown`,
  with a content-free reason (`unstated`, `other_anchor`, `ambiguous_attribution`,
  `approximate`, `insufficient_bound`, `not_settling`, `operating_hours`, `conflict`,
  `ordinal_unverified`).

Version 1 (Task 16c) compared facts only after reducing each to within, outside or
unknown, so an approximate or bounded fact that conflicted with the deciding one went
unnoticed (16c review I3); version 2 also adds the one-aircraft rule, operating hours and
the zero-interval refusal; version 3 (Task 16e) the event-level conflict and rule O-1.

A case whose passages do not settle a criterion is shown labelled unconfirmed, never as a
match; the copy says this analysis could not establish the timing from the supplied
passages, never that the investigation has none. Every decision, `unknown` included,
becomes a server-template claim ("Under the timing rules, the supplied passages of this
case do not settle whether …") that the evidence checker judges against every supplied
passage of the case; a contradiction of a "do not settle" claim is recorded as
`chronology_missed` (a likely extraction miss). A decision is shown as decided only while
its own claim and the facts it rests on are confirmed; the display never recomputes it,
so a removal can only downgrade it to unconfirmed (claim-level display, below). There is
no repair call.

**Deterministic rules before the check** (Task 16e, gate G6's 16d verdict, findings 1 and
2). Two versioned rules run in code on the validated composition and the canonical passage
texts and decide, whatever any model says, what can never be shown. A claim they abstain
from is still sent to the evidence checker (its verdict counts, a contradiction included),
and is never shown; in `whole` mode an abstention withholds the summary like any removal.

- **Excerpt context, `excerpt-context-v1`** (server/briefs/excerpts.ts, in the validator):
  a quote is shown only when its words keep their meaning read alone in a card. It is
  omitted when it is not whole sentences of its passage (a pilot's or witness's account may
  leave out "the pilot reported that"), opens with a pointing word or connective ("This
  deformation", "He", "However"), keeps a pronoun with no person named, a demonstrative
  ("this work", "these repairs", "at that time") whose noun it does not name, a relative
  time without its anchor ("approximately 29 hours earlier", "the previous day"), a
  relative sequence ("the next flight", "then"), or a comparison without its object ("the
  same mechanic", "similar debris"). Version 1 supplies no surrounding context: nothing
  can prove that added words hold the antecedent, so such an excerpt is omitted, and the
  card says how many quotes were left out. Measured on a blind sample of 200 sentences of
  the 16e evidence, labelled before the frozen rule ran on them: 7 of 166 standalone
  sentences omitted (4.2%, Wilson 95% 2.1–8.4%), 18 of 34 context-dependent ones caught; the
  misses (quoted handbook words, unnamed test settings, "the valve" among many) are left to
  the checker. On the development sample the rule was revised against, 1 of 164 and 25 of
  36.
- **Ordinal evidence, `ordinal-evidence-v2`** (server/briefs/ordinals.ts): which flight it
  was needs an ordinal the cited passages state for a flight ("the first flight after the
  annual inspection", "the accident flight was the first following …") or a complete count
  stated with what it counts from ("had not flown since", "two flights since the overhaul",
  maintenance completed "immediately before the flight"). A timing fact, summary sentence,
  `why` line or gap note stating an ordinal without it is never shown (an ordinal in a
  "whether" clause is asked, not stated). The rule is a necessary condition only: it does
  not check what the ordinal is counted from, which the checker judges. Version 2 (before
  any 16e checker call) stopped reading "had not flown in 22 years" or "the previous two
  flights" as counts.

**Claim-level display** (Task 16d, versioned dependency rules **`display-deps-v2`** since Task
16e, server/briefs/display.ts). After the evidence check (§5), one pure function decides what may
be shown, from dependencies the server derives from the composition's structure and never from
the model. A claim is shown only with exactly one valid `supported` verdict, no abstention by
the rules above, and only while everything it depends on is shown; removal is of whole
sentences and whole fields, never spliced or reworded.

- **Reading.** A presented case's AI reading needs a confirmed `why` line, at least one
  confirmed quote and no contradicted criterion claim (a contradicted decision has no
  direction: the case may be outside the reader's criteria). Every other statement of the case
  depends on it.
- **Basis.** A contradicted essential claim of a case (its `why` line, classification,
  maintenance relation, a timing fact, a criterion decision, a quote attribution, or a summary
  sentence citing it) suppresses the case's summary sentences, its group placement and every
  comparison citing it, whatever the thresholds below. Symptoms and gap notes are not
  essential.
- **Group.** A case keeps its group only with its reading, its basis and (mechanical grouping)
  its confirmed classification; otherwise it is shown unclassified, never in another group.
  A classification also depends on the case's basis (v2).
- **Criteria.** A decision is shown as decided only when its own claim is confirmed and the
  facts it reads are shown (every timing fact for the timing window and the first flight; the
  symptom for a failure type); otherwise it is shown unconfirmed and marked not verified.
  Decisions are never recomputed, so a removal only ever downgrades one. Timing facts that
  conflict with each other are shown together or not at all (v2): "2 days" is never left
  standing once the "40 days" beside it is removed.
- **Summary sentences.** A sentence depends on the reading and basis of every case it cites,
  and, when it refers outside itself anywhere (v2, 16d review I1: comparatives and anaphora such
  as "similar", "again", "comparable", "too", "also", "another", "both", "the same", "the second
  case", "earlier", "remaining", "this", "these", "however", a leading "it" or "they"), on every
  other sentence and every case those sentences present; a sentence that counts or contrasts
  the presented cases ("in both cases", "all three") depends on every presented case's reading
  and basis. When in doubt, the sentence is removed with its antecedent. A case's own sentences
  stand or fall together. A comparison citing two or more
  cases also depends on every statement and group placement of those cases, on their own
  sentences and on other comparisons sharing a case; removing a comparison never removes a
  case's own sentences. Gap notes depend on nothing else.
- **Whole output.** A failed check call, a check input over its limits, or a structurally
  unusable verdict set withholds everything. After the cascade, more than a third of the
  summary's sentences removed, or two or more contradicted claims, withholds the whole output
  (pre-registered experimental usability defaults, not safety guarantees). Minimum useful
  content is one shown summary sentence and one presented case with its reading; a marker-only
  summary is never shown.
- **Copy.** A removed run of sentences leaves a count marker; a removed field or decision is
  marked as not verified ("the check could not confirm this against the cited passages"),
  never as evidence the NTSB record lacks. The checklist states the count, never a blanket
  status: "Evidence check completed · 2 statements removed" (Task 16e; "PARTLY CHECKED" is
  gone). Every case the result counts is on the sheet: one the projection keeps without a
  confirmed classification is listed under "Not classified" (or "Not confirmed" for
  examples), one without its reading says "AI reading not shown", and its drawer, the print
  view and Compare carry the same markers (UI_DESIGN §4.3, "What the evidence check
  removed").

The [data assessment](DATA_REVIEW.md) gives four real seed cases. DFW08TA066
supports a maintenance-related causal fault; DEN08LA103 an undetermined cause
with a negative examination; MIA08LA156 a real defect without an established causal
link. NYC08LA106 shows why a successful test after cleaning does not negate the
earlier failure. An aviation reviewer must adjudicate final evaluation labels.

## 4. Sources and ingestion

The inspected archive contains **31,303 events**, including **24,291 provisional
US completed cases**. `avall.zip` starts in 2008. Historical archives have other
schemas. NTSB announces replacement of the download channel on **April 5, 2027**.
See [source measurements and qualifications](DATA_REVIEW.md).

Define a source adapter returning canonical cases, identifiers, revisions, and
provenance. Implement MDB first, historical normalizers separately, and an
Enterprise API adapter before the transition. API access, pagination, quotas,
identifier mapping, date semantics, revisions, and deletions remain unverified.
`GetCasesByDateRangeV2` must not be assumed to be a change feed.

The pipeline:

1. Discover official downloads and record retrieval metadata/hash. Accept fixed
   source hosts/paths only, with download time and size limits.
2. Extract allowlisted members with expanded-size limits; reject traversal,
   symlinks, nested archives, and unexpected files. Run pinned MDBTools in a
   no-network/no-secrets extraction container with read-only root and CPU, memory,
   and execution limits. A separate TypeScript loader validates its CSV before
   receiving database/search credentials. Source text never becomes a command,
   script, filename, or SQL statement. Check allowlisted hosts at every redirect.
3. Use the embedded dictionary to normalize dates, units, and country codes;
   validate coordinates/keys and quarantine malformed records.
4. Join on `(ev_id, Aircraft_Key)` where applicable. Select fields explicitly,
   omitting owner street addresses, contact details, and internal editor names.
5. Verify completed-status mapping using official metadata/reports. Preserve the
   raw status and mapping version. Missing/conflicting status is ineligible for
   findings-based answers; `F` must not be guessed to mean final.
6. Store canonical sections and revisions in PostgreSQL; create sanitized search
   documents/chunks. Keep factual, final analysis, cause, and findings separate.
7. Hash normalized sections, embed only changed text, build versioned indices,
   check counts/sample queries, and switch aliases atomically. Mark dependent
   assertions stale after a revision and exclude them from answers/aggregates until
   reprocessed. Version citation text independently of normalized search text;
   specify the offset unit and retain a deterministic mapping between the two.

**As built (first release).** Step 1 is not automated: an operator supplies the
archive and its SHA-256, and the worker checks the hash before extraction, so the
host allowlist and download limits wait for an automated download. In step 3 the
dictionary supplies display labels; units and country codes are kept as published
(for example `USA`). Step 7 publishes by writing the active `dataset_manifests`
row, which names concrete index names. Aliases only point at the last build, and
the API never reads them. [DATA_PIPELINE.md](DATA_PIPELINE.md) describes the
pipeline as built.

Use the event-level `ntsb_no` as the public case key and URL (`/cases/SEA08LA057`);
keep `ev_id` internal. All 31,303 event-level numbers in the inspected snapshot are
populated and unique; enforce that invariant during import. Multiaircraft events
carry suffixed aircraft numbers (`SEA08LA057A`, `SEA08LA057B`). Resolve them
through the parent event relationship, not by stripping a trailing letter, and
preserve aircraft attribution on narratives, findings, and report links.

The numeric CAROL report ID is not `ev_id`; `ntsb_docket` is entirely empty in the
inspected snapshot, and the MDB contains no other report identifier. The four seed
IDs were matched individually. For the bulk mapping, use the official Aviation
Search JSON (or CSV) export, which [NTSB documents](https://www.ntsb.gov/news/press-releases/Pages/NR07172023.aspx)
as including report and docket links. Verify a fresh export's field names, limits,
and completeness first; do not hard-code an assumed field name. Match case/aircraft
numbers and dates to imported records, keep potentially several reports per event,
record the mapping source and retrieval date, and partition exports by date if
needed. Start with database text and official PDF links. Full PDF/docket
extraction can wait.
PDF citations need real page/version information; MDB citations use source
sections/paragraphs without invented PDF pages. Build clickable URLs from a fixed
HTTPS host/path template and a validated, resolved report ID; never directly render
an arbitrary source/model URL. Label captured source revisions because the official
latest-report link can subsequently change. When no report ID is resolved, show
the copyable case number, “Direct report link unavailable,” and a link to official
[Aviation Search](https://my.ntsb.gov/aviation) labelled as a search, not as the
report. Do not construct prefilled search URLs until their format is verified.

Use monthly full snapshots for reconciliation. Weekly filenames repeat; version
them by retrieval timestamp/hash. Verify whether updates contain full cases or
partial rows before replacing child records or detecting deletions. Until then,
full snapshots are the reliable refresh path and the UI shows their actual age.
Failures preserve the last known-good corpus. Date-range API ingestion also needs
historical reconciliation to catch amendments to old cases.

Suggested PostgreSQL groups:

| Group | Tables/responsibility |
| --- | --- |
| Corpus | Cases, aircraft, source sections/revisions, findings, assertions, ingestion runs |
| Identity | Better Auth user/account/session/verification tables |
| Product | Later: saved case collections and separate email-consent records |
| Controls | Usage buckets, cost ledger, reservations, concurrency leases, short-lived idempotent results |

Use a dedicated application database and separate restricted runtime, ingestion,
and migration roles. Elasticsearch is a rebuildable projection, not the only
copy of source evidence or the store for users/quotas.

## 5. Hybrid retrieval and bounded RAG

Embeddings represent text numerically so differently worded passages can match.
RAG retrieves evidence and supplies it to a model to write an answer. Neither
establishes whether a suspected cause was confirmed; provenance and evaluation
are essential.

Create two versioned indices:

- `aviation-cases-*`: one event document, typed filters, nested aircraft, completion
  state, source references, and dashboard attributes.
- `aviation-passages-*`: section chunks with event/aircraft keys, revision/hash,
  offsets, section type, copied filter metadata, text, and `dense_vector`.

Use explicit mappings and `dynamic: strict`. Same-aircraft constraints must match
one nested aircraft or a validated aircraft ID. A collision must not satisfy a
Cessna filter with one aircraft and turbine evidence from another. Case charts
count distinct events, not expanded join rows.

Mark passages as aircraft-scoped or event-scoped. A row's aircraft key does not
prove that every sentence concerns that aircraft. In multiaircraft events,
event-scoped text alone cannot establish an aircraft-specific maintenance or fault
claim. Require an explicitly attributable passage or retain ambiguity. Mark these
cases in the UI and test them independently.

Start with 500–800-token section chunks and modest overlap; retain short causes
and findings intact. Use `text-embedding-3-small` at 1,536 dimensions. Evaluate
768/1,024 dimensions only with a full reindex and retrieval benchmark. Version
model, dimensions, normalization, and chunking together. The
[embeddings guide](https://developers.openai.com/api/docs/guides/embeddings)
documents shortened dimensions.

Run BM25 keyword search and filtered kNN, then combine rankings in TypeScript via
reciprocal rank fusion: `sum(1 / (60 + rank))`. Apply the same
completion/country/aircraft constraints in every channel, including the kNN
prefilter. Preserve exact case numbers and negation such as “no” in evidence text.

Retrieval behaviour is versioned (task 10e; `server/search/retrieval-config.ts`): one
frozen configuration per version holds every channel, field, depth, query form and
text, the fusion level, constant, weights and tie order, the mapping and the packing,
and an operator setting (`AVIATION_RETRIEVAL_VERSION`) chooses one. The version is
recorded with every brief step, on its retrieval span and in evaluation reports.

- **`retrieval.v1`** (the rollback): passage BM25 on the scope stage's keyword text
  and passage kNN on the question, 50 candidates each, passage-level fusion, cases at
  their best passage.
- **`retrieval.v2`** (the default; task 10d phase A's `c200+n-kt`): the same two
  passage channels at 200 candidates (kNN `num_candidates` 800), plus BM25 over each
  case's narratives in the cases index (200 cases). Each channel is collapsed to its
  unique cases and the case lists are fused (k = 60, equal weights) with exact
  fractions and a total tie order. The cases index takes part only as a channel that
  nominates cases: its filter reaches exactly the cohort the passages filter reaches,
  under the passages contract's aircraft semantics, and a nominated case reaches the
  answer only through its own passages under the passages filter (mapped by the same
  query vector when no passage channel returned it), with every probable-cause
  variant. A case-level match is never evidence by itself. The cases channel reads
  only the cases index version the validation covered (`cases-v3`); the cases index a
  step read (name and version) is recorded in its private metadata.
- **Cutoffs.** Candidate discovery and fusion are kept apart. Both BM25 channels ask
  Elasticsearch to sort by score, then passage id or case number, while it collects
  their top 200, so equal scores at the cut are decided by the id. The kNN channel is
  approximate discovery: which neighbours it finds, and their quantized scores, belong
  to one index state, so a rebuilt copy of the same documents can return a different
  set. A mapped case's passages are all scored exactly and cut by score, then id.
  Fusion is exact and totally ordered over whatever the channels returned; it is
  reproducible for one index state, not across rebuilds.
- **`retrieval.v2-nf`** (experimental, never on `live`): also searches the coded
  `findings_text`; its coded-reference gain rests on the field the coded labels come
  from, so its value waits for narrative-relevance evaluation (Track N).

Use `match`/`multi_match` on allowlisted text fields, never user/model text in
`query_string`, regex, scripts, or wildcard queries. Validate filter enums/ranges;
fix candidate counts, page limits, and timeouts in code. Country and completion
constraints are compulsory server clauses, not optional planner suggestions.

This Basic-compatible approach does not need ELSER, ML nodes, additional plugins,
`semantic_text`, Elasticsearch inference endpoints, or licensed native RRF. Use
[explicit vector mappings](https://www.elastic.co/docs/solutions/search/vector)
and check deployment features against the [subscription matrix](https://www.elastic.co/subscriptions).
OpenAI embedding calls happen in application/worker code. The embedding model is
part of the index version: changing it, including to another vendor, means a full
reindex and a retrieval benchmark. Changing the language-model provider (§9) does
not touch embeddings.

The online pipeline is fixed:

1. **Admit:** validate input, identify the principal, validate Turnstile when
   required, and atomically reserve quota, concurrency, and maximum cost.
2. **Scope/plan:** one small structured model call emits an allowed intent, filters,
   terms, and ambiguity. It cannot emit SQL, Elasticsearch DSL, URLs, index names,
   model choices, or privileged messages.
3. **Retrieve:** compile fixed query templates, embed the query once, and retrieve
   at most six cases/twelve passages under the configured retrieval version. Include
   relevant cause, analysis, and adjacent context rather than classify an isolated
   fragment.
4. **Compose:** one model call emits structured comparisons and references from
   an allowlisted set of retrieved passages.
5. **Validate:** code checks IDs, revisions, offsets, exact quotation matches, and
   schema; then the reader's criteria in code (the timing rules, §3); then a separate
   model, the evidence checker, judges every claim against the evidence. It receives
   bounded claims with server-issued ids and their citations, every supplied passage of
   the cases they are about, and a fixed policy, not the raw user question/history or
   planner instructions. It returns exactly one verdict per claim id (`supported`,
   `contradicted` or `not_established`) with the passages it rests on and, for a
   contradiction, the decisive words, which code finds in the passage. The check input
   also carries a server-built header per case (aircraft, place and date from the coded
   record, since `check.v7`): a claim may name a case by it, and it supports nothing else. Code
   decides the outcome (server/briefs/verdicts.ts, server/briefs/display.ts): a missing,
   duplicate or unknown id, a verdict naming passages outside the claim's cases, a
   `supported` verdict naming no passage for a claim that is not an absence, an
   unverifiable quote, and a failed, truncated or malformed response withhold everything
   generated; since `check-judgement-v2` (Task 16e) a `supported` verdict naming a passage
   of the case that the claim does not cite makes only that claim not established
   (`supported_outside_citations`). A claim is confirmed
   only by exactly one valid `supported` verdict; an absence claim ("none of the supplied
   passages mentions maintenance"), which cites every passage of its case, needs
   `supported` too. What is shown is decided by one pure function, the **display
   projection** (`display-deps-v2`, Tasks 16d and 16e; the rules in §3), from dependencies the server derives from
   the composition's structure, never from the model: a case's reading needs its
   confirmed why line and at least one confirmed quote and no contradicted criterion; a
   contradicted essential claim of a case (why, classification, maintenance, timing,
   criterion, quote attribution, or a summary sentence citing it) suppresses its summary
   sentences, its group placement and every comparison citing it; a decision is shown as
   decided only while its claim and the facts it rests on are confirmed (never
   recomputed, so it can only be downgraded to unconfirmed); a case's own sentences stand
   or fall together, a comparison depends on everything about the cases it cites, and a
   sentence that refers outside itself anywhere depends on the other sentences and the
   cases they present; conflicting timing facts are shown together or not at all; and
   what the deterministic rules abstain from (an excerpt that loses its context, a flight
   ordinal no passage states; §3) is never shown. Whole
   sentences only: nothing is spliced or reworded. More than a third of the summary's
   sentences removed, two or more contradictions, or no shown sentence and case reading
   withhold the whole output (pre-registered usability defaults, not safety guarantees).
   Every response surface (the step, the stored dimensions, the case context, refinement
   inputs) is rendered from the projection; diagnostics keep the raw verdicts. Until gate
   G6 clears partial display, production runs the projection in `whole` mode
   (`AI_PARTIAL_DISPLAY` unset): any removal withholds the summary, as in Task 16c.
   Validate referenced case identifiers
   in free text too; an unallowlisted identifier rejects the whole generated answer
   and falls back to retrieved case cards. Render labels/links from server-owned fields. The checker
   is still fallible and has no tools or authorization role.
   Every summary sentence must end with the case markers it cites, and the code check
   withholds any summary whose sentence boundaries it cannot see
   (server/briefs/sentences.ts): the summary is written with an allow-list of
   characters (printable ASCII except Markdown and decoration, the quotation marks
   `“ ” ‘ ’`, the dashes `– —`, `° ± × ½ ¼ ¾ §`, and Latin-1 letters with diacritics),
   so the only characters that can end a sentence are `.`, `!` and `?` and the only space
   is U+0020; a sentence ends at every `.`, `!` or `?` before a space, and no other one
   may remain inside a sentence. What this does not cover: six declared abbreviation
   contexts ("No. 2", "approx. 5", "Mr. Smith", "U.S. operator", "49 U.S.C. 1154", "e.g.
   a school") are an accepted residual (a sentence that really ends with one of them,
   "…hurt? No. 3 passengers…", joins the next), and clauses joined by a semicolon, colon,
   comma or dash are one sentence; the checker judges each joined claim whole.
   Failed/inconclusive validation returns case cards without generated conclusions.
   There is no automatic repair loop.
6. **Settle:** record cost metadata, settle reservations, release concurrency, and
   return the validated result. Show progress stages; do not stream unvalidated
   generated claims before verification finishes.

No general agent loop is needed. Developer instructions are server-controlled;
questions and source passages are untrusted data. The model cannot see credentials,
emails, sessions, private configuration, or quota rows. Code determines tools,
sources, budgets, and permissible filters.

Label a relevance-ranked result “examples found,” not all matching investigations.
Global statistics come from deterministic queries over indexed fields. Aggregates
using extracted assertions must state the processed/reviewed cohort and show
unknown/unprocessed counts. Do not extrapolate from the top retrieved cases.

## 6. Off-topic and prompt-injection defenses

Neither a system prompt nor an LLM classifier guarantees rejection of every attack.
Use layered rejection and bounded consequences. OpenAI's
[safety guidance](https://developers.openai.com/api/docs/guides/safety-best-practices)
supports constrained inputs/outputs, evidence-based answers, and adversarial tests;
[OWASP](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
also treats retrieved content/model output as untrusted.

| Layer | Decision |
| --- | --- |
| Input | JSON only; bounded body, 1,500-character question, limited filter/case arrays/history; reject unknown fields |
| Scope | Enum: `case_search`, `case_comparison`, `corpus_statistics`, `needs_clarification`, `out_of_scope`, `operational_advice` |
| Topic | Historical case study and evidence-supported explanations; decline unrelated coding, finance, travel, prompt/key disclosure |
| History | Recheck each refinement; only the server-owned brief (bounded intent, validated filters/IDs); never accept client system/developer messages or earlier answers as evidence |
| Retrieval | Fixed read queries over public aviation indices; no arbitrary URLs, browsing, scripts, shell, uploads, or generic SQL |
| Output | Allowlisted case/citation IDs; HTML-encoded text; no model-generated active HTML, images, scripts, or arbitrary links |
| Uncertainty | Insufficient evidence/verifier failure returns abstention or case cards |
| Economics | Rejections count toward abuse attempts; classifier, embedding, and verification costs are also metered |

Moderation is content-safety screening, not topic detection. Evaluate it on
aviation queries so references to fatalities are not automatically treated as
abusive. If included, screen user input and treat it as an additional layer.

Structured outputs enforce shape, not truth. Both providers support them:
[Anthropic](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
through `output_config.format`, and
[OpenAI](https://developers.openai.com/api/docs/guides/structured-outputs). Validate
with Zod again in app code. Handle refusals (`stop_reason: "refusal"` on
Anthropic), truncation (`max_tokens`) and unparsed output as failed stages, and
verify semantics separately. Server-owned instructions go only in the
provider's privileged channel (the Anthropic system prompt, or the OpenAI
developer message). Questions and passages go in the user turn as delimited,
untrusted data. Use the SDKs directly, with no agent frameworks or hosted agent
products.

Tests must include a recipe hidden in an aviation story, encoded off-topic input,
fake source IDs, “ignore instructions,” malicious text inside a narrative, topic
drift, and valid citations attached to unsupported claims. Also measure false
rejections of legitimate questions without obvious aviation keywords.

## 7. Anonymous trial, Google login, and consent

Proposed configurable ceilings, all subordinate to the global spend limit:

| Identity/action | Initial limit |
| --- | --- |
| Anonymous trial | 3 AI requests per server-tracked identity retained for 30 days |
| Anonymous burst | 2 AI attempts/minute; one in flight per identity |
| Anonymous network backstop | 10 attempts/hour and 20/day per normalized IP or IPv6 /64 |
| Signed-in AI | 20/day, 150/month/account; 5 attempts/minute; one in flight; new accounts get 5/day for their first 3 days |
| Signed-in network backstop | 30 attempts/hour and 100/day per normalized IP or IPv6 /64, with tuning for shared networks |
| Global AI | 2 in flight, at most 1 anonymous; anonymous spend at most 25% of daily interactive allowance |
| Browsing/search/dashboard | No AI quota; bounded queries and initially 60 HTTP requests/minute/network identity |

These are ceilings, not guaranteed allocations. Tune shared-school-network behavior.
Cookies, IPs, and Google accounts are not unique people: resets, network changes,
and account farming remain possible. The global budget is the final cost boundary.

Reserve the remaining daily budget for authenticated users. Broader IPv6 /56 and
/48 anomalies can trigger step-up checks and temporary limits, but shared networks
need an appeal/tuning path. Multiple aged accounts can still exhaust the public
allocation: retain a login-required emergency mode and expect a small beta under
this budget, not abuse-proof availability.

Use a random signed HttpOnly trial cookie backed by a database record, not a
browser-only counter. After three requests, explain the limit and offer Google
sign-in while keeping browsing available. A live brief can move to the new
account at sign-in. Each step keeps the billing principal it was admitted under
(later refinements bill the account), and only read ownership moves, atomically
and once
([interface design](UI_DESIGN.md) §5, "Signing in mid-brief").

Describe the offer as “Up to three free AI searches, subject to daily availability.”
Pacing makes the anonymous allowance small. With $80 spread over a fresh 30-day
month, roughly $2.67/day is interactive and $0.67/day anonymous. With the default
Opus answer model (§9), that is about 7 anonymous requests, or 2 complete trials,
a day. Exhausted capacity is therefore a normal
state, not an edge case. Offer “Sign in to continue” only while authenticated
capacity remains; when the global allowance is exhausted, say AI search is
temporarily unavailable and keep keyword search, case reading, and deterministic
comparison usable. Signing in never implies a guaranteed allocation. The anonymous
share and new-account allowance are runtime configuration; other limits start as
typed, centralized defaults.

Better Auth manages authorization-code login, state/PKCE, and sessions. Request
only `openid email profile`; require verified email. Use Google provider **`sub`**
as identity, not mutable email, as [Google specifies](https://developers.google.com/identity/openid-connect/openid-connect).
Disable unused providers, password registration, and automatic email-based account
linking. Avoid offline access and retaining provider tokens unless required;
verify the auth library's actual storage behavior.

Disable session cookie caching initially so logout/deletion/revocation checks hit
the authoritative session store. Store only needed Google profile fields. Create
trial identities only after a successful challenge when AI is first requested;
cap their creation rate and count. A cookie-setting response must never be cached.

Use host-only Secure/HttpOnly/SameSite cookies, explicit production `APP_URL`,
exact trusted origins/callbacks, and CSRF protection on custom POST endpoints.
Keep [Better Auth security checks](https://better-auth.com/docs/reference/security)
enabled and configure its [auth rate limiter](https://better-auth.com/docs/concepts/rate-limit).
That limiter does not replace application AI quotas.

Login email serves account operation only. **The first release sends no
training-case or marketing email and collects no opt-in.** That waits for an
email provider. Email/password accounts with email verification, alongside
Google, are planned for the same later step. When email updates arrive, they
require a **separate, unchecked opt-in**, consent text/version/time,
confirmation, and unsubscribe.
Google login must not silently subscribe users to marketing. This conservative
design follows the [Czech privacy authority's guidance](https://uoou.gov.cz/index.php/profesional/qa-otazky-a-odpovedi/obchodni-sdeleni).
Publish a privacy/contact notice before collecting real users.

Consent belongs to the confirmed email address as well as the account; changing
that address requires reconfirmation. Unsubscribe must work without login using
an opaque token. After deletion, retain only the minimal documented suppression
record needed to avoid further mail, not an active marketing profile.

Proposed retention: trial identities 30 days; pseudonymous security logs 7 days;
content-free request records 30 days; quota buckets through their calendar window
plus 7 days; content-free cost ledger 90 days for reconciliation; backup expiry
30 days. Keep in-progress/idempotent results for at most 24 hours, disclosed as
temporary processing; conversation context expires with that window. Persist a
collection/history beyond that only at the user's request. Account deletion ends
sessions and removes saved content; explain backup expiry and minimal retained
anti-abuse/financial records. Do not delete an active monthly budget bucket on day
30 of a 31-day month or grant fresh quota on account deletion/re-registration.
Keep a minimal anti-abuse record keyed by an HMAC of the Google issuer and `sub`,
using a dedicated secret, through the quota window plus 7 days. It survives account
deletion without retaining the email/profile and reattaches the existing usage on
re-registration. Document this pseudonymous retention and preserve its counters
during key rotation; do not cascade-delete it with the account.

Langfuse production traces follow the 30-day content-free metadata limit. Questions
and answers remain outside telemetry by default; asynchronous evaluation uses only
the existing 24-hour temporary-processing window. Public/synthetic benchmark
fixtures have a separate lifecycle. See the [capture and retention policy](OBSERVABILITY_AND_EVALUATION.md#privacy-retention-cost-and-availability).

## 8. Abuse controls and atomic accounting

Cloudflare is the outer traffic filter. Validate Turnstile server-side, checking
success and expected hostname/action; tokens expire after five minutes and are
single-use. Challenge anonymous AI use and suspicious authenticated activity.
The public site key is server runtime configuration returned by a typed, allowlisted
`GET /api/config`, so one image serves every environment; render the widget
explicitly after that config loads. Nothing in that response affects quota checks.
See [Turnstile verification](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

Trust `CF-Connecting-IP` only through the controlled tunnel/proxy path. Never accept
arbitrary forwarded headers on an independently reachable origin. Normalize
IPv4-mapped IPv6; enforce IPv6 /64 limits. Store short-lived keyed IP HMACs, not raw
addresses in analytics; these remain pseudonymous personal data. Key rotation must
preserve counters across an overlap period. No browser fingerprinting.

For the public deployment, isolate app ingress and the tunnel connector on a
dedicated network, with no unrelated containers. Set Fastify `trustProxy: false`
explicitly; admit production HTTP only from the configured connector socket peer,
not from a header assertion. Bind/firewall the listener accordingly even if the
app has other interfaces for database access. After accepting the socket peer,
derive one validated client identity from `CF-Connecting-IP`. Every network bucket,
including browsing and Better Auth's limiter, must use that identity through an
explicit adapter, never Fastify's connector-valued `request.ip`. Missing/invalid
client-IP headers reject dynamic requests, including browsing, auth, and paid APIs;
they must not mint a new identity or put everyone in the connector's bucket.
Test direct access and forged headers from another container. Loopback alone does not authenticate
co-resident processes; reserve that simpler mode for local development.

For every paid path, use one short PostgreSQL transaction to lock/create relevant
principal/network/global buckets in a stable order, enforce limits/idempotency,
reserve maximum cost, and acquire expiring concurrency leases. Commit before
provider calls; do not hold a transaction while waiting on the model.

Scope idempotency to principal and canonical request hash. Different content with
the same key fails; identical retries cannot trigger another paid request or read
another user's result. Comparisons, future exports, and ingestion/evaluation jobs
must use the same cost gate.

Settle actual usage and release unused reservations. If a paid call has no reliable
usage result, settle its reservation at the full maximum, marked uncertain; never
automatically refund it on timeout or lease expiry. Operator reconciliation against
the dedicated provider project's billing can correct verified over-reservations
or reduce remaining headroom when observed spend is higher. Aggregate billing
does not prove an individual request was free. Provider organization/admin billing
credentials, if needed, belong to operator tooling, never the public app/worker.
User credit refunds are separate from actual provider-spend accounting.

Give each lease an ownership/fencing token. Enforce a total application pipeline
deadline of 100 seconds (`PIPELINE_DEADLINE_MS`: the sum of the stage timeouts, scope 10,
retrieval 8, answer 35 and check 45 seconds, plus 2 seconds of margin, so the check always
gets its full timeout after slow earlier stages; Task 16c's 90 seconds were less than that
sum), per-stage timeouts within it (each cut to what is left), and a longer lease TTL
(120 seconds; a running step is stale after 150). A call that runs out of time settles
uncertain and is charged its whole reservation, because the provider may still bill it.
The check timeout is the one the calibration ran with (Task 16d gate condition 4); since
Task 16e it is derived from the measured latency (1.25 times the slowest development call,
within 30 to 45 seconds), which kept 45 seconds (§12).
Settlements/releases require the current ownership token. A retry
finding running/expired work returns its state/result, never silently starts a
second pipeline. Expiry can free a local execution slot but not reserved money.
Aborting a connection cannot guarantee remote inference stopped; the conservative
charge still bounds spend. The concurrency target concerns local pipelines, not
an unverifiable promise about provider execution after timeouts.

Fail closed for paid requests if quota storage or required abuse validation is
unavailable; cached/bounded browsing can continue. Use 429 plus retry information
for limits, 503 for temporary dependency failures, and an AI kill switch.
Do not rely on provider dashboard budgets as an instantaneous hard cutoff.
Bound timeouts/tokens/context/concurrency and disable automatic SDK retries
initially; ambiguous retries must not multiply unaccounted charges.

## 9. Model providers, choices and cost envelope

### Provider switching

Language-model calls (scope/plan, compose, check) go through an app-owned
provider interface. Anthropic is the first and initially only implementation. An
OpenAI Responses API adapter is designed for but built only when a switch is
actually needed. Each stage call takes a typed input and returns:

- a Zod-validated object
- normalized usage: input, output including reasoning, cache-write and
  cache-read tokens
- the provider, model and prompt version

Prompts are versioned per provider and model.

- **Who switches:** operators only, through deployment configuration
  (`AI_LLM_PROVIDER`, plus per-stage model variables) and a restart. It is
  never visible to or selectable by users.
- **No routing:** there is no per-request routing or automatic failover between
  providers. One process uses one provider, so the cost gate prices exactly the
  allowlisted models.
- **Before enabling:** a provider/model combination must pass the §12 evaluation
  gates on the same versioned dataset, and its price/cap rows must exist in the
  allowlist. The startup check refuses to enable AI otherwise.
- **Live briefs:** a brief records the provider and model of each step. A
  refinement after a switch simply runs on the new provider; earlier answers
  were never evidence.
- **Embeddings are independent.** Anthropic offers no embedding model, so
  embeddings stay on OpenAI `text-embedding-3-small` whichever language-model
  provider runs. Switching the language-model provider therefore needs no
  reindex. Changing the embedding model or vendor is a separate, index-versioned
  rebuild (§5). The app needs an Anthropic key for language models and an
  OpenAI key for embeddings.

### Candidate models

These are candidates to evaluate, not benchmark results. Published prices were
checked on 2026-10-21; verify account access and current pricing when
implementing.

| Stage | Anthropic (default) | USD / million tokens (input / output) |
| --- | --- | --- |
| Scope/plan | `claude-haiku-5-5`, thinking disabled, effort `low` | $0.10 / $0.50 (prompts ≤100K tokens) |
| Evidence comparison | `claude-opus-5-5`, effort `low` (thinking cannot be disabled) | $4 / $20 |
| Output check | `claude-haiku-5-5`, adaptive thinking, effort `medium` (the calibrated configuration, §12; `low` until Task 16e) | $0.10 / $0.50 |
| Cheaper answer candidates | `claude-sonnet-5-5` / `claude-haiku-5-5` | $2 / $10 and $0.10 / $0.50 |
| Embeddings | OpenAI `text-embedding-3-small` | $0.02 input |

The OpenAI candidates for a future adapter remain GPT-5.6 Luna for scope and
check ($0.20 / $1.20) and `gpt-5.4-mini-2026-03-17` for comparison
($0.75 / $4.50).

`claude-opus-5-5` is the default answer model. The cheaper Sonnet and Haiku
candidates run in the same evaluation. **The owner chooses the production answer
model from those results, together with the budget below.** Choosing a cheaper
model is a product decision, not an automatic downgrade.

### Example cost per request

Request sizes below were measured with Anthropic's own counter (`messages.countTokens`,
free) on 2026-10-22 against real shared-dev passages; `claude-haiku-5-5` and
`claude-opus-5-5` count identically. Claude counts about **1.6×** the `cl100k_base`
tokens of the same NTSB text (median 1.59, 90th percentile 1.68, maximum 1.89 over
100 passages; 1.62 over a 12-passage bundle), and a structured-output schema costs
about 2.5× its JSON size. Each stage's fixed request (system prompt and schema) is
3,204 tokens for scope, 5,673 for the answer and 4,684 for the check (the `compose.v8`
and `check.v9` prompts, measured by the preflight on 2026-10-23, Task 16e). A typical request,
estimated from those sizes and, for the check, from the calibration's settled usage
(about 30 claims; Haiku thinks adaptively):

| Stage | Tokens (input / output) | Cost |
| --- | --- | --- |
| Scope | 3,250 / 150 | $0.0004 |
| Answer | 13,000 / 2,600, including about 800 thinking tokens | $0.104 on Opus 5.5 |
| Check | 11,700 (4,500 of it the cached prefix) / 5,400, including about 4,600 thinking tokens at effort `medium` (Task 16e's selection; about 3,600 and 2,700 at `low`) | $0.0035 |
| Embedding | — | ~$0 |

Total per request:

| Answer model | Typical | Hard-cap reservation |
| --- | --- | --- |
| Opus 5.5 | about $0.11 | $0.36 |
| Sonnet 5.5 | about $0.056 | $0.19 |
| Haiku 5.5 | about $0.007 | $0.03 |

These exclude ingestion, evaluations, taxes and hosting. Meter all billable
output, including thinking. Built-in web or file tools are unnecessary.

**Hard caps,** in provider tokens, each above the largest request the server can
build for its stage (measured with the provider's counter; real passages and the
synthetic worst cases of `pnpm worker ai-preflight`):

| Stage | Input | Output | Largest measured request |
| --- | --- | --- | --- |
| Scope | 6,500 | 600 | fixed 3,204; the longest refinement 5,055 (English) and 5,074 (dense text at the query-embedding cap); output at its schema bounds 445 |
| Answer | 28,000 | 11,000, including thinking | fixed 5,673 (`compose.v8`); a full bundle (12 passages, about 9,400 `cl100k` evidence tokens) 23,213 synthetic; the 10,000-token evidence budget at 1.75× bounds it near 25,600, and the measured stress cases fit without re-packing; output at its schema bounds (six cases, each with four chronology facts naming their anchors) 8,000 plus 1,500 for thinking |
| Check | 40,000 | 24,500, including thinking | fixed 4,684 (`check.v9`); a full bundle's complete evidence with 60 claims (`MAX_CHECK_CLAIMS`) 26,969; the visible output at its schema bounds (a verdict for each of 60 claims, each naming 12 passages, and eight 1,000-character quotes) 6,461, plus a 15,000-token thinking allowance (the most measured: 11,408 thinking tokens and 13,405 output tokens on a 60-claim check at effort `medium` in the Task 16e development round, 9,180 at effort `low`, against 8,178 in 16d's and 4,915 and 5,545 on 16c's development and held-out checks) |
| Embedding | 1,000 | — | — |

The models read passage ids as short aliases (`P1`..`P12`): a 64-character id costs
about 42 tokens wherever a model reads or writes it, which would add some 6,000 tokens
to a full check and some 2,500 to a full composition's output. The check is never cut
to fit (gate G6 ruling 5): above its cap the summary is withheld.

Context assembly bounds input with the provider's tokenizer: Anthropic
`messages.countTokens`, or a measured margin. Characters alone do not bound
tokens. **`pnpm worker ai-preflight`** re-measures every stage's fixed request, its
synthetic worst case and its output at the schema bounds with the configured provider
and models (free), and fails when any is over its cap; it is mandatory before paid
tests and deployments (RUNBOOK). Between preflights a unit test sizes the same
requests offline (`cl100k_base` × 2.2 for system prompt plus schema, × 1.8 for text).

**Prompt caching:** only the frozen system prefix of each stage is cached, with
the 5-minute TTL and at most 6,500 tokens (the largest, the answer stage's, is 4,883
with its schema). The reservation is the **sum over all stages** of each stage's
hard-cap cost at the worst applicable price, plus the cache-write premium on its
cached prefix:

| Answer model | Uncached sum | Answer-prefix premium | Haiku scope and check prefixes | Total | Reservation |
| --- | --- | --- | --- | --- | --- |
| Opus 5.5 | $0.34772 | 6,500 × $1/M = $0.0065 | $0.000325 | about $0.3545 | $0.36 |
| Sonnet 5.5 | $0.18172 | 6,500 × $0.50/M = $0.00325 | $0.000325 | about $0.1853 | $0.19 |
| Haiku 5.5 | $0.02402 | 6,500 × $0.025/M = $0.0001625 | $0.000325 | about $0.0245 | $0.03 |

The check's share is $0.0149 (40,000 input and 21,500 output tokens on Haiku, thinking
included); a Sonnet checker at the same caps would add $0.28 and need about $0.64 with
the Opus answer model. With the Opus answer model, the $3 daily cap holds eight
worst-case reservations, and a fresh 30-day month's paced allowance (the lower of $3 and
$80 / 30 = $2.67) seven.
That is **budget capacity, not concurrency**: separate in-flight limits apply (one
request per principal, `AI_GLOBAL_CONCURRENCY` overall, and currently one anonymous
request at a time). Each admission needs its whole reservation as headroom under the
day's allowance, even though it settles at its actual cost; how many briefs a day that
admits is under [Budget](#budget).

Recalculate whenever a model, price, cap, TTL, cached-prefix size or retry policy
changes.

At startup, compute this per-request sum from the allowlisted
provider/model/price/cap table. Refuse to enable AI if the sum exceeds the
configured reservation, or if any reachable model's pricing is unknown. A
per-stage check is not enough. Low output caps can truncate verification; measure abstention and
truncation rather than treating them as good quality.

### Anthropic call settings

- Construct the client with `maxRetries: 0` and a per-request `timeout` (in
  milliseconds) inside each stage's deadline.
- Use `messages.parse` with `output_config.format` built from the stage's Zod
  schema.
- Check `stop_reason` before reading content: `refusal`, `max_tokens` or a null
  `parsed_output` fails the stage.
- Settle from `usage` (`input_tokens`, `output_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`).
- Cache the frozen system prompt. Low traffic means cache hits will be rare, so
  do not budget on them.
- No assistant prefill, sampling parameters, server tools or Files API.
- Anthropic recommends server-side refusal fallbacks (`fallbacks: "default"`)
  for Opus. Keep them off until the cost gate prices every permitted fallback
  target and settles both attempts from `usage.iterations`. Until then a refusal
  is a failed stage that returns case cards.

### Budget

Split $100/month into **$80 interactive + $20 indexing/evaluation**, with
**$3/day** as an upper interactive daily bound. The owner set $100 while the $200
Anthropic credit lasts. Revisit it when the credit runs out; all of these are
runtime configuration. The indexing/evaluation share covers embedding passes and
budgeted evaluation runs: one 100-question run with the Opus answer model costs
about $11. Pace the daily allowance using the lower of
that bound and remaining interactive money divided by remaining calendar days.
Cap anonymous spending at 25% of the resulting allowance.

What $80 covers depends on the answer model. Each admission needs today's spend plus
its whole reservation to fit the day's allowance (`server/quota/pacing.ts`), and then
settles at its actual cost. Simulating a fresh 30-day month in which every brief
settles at the estimated typical cost above before the next is admitted (unspent
allowance rolls into later days, so the daily figure rises slowly;
`tests/unit/capacity.test.ts` reproduces the Opus and Sonnet rows with the real admission
rule, the shipped budgets and the shipped reservations):

| Answer model | Typical cost / reservation | Admitted per day | Per month | Anonymous searches per day |
| --- | --- | --- | --- | --- |
| Opus 5.5 | about $0.11 / $0.36 | about 21, rising to 25 | about 703 | 3 to 4 (less than one complete trial) |
| Sonnet 5.5 | about $0.056 / $0.19 | about 45, rising to 51 | about 1,418 | 9 to 11 |
| Haiku 5.5 | about $0.007 / $0.03 | hundreds; per-user and network limits bind first | — | per-user and network limits bind first |

The anonymous column applies the same rule to the 25% anonymous share of the allowance.
These are budget capacity, not concurrency (see the reservation table above), and none
is a guaranteed allocation: abuse, uncertain settlements (charged at the whole
reservation) and unresolved reservations reduce them. The typical costs are estimates
from measured request sizes; the paid runs' settled usage replaces them.

**Capacity trade-off** (the owner's decision after the paid run): the Opus answer
model's $0.36 reservation is mostly its output cap (11,000 tokens, including room for
thinking), so it admits about 21 briefs and 3 to 4 anonymous searches a day. The
calibrated checker (Haiku with adaptive thinking at effort `medium`, `check.v9` since Task
16e) adds about $0.0035 to a typical brief, and its 15,000-token thinking allowance about
$0.0075 to the worst case. Sonnet roughly
doubles both at half the cost per brief; a lower answer output cap or a larger anonymous
share would also raise them, at the cost of truncated answers or of signed-in capacity.
The anonymous share and daily caps stay as they are. Opus 5.5 stays the default answer
model; the owner picks the production model from the evaluation results (§12).

Compute remaining money after subtracting settled charges and the full amount of
all unsettled or uncertain reservations. Pacing must never make those funds
available again merely because a request or lease expired.

The provisional corpus has approximately 31.9 million tokens before deduplication
and overlap: roughly **$0.64 for one embedding pass** at the stated price. This
is a character-based estimate, not a measured token bill. Bulk LLM extraction is
separate and can cost far more. Start with a capped maintenance-related sample,
retain unprocessed values, and expand only after quality and cost measurements.

### Data handling

Send only bounded questions and public evidence. Do not use provider-side
storage features:

- **Anthropic:** the Messages API holds no conversation state for the app; do not
  use Files, Batches or Managed Agents for user content.
- **OpenAI adapter:** `store: false`, and no background execution.
- **Embeddings:** inputs are the question text and public passages.

This is not zero retention. Each provider retains API data under its own terms;
see the [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)
and Anthropic's current commercial data-retention terms. Zero data retention
requires a separate agreement. Verify the terms before launch and disclose the
actual processing.

## 10. Interface and dashboard direction

The [interface design](UI_DESIGN.md) defines the visual language, every screen,
states and copy, night mode, phone layout, print, and accessibility. It supersedes
earlier visual notes here. In short: chart paper surfaces, ink for NTSB text, chart
blue for anything clickable, magenta only for AI output, and self-hosted B612 and
Source Serif 4. Evidence dominates the page; avoid decorative cockpit graphics and
endless chat bubbles.

Desktop: compact header with Explore/Dashboard, question box and example prompts,
filter chips, results, evidence drawer, and a four-case comparison tray. Mobile:
accessible filter/evidence drawers and stacked comparison cards. Support keyboard
focus, screen readers, contrast, reduced motion, and labels beyond color.

Each case shows number, date, aircraft, location, why it matched, evidence category,
source excerpt, completion status, and source provenance: the direct report link
when resolved, otherwise the labelled search fallback from §4. Citations open exact
sections with context. Distinguish NTSB text from application interpretation. Show
actual coverage/freshness, trial balance, and useful loading, empty, limit, and error
states. The user should never need to understand embeddings to judge an answer.

Initial dashboard: counts by year, phase, weather, aircraft category, and a data
coverage panel. Display cohort/denominator and let each bar open matching cases.
A map follows coordinate validation and a tile-provider decision with attribution,
usage terms, and budget; a static geographic overview is sufficient initially.

Follow-ups grounded in [the data assessment](DATA_REVIEW.md): evidence maps,
maintenance-to-event timelines, similar-symptom/different-finding case pairs,
recurring phase/event sequences, and report revision tracking. AI-derived charts
must expose extraction/review coverage.

These ideas are potential differentiators, not claims of scientific novelty.
Do not rank manufacturers as safest, turn counts into exposure-adjusted accident
risk, infer causation from co-occurrence, or hide completion lag. A later lesson
pack can generate cited discussion questions from selected cases, not operational
recommendations.

## 11. Deployment and trust boundaries

```mermaid
flowchart LR
    U[Public browser] --> C[Cloudflare edge and Turnstile]
    C --> T[Cloudflare Tunnel]
    T --> A[Fastify API and built React assets]
    A --> P[(Application PostgreSQL database)]
    A --> E[(Aviation search indices)]
    A --> M[Language-model API: Anthropic first, OpenAI optional]
    A --> V[OpenAI embeddings API]
    N[NTSB sources] --> W[Restricted ingestion worker]
    W --> P
    W --> E
    W --> M
    W --> V
    A -. Sanitized telemetry .-> L[Private Langfuse dashboard and storage]
    W -. Sanitized telemetry .-> L
    R[TypeScript experiment runner] --> E
    R --> M
    R --> V
    R --> P
    R -. Traces and evaluation scores .-> L
```

Use a multi-stage non-root image. Fastify serves built Vite assets and `/api/*`
on the same origin; the dev server is not deployed. One Compose project per
environment (`ai-aviation-dev`, `ai-aviation-live`) groups clear `aviation-app`,
`aviation-ingest`, and one-shot `extract` services and connects to the shared
PostgreSQL, Elasticsearch and Langfuse over their Docker networks, with a database
(`aviation_<env>`), index prefix (`ai-aviation-<env>`) and Langfuse project per
environment. Avoid global `container_name` values so environments and
checkouts can coexist. An optional project `ai-aviation-local` offers pinned
PostgreSQL/Elasticsearch for contributors and offline tests. See the
[runbook](RUNBOOK.md).

Run Langfuse as separate reusable infrastructure under Compose project
`ai-observability`, with isolated projects/credentials and its own resource budget.
The experiment runner invokes the same application functions and cost gate; its
provider calls remain metered. Tracing exports are asynchronous and best-effort.
The [hosting plan](OBSERVABILITY_AND_EVALUATION.md#prompt-management-and-hosting)
lists Langfuse's additional services and portable configuration.

Only the application is tunnel-exposed. Elasticsearch, Kibana, PostgreSQL, workers,
Langfuse, admin, and metrics routes remain private. Use an isolated container
connector for production and publish no app port; loopback access is a development
option. Test origin restrictions externally and from co-resident containers.
Direct/LAN access must not become an alternate trusted-header path. Set the final
hostname with `APP_URL`; keep machine-specific addresses/tunnel secrets outside Git.

The HTTP process receives an Elasticsearch read credential limited to aviation
indices; ingestion uses a separate writer. Validate TLS using the configured CA.
PostgreSQL roles are limited to the app database; HTTP has no migration/ingestion
or shared-cluster administration privileges. On a shared cluster, per-environment
login roles may connect only to their environment's database and act as the
NOLOGIN group roles the migrations grant to. No Docker socket, host-home mounts,
or file containing unrelated provider keys. Scope worker credentials separately.

Add CSP/security headers, safe text rendering, parameterized SQL, explicit response
serialization, bounded search templates, and redacted logs/errors. Never publicly
cache AI responses, OAuth callbacks, session/quota endpoints, or authenticated
responses: use `Cache-Control: private, no-store`. Public case/aggregate caches
include dataset revision. Arbitrary prompts/answers are not shared across users.

Initial resource budgets to measure: API 0.5–1 GiB, worker 1–2 GiB, one ingestion
job, two AI requests in flight. One primary shard and zero replicas suit a single
node but provide no high availability. 100,000 raw 1,536-dimensional float32 vectors
alone use about 614 MB; text, graph/index structures, and encoding add overhead.
Measure the actual index and allow a second index's disk space during rebuilds.

Use bounded database/search timeouts and pools. Back up identity/consent/quota data
encrypted to an off-host destination and test restore; search indices are
rebuildable. Track freshness, latency, cost, rejects, errors, and saturation without
default email/prompt logging. Document single-host downtime, rollback, and recovery.

## 12. Security review and evaluation gates

Use Langfuse for traces, datasets, experiments, and scores; custom TypeScript
evaluators run in our controlled script/worker process. Ordinary software tests
remain separate. [The evaluation guide](OBSERVABILITY_AND_EVALUATION.md) explains
unit tests, component/end-to-end evaluations, human/model scoring, and production
sampling. Scores are assessments from a named evaluator, not automatic proof of
correctness. Inline answer checks and PostgreSQL spend enforcement remain in the API.

[Independent design review](SECURITY_REVIEW.md) is separate from implementation
review. Before public launch, ask **Claude Fable or Opus** to review a fixed code
commit and configuration: auth/cookies, every paid-call path, quota races, proxy
trust, output rendering, permissions, dependencies, and containers/tunnel. Use
synthetic credentials and public fixtures; record actual reviewer model and fixes.
Test findings, and review changes after the reviewed commit. A model review is
not a guarantee of no vulnerabilities. The Langfuse additions postdate the October 16
review and must be included in the implementation review.

Block public launch on unresolved critical/high issues, failed auth/origin/budget
tests, or evidence-classification failures. Run the same gates for every
provider/model combination before operators can enable it (§9), and record which
combination produced each score. Build a 60–100-question set, split by
case to prevent overlapping-chunk leakage. Include confirmed faults, negative
examinations, noncausal defects, unknowns, pilot beliefs, timing ambiguity,
multiaircraft cases, negation, and attacks. Have an instructor/analyst adjudicate
important labels. The four seed cases are not a sufficient independent benchmark.

Proposed targets to measure:

- Recall@20 at least 90% on curated relevant cases; compare keyword, vector, and
  hybrid baselines before adding reranking.
- At least 95% precision for established causal mechanical faults on reviewed
  holdout data; report sample size and abstentions separately.
- 100% resolvable citations/exact span matches; human-check semantic support.
- No preliminary/factual-only cases in completed-only answers or known
  cross-aircraft attribution failures in the regression suite.
- At least 98% off-topic rejection on the curated set, plus a false-reject target
  for valid requests; not a guarantee against arbitrary adversarial input.
- Concurrent requests, retries, restarts, proxy-header forgery, cookie deletion,
  account switching, and dependency outages cannot bypass the global budget.
- Test cross-user caches/idempotency/sessions, XSS, CSRF, OAuth redirects,
  unsafe source redirects, and malicious retrieved text.

**Evidence checker calibration** (Task 16c, gate G6; `evals/checker`, README "Checker
calibration"). Targets frozen before any comparison: whole-brief false withholding on
wholly supported briefs at most 10%; at least 95% detection in each family (timing,
attribution, contradiction, unsupported addition, provisional); every known critical
regression withheld in every trial. Labels are constructed or model-reviewed, never
expert ground truth; tuning used the development split only, at most two prompt
revisions.

| Run (development; 21 supported-brief trials, 92 errors, 8 critical) | False withholding | Detection as published | Semantic detection (16d correction) | Critical | Cost / brief | p50 / p95 latency |
| --- | --- | --- | --- | --- | --- | --- |
| Haiku 5.5, no thinking, `check.v4` / v5 / v6 | 20, 18, 21 of 21 | 69, 68, 74 of 92 | 69 of 92; 66 of 90 (2 blocked); 52 of 70 (22 blocked) | 2, 3, 3 | $0.0009 | 3.4 / 4.4 s |
| Haiku 5.5, adaptive thinking, `check.v4` | 9 of 21 | 87 of 92 | 66 of 71 (21 blocked) | 5 | $0.0020 | 14.5 / 22.2 s |
| **Haiku 5.5, adaptive thinking, `check.v5`** (frozen) | 7 of 21 (33%) | 92 of 92 | 91 of 91 (1 blocked) | 8 | $0.0018 | 13.3 / 20.1 s |
| Haiku 5.5, adaptive thinking, `check.v6` | 6 of 21 | 87 of 92 | 87 of 92 | 6 | $0.0018 | 13.4 / 21.3 s |
| Sonnet 5.5, no thinking, `check.v4` / v5 | 18, 18 of 21 | 86, 84 of 92 | 86, 84 of 92 | 4, 3 | $0.0172 | 5.0 / 9.0 s |

**Correction (Task 16d, 16c review I2).** Task 16c counted an error claim in a failed
check call (a refusal, a truncated or invalid output) as detected, because a failed call
withholds the brief. That is blocked output, not detection: the "Semantic detection"
column counts only error claims the checker actually judged, with the failed calls'
claims apart ("blocked"). The published column is kept as the record. The ranking and the
frozen choice do not change; the inflated runs are the ones with many failed calls.

No run met every target, so the fallback order (critical regressions, then the lowest
family detection, then false withholding) froze Haiku 5.5 with adaptive thinking on
`check.v5` (`selection.json`). The held-out split, run once with it, did not confirm the
primary target: **17 of 21 supported-brief trials withheld (81%; 95% interval
60–92%)**; detection 81 of 86 (timing 19 of 20, attribution 15 of 18, contradiction 28
of 28, unsupported addition 19 of 20); 11 of 12 one-error briefs withheld for their
error; 13% of supported claims flagged; p50 11.9 s, p95 26.2 s. The flags are mostly
`not_established` on plain restatements, and more of them when the reader's criteria
include the first flight. Production runs the frozen configuration and fails closed: a
withheld summary returns the case cards. Shipping summaries needs a checker that passes
these gates on fresh held-out data (the gate's decision).

**Claim-level display calibration** (Task 16d, gate G6; `evals/checker/protocol.v2.ts`,
committed before any paid 16d call with the complete candidates, the targets and the selection
code). Every judged trial runs through the production display projection (`display-deps-v1`,
`claims` mode). Targets: M1 at least 90% of supported claims shown in wholly supported briefs,
M2 at least 90% of those briefs shown with minimum useful content, M3 at most 5% of error claims
shown in each family with every critical regression never shown, M4 at most 5% of one-error and
mixed-error briefs showing an error, M5 no dependency violation; exposure E1 (unsupported among
shown claims) and E2 (shown briefs carrying one) are reported beside them. Semantic detection
counts judged claims only. Intervals are clustered by source bundle; a gate is inconclusive while
its clustered interval straddles the threshold. Both 16c splits are development now (labels v2),
with the 16d context-loss regressions and three 60-claim inputs for latency.

| Development run (21 supported-brief trials, 194 errors, 11 critical) | M1 | M2 | M3 shown: timing; attribution; contradiction; addition | Critical never shown | M4 | E1; E2 | Semantic detection | p50 / p95 / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Haiku 5.5, adaptive thinking, `check.v7` (round 1) | 463 of 495 (93.5%) | 20 of 21 | 1 of 55; 8 of 51; 2 of 51; 2 of 37 | 9 of 11 | 1 of 30 | 1 of 1,205; 1 of 50 | 181 of 194 | 14.3 / 27.7 / 35.1 s |
| Haiku 5.5, adaptive thinking, `check.v8` (round 2) | 407 of 495 (82.2%) | 19 of 21 | 2 of 55; 1 of 51; 0 of 51; 0 of 37 | 10 of 11 | 0 of 30 | 0 of 1,244; 0 of 55 | 190 of 194 | 15.1 / 30.0 / 39.4 s |

The same trials under whole-brief display (16c's rule) show 12 of 21 supported briefs in both
rounds. In round 1, adaptive thinking at effort `low` did not think at all on 14 of 84 calls,
and those calls carried 10 of the 13 errors shown; `check.v8` asks for a pass over every claim
before the verdicts (in round 2 only 4 calls went without thinking, all two-claim
abstentions), spells out pointing words and cut excerpts, and keeps the header's date out of
day counts. It also showed one critical regression
(a "two days after the installation" wrong anchor, likely from its own narrated-flights
example) and removed more supported claims. Neither run met every target; the pre-registered
fallback (critical regressions first) froze `haiku-think-v8` (`selection.v2.json`), which
production runs. The 60-claim checks took 26 to 39 seconds (0 timeouts at 45 s), with at most
8,178 thinking tokens.

**Held-out pilot** (run once with `haiku-think-v8`; `results/16d-holdout-haiku-think-v8.json`):
nine new retrieval bundles whose 54 cases are in neither 16c split, each with a brief as
`compose.v7` would write it, its one-error, mixed-error and reading variants and a claim batch
(97 batches, 123 calls, 2,903 claims, 171 errors, 58 critical items), labels frozen before any
16d checker output. With nine source bundles it is inconclusive by design (about 73 independent
trials a family are needed for a 5% bound), and nothing in it is a pass.

| Held-out pilot (39 supported-brief trials, 171 errors, 58 critical, 9 bundles) | Result | Clustered 95% |
| --- | --- | --- |
| M1 supported claims shown | 890 of 1,194 (74.5%) | 45–97% |
| M2 supported briefs shown (whole-brief rule: 22 of 39) | 32 of 39 (82.1%) | 45–100% |
| M3 errors shown: timing; attribution; contradiction; addition | 0 of 78; 2 of 36; 0 of 35; 0 of 22 | upper bounds 30%; 43%; 30%; 30% |
| Critical regressions never shown | 56 of 58 | |
| M4 error briefs showing an error | 2 of 75 (2.7%) | 0–30% |
| E1 unsupported among shown claims; E2 shown briefs carrying one | 2 of 1,961; 2 of 72 | 0–30% each |
| Semantic detection; false flags | 169 of 171; 179 of 3,528 (5.1%) | |
| p50 / p95 / max | 15.7 / 23.3 / 31.4 s, no timeout | |

The two errors shown are critical context-losing excerpts, each confirmed in one trial: "The
accident flight was the first flight after completion of this work." and "… the last 100-Hour
inspection was approximately 29 hours earlier." Every timing, contradiction and
unsupported-addition error was withheld, the 51 critical timing mutations included. The
withheld supported briefs are in two bundles (5 of the 6 trials of the previous-day bundle, 2 of
the 3 of the throttle-linkage bundle; the other seven bundles showed all 30). In four of the
first five, the checker contradicted a case's "do not settle" classification, reading "the
limited examination did not reveal any pre-impact abnormalities" as an examination that found no
fault, where the probable cause says the reasons "could not be determined because thermal damage
to the engine prevented a complete examination"; the fifth did not think at all. In the throttle
bundle it would not confirm when a linkage "came loose" relative to the maintenance. Seven of the
123 calls did not think at all and carried 83 of the 179 false flags.

Every calibration bundle, development and held-out, was retrieved under `retrieval.v1`, before
task 10e made `retrieval.v2` the default. The check input's form does not depend on the
retrieval version, but `retrieval.v2` bundles can hold cases the cases-index channel nominated,
which the calibration has not seen. Production keeps whole-brief display until gate G6 reviews
these results.

**Deterministic rules and re-calibration** (Task 16e, gate G6's 16d verdict;
`evals/checker/protocol.v3.ts`, protocol v3.1: committed before any paid 16e call and before
the 16e held-out set existed, and amended once, before any checker call, to ordinal rule
v2; the only paid call before it embedded the 16e questions to retrieve their evidence).
The check now runs behind §3's deterministic rules (`excerpt-context-v1`,
`ordinal-evidence-v2`), with `check-judgement-v2` (a `supported` verdict naming a passage
outside the claim's citations does not confirm it), `display-deps-v2`, `check.v9` and
`compose.v8`. The targets are 16d's, with M4 now part of the eligibility. M1 and M2 are answer
retention (`checker-metrics-v3`): the supported claims and wholly supported briefs the
projection shows, over those its static floor (the projection under a checker that confirms
everything) shows; the rules' own abstentions are reported apart, with the displayed retention
beside them. Without an eligible candidate the order is critical regressions, M4, the highest
family's M3, M2, M1, then the lower effort. Every 16c and 16d item is development now (labels
v3: the errata overlay `checker-errata-v1`, each correction with its source and reason).

Offline, before any checker call, the 16d recordings of `haiku-think-v8` went through the 16e
projection with labels v3 (`results/16e-simulation.json`). Development: 1 of 227 errors shown,
no error brief showing an error (36), all 11 critical items withheld, M1 323 of 396 (81.6%), M2
15 of 18. The 16d held-out pilot: 0 of 183 errors shown (16d showed two context-losing
excerpts), 0 of 78 error briefs, all 58 critical items withheld, M1 797 of 1,056 (75.5%), M2 29
of 36. The rules alone removed 53 of 227 and 32 of 183 errors, and 0 of 396 and 6 of 1,062
supported claims.

| Development run (179 calls; 36 supported-brief trials, 396 errors, 69 critical) | M1 | M2 | M3 shown: timing; attribution; contradiction; addition | Critical never shown | M4 | E1; E2 | Semantic detection; false flags | p50 / p95 / max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Haiku 5.5, adaptive thinking, `check.v9`, effort `low` | 722 of 968 (74.6%) | 29 of 36 | 4 of 154; 0 of 97; 0 of 86; 2 of 59 | 68 of 69 | 0 of 108 | 0 of 1,824; 0 of 74 | 375 of 396; 449 of 4,468 (10.0%) | 14.1 / 27.3 / 42.4 s |
| **Haiku 5.5, adaptive thinking, `check.v9`, effort `medium`** (frozen) | 822 of 968 (84.9%) | 32 of 36 | 2 of 154; 0 of 97; 1 of 86; 0 of 59 | 69 of 69 | 0 of 108 | 0 of 1,993; 0 of 80 | 384 of 396; 138 of 4,468 (3.1%) | 19.9 / 38.2 / 51.0 s |

In both rounds the rules abstained from 41 excerpts and 39 ordinal statements, which removed
71 of the 396 errors and 4 of the 972 supported claims. Under whole-brief display the same
trials show 19 and 15 of the 36 supported briefs. At effort `medium` the checker thought on
every call (31 calls at `low` did not) and flagged about a third as many supported claims (138
against 449), so it kept more; neither round reached M1 or M2. The fallback order froze `haiku-think-v9-medium`
(`selection.v3.json`: critical 69 of 69, M4 0%, the highest family's M3 1.3%, M2 88.9%, M1
84.9%), and production checks at effort `medium` since. The derived check timeout, 1.25 times
the slowest development call (51.0 s), is above the 45 s ceiling, so it stays 45 s: the six
60-claim checks took 39.5 to 51.0 s at `medium` (one over, counted as a failed call in every
figure; in production it withholds the summary), with at most 11,408 thinking tokens.

**Held-out pilot** (run once with `haiku-think-v9-medium`;
`results/16e-holdout-haiku-think-v9-medium.json`): the first nine `retrieval.v2` bundles of the
16e questions with at least four cases and no case of an earlier split, each with a brief as
`compose.v8` would write it, its one-error, mixed-error and reading variants and a claim batch
(92 batches, 105 calls, 158 error claims, 44 critical items), labels frozen before any 16e
checker output. With nine bundles it is inconclusive by design, and nothing in it is a pass.

| Held-out pilot (26 supported-brief trials, 158 errors, 44 critical, 9 bundles) | Result | Clustered 95% |
| --- | --- | --- |
| M1 supported claims shown (the static floor removed none) | 183 of 770 (23.8%) | 6–55% |
| M2 supported briefs shown (whole-brief rule: 2 of 26) | 7 of 26 (26.9%) | 6–55% |
| M3 errors shown: timing; attribution; contradiction; addition | 0 of 67; 0 of 29; 0 of 44; 0 of 18 | upper bound 30% each |
| Critical regressions never shown | 44 of 44 | |
| M4 error briefs showing an error | 0 of 70 | 0–30% |
| E1 unsupported among shown claims; E2 shown briefs carrying one | 0 of 544; 0 of 22 | 0–39% each |
| Semantic detection; false flags | 155 of 158 (two of the other three in blocked output); 128 of 2,860 (4.5%) | |
| p50 / p95 / max | 23.3 / 31.7 / 37.5 s, none over 45 s | |

The pilot showed no error, and withheld 19 of the 26 supported-brief trials (17 for the share
of removed sentences, 4 for two contradicted claims, 3 below the minimum content, 1 for a
structurally unusable output; a trial can have several reasons). Eleven claims, repeated
across their bundles' variants, carry 106 of the 128 false flags. A reading of those claims
after the run, outside the pre-registered figures (which stand), found errors in the held-out
labels as authored: two `why` lines stating a fact from a passage they do not cite ("after he
replaced the main fuel tank lines", "during the initial climb"), a quote "The pilot reported
that …" labelled as the investigators' own words, a timing claim saying a passage does not
call the interval flight hours where it says "1 hour of flight", and a gap note a preflight
inspection passage contradicts; the others are readings a reviewer could take either way
(whether investigators established a fault as the cause or a defect as not causal, whether
maintenance contributed). Read as `unknown` (a sensitivity reading, not a result), they leave
22 false flags of 2,724 and only 4 wholly supported brief trials, too few to say anything about
M2. These are the first calibration bundles retrieved under `retrieval.v2`, the production
default; the development split stays `retrieval.v1`. Production keeps whole-brief display until
gate G6 reviews these results.

Network-independent tests run in CI. Prepared-dataset ("offline") evaluations can
call real models: run them only as explicit, budgeted jobs, recording dataset,
corpus, prompt, model, evaluator, and code versions. Missing/failed required scores
must fail the release gate. Background production judges use the same $20/month
indexing/evaluation allocation and shared paid-call gate; Langfuse cost charts do
not enforce the app's spending limit. Aim for
subsecond cached browsing and roughly ten-second AI responses, then measure on
the target host; these are targets, not observed benchmarks. The calibrated checker alone
takes about 20 to 38 seconds (p50 to p95 at effort `medium` in the Task 16e development round;
up to 51 seconds for a 60-claim check, over its 45-second timeout), so a brief takes longer
than that today.

## 13. Delivery plan

| Milestone | Deliverable | Exit condition |
| --- | --- | --- |
| 1. Data and keyword search | TypeScript importer, canonical schema, 2008+ US slice, report-link mapping, minimal UI on the final design system (keyword search, filters, results, case page) | Completion mapping/counts/joins/report links verified; no LLM needed |
| 2. Evidence retrieval | Chunks, embeddings, application RRF, cited comparison, Langfuse traces and TypeScript experiments | Seed cases correct; baseline/holdout scores recorded; telemetry capture checked |
| 3. Complete search and evidence workspace | AI answers and refinements, evidence drawer, comparison, basic dashboard | Instructor can find and verify a case independently |
| 4. Public-beta controls | Google login, trial, privacy notice, Turnstile, atomic quotas/spend, bounded production evaluation | Adversarial/auth/concurrency and telemetry privacy/retention tests pass privately |
| 5. Review and launch | Claude code/config review, fixes, restore drill, tunnel/domain | Launch gates pass; enable a small public beta |
| 6. Extend coverage | Historical sources, reviewed enrichment | Coverage and quality remain explicit |

First slice: import the four seed cases, index their sections, answer the motivating
question, and click every evidence reference. Expand the corpus before advanced
dashboard graphics. Start the Enterprise API access/schema investigation alongside
milestone 1 and deliver its adapter before the April 5, 2027 transition, even if
historical backfill or advanced features slip.

## 14. Decisions and remaining verification

Accepted tooling: Langfuse's existing UI for observability/evaluations, custom
TypeScript evaluation rules, and Vitest for ordinary tests. No Jaeger UI work or
Promptfoo dependency in version one. Plain TypeScript orchestration remains.

Defaults awaiting feedback: monthly budget and breadth of initial coverage.
Technical unknowns: completion codes, historical schemas, partial-update semantics,
Aviation Search export fields/limits for report links, Enterprise API
access/pagination, actual model availability, evaluated quality,
and measured Langfuse resource/retention behavior on the deployment host.
These are implementation tasks, not concealed assumptions of production readiness.

Before implementing public login/access, configure Google OAuth for the final
origin, Turnstile, an app-specific Anthropic workspace/key, an app-specific OpenAI
project/key for embeddings, restricted database/search
credentials, and a privacy/contact notice. Environment configuration keeps the app
reproducible without any particular private network or shared secrets file.
