# Aviation Casebook data pipeline (as built)

How NTSB data becomes the PostgreSQL corpus and the two Elasticsearch indices, and
why each step works the way it does. Written 2026-10-22 against implementation
snapshot `fc450ec`; sections 2.4, 2.11, 2.12, 5 and 6 were updated at `f69d8a3`,
when hybrid retrieval (Task 10) was merged, and sections 2.9 to 2.12, 3, 5 and 6 for
`passages-v2` and the event-level aircraft qualification (Task 10b). The numbers come from generation 1 in the shared `dev`
environment, loaded from the NTSB `avall.zip` archive. Paths are relative to
`apps/aviation-investigations/`.

Related documents: [DESIGN.md](DESIGN.md) and [DATA_REVIEW.md](DATA_REVIEW.md) give
the background. "Amendments after review gate G0" (A1–A16) in
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) are binding. Commands are in the
[README](../README.md) and [RUNBOOK.md](RUNBOOK.md). Where the plan or design text
differs from this document, this document describes the implementation. That covers
multi-aircraft attribution (A3), index naming, the embedding-cache schema, archive
download and publication.

## 1. Summary

The pipeline turns one NTSB Access archive into a verified, versioned corpus and two
rebuildable search projections:

1. A host command checks the archive against a pinned SHA-256. It exports
   allowlisted columns with MDBTools inside a container that has no network.
2. A TypeScript normalizer turns the CSVs into canonical cases: decoded codes, a
   provisional completion class, flight phases, and narrative sections with
   versioned citation text.
3. The loader writes each import as an immutable *generation* in PostgreSQL.
   Database triggers seal it, and verification rebuilds every source text.
4. Two indices are built from a verified generation:
   - a **cases index**: one document per US event, for keyword search and facets;
   - a **passages index**: narrative chunks of provisionally answer-eligible US
     cases (completed, with probable cause), each with a 1,536-dimension OpenAI
     embedding.
5. A PostgreSQL **manifest** row, not an Elasticsearch alias, decides what the API
   serves.

Hybrid retrieval (section 2.12) reads the passages index to find the evidence an AI
brief is written from.

```mermaid
flowchart TD
    A["avall.zip<br/>operator download, pinned SHA-256"] --> B["Archive checks"]
    B --> C["mdb-export in a sandbox container<br/>no network, read-only, no credentials"]
    C --> D["Allowlisted CSVs + manifest.json"]
    D --> E["Normalize<br/>codes, completion, phases, sections"]
    E --> F[("PostgreSQL generation<br/>load, seal, verify")]
    S["Report-link seed or export"] --> RL[("report_links")]
    F --> G["Cases index<br/>one document per US event"]
    F --> H["Chunk answer-eligible US sections"]
    H --> P[("passages table")]
    H --> I["Embed<br/>text-embedding-3-small"]
    I <--> EC[("embedding_cache")]
    I --> J["Passages index"]
    G --> M["publish: active dataset_manifests row"]
    J --> M
    M --> API["API: search, facets, dashboard, case pages"]
    F --> API
    RL --> API
    M --> R["Hybrid retrieval<br/>evidence for AI briefs"]
```

## 2. Step by step

### 2.1 Source archive and provenance

`avall.zip` holds events from 2008 onward in one Access database, `avall.mdb`. The
code downloads nothing: the operator passes the file and its expected SHA-256 to
`pnpm worker extract`, and `verifyArchive` (`worker/ingest/archive.ts`) refuses a
mismatch.

The hash pins the bytes that every count and citation depends on. Expectations for
one snapshot are keyed to it (`worker/ingest/verify-profiles/avall-2026-10-16.json`).

Provenance runs from the archive hash to the extraction `manifest.json` (image ID,
MDBTools version, flags, per-table counts), to the `dataset_generations` row (hash,
manifest, normalization versions), to each case's `source_revision` and each
section's `revision_id`.

The archive's own date is not recorded. The API's snapshot date is the newest change
date among the generation's case, admin and section records, capped at the extraction
date (`server/dataset.ts`). For generation 1 it is 2026-09-30.

### 2.2 Sandboxed extraction

Code: `worker/ingest/archive.ts`, `worker/ingest/extract.ts`,
`worker/ingest/tables.ts`, `docker/extract/Dockerfile`.

**Unzip.** The archive must contain exactly one entry, `avall.mdb`. The code rejects
traversal, symlinks, encrypted entries and nested zips, and anything over 200 MiB
compressed or 1 GiB expanded (counted on the bytes actually written).

**Export.** The image is a digest-pinned `debian:bookworm-slim` with
`mdbtools=1.0.0+dfsg-1.1`, running as uid 65534; its image ID is recorded. Each
table runs in its own container with `--network none --read-only --cap-drop ALL
--security-opt no-new-privileges --memory 1g --cpus 2 --pids-limit 64`. The root
filesystem and the MDB mount are read-only, there is no writable host mount, and the
host streams stdout to the CSV. The flags `-D %Y-%m-%d -T
%Y-%m-%dT%H:%M:%S` keep dates unambiguous without inventing time zones.

**Limits.** Each table gets 10 minutes and 2 GiB. Container removal is awaited and
confirmed, also on signals. **Any stderr output fails the export**, because MDBTools
can report read errors and still exit 0.

**Projection** to allowlisted columns happens in TypeScript:

- UTF-8 is validated with a fatal decoder, so a bad byte is an error, not U+FFFD.
- Records are capped at 4 MiB (the largest real one is about 106 KB) and 256 fields;
  oversized input is rejected, never truncated.
- The allowlist names every column, keys and `lchg_date` included, and never owner or
  operator names, addresses, contact fields or editor IDs.

The raw export is deleted, and the 0700 staging directory is published by one atomic
rename, with `manifest.json` written last.

**Why.** Parsing an external Access file is the riskiest step. In the container, a
parser exploit gets no network, no credentials, a read-only root and input, and no
writable host mount; the loader sees only validated CSV. Extraction needs the Docker
CLI, so it runs on the host.

**Real data.**

| events | aircraft | engines | narratives | findings | events_sequence | ntsb_admin |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 31,303 | 31,854 | 28,648 | 28,516 | 73,002 | 66,683 | 31,303 |

Narratives use CRLF line ends. Thirty fields also contain `\r\r\n` or a lone CR.

### 2.3 Normalization

Code: `worker/ingest/normalize.ts`, `worker/ingest/scalars.ts`,
`worker/ingest/citation-text.ts`, `shared/codes.ts`, `shared/completion.ts`,
`shared/occurrences.ts`.

**Errors.** Structural problems stop the run:

- a missing table or column;
- a blank or duplicate `ntsb_no`;
- a duplicate composite key. Keys are typed tuples, so `1` and `01` are the same
  aircraft key.

Value problems go to a quarantine list with an action (row excluded, value nulled or
value kept) and are never coerced. Generation 1 has 25 entries, all coordinates of
non-US events. 75 US events have no coordinates, so their location is null. An event
year outside 1900–2100 stops the load instead (`LoadValueError`, naming the case): the
API's year axis carries only 1900–2100, so one such year would otherwise pass every
check and make every search fail once published. The server also refuses a cases index
whose years fall outside it, as unavailable. (A refusal, not a change to normalized
output: field normalization stays `v1`.)

**Scalars and codes.** A blank field becomes `null` before any numeric conversion.
Flags are decoded from their real vocabularies (`defining_ev` `0`/`1`, `cm_inpc`
`T`/`F`), never by truthiness. `afm_hrs_since` is exported as `Y`/`N`, unlike the
codes the dictionary documents, so it is kept as recorded and not interpreted.
Display labels come from fixed maps plus the embedded dictionary; raw codes are kept.

**Completion mapping** (`shared/completion.ts`). The raw `rec_stat` is stored
unchanged. `COMPLETION_MAPPING_V1` is `{ version: 'v1-empirical', verified: false,
completedStatuses: ['B'] }`:

- `B` is `completed`. While the mapping is unverified, every other status is
  `other_status`, never "in progress".
- Probable-cause availability is a separate boolean.
- **Answer-eligible** means a US event, `completed`, and nonblank probable-cause text.

The mapping is provisional because it is purely empirical. Among US records, every
record with a probable cause has `B`:

| `B` with cause | `B` without | `P` | `F` | blank |
| ---: | ---: | ---: | ---: | ---: |
| 24,291 | 2 | 1,040 | 18 | 56 |

NTSB metadata has not confirmed what the codes mean, and `F` is not guessed to mean
"final". Generations record `mapping_verified = false`, and `/api/config` reports the
cohort as provisional.

**Phases and defining events.** `phase_no` maps to 16 phase groups by fixed ranges.
An aircraft's defining event is its single row with `defining_ev = 1`; if several are
flagged, none is chosen. The event's `definingPhaseGroups` is the union over its
aircraft, and `sequencePhaseGroups` (every phase in the sequence) is kept separately.
Taking the first aircraft's phase had turned SEA08LA057 into `landing` and lost the
other aircraft's `initial_climb` (G2a).

**Sections and scope.** Each narrative row has three fields:

| Source field | Section kind |
| --- | --- |
| `narr_accp` | factual |
| `narr_accf` | analysis |
| `narr_cause` | probable cause |

- **Single-aircraft event:** each field is an aircraft-scoped section.
- **Multi-aircraft event:** every section is event-scoped. Texts that are equal after
  collapsing whitespace merge into one section, and every row is kept as provenance.
  Texts that genuinely differ become separate event-scoped variants.

The narrative row a text came from does not show which aircraft it describes. In
SEA08LA057 the cause stored under the landing Piper describes the departing pilot.
Structured rows (findings, sequence, aircraft fields) keep their aircraft key.

**Citation text** (`CITATION_TEXT_VERSION = 'v1'`). Plain text is kept as exported
except that CRLF and lone CR become LF. Text that looks like HTML goes through a
deterministic htmlparser2 conversion: inline tags vanish (`o<span>ne</span>` →
`one`), blocks and `<br>` become line breaks, entities are decoded, and unknown
tag-like text such as `<unintelligible>` stays literal. The exported original is
kept. Citation text is versioned apart from search analysis because offsets and quote
checks depend on its exact characters.

**Real data.** 31,303 events: 25,407 US, 24,291 answer-eligible, 545 multi-aircraft.
2 US events are completed without a cause (911 across all countries). 73,146
sections: 1,318 event-scoped and 11 converted from HTML.

### 2.4 Generations in PostgreSQL

Code: `server/db/schema/corpus.ts`, `worker/ingest/load.ts`,
`worker/ingest/verify.ts`, `server/db/generations.ts`, migrations `0000`–`0004`.

**Load.** One transaction inserts the generation as `loading`, batch-inserts every
row, records the run as `succeeded`, seals the generation and commits. A failure
rolls everything back. Keys start with `generation_id` and foreign keys are
composite, so rows reference only their own generation. The loader rejects an
extraction whose manifest disagrees with its files or row counts. Generation 1 loaded
in about 38 s.

**Sealing.** Statement triggers reject every insert, update or delete on a
generation that is not `loading`, for every role including the owner. The one
exception is a guarded deletion: `prune_generation` removes a whole generation.

- Status changes go only through migrator-owned `SECURITY DEFINER` functions.
  `seal_generation` runs inside the load transaction. `record_verification`,
  `publish_manifest` and `prune_generation` take one shared advisory lock, which
  verification also holds. `pin_generation` and `unpin_generation` take the same lock
  but only protect a generation from pruning; they never change its status.
- A sealed generation is `loaded`, and verification makes it `verified` or `failed`.
  Only a `verified` generation can be published. A `failed` one must pass
  verification first; there is no direct `failed → published` transition.
  Publishing another generation makes the previous one `retired`, and a `retired`
  generation can be published again.
- Why: G2b showed that denying UPDATE was not enough. The ingest role could still
  delete and re-insert rows.

**Revision IDs.** `section_id` is `<ntsb_no>:<section_key>`. `revision_id` is a
SHA-256 over the case number, section key, text hash and citation-text version, so
unchanged text keeps its revision across generations. Event section keys are
ordinals that can shift, so citations pin the generation **and** `revision_id`.

**Sources.** `case_section_sources` lists every narrative row behind a section. The
exported text is stored only when it cannot be rebuilt from the section text (HTML,
whitespace variants, mixed line ends). Otherwise `source_form` records how to rebuild
it.

**Verification.** `verify` holds the lifecycle lock and reads one REPEATABLE READ
snapshot. It checks keys, parents, hashes, scope rules, phase summaries and the
eligibility rules. It then rebuilds every exported source and re-derives its citation
text with the normalization code. A source recorded as `match = exact` must equal the
stored section exactly, and one recorded as `match = whitespace` must be
whitespace-equivalent to it. Its
aggregate-only report is written under a content-addressed name before the hash is
recorded. Publication requires a current `ok` from `VERIFIER_VERSION` (`verify-v2`).
**Generation 1: all 74,087 source texts were reconstructed and hash-verified, and the
snapshot profile matched.**

**Retention.** `pnpm worker prune-generations [--dry-run]` runs `pruneGenerations`;
run it after publishing a new generation. It:

- keep the two most recently published generations and delete older published or
  retired ones;
- delete never-published generations that have failed, at once;
- delete other never-published generations 24 hours (the default grace) after their
  seal or latest verification;
- never delete loading, active or pinned generations.

Control data (usage buckets, leases, Turnstile redemptions and expired briefs) is
pruned by a periodic job in the API server, serialized by an advisory lock.

### 2.5 Report links

Code: `shared/report-links.ts`, `worker/ingest/report-links.ts`, table
`report_links`.

The MDB holds no report identifier, and the numeric CAROL report ID is not `ev_id`.
Links therefore live in a separate mapping table without generations, because they
change on their own schedule.

- **Seed.** Four IDs were verified by hand on 2026-10-16, for DFW08TA066,
  DEN08LA103, MIA08LA156 and NYC08LA106.
- **Bulk import** from an Aviation Search export needs a column mapping supplied by
  the operator. `VERIFIED_LAYOUTS` is empty on purpose, so no field name is assumed.
- **Validation.** Rows are checked against the latest verified generation. Unknown
  cases and date mismatches are reported, not inserted. Each row records its source,
  file hash and retrieval time.
- **URLs** come only from a fixed HTTPS template and an ID matching `^\d{1,9}$`.
  Without one, the case page links to Aviation Search, labelled as a search.

In `dev`, all 4 seed links matched. No bulk export has been imported.

### 2.6 The cases index

Code: `worker/index/cases-index.ts`, `worker/index/analysis.ts`,
`worker/index/synonyms.ts`.

There is one document per US event, keyed by `ntsb_no`. `ev_id` is never indexed,
and `country` is always `USA`.

**Analyzer chain.** The index analyzer `aviation_english` runs: glued-heading
character filter → standard tokenizer → lowercase → possessive stemmer → stop words
(English **minus negations**) → stem overrides → light English (KStem) stemmer.
The search analyzer adds `synonym_graph` after the possessive stemmer, so **synonyms
run before stop words and stemming**. Quoted phrases use the index analyzer and never
expand synonyms.

- **Negations kept.** `no`, `not`, `nor`, `none`, `never` and `without` stay, so "no
  anomalies" never becomes "anomalies".
- **KStem, not Porter.** Porter merges generator/general and engine/engineer.
  Overrides join a few forms KStem keeps apart, such as icing → ice.
- **Synonyms first.** The rules are unstemmed. A stop filter in front of them would
  drop "into" from "controlled flight into terrain", and Elasticsearch rejects the
  rule set. G3 approved this order.
- **Synonym list.**
  - Equivalent: spelling variants (carb, carburetor, carburettor) and unambiguous
    abbreviations (IMC, VMC, ATC, IFR, VFR, AGL, MSL, CFIT, CFI).
  - One-way: `wx`, `mx`, and "carb ice".
  - Stall and spin are never synonyms.
- **Glued headings.** Runs such as "AIRCRAFT INFORMATIONThe" are mostly in the
  exported narratives themselves; the app's HTML conversion created few of them. The
  current pattern matches 2,769 sections, 2,751 of them answer-eligible, and only six
  of the matches were converted from HTML. The filter rewrites "NT" as "N T", which
  keeps highlight offsets exact. Stored text is unchanged.
- **Text arrays.** The text fields hold one array value per section or finding, with
  a position gap of 100. A phrase query with slop below 100 therefore cannot match
  across two values.

**Nested aircraft and facets.** `aircraft` is `nested`, so all active aircraft facets
(phase, category, engine, FAR part, purpose) must hold for one aircraft. The Phase
facet uses each aircraft's defining phase group. Aircraft facets count distinct
events with `nested → filter → terms → reverse_nested`. An event with different
aircraft counts once in each bucket, so buckets can sum to more than the total.

**Versions.** The current version is `cases-v3`: v2 introduced text arrays and KStem
(G3), and v3 added the glued-heading filter. The index `_meta` records the version, a
fingerprint of the settings and mapping, the generation and the build ID. The API
also serves `cases-v2` to keyword search, but only at its exact recorded fingerprint;
AI retrieval's cases channel (`retrieval.v2`) reads `cases-v3` only.

**Build.** Pin the verified generation, then stream its US cases from one snapshot in
batches of 500 with refresh off. Then check documents, nested aircraft, eligible and
multi-aircraft counts against PostgreSQL.

**Real data.**

- 25,407 documents and 25,816 aircraft, built in 17.8 s.
- 405 multi-aircraft events; 140 with several defining phases, 7 with none.
- "carburetor icing" over the probable cause matches 373 cases as a `match` query
  with AND, and 367 as a `match_phrase`. As an API search anywhere in the text it
  matches 968 cases.
- "carb ice" through the synonym-expanded search analyzer matches 367 probable
  causes, the phrase count, because a multi-word synonym alternative is matched as a
  phrase.

### 2.7 Chunking

Code: `worker/index/chunk.ts`, `worker/index/tokens.ts`, `worker/index/passages.ts`.

Only provisionally answer-eligible US cases get passages. Each section is chunked on
its own, with exact `cl100k_base` token counts. `chunk-v2` uses a target of 650, a
maximum of 800, a minimum of 200 and an overlap of 80 tokens. The limits apply to
passage text, without the embedding header.

- **Short sections stay whole.** A section of at most 800 tokens is one passage,
  probable causes included. In generation 1 no cause needed splitting.
- **Longer sections** are split into paragraphs and sentences. Abbreviations and
  decimals do not end a sentence. Sentences are then packed evenly near the target.
  The packer *prefers* paragraph ends, avoids ending on a heading and avoids tails
  under 200 tokens; these are preferences with fallbacks, not guarantees. An offline
  probe produced ordinary chunks of 749 and 142 tokens.
- **Overlap.** Each later passage repeats up to 80 tokens from the end of the
  previous one: whole trailing sentences, or a clause or word tail when the last
  sentence is longer.
- **Glued headings** (new in chunk-v2) count as soft paragraph starts.
- **Continuation rule (A16).** A sentence or cause over 800 tokens is split at a
  clause boundary, else at whitespace. Text without whitespace is cut at a code-point
  boundary as a last resort. Later pieces carry `continuation: true` and
  `part`/`parts`. Nothing is truncated.
- **Offsets** are UTF-16 code units into the stored section text, never inside a
  surrogate pair. `text === section.text.slice(start, end)` always holds.
- **Identity.** `passage_id` is SHA-256 over the revision ID, the offsets and the
  chunker version.

G4 approved 650/800/80. The low median reflects short sections kept whole.

| Measure | Value |
| --- | ---: |
| Sections → passages | 69,023 → 91,898 |
| Aircraft-specific / event-scoped | 89,701 / 2,197 |
| Factual / analysis / probable cause | 42,599 / 24,921 / 24,378 |
| Input tokens (text + headers; overlap) | 28.51M (27.17M + 1.34M; 1.48M) |
| Embedding-input tokens per passage, header included: p50 / p95 / max | 238 / 663 / 819 |
| Largest whole probable cause (passage text) | 428 |
| Oversized splits | 0 |

### 2.8 Embedding

Code: `worker/index/embed.ts`, `worker/index/embedding-cache.ts`,
`worker/index/spend-gate.ts`.

**Input** (template `input-v1`):

```
<section label> · <make model | Event (n aircraft)> · <defining phase(s)>
<passage text>
```

The header gives the vector context that a mid-section passage lacks: which section,
aircraft type and phase. It exists only in the embedding input. Stored, indexed and
cited text is the raw passage.

**Model.** `text-embedding-3-small`, 1,536 dimensions, $0.02 per million tokens.

**Cache key.** SHA-256 of the template version, model, dimensions and the exact
input, header included, so a header change misses. Vectors are stored as their
responses arrive. A rerun pays again for any vector that was not stored successfully.
Identical inputs are embedded once.

**Batching and rate limits.** A request holds at most 96 inputs and 250,000 tokens.
SDK retries are off. The worker makes up to 3 attempts on 429 (except
`insufficient_quota`), 408, 5xx and connection failures. It waits out the latest of
`Retry-After` and the rate-limit reset headers, and a wait over 10 minutes stops the
run with a rerun time.

**Spend gate: reserve and settle.** Each attempt, retries included, gets its own
reservation on the ledger before it is sent: exact tokens × price × 1.1, rounded up to
a micro-dollar. It settles at the reported usage on success, at zero for a 4xx other
than 408, and at the full reservation when the outcome is uncertain. Without
`--confirm-cost` the command is a dry run. A paid run refuses if its planned
reservations exceed what remains of the $20 monthly allowance, which indexing and
evaluation share.

**Errors** keep only the HTTP status, provider error code and request ID: no
provider message (a 401 quotes part of the key) and no input text. A malformed 200 is
reported by a fixed category, never by its content.

**Real data.** 91,676 distinct inputs (222 duplicates embedded once), 955 requests,
28,428,104 tokens, 597 s, no cache hits. Three amounts describe the cost:

| Amount | Value |
| --- | ---: |
| Computed cost: usage × price | $0.56856208 (shown as **$0.5686**) |
| Ledger charge: each request rounded up to a micro-dollar | $0.569028 |
| Reservations: sum of 955 separate attempts, not one held for the run | $0.625890 |

### 2.9 The passages index

Code: `worker/index/passages-index.ts`, `server/db/schema/passages.ts`, migration
`0012_passages.sql`.

**PostgreSQL first.** Passage rows (IDs, scope, offsets, token count, no text) go
into `passages` before indexing. Triggers require a verified generation and a
matching section of an answer-eligible US case. They also forbid updates, and make
an insert lock its generation so pruning waits (G4).

**Mapping choices** (`passages-v2`).

- **`embedding`** is a `dense_vector` with 1,536 dimensions, cosine similarity and
  `int8_hnsw`, which quantizes the vectors used by the HNSW graph to save memory.
- **`exclude_source_vectors`** keeps vectors out of `_source`, so hits do not carry
  1,536 floats each.
- **Nested `aircraft` versus nested `event_aircraft`.**
  - An aircraft-scoped passage fills the nested `aircraft` field with its own
    aircraft. Its `event_aircraft` is empty, `event_aircraft_count` null and
    `event_aircraft_complete` false.
  - An event-scoped passage sets `aircraft_specific: false` and `aircraft_key` null,
    leaves `aircraft` empty and puts every aircraft of the event in the nested field
    `event_aircraft` (the same properties: key, category, make, model, FAR part,
    purpose, engine types, defining phase group). It records `event_aircraft_count`,
    the event's `case_aircraft` rows, and `event_aircraft_complete: true`.

  A nested `aircraft` filter therefore never matches an event-scoped passage.
  Because `event_aircraft` is nested, a query can ask whether one and the same
  aircraft meets several conditions, which the flattened object of `passages-v1`
  could not (its fields merged the event's aircraft). Retrieval uses this for the
  event-level qualification (section 2.12).
- **Filters copied per passage:** `country`, year, date, state, `answer_eligible`,
  defining phases, injury, weather and light. The kNN prefilter and the keyword
  channel can then apply the same constraints without a cross-index join.
- **One primary shard** avoids BM25 statistics that differ from shard to shard.
  **Zero replicas** is a capacity choice for a single node and gives no redundancy.

**Event aircraft sets.** The dry run and the build read each multi-aircraft event's
aircraft keys from `case_aircraft` with their own aggregate query, separately from
the case records the passages are built from. Every event-scoped passage must carry
exactly that key set, at least two. Any difference stops the dry run and the build
(`IncompleteEventAircraftError`) before an index exists. The completeness flag is
written only after that check, so a document cannot claim a set the build did not
compare.

**Build checks.** Before the alias moves, the build checks counts per kind and scope,
that every document has an embedding, and that there are zero scope violations and
zero non-US or non-eligible documents. For event aircraft it checks that the nested
`event_aircraft` documents and the sum of `event_aircraft_count` both equal the
PostgreSQL counts, and that no event-scoped passage lacks the nested set, the
completeness flag or a count of at least 2, and no aircraft-scoped passage has any of
them.

**Versions.** `passages-v2` differs from `passages-v1` only in the three event
aircraft fields. Chunks (`chunk-v2`), passage ids, the input template (`input-v1`)
and therefore every embedding input and cache key are unchanged, so a generation
indexed as v1 is rebuilt as v2 entirely from `embedding_cache`. A unit test pins the
fixture passages' ids and cache keys to the values the v1 code produced.

**Cache-only builds.** `index passages --cache-only` builds without an embedder: the
worker creates no OpenAI client and passes the build an embedder that throws on any
call, and `confirmCost` and the spend gate are not used. The build stops with
`CacheIncompleteError` before creating an index unless the dry run finds every input
cached ("to embed: 0"). A miss that appeared after planning would reach the throwing
embedder and fail the build, which then deletes its unsubmitted index.

**Real data.** 91,898 documents, all US and answer-eligible (`passages-v1`, built on
`dev`). A read-only `passages-v2` dry run on a local load of the same archive
(generation 1) gives the same 91,898 passages, 91,676 distinct inputs and 28,512,628
input tokens. It checked 2,197 event-scoped passages of 375 events against
`case_aircraft`: all complete, with 4,412 nested event aircraft. In a smoke check, kNN
seeded with a carburetor-icing probable-cause vector returned other
carburetor-icing causes at Elasticsearch `_score` 0.94–0.95. With cosine
similarity, `_score = (1 + cosine) / 2`, so that is a cosine of about 0.88–0.90.
This is a smoke check, not a retrieval evaluation.

### 2.10 Index naming, aliases and the manifest

Code: `worker/index/aliases.ts`, `worker/index/publications.ts`, migration
`0010_index_switches.sql`.

**Naming.** Indices are named `<prefix>-<version>-g<generation>-<UTC
timestamp>-<build id>` with prefix `ai-aviation-<env>`, for example
`ai-aviation-dev-cases-v3-g1-20261022143728115-f0d0e84d`.

**Aliases versus the manifest.** The aliases `<prefix>-cases` and
`<prefix>-passages` mean "built last", for operators, and the API never reads them.
The served dataset is a PostgreSQL generation plus two indices that must change
together. An alias switches one index and knows nothing of PostgreSQL. A manifest
flip is one transaction under the lifecycle lock.

**Switch attempts are kept.** A per-alias advisory lock serializes switches.

- If the alias already points only at the index, nothing is sent and no attempt is
  recorded.
- Otherwise a `pending` row goes into `index_switch_attempts`, and one unretried
  `_aliases` request is sent.
- A response resolves the attempt to `committed` or `rejected`. A timeout, transport
  failure or server error leaves it `unknown`, because Elasticsearch may still apply
  a queued change.
- An `unknown` attempt blocks the alias until `index reconcile` sees the index there,
  or an operator declares it abandoned, which deletes nothing.
- Attempt rows are never deleted. Their outcome changes only through permitted
  forward transitions, and `committed` is final.

G3 re-checks kept finding races in automatic recovery, so the design was simplified
to this.

**Explicit deletion.** A build deletes its own index only if it never reached an
alias request. Everything else waits for `index delete-unused --yes`, which
revalidates under locks and refuses:

- alias targets, and indices named in any manifest;
- indices with any committed, pending or unknown attempt, including an unknown one
  declared abandoned;
- running or recent builds.

It is therefore no way to retire a previously committed index routinely.

### 2.11 Publishing, and what the API reads

Code: `worker/index/publish.ts`, `server/dataset.ts`, `server/search/*`.

**Publishing.** `pnpm worker publish` checks that the cases index is a concrete index
whose `_meta` names the generation and a servable version and fingerprint, and whose
document count equals the generation's US events. A passages index must meet the
passages contract (`server/search/passages-contract.ts`):

- its `_meta` names this generation and an approved version: `passages-v2`, or
  `passages-v1`, which stays servable with the event-level qualification off. The
  version brings its chunker (`chunk-v2` for both) and input template (`input-v1`
  for both);
- it was built for the configured embedding model and dimensions
  (`OPENAI_EMBEDDING_MODEL`, `OPENAI_EMBEDDING_DIMENSIONS`), and its mapping
  fingerprint is the one approved for that version and pair in code (today only
  `text-embedding-3-small/1536`: `ed335f46…` for v2, `57d731b2…` for v1). A v2
  mapping cannot pass as v1, or the reverse;
- its document count equals the generation's `chunk-v2` passage rows.

`publish_manifest` then requires a current successful verification, retires the old
manifest and activates the new one. A manifest without passages is keyword-only.
Republishing an earlier generation, or the same generation with its earlier passages
index, is the rollback. **The `dev` manifest for generation 1 serves `cases-v3` and
`passages-v1` until the cache-only `passages-v2` rebuild is published (RUNBOOK,
"Rebuilding passages as `passages-v2` from the cache").**

**The API:**

- caches the active manifest row for 5 s;
- checks the cases index `_meta` once per manifest, when it loads that manifest's
  facts, and answers 503 rather than serve a mismatch;
- uses a dataset revision such as `g1-cases-v3-b65442be` in ETags;
- runs search, facets and the dashboard on the cases index, with a 5 s timeout and
  no partial results (each request sets `allow_partial_search_results: false`, and a
  response that timed out or whose shards did not all succeed is a 503);
- reads result rows and case pages from PostgreSQL for the same generation;
- reads report links, which belong to no generation, from `report_links`;
- checks the passages index against the same contract, bounded to 2 s, once per
  manifest. A failure never fails the dataset: keyword search, case pages and the
  dashboard keep working, and only AI evidence is off. The status records a fixed
  code (`not_configured`, `incompatible`, `unavailable`) and a fixed failure
  category (`timeout`, `transport`, `http_<status>`, `incompatible:<fields>`, …),
  never upstream error text. A broken contract or a missing index is kept until the
  manifest changes; a transient failure is checked again after 30 s, in the
  background, while requests get the last answer.

Only the AI brief routes read the passages index, through hybrid retrieval, and only
while the dataset reports it servable; otherwise AI answers 503 `unavailable` and its
status reports `dependency` (README, "AI briefs").

### 2.12 Retrieval

Code: `server/search/hybrid.ts`, `evidence.ts`, `rrf.ts`, `filters.ts`,
`passages-contract.ts`, and for the case-level version `retrieval-config.ts`,
`cases-channel.ts`, `case-fusion.ts`, `case-mapping.ts`, `case-retrieval.ts`;
`server/ai/embeddings.ts`. Gate G5 cleared the first defaults provisionally (section
5). Since task 10e the behaviour is versioned: `AVIATION_RETRIEVAL_VERSION` picks one
frozen configuration, `retrieval.v2` by default and `retrieval.v1` (the earlier
behaviour, every value in `RETRIEVAL_DEFAULTS`) to roll back; each brief step records
the version it used.

**How the cases index takes part in AI answers (`retrieval.v2`), in plain words.**
The cases index, built for keyword search with one document per accident, now also
helps choose which accidents an AI brief looks at. Three searches run for each
question: a word search over the passages (with the search terms the scope stage
extracted), a meaning search over the passages (with the question's embedding), and
a word search over each accident's narrative fields in the cases index (the same
search terms over the probable cause, the analysis and the factual narrative; an
accident scores by its best-matching field, not by the narrative as a whole). Each
search returns its 200 best matches; each list is reduced to its accidents, and the
three lists are combined so that an accident several searches agree on comes first.
The cases index never supplies the evidence itself: an
accident it finds is shown only through its own passages from the passages index,
under the same filters, with every probable cause attached. When none of its
passages was among the passage searches' matches, the passages closest in meaning to
the question are looked up for that accident alone (with the embedding already made;
nothing is paid twice). The cases index search uses the same cohort as the passages:
US, answer-eligible accidents with at least one aircraft, and the same rules for
aircraft filters (a multi-aircraft accident counts only when every aircraft matches,
and only on a `passages-v2` index). Only the cases index that the brief's dataset
manifest published with its passages index is used, checked against the generation
first, and only a `cases-v3` index (the version the validation covered; a manifest
that pairs the passages with a `cases-v2` index makes AI retrieval unavailable
rather than run an unvalidated channel). Each brief step records the cases index it
read (name and version) in its private metadata. The manifest pairing ties a cases
index to a generation, not to a brief: re-publishing the passages index invalidates
the briefs made from the old one (their later steps find no cases index paired with
their passages index and are unavailable), while re-publishing only the cases index
can change what later retrieval for the same question returns. Nothing in either
index changes.

- **Contract first.** Retrieval refuses (`RetrievalUnavailableError`) when the
  dataset has no passages index or the index breaks the passages contract. It checks
  before the query is embedded, within the request's deadline. There is no
  keyword-only fallback for AI answers.
- **One filter compiler for both channels and the fetch.** It always adds
  `country: USA` and `answer_eligible: true`. The filter is compiled once per
  request, for the version the passages contract matched, and the BM25 query, the kNN
  prefilter and the evidence fetch carry the identical clauses. With an aircraft
  facet:
  - **`passages-v1`: exclusion.** `aircraft_specific: true` and one nested
    `aircraft` clause, so an event-scoped passage never satisfies an aircraft
    filter.
  - **`passages-v2`: event-level qualification** (gate G5 extension). One clause:
    either that aircraft branch, or an event-scoped passage of an event that
    qualifies as a whole:
    - `aircraft_specific: false` and `event_aircraft_complete: true`;
    - a non-empty nested `event_aircraft`;
    - no nested event aircraft failing the full conjunction of the active aircraft
      facets: `must_not nested(event_aircraft, bool must_not [bool filter
      conjunction])`. Each aircraft must meet every facet itself. A missing value
      fails its facet: `blank` is left out of the event branch, and a facet whose
      only value is `blank` leaves the event branch out.

    Two helicopters qualify under a helicopter filter; a helicopter and an airplane
    do not, and neither do two facets met by different aircraft (an Army helicopter
    and a Part 121 airliner under "helicopter, Part 121"). The passage stays
    event-scoped (`scope: event`, `aircraft_key` null), so nothing attributes it to
    one aircraft, and the brief pipeline's rules for multi-aircraft events are
    unchanged. The qualification belongs to the event: every passage of a qualifying
    event qualifies, so the fetch attaches every event-scoped probable-cause variant
    stored for it. Applied to a v1 index by mistake, the clause qualifies nothing:
    v1 has no `event_aircraft_complete` field.

  Integration tests compare the matches of 18 selections on a fixture variant with
  an independent reference implementation of these rules.
- **Complete answers only.** Every search sets `allow_partial_search_results: false`.
  A response that timed out, has a failed shard, or has fewer `successful` shards than
  `total` fails retrieval.
- **Stage 1, case candidates.** The question is embedded once (template `query-v1`:
  whitespace collapsed, no header, at most 1,000 tokens). BM25 over passage `text`
  (with the search terms the brief's scope stage extracts, when there are any) and
  kNN (`num_candidates` = 4 × k) each return 50 passages under `retrieval.v1`, 200
  under `retrieval.v2`; the evaluation also runs 100. Reciprocal rank fusion,
  `sum(1 / (60 + rank))`, runs in TypeScript (native RRF needs a paid license).
  `retrieval.v1` fuses the passage lists and takes each case at its best passage.
  `retrieval.v2` adds the cases channel (200 cases, BM25 over `probable_cause`,
  `analysis` and `factual`), collapses each channel to its unique cases (in a total
  order: score, then id), and fuses the case lists with exact fractions and a total
  tie order (best rank, ranks channel by channel, case number). **Cutoffs:** both
  BM25 channels send `sort: [_score desc, passage_id | ntsb_no asc]`, so Elasticsearch
  decides equal scores at the 200th place by the id while it collects the top 200
  (an integration test with 201 equal scores in two insertion orders); the kNN
  channel is approximate discovery (HNSW, int8 quantization per segment), so its set
  and scores belong to one index state and a rebuilt copy may differ. Fusion is exact
  over whatever the channels returned. Its filter is the
  passages filter restated on the cases index: compulsory `country` and
  `answer_eligible`, `aircraft_count >= 1`, the same event facets and years, and the
  passages contract's aircraft rule on the nested `aircraft` (one aircraft meeting
  every facet; under `passages-v2` also a multi-aircraft event whose every aircraft
  meets the full conjunction). An integration test compares it with the passages
  filter and an independent reference on adversarial selections for both contract
  versions, and the validation's preflight checks it on the target for every
  evaluation and scope-inferred filter. The leading 12 cases no passage channel
  returned are mapped: the count of each case's passages under the passages filter
  (`n`), then a kNN for that case with k = `num_candidates` = `n`, an exact search
  over all of them. The answer must hold exactly the `n` passages, all of that case,
  each once and scored; anything else fails the whole retrieval like an incomplete
  search. The best 3 by score, then passage id, are kept. A case with no passages
  under the filter, or more than 1,000 (the mapping-size limit; the largest `dev`
  case holds 63), is reported unmapped and never packed. The first failed mapping
  request cancels the others.
- **Stage 2, packing.** At most 6 cases, 12 passages, 3 passages per case and 10,000
  `cl100k_base` passage-text tokens. Each selected case first reserves its
  justification: its best retrieved passage and every probable-cause variant it has
  under the filters, including each distinct event-scoped variant. A case whose
  reservation does not fit is skipped, so the bundle holds fewer cases rather than
  cases without the passage that ranked them. Then each case gets at most one more
  retrieved passage (two retrieved in all, the reserved one included:
  `retrievedPerCase` 2), trimmed to the budgets lowest-ranked first, and free room is
  filled in fused order, where a case can reach its third passage.
- **Cost.** The query embedding's usage (tokens, USD, `reported` or `uncertain`) is
  handed to the caller as soon as the embedding returns, before any search, so a
  later failure cannot lose a paid stage. Retrieval reserves no money: the AI
  request's admission reservation covers one query embedding.

**Evaluation** (`evals/retrieval/`). The silver set has 76 questions derived from
generation 1 by committed rules (structured fields plus explicit PostgreSQL regular
expressions, each recorded for an expert to re-check; every label is
`pending-expert`):

- 73 retrieval questions, 35 `dev` and 38 `holdout`, including 16 independently
  worded paraphrases. Questions that share a case, and paraphrases with their
  originals, form groups assigned whole to one split. Groups go first where they
  bring a required tag a split lacks, then by primary tag; adding questions
  reorders the groups, and 29 of the 72 earlier questions changed split at Task 10b.
- 5 retrieval questions (tag `multi_aircraft_filtered`) ask for multi-aircraft events
  under an aircraft category filter, with every-aircraft rules (`categoryEvery`):
  two helicopters and helicopter collisions under the helicopter filter, and the
  airplane versions of the taxi, Alaska and skydiving questions under the airplane
  filter (the latter three keep their originals' exclusions, which hold the
  multi-aircraft questions in three groups). Only the `passages-v2` qualification
  reaches their cases. On a `passages-v1` index the evaluation reports them as a
  problem and, with `--exploratory`, runs without them.
- 3 questions answered by inspection dates and hours, kept as `structured` and not
  run by the retrieval evaluation.

It reports candidate case Recall@20 and, on the packed bundle, case coverage,
question-specific evidence coverage, bundle precision and nDCG@6, for BM25, kNN and
the hybrid at 50 and 100 passages per channel. It fails closed: dataset problems, a
generation other than the silver set's, or an index that breaks the contract stop
the run before anything is embedded. On `dev` generation 1 at 50 passages per
channel, hybrid candidate Recall@20 was 33.7% (BM25 28.4%, kNN 30.5%), and the
maintenance-timing questions were near 0.

The coded-reference set (`evals/retrieval/coded/`, Track C of the task 10c protocol)
has 43 questions on generation 1: 34 originals over environment, aircraft systems,
personnel and occurrences, and 9 paraphrases. 25 are narrow (1 to 20 coded cases,
gated on Recall@20) and 18 broad (more than 20, gated on strict P@6 and nDCG@6); the
dev and holdout splits hold 21 and 22 questions, each with narrow and broad questions
of every area. Labels are exact membership in a frozen code set: finding codes with
explicit modifiers, optionally cited in the probable cause, and occurrence codes, with
an aircraft attribution rule. Under an aircraft filter the carrying aircraft must
match and a multi-aircraft event must match as a whole (one question, helicopter
midair collisions, relies on the `passages-v2` qualification and records 15 mixed
events as unreachable). Absence of a code is not a negative judgement: precision is
coded precision. `pnpm eval:retrieval --track coded` runs it with the silver run's
checks, plus a check that the dataset was built from the committed specs. Its splits
are frozen: rebuilds keep every committed question in its split.

**Task 10e validation of `retrieval.v2`** (`evals/retrieval/adoption/`, coded-reference,
development split only, phase A's cached scope samples and one query vector per
question for every arm). Against what the pipeline retrieved before (`retrieval.v1`,
phase A's `p50-kt`), narrow Recall@20 rose from 62.1% to 72.2% (+10.1 points, 95% group
bootstrap [+5.8, +16.0]); broad coded P@6 from 40.1% to 45.1% and nDCG@6 from 39.7% to
46.6%, with intervals spanning zero on 9 broad questions in 3 groups. With the scope
stage's own filters instead of the evaluation filters the figures are the same for
narrow questions and 40.7% to 45.1% (P@6), 41.6% to 47.7% (nDCG@6) for broad ones.
One broad question loses heavily and is kept as a regression case
(`per-pilot-decision-cause-weight-shift`, nDCG@6 65.8% to 25.9%: in its small
weight-shift cohort the two word searches agree on accidents that repeat the generic
search terms and outrank accidents whose probable cause states the decision). No
development question needed the mapping, and every delivered case was also found by a
passage channel. These are not holdout or release results: the phase A holdout
confirmed the findings variant, not this one.

The narrative-relevance set (`evals/retrieval/narrative/`, Track N) has 25 development
benchmark questions in 21 families, and task 10e's regression question as a diagnostic
reported apart, over negation, maintenance chronology, causal uncertainty,
pilot-versus-investigator attribution, paraphrases, multi-aircraft events and aircraft
filters, operational and mechanical concepts, each with a written rubric whose grades
are decided in order. Six are bounded cohorts (82 to 107 answer-eligible cases each, 581
in all) judged completely; the others are judged on pools. Cohorts are derived from PostgreSQL with the passages-v2 semantics
(every aircraft of a multi-aircraft event must meet the aircraft filters) and checked
against the passages index before any paid step. Labels are model-judged: two judges
from different providers grade each case on its complete record, and an adjudicator
settles disagreements; unresolved pairs stay unknown. Its pools come from the production
retrieval versions (`retrieval.v1`, `retrieval.v2`, `retrieval.v2-nf`, each configuration
hash recorded) run on identical cached inputs, and their identity is frozen before any
judging. Two calibration sets with
constructed labels (code-reading items and synthetic narrative controls, including
answerability bundles and long records judged in parts) are frozen by hash; the
synthetic records carry real-format case numbers that the builder checks no real case
uses.

Both runs verify their labels on the target before anything is embedded. Each dataset
records its generation's id and identity (archive sha256 and the completion mapping,
field normalization and citation text versions; ids are per-database sequences), and
the run re-derives every question's labels on the target generation, read-only, from
the rules or code sets the dataset records. A different identity, or labels that
differ for any question, stop a gating run; `--exploratory` continues and names the
reasons in the non-gating report.

## 3. How Elasticsearch is composed

Both indices are `dynamic: strict`, share the aviation analyzers, and record version,
fingerprint and generation in `_meta`. Each has one primary shard, for consistent
BM25 statistics, and zero replicas, for single-node capacity without redundancy.

| Field group | Cases index (`cases-v3`, 25,407 docs) | Passages index (`passages-v2`; `passages-v1` on `dev`, 91,898 docs) | Purpose |
| --- | --- | --- | --- |
| Unit | one US event | one passage of a provisionally answer-eligible US case (completed, with probable cause) | |
| Identity | `ntsb_no` | `passage_id`, `ntsb_no`, `section_id`, `revision_id` | Case URL; citation chain |
| Span | — | `section_kind`, `scope`, `aircraft_specific`, `aircraft_key`, `start`, `end`, `part`, `parts`, `continuation` | Provenance, UTF-16 offsets |
| Text | `probable_cause`, `analysis`, `factual`, `findings_text`: arrays, gap 100 | `text` | BM25, highlights |
| Vector | — | `embedding`: `dense_vector` 1,536, cosine, `int8_hnsw`, not in `_source` | kNN |
| Event filters | `country`, `ev_date`, `ev_year`, `state`, `city`, `location` (`geo_point`), `highest_injury`, `light`, `wx_cond`, `completion_class`, `raw_status`, `answer_eligible`, `completed_with_cause` | `country`, `ev_date`, `ev_year`, `state`, `highest_injury`, `light`, `wx_cond`, `answer_eligible` | Facets, cohorts, compulsory clauses |
| Phases | `defining_phase_groups`, `sequence_phase_groups`, `defining_events` | `defining_phase_groups` | Event-level phase data; the Phase facet filters `aircraft.defining_phase_group` |
| Aircraft | `nested` `aircraft` (make, model, category, FAR part, purpose, damage, engine types, homebuilt, defining phase); `aircraft_count` | `nested` `aircraft` if aircraft-scoped; `nested` `event_aircraft` (every aircraft of the event), `event_aircraft_count` and `event_aircraft_complete` if event-scoped (v1: `object` `event_aircraft`, no count or flag) | Same-aircraft constraints; event-level qualification |

**Why two indices.**

- **Units.** Search, facets and the dashboard count events. Evidence retrieval
  scores passages and needs vectors.
- **Cohorts.** Browsing covers every US event; passages cover only provisionally
  answer-eligible cases.
- **Cost.** A cases rebuild takes 18 s and makes no paid embedding calls. A passages
  build needs embeddings, although the cache makes rebuilds nearly free.
- **No joins.** Copying filters into the passages avoids a cross-index join in the
  search and kNN pipeline.
- **Independence.** A keyword-only manifest keeps browsing working without AI.

## 4. Access model for data

**PostgreSQL** has one database per environment (`aviation_dev`, `aviation_live`):

- `NOLOGIN` group roles (migrator, ingest, app) hold the privileges.
- Per-environment `NOINHERIT` login roles act as their group role.
- A per-environment `NOLOGIN` owner role owns the database. `CONNECT` is granted only
  to that environment's logins, so a `dev` login cannot reach `aviation_live`.
- **Ingest** inserts corpus, passage and cache rows, but cannot update or delete them;
  status changes go through the definer functions.
- **App** has two separate boundaries:
  - **Corpus data:** read-only. It cannot read `ev_id`, quarantine, run errors or the
    embedding cache.
  - **Control data:** it writes usage buckets, leases, idempotency records, trial and
    abuse records, reservations and ledger entries.

**Elasticsearch** has a reader role and a writer role per environment, both limited
to `ai-aviation-<env>-*` and without cluster privileges. The API gets only the read
key; workers use the write key.

The extraction container holds no credentials. The OpenAI key is used only by the
worker's paid run.

## 5. Data-review gates

GPT-6-Astra (Codex) reviewed each data step before it ran on real data, and re-checked
until no blocking issue remained.

| Gate | Before | Found | Changed |
| --- | --- | --- | --- |
| G0 | Implementation | 15 plan gaps: join keys, country field, attribution, completion code, generations, spend metering, scalars, HTML, negations | Amendments A1–A16 |
| G1 | Real extraction | Unbounded CSV parsing, unsafe cleanup, unawaited container removal, ignored stderr, silent UTF-8 repair, readable raw MDB | Bounded fatal parsing, owned staging, confirmed removal, stderr fails |
| G2a | Normalization | Provenance read as attribution, string-typed keys, first-aircraft phase, arbitrary defining flags | Event scope, typed keys, phase union, unresolved conflicts |
| G2b | Full load | Sealed rows deletable, unproven source-to-text link, failed generations publishable, lifecycle races | Seal triggers, source reconstruction, verification status, lifecycle lock, locked pins |
| G3 | Full cases index | Cross-section phrases, alias-switch and cleanup races, pruning during builds | Text arrays, alias locks, build pins, append-only attempts, explicit deletion; KStem |
| G4 | Paid embedding | Error text leaks, insert/prune race, shortened provider waits | Metadata-only errors, generation lock, full waits; defaults and estimate confirmed |
| G5 | AI retrieval | Partial search results accepted, packing could drop the passage that ranked a case, an inspection-hours label bug, shared positives scored as wrong, incomplete passages checks, query-embedding cost lost on a later failure, an evaluation that warned and went on; then skipped shards counted twice, a transient passages failure kept until the next publication, upstream error text in the status | Complete responses only, packing reservations, full positive sets with grouped splits, paraphrases and structured questions, the passages contract at publish and load, the usage callback, a fail-closed evaluation, `successful === total`, a 30 s re-check, fixed failure categories |

G5 cleared provisionally: the defaults may serve AI in `dev`, not public answers,
until a relevance audit and candidate-discovery work (planned) improve recall. G5
then approved a conservative event-level "every aircraft matches" extension:
complete, non-empty aircraft sets, the full conjunction of the active facets for
every aircraft, a properly nested representation, the identical clause in both
channels and the cause fetch, no attribution to an individual aircraft, and the
exclusion kept until those tests pass. `passages-v2` implements it; the extension
itself goes back to G5 before it runs on `dev`. G6 (model input and quote
validation) is still ahead.

Task 10e (adopting the case-level `retrieval.v2`) was approved with binding
conditions: a frozen, versioned configuration with a rollback; the cases channel on
the same manifest generation with the passages contract's cohort and aircraft rule;
deterministic, exact case-level fusion; a mapping that reuses the query vector and
verifies every case; unchanged packing guarantees; failures that still settle the
paid embedding once; and validation against the deployed retrieval, end to end with
inferred filters, on delivered evidence, on the regression question and under
concurrent load. The implementation review asked for a bounded manifest lookup, a
mapping that fails the retrieval on an inconsistent answer, and cutoffs decided by
the id inside Elasticsearch; fix round 1 makes those changes and goes back to it.

## 6. Known limits and open owner items

**Owner items:**

- **Completion mapping.** Verify it with NTSB. Production launch is blocked until
  then. Generation 1's metadata is immutable and cannot simply be flipped:
  confirming the mapping needs a new generation, recorded with the verified mapping,
  and republished projections.
- **Report links.** Provide a real Aviation Search export; only the 4 seed links
  exist.
- **Evaluation labels.** Seed cases and the silver set need an aviation expert.
- **Snapshot date.** Confirm whether it should stay the newest record change
  (2026-09-30) or become the download date.
- **Enterprise API.** Arrange access before NTSB retires the legacy downloads on
  2027-04-05.

**Remaining work:**

- **Retrieval quality.** Candidate recall is far below the 90% target
  (section 2.12). The planned order is a blinded audit of the labels, the scope-stage
  search terms, better candidate discovery (notably for maintenance timelines), then
  a bounded reranker.
- **Multi-aircraft events under aircraft filters.** `passages-v2` implements the
  G5 event-level qualification (section 2.12). It takes effect on `dev` once a
  cache-only `passages-v2` rebuild of generation 1 is reviewed and published; until
  then the published `passages-v1` keeps the exclusion, and the 5
  `multi_aircraft_filtered` evaluation questions run only against a v2 index.

**Known limits:**

- Archive download is manual; the planned host allowlist is not implemented.
- Only `avall.zip` (2008 onward) is ingested: no weekly updates or pre-2008 archives.
- Old indices are deleted by hand, and `delete-unused` never removes an index that
  was ever committed to an alias. `dev` still keeps `cases-v2`.
- Embedding inputs still contain glued headings. Fixing that needs a new input
  template and a paid re-embedding.
- Multi-aircraft narratives (2,197 passages) can never ground an aircraft-specific
  claim. Under an aircraft filter they reach a brief only when every aircraft of
  the event satisfies it, and then only as event-scoped evidence. A mixed event (a
  helicopter and an airplane) stays out of a helicopter-only filter, and an aircraft
  with a missing value for a filtered field keeps its event out.
- Aircraft facets can sum to more than the event total.
- Extraction can rarely orphan a container if the Docker daemon is slow.
- There are no replicas. Both indices can be rebuilt from PostgreSQL and the cache.
