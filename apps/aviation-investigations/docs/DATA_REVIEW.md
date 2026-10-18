# NTSB data assessment

Observed **2026-10-16** through inspection of the actual downloadable database and
official final reports. This is a design input, not production ingestion or a
validated safety study. [Implementation design](DESIGN.md).

## Source and coverage

The [download directory](https://data.ntsb.gov/avdata/) lists `avall.zip` dated
October 1, 2026 at **96,583,215 bytes** (96.6 MB decimal). The downloaded archive
matches that size and expands to one **561,229,824-byte `avall.mdb`**.

The [release notes](https://data.ntsb.gov/avdata/FileDirectory/DownloadFile?fileID=C%3A%5Cavdata%5CMDB_Release_Notes.pdf)
specify separate sources:

| Source | Coverage | Plan |
| --- | --- | --- |
| `avall.zip` | 2008 onward, refreshed monthly | Initial import |
| `Pre2008.zip` | 1982–2007 | Separate adapter/backfill |
| `PRE1982.zip` | 1962–1981 | Later adapter with different coding conventions |
| `up<day><month>.zip` | Weekly changes, potentially to older events | Revisions, not just new accidents |

The directory announces replacement of legacy downloads on **April 5, 2027**,
recommending the Enterprise API's `GetCasesByDateRangeV2`. The
[developer portal](https://developer.ntsb.gov/) exists, but its API catalog requires
sign-in. Authentication, schema, pagination, quotas, deletion handling, and whether
date filters mean event or modification dates remain **unverified**. Do not assume
this endpoint is a change feed or build a permanent MDB-only pipeline.

The downloaded October 15 update contained 139 events, 139 aircraft, 89 narrative
rows, and 209 findings. It was inspected separately, **not merged** into the base
snapshot used below.

## Measured contents

The [aggregate profile](data-profile-2026-10-16.json) records source hash, counts,
field coverage, raw status distributions, and relevant dictionary definitions.

| Measurement | Observed value |
| --- | ---: |
| Events, all countries, 2008–2026 | 31,303 |
| Events with `ev_country = USA` | 25,407 |
| Aircraft rows | 31,854 |
| Events with multiple aircraft | 545 |
| Narrative rows, keyed by event and aircraft | 28,516 |
| Findings | 73,002 |
| Event-sequence rows | 66,683 |
| Engines | 28,648 |
| US events with status `B` and nonblank probable-cause text | 24,291 |

The final row is a **provisional completed-case cohort**, not an officially
verified completion-code mapping. Every US case with populated probable cause
had status `B`. US statuses were `B=24,293`, `P=1,040`, `F=18`, and blank `=56`.
**Do not interpret `F` as final from its letter.** Verify against current official
metadata and representative final/factual/preliminary records before publishing
completed-only results. Two US `B` records lacked a cause narrative.

This provisional cohort has 24,668 aircraft narrative rows and 127,522,915
characters across factual/final/cause fields: approximately **31.9 million tokens**
at four characters per token, before deduplication/overlap/redaction. This is not
a tokenizer measurement. Factual and final text are identical in 2,086 rows.

## Useful fields and join rules

Use the embedded `eADMSPUB_DataDictionary` and
[MDB schema](https://data.ntsb.gov/avdata/FileDirectory/DownloadFile?fileID=C%3A%5Cavdata%5Ceadmspub.pdf).
The [web export dictionary](https://www.ntsb.gov/pages/AviationDownloadDataDictionary.aspx)
describes a different export shape and is not a full specification of the MDB.

| Table | Useful content | Interpretation |
| --- | --- | --- |
| `events` | IDs, date, location/country, weather, coordinates, injuries | Event-count denominator |
| `aircraft` | Aircraft key, make/model, category, FAR part, purpose, inspection date/hours | Multiple aircraft per event |
| `engines` | Type/model, fuel system, time since overhaul | Join by event **and aircraft** |
| `narratives` | `narr_accp`, `narr_accf`, `narr_cause` | Factual narrative, final summary, probable cause; retain separately |
| `Findings` | Codes/descriptions and `cm_inPC` | Structured findings and probable-cause membership |
| `Events_Sequence` | Ordered phases/occurrences, defining-event flag | Flight-phase filters and sequence comparisons |
| `NTSB_Admin` | Raw status, approval/change dates | Verify semantics before deriving completion or duration |

`narr_accf` corresponds to Analysis in the inspected example reports. Preserve the
original field and verify across eras rather than guessing from abbreviations.
Flattening aircraft, engines, narratives, and findings into one join multiplies
events and risks attributing one aircraft's evidence to another in a collision.

## Quality constraints

Percentages below mean **nonblank**, not validated. Denominators are all event or
aircraft rows, including foreign/incomplete investigations, not the final US cohort.

| Observation | Consequence |
| --- | --- |
| Decimal coordinates present for about 89.1% of events | Validate coordinates; show unmapped cases |
| Basic weather 82.9%; wind speed 64.3% | Explicit unknown filters and chart denominators |
| Last-inspection date 65.4% of aircraft | Useful context, not proof of recent maintenance |
| Hours since inspection only 27.5% | Cannot support a universal maintenance-exposure dashboard |
| `aircraft.phase_flt_spec` entirely empty | Use `Events_Sequence` instead |
| `events.ntsb_docket` entirely empty | Resolve report identifiers elsewhere; never guess numeric PDF IDs |
| `narr_inc` entirely empty | Do not expect FAA incident narratives here |
| Temperature/dew point almost always nonblank, with many zeros | Verify units/sentinels; neither accept every zero nor erase real zero temperatures |

The 2024 release notes replace deprecated `cause_factor` with `cm_inPC`. The actual
MDB exports **`T`/`F` strings**, although notes describe TRUE/FALSE. This merges
causal and contributing findings; it does not distinguish them. Country-code
revisions are documented in the May 2026 notes. Preserve raw codes and versioned
normalization.

## Four seed cases

These interpretations of official passages are candidate evaluation fixtures.
An instructor/aviation analyst should confirm the final labels.

| Case/source | Supported interpretation | Search challenge |
| --- | --- | --- |
| [DFW08TA066](https://data.ntsb.gov/carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/67493/pdf), Analysis pp. 1–2 | Engine replaced 5.1 hours earlier; unsecured linkage attachment and missing cotter pin; maintenance fault identified in probable cause | Earlier checks with no anomalies do not negate the later confirmed fault |
| [DEN08LA103](https://data.ntsb.gov/carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/68245/pdf), Analysis/Factual Information | Maintenance/test flights preceded power loss; examination found no anomalies; cause undetermined | A pilot's belief that the engine was seizing is not an investigator finding |
| [MIA08LA156](https://data.ntsb.gov/carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/68586/pdf), Analysis p. 1 | Test flight after rudder maintenance; backwards fuel-system valve; tests did not establish it caused the loss; cause undetermined | A real defect without an established causal link needs more than a fault/no-fault label |
| [NYC08LA106](https://data.ntsb.gov/carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/67552/pdf), Analysis p. 1 | Fuel-pump failure contributed; 12 flight hours and about two months since installation | Successful testing after cleaning does not erase the earlier failure; hours and days differ |

DFW08TA066 also has date/injury inconsistencies between its header and factual
narrative. Retain sections and surface conflicts rather than silently reconciling
them with a model.

A deliberately broad phrase search produced 1,585 candidate narrative rows, 621
with negative-fault wording. Inspection immediately exposed false matches, such
as fuel-exhaustion accounts that merely mention maintenance records. These are
**candidate retrieval counts, not maintenance-accident statistics**.

## Dashboard opportunities

| Feature | Required data | Feasibility/caveat |
| --- | --- | --- |
| Evidence map | Classification, spans, examination limitations | Distinguish established faults, negative examinations, noncausal defects, unknowns; needs reviewed extraction |
| Same symptom, different explanation | Similar narratives plus causes/examination evidence | Useful instructor case pairs; not causal counterfactuals |
| Maintenance-to-event timeline | Explicit dates/hours/flights with citations | Show reported intervals/unknowns, not assumed inspection-to-maintenance equivalence |
| Recurring event sequences | `Events_Sequence` and phase codes | Deterministic initial charts and case drill-down |
| Evidence coverage | Missing/invalid fields and narrative availability | Immediately feasible and valuable for judging comparisons |
| Revision tracker | Source snapshots and hashes | Detect future changes; cannot reconstruct unobserved historical versions |

These are product hypotheses, not claims of novelty. Avoid “danger rankings” or
risk per flight: the archive lacks the necessary flight-hour, departure, and
fleet-exposure denominators. Recent completed cases have completion lag. Charts
describe selected investigations, not accident probability in the wider population.

## Reproduction and handling

1. Follow the official directory links: downloads use `FileDirectory/DownloadFile`,
   not plain `/avdata/avall.zip` paths.
2. Record source metadata and SHA-256. Base archive hash:
   `bc74fefb1b39e1b86700a4be82b8ff6014bb1f6d81008524de73f2ddbd38b052`.
3. Inspect using [MDBTools](https://github.com/mdbtools/mdbtools); this assessment
   used version `1.0.0`, extracted locally without system-package changes. Parse
   CSV records, not lines: narrative fields contain newlines.
4. Count rows/distinct event IDs and trimmed nonblank fields. Use the denominators
   and provisional eligibility predicate recorded in the profile. Keep weekly
   updates separate when reproducing these base-snapshot counts.

Example commands with the extracted file under `data/raw/`:

```bash
mdb-tables -1 data/raw/avall.mdb
mdb-schema data/raw/avall.mdb postgres
mdb-export data/raw/avall.mdb events > data/events.csv
mdb-export data/raw/avall.mdb narratives > data/narratives.csv
```

The production importer will be TypeScript invoking pinned MDBTools in a worker
image. Raw downloads contain owner addresses and internal editor identifiers;
exclude them from Git, public indices/exports, and provider prompts. Keep only
product-relevant fields in normalized storage.

The [NTSB website policy](https://www.ntsb.gov/about/Pages/Website-Policies.aspx)
warns that third-party copyrighted material can occur in reports. Prefer
NTSB-authored text and official links; check redistribution before bundling docket
attachments/photos, and do not imply agency endorsement.
