# Automatic NTSB snapshots

The snapshot worker checks the NTSB avall listing daily at **05:30 Europe/Prague**.
It is disabled by default. Installing or enabling its host user-systemd timer is an
operator action after the implementation and data gates, backup exclusion test and
measured storage review. It never deploys application code.

The adapter uses only `https://data.ntsb.gov/avdata/` and the fixed avall ZIP download
endpoint. It refuses redirects, ambiguous listing rows, changed download metadata,
unexpected content encoding and oversized streams. The source's advertised date is
kept without a timezone: the listing supplies none. An unchanged advertisement can
skip retrieval for at most seven days after a successful unconditional byte fetch.
An unknown fetch time means retrieval is owed. A local seed/hash or a listing read
does not advance that clock. A fixed journal reminder starts **2027-03-01 UTC**;
automatic acquisition stops at **2027-04-05T00:00:00Z**. The accepted dataset remains
servable. An Enterprise API adapter needs its own reviewed completeness contract;
weekly deltas and pre-2008 backfill are outside this implementation.

## State and publication

Migration **0027**, after 0026, adds importer control, artifact, run and concrete-index
reference tables, an immutable reservation tag, narrow status functions and guards.
Migration **0028** adds durable pending acquisition and last-fetched state, append-only
acceptance/recovery attestations, exact successful-publication identity, pre-artifact
acknowledgement and audited baseline recovery. It replaces the relevant functions
without changing the applied 0027 file.
Use the migrator for migration, the ingestion role for the worker, and the app role
only for the trimmed status projection. Do not reapply or edit an applied migration.

Every logical artifact is identified by environment, pinned ZIP and canonical
projected-source digest. Row order and extraction timestamps do not change the
digest; duplicate multiplicity, all nine allowlisted tables, raw provenance and
dictionary meanings do. Repackaging pending content reuses the original artifact,
cap and attempt allowance. Dev acceptance cannot advance live acceptance. The fetched
ZIP, observation, originating run and processing state are saved before extraction,
separately from accepted content. Pending work and all unresolved reviews are checked
before the metadata shortcut or another acquisition. A newer listing while a review
is unresolved is recorded only as a pending observation. Repackaging acceptance keeps
the canonical artifact identity and separately records the fetched ZIP as accepted.

The worker checks the unchanged normalizer and generic verifier, then frozen
`snapshot-monthly.v1` comparisons. Events and US cases cannot fall or grow more than
3%; a disappearing identity, reassociation or US-membership loss requires a named review. At most 5% of
existing cases may change. Eligible counts are bounded by −0.5%/+5%, losses by
0.5%, and eligible share by two percentage points. Narrative sections and characters
are bounded by −2%/+10%. Per-source narrative loss, raw future/backwards dates,
changed codes/dictionaries and new quarantine are checked independently of totals.
At most ten new reviewed foreign-coordinate anomalies are allowed; a new US or
critical anomaly is never absorbed into an old count. An exception cannot waive
integrity, mapping, quarantine, money, servability or fencing. Changed content with
no advancing advertised date requires `source_reissued` review; an advertisement gap
over 62 days requires `baseline_required` review. Both are checked during the actual
run, including the weekly unconditional refresh.

The consumed-code inventory in `worker/importer/codes.ts` is explicit:

| Projected table | Consumed code/flag columns |
| --- | --- |
| `events` | `ev_type`, `ev_dow`, `ev_tmzn`, `ev_state`, `ev_country`, `light_cond`, `sky_cond_nonceil`, `sky_cond_ceil`, `wind_dir_ind`, `wind_vel_ind`, `gust_ind`, `wx_int_precip`, `wx_cond_basic`, `ev_highest_injury` |
| `aircraft` | `acft_category`, `far_part`, `type_fly`, `damage`, `homebuilt`, `afm_hrs_since` |
| `engines` | `eng_type`, `carb_fuel_injection` |
| `findings` | `finding_code`, `category_no`, `subcategory_no`, `section_no`, `subsection_no`, `modifier_no`, `cause_factor`, `cm_inpc` |
| `events_sequence` | `phase_no`, `eventsoe_no`, `occurrence_code`, `defining_ev` |
| `ntsb_admin` | `rec_stat` |

A newly observed semantic value requires `codes` review even in one row with an
unchanged dictionary. Both dictionaries are compared in full separately. Numeric
measurements, dates, identities and free text remain in the full provenance digest;
they are not code vocabularies. Quarantine attribution joins the complete diagnostic
`ev_id=<full ID>` key, including any commas; unknown or ambiguous identities fail
closed.

The PostgreSQL manifest is the **only serving switch**. Builders keep their existing
independent operational aliases. The importer retains concrete candidates before a
builder releases its protection, and pins the full baseline pair. Certification and
activation use the import fence and the existing lifecycle lock on the publication
connection. The certificate binds archive, content, full baseline (including
microsecond publication time), generation, concrete pair/builds, comparison and
verification reports, probes, worker Git commit and deployed image. A manual
publication, including the same generation with a new pair or timestamp, invalidates
the certificate. An ambiguous COMMIT is reconciled against the authoritative manifest.

Candidate probes reject partial shards, timeouts, capped totals, incomplete pages,
aggregation truncation and bulk-item errors. They check full totals/provenance and
fixed plus changed-case samples, with multi-aircraft/cause variants and non-US and
non-eligible boundaries. Vector probes use an exact cached input; no AI question,
scope, rerank or query-embedding call is made. After activation, actual application
read paths must expose the new coherent revision within five minutes, then pass two
checks ten minutes apart. Live additionally requires the exact dev publication and
same worker/image, with a successful canary no older than 24 hours. This canary checks
availability/contracts, not retrieval quality. Dev and live image pins must be equal;
the observed running dev image must still match its canary and the live pin at
promotion. The dev app must already be running separately at that pinned image. The
importer never starts, updates or stops an application container; missing/stopped or
unreachable apps defer before candidate work where possible.

Canary acceptance, its immutable attestation and the run's exact successful generation
commit in one fenced transaction. A lost acknowledgement or report-file failure
cannot downgrade that success. Later code/image changes use the free re-certification
path, including the full ten-minute canary, rather than waiting for a new NTSB file.

After a possibly committed switch, failure status does not claim that the previous
dataset is still serving. Both pairs stay protected. A network outage does not cause
automatic rollback. The operator can activate the revalidated previous pair once,
conditional on the exact failed publication still being current.

## Money, isolation and recovery

The **$0.50 per logical artifact per environment** cap includes settled, uncertain,
open and expired-outstanding reservations across attempts and month boundaries.
The tag is inserted in the production reservation transaction; there is no separate
cap ledger or accounting compaction. Plan admission includes up to three provider
attempts. Every attempt also reserves under normal monthly/ingestion budgets.
Cache-only mode cannot call a provider and refuses cache misses. At or after
**89 days (2,136 hours on database time)** from the immutable database
first-reservation time, the artifact refuses even a cache-only resume: the one-day
margin precedes the 90-day ledger pruning boundary. Restoring a
database latches the importer separately; global spend reconciliation does not clear
that latch. A restore needs reviewed importer/accounting reconciliation before any
further import, not an automated reset or a new artifact identity.

An artifact gets one automatic attempt plus at most three transient resumptions.
Data, integrity, accounting and contract failures latch; a new run row or a
repackaging does not reset them. The pre-registration gap also has a durable four-try
bound. A short monthly allowance, dev not yet certified, non-200/network source
response or unavailable app is `deferred`, not a data review. Unknown failures are
`failed/interrupted` and use the same bounded retry history; loss of the fence or
session cancels with `lock_lost`. A lost settlement or cache-write acknowledgement
never loses the original reservation tag or creates a fresh allowance.
Session loss prevents further reservation or publication through database checks.
The nonqueuing host lock covers dev, live, manual runs, approvals, rollback and daemon
cleanup. A second maintenance lock must also be held by **AirCase database backup
entry points, scheduled and manual**, in both directions:
a backup blocks an importer and an importer blocks a backup. This mandatory mutex
does not cover Langfuse backups. Runs caught between 04:00 and 05:15 Prague time defer.

The whole host invocation, including dev, live and cleanup, has a three-hour deadline.
The final two minutes are reserved for termination/cleanup. Inherited lock descriptors
and a child deadline survive host-process loss. Docker container names are durably
registered before creation and reconciled before scratch reuse. All MDBTools helpers
and exporters use `--log-driver=none`, no network, a read-only root, no capabilities,
**65534:65534 (`nobody`)** and fixed memory/CPU/process limits. The MDB copy is 0644
inside a 0700 directory owned by the non-root operator. Other host users cannot
traverse that directory, while the file bind mount gives `nobody` access to that
single file. Root host users or groups remain refused. Attached stdout enters only
the bounded private projection pipeline. Killing a Docker CLI alone is not cleanup.

Write-time limits are 200 MiB compressed, 1 GiB expanded MDB, 2 GiB aggregate raw
exports, 1 GiB projected CSV, 5 GiB workspace and 10 GiB managed root, with a 2 GiB
filesystem free-space reserve checked during writes. Private JSON reports are at
most 4 MiB each; all also count against the root bound. Directories are 0700 and
files 0600, except the protected MDB file described above. CSV hashes are checked
again at use; complete artifacts use fsync,
read-back checks and atomic rename. Reuse/deletion never follows symlinks.

These are application bounds and sampled filesystem checks, **not a filesystem
quota**. Installation must measure/protect capacity for archive scratch, retained and
candidate PostgreSQL/ES copies, WAL/temp files and ES merge/build overhead, including
unrelated writers and concurrent Langfuse backup I/O. Optional serialization with
that backup may reduce contention, but cannot substitute for measured headroom.
The worker reports a conservative allocation high-water bound
(`peakBytes`); the release exercise also needs measured filesystem high-water marks.
Protected data takes precedence over deletion targets; insufficient space stops work.

Retention runs after the canary. It keeps active/previous generations, 48-hour
supersession grace, unresolved
import references, and existing private evidence/brief references. Host cleanup only
touches registered owned artifacts; it consults both environments before releasing
shared files through a host-mediated metadata bridge. An environment worker never
loads the other environment's files or opens its database. A latched artifact's ZIP,
extraction and indexes stay protected without an age limit until an audited
resolution; rebaseline releases that protection subject to the active/previous
references and 48-hour grace. Removed owned paths are unregistered. Completed run
history is pruned while retaining last source/success, immutable attestations,
acknowledgements and unresolved evidence. Artifact identity, first-reservation markers and spend
history are never compacted into a new allowance. Private comparison/certification
reports remain bounded by the managed-root cap; review them before removing any
unresolved evidence.

Only fixed step/result/reason enums enter normal journals. The March reminder is
separate fixed literal text. Child stderr and arbitrary stdout are discarded; tracing
is disabled. Admin status receives only the approved dates, digests, counts, money and
enums, never case IDs, narratives, filenames, URLs, credentials or exception text.
One bounded private outage spool per environment is replayed when its database
returns; it cannot make `lastCheck` fresh. Stale/unknown status remains attention-worthy.

## Configuration and operator commands

Use Node 24, pinned pnpm dependencies, the local extraction image and a clean checkout
of the exact reviewed commit. A private 0600 JSON file outside the checkout contains:

```json
{
  "version": "snapshot-importer.v1",
  "root": "/path/to/private/imports",
  "hostLock": "/path/to/private/locks/importer.lock",
  "maintenanceLock": "/path/to/private/locks/maintenance.lock",
  "code": "REPLACE_WITH_FULL_REVIEWED_GIT_SHA",
  "schedule": { "enabled": false, "localTime": "05:30", "timeZone": "Europe/Prague" },
  "installation": null,
  "dev": {
    "envFiles": ["/path/to/private/dev-worker.env"],
    "applicationUrl": "https://dev.example.org/",
    "container": "ai-aviation-dev-app-1",
    "image": "sha256:REPLACE_WITH_IMMUTABLE_DEPLOYED_IMAGE_ID"
  }
}
```

For scheduling both environments, add a `live` block of the same shape. Use the same
approved deployed image in dev and live. Env files must explicitly identify their
`APP_ENV`, ingestion URL, ES URL/write key/prefix, and total/interactive/ingestion
monthly budgets. Set `AVIATION_IMPORTS_ENABLED` consistently with `schedule.enabled`
in both worker and app configuration. The app's next-check projection describes that
configured intent, not a probe of systemd. Time and zone come from
`shared/import-schedule.ts` and match the timer template.

Only allowlisted worker variables are read from the selected environment's files.
The host forwards no database, ES or provider credentials to its environment child.
Direct configuration loading preserves matching nonempty process inputs and refuses
conflicting project settings. The 0600 configuration is opened with `O_NOFOLLOW` and
validated using `fstat` on that same bounded-read handle.
The database must be `aviation_<environment>` with the `aviation_ingest` role switch,
and the index prefix must be `ai-aviation-<environment>`, as in the Compose wrapper.
The provider key is loaded lazily from that environment's files only, after an
admitted nonzero miss plan; a process-global key cannot supply both environments. No auth,
visitor HMAC, Langfuse or infrastructure/admin credentials belong in the worker.
Keep credentials out of command arguments. Examples use shell variables for paths
and public digests only, never for key values.

Seed the verified current corpus with the already pinned ZIP and its recorded listing
advertisement; no new matching expectation profile is generated:

```sh
pnpm importer run --config "$IMPORT_CONFIG" --env dev --no-change --cache-only \
  --seed-archive "$PINNED_ZIP" --sha256 "$PINNED_SHA256" \
  --seed-advertised-at "$PINNED_ADVERTISED_LOCAL_TIME"
pnpm importer run --config "$IMPORT_CONFIG" --env dev --forced-dev --cache-only
```

The first command may extract/verify local material but performs no load, index or
provider call and never claims a remote refresh. A forced dev run uses the same
artifact, creates one new generation and publishes only dev. It cannot repeatedly
create new generations after that logical artifact has already completed. Once
configured and reviewed, run an ordinary cycle or one environment explicitly:

```sh
pnpm importer cycle --config "$IMPORT_CONFIG" --cache-only
pnpm importer run --config "$IMPORT_CONFIG" --env dev
```

`cycle` requires installation evidence and enabled schedule intent. Omit
`--cache-only` only when paid misses are intended; all reservations still use the cap.
For a named comparative exception, write a 0600 approval JSON with the exact `archive`,
`environment`, full `baseline`, `policy`, full worker `code`, comparison `report` hash
and the exact `cases` array and sorted `reasons` from the bounded private comparison
report. Supported source-change reasons include `removals`, `reassociations`,
`us_membership`, `codes`, `source_reissued` and `baseline_required`, alongside the
other named comparative bounds. There is no blanket
force flag. An altered baseline/report/code or an unreviewable reason refuses:

```sh
pnpm importer approve --config "$IMPORT_CONFIG" --env dev \
  --artifact "$ARCHIVE_SHA256" --approval "$APPROVAL_JSON"
pnpm importer run --config "$IMPORT_CONFIG" --env dev --cache-only
pnpm importer rollback --config "$IMPORT_CONFIG" --env dev \
  --artifact "$ARCHIVE_SHA256" --publication-sha256 "$PUBLICATION_IDENTITY_SHA256"
```

The publication identity hash is the canonical digest of the exact `publication`
object saved for the artifact (including microseconds), not the archive hash. Read it
from the private activation report. Rollback does not change operational aliases,
restore a backup, delete spend or delete candidate data still referenced by users.

### Free re-certification and baseline recovery

Re-certify the exact accepted serving pair after a reviewed code/image upgrade:

```sh
pnpm importer recertify --config "$IMPORT_CONFIG" --env dev
```

This makes no provider call, load, new generation, attempt increment or allowance
reset. It verifies projected provenance, the current generic verifier, strict
candidate probes and the full ten-minute application canary; any intervening full
manifest change refuses. Original publication certificates and attestations remain.
Existing integrity/accounting/restore reviews refuse this operation. With live
configured, the ordinary dev cycle takes this path when its certificate is absent,
older than 23 hours, or from another code/image/publication. Live then uses the fresh
exact dev proof; a temporary inability to certify dev defers live.

After a rollback or a reviewed manual publication, adopt the **currently active**
manifest explicitly. A canonical manifest digest is available from the private
publication/rollback report (`digest` in `worker/importer/provenance.ts` hashes sorted
JSON keys, preserving the microsecond timestamp). Rebaseline never selects a
publication itself:

```sh
pnpm importer rebaseline --config "$IMPORT_CONFIG" --env dev \
  --publication-sha256 "$CURRENT_PUBLICATION_SHA256"
# Inspect the bounded private rebaseline report, then repeat with --apply.
pnpm importer rebaseline --config "$IMPORT_CONFIG" --env dev \
  --publication-sha256 "$CURRENT_PUBLICATION_SHA256" --apply
```

Dry-run is the default. Both forms hold the host/import locks and a fresh fence,
check provenance, run generic verification and strict probes, then exercise the same
final guarded adoption transaction; dry-run rolls that adoption back. The current
publication, code, generic report and probe hashes are recorded in an append-only
attestation on apply. A local seed may be supplied with the same three `--seed-*` /
`--sha256` options as `run` if the exact archive is absent; its advertised date is
required and does not count as a remote refresh.

One reviewed abandoned data candidate or pre-registration pending fetch may be
resolved by this operation while keeping its failure reason, attempts, original
certificate and ledger history. The existing validated serving baseline is adopted;
the rejected candidate is never implicitly promoted. A resolved artifact cannot
resume under a new identity. Unknown aliases/publication outcomes, outstanding
extraction/outage spool, multiple unresolved candidates, an active failed publication
that has not been rolled back, and accounting/import-cap/restore reviews refuse.
Manual data repair and restored accounting still need a separate reviewed procedure;
these commands cannot clear those holds.

### Acknowledge a proved pre-artifact setup failure

`acknowledge-preartifact` covers only a finished reviewed setup failure **before any
artifact existed**. It cannot clear an artifact-bound, accounting, restore, uncertain
publication or uncleared extraction/spool outcome. Ambiguous later failures require
a separate reviewed repair. The command proves database absence as well as private
cleanup/container absence, preserves every original run field and appends only the
acknowledgement timestamp and evidence hash through a narrowly granted SQL function.

After reviewing the original run and proving cleanup, prepare a 0600 JSON file under
`<root>/reconciliation/preartifact-<SHA256_OF_EXACT_FILE_BYTES>.json`:

```json
{
  "version": "preartifact-ack.v1",
  "environment": "dev",
  "runId": "REPLACE_WITH_RUN_UUID",
  "runFingerprint": "REPLACE_WITH_ORIGINAL_ROW_FINGERPRINT",
  "cleanupChecked": true
}
```

Compute the original fingerprint with the parameterized query used by
`preartifactFingerprint` in `worker/importer/durable.ts`: SHA-256 of the PostgreSQL
`to_jsonb(import_runs row)` text, excluding `acknowledged_at` and
`acknowledgement_sha256`. Do not copy diagnostic text or credentials into the evidence.
The exact file hash and original fingerprint are rechecked at acknowledgement:

```sh
pnpm importer acknowledge-preartifact --config "$IMPORT_CONFIG" --env dev \
  --run "$RUN_UUID" --evidence-sha256 "$EVIDENCE_SHA256"
# Apply only after reviewing the same proof and dry-run result.
pnpm importer acknowledge-preartifact --config "$IMPORT_CONFIG" --env dev \
  --run "$RUN_UUID" --evidence-sha256 "$EVIDENCE_SHA256" --apply
```

Dry-run is the default. An exact repeat is idempotent; a different evidence hash or
changed failure refuses. Concurrent invocations serialize under the host/import
locks and database row guard. This operation removes only that proved setup failure
from the attention calculation; it neither claims a source check nor a successful
import.

## Installation gate

Do not install as part of implementation testing. Before the controller installs:

1. Merge the reviewed app/worker code, apply migrations in order and regenerate/check
   privileges. Run the local no-change exercise, then the single forced cache-only dev
   publication/canary; record cost, misses, every reservation/settlement, disk and time.
2. Measure the actual backing filesystems and operating headroom above. Verify the
   same maintenance flock really excludes AirCase's own scheduled and manual
   database backups in both directions. Set `AVIATION_MAINTENANCE_LOCK` in every
   dev/live backup and restore environment to the same existing host file as the
   importer's `maintenanceLock`; follow [RUNBOOK — Maintenance lock](RUNBOOK.md#maintenance-lock)
   for file setup and the exclusion proof. Both importer lock parents must be
   directories owned by the invoking user, without group or other write permission
   or a symlink. Keep a separately running pinned dev app available for the canary.
   Put `backupMutexConfirmed: true` and the approved headroom report's SHA-256 in
   `installation`. The worker does not invent that evidence.
3. Fill the placeholders in `ops/importer/aircase-importer.service.in`, including a
   Node-24-capable PATH, app directory, pnpm executable, config and writable private
   directories. Copy the reviewed service and timer to the user systemd unit directory.
   Set consistent enabled intent in the private JSON and app/worker env files.
4. Inspect the rendered units and calendar, then enable:

```sh
systemd-analyze verify "$RENDERED_SERVICE" "$RENDERED_TIMER"
systemd-analyze calendar '*-*-* 05:30:00 Europe/Prague'
systemctl --user daemon-reload
systemctl --user enable --now aircase-importer.timer
systemctl --user start aircase-importer.service
systemctl --user list-timers aircase-importer.timer
journalctl --user -u aircase-importer.service
```

To disable, run `systemctl --user disable --now aircase-importer.timer`, then
`systemctl --user stop aircase-importer.service`. Set configured enabled intent false
and deploy that setting so the admin next-check hint agrees. Inspect durable cleanup
state before any manual run after interruption. Never delete lock files to break a
lock or clear restore/review/accounting state to obtain another allowance.

## Offline validation

The default unit suite makes no network/provider calls. Importer integration tests
use disposable local databases, uniquely named local ES indices, fake/cached vectors
and a networkless synthetic extraction container:

```sh
pnpm exec vitest run --project unit tests/unit/importer*.test.ts tests/unit/extract.test.ts
pnpm exec vitest run -c vitest.importer.config.ts
pnpm db:privileges --check
pnpm typecheck
```

Serialize integration tests with other repository users using the operator's shared
test lock. Never point the disposable test harness at shared dev or live services.
