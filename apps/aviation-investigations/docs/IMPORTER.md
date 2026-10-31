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
Use the migrator for migration, the ingestion role for the worker, and the app role
only for the trimmed status projection. Do not reapply or edit an applied migration.

Every logical artifact is identified by environment, pinned ZIP and canonical
projected-source digest. Row order and extraction timestamps do not change the
digest; duplicate multiplicity, all nine allowlisted tables, raw provenance and
dictionary meanings do. Repackaging pending content reuses the original artifact,
cap and attempt allowance. Dev acceptance cannot advance live acceptance.

The worker checks the unchanged normalizer and generic verifier, then frozen
`snapshot-monthly.v1` comparisons. Events and US cases cannot fall or grow more than
3%; no old identity, association or US membership may disappear. At most 5% of
existing cases may change. Eligible counts are bounded by −0.5%/+5%, losses by
0.5%, and eligible share by two percentage points. Narrative sections and characters
are bounded by −2%/+10%. Per-source narrative loss, raw future/backwards dates,
changed codes/dictionaries and new quarantine are checked independently of totals.
At most ten new reviewed foreign-coordinate anomalies are allowed; a new US or
critical anomaly is never absorbed into an old count. An exception cannot waive
integrity, mapping, quarantine, money, servability or fencing.

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
availability/contracts, not retrieval quality.

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
Cache-only mode cannot call a provider and refuses cache misses. At or after 90 days
from the immutable database first-reservation time, the artifact refuses even a
cache-only resume: retained history can no longer prove its allowance. Restoring a
database latches the importer separately; global spend reconciliation does not clear
that latch. A restore needs reviewed importer/accounting reconciliation before any
further import, not an automated reset or a new artifact identity.

An artifact gets one automatic attempt plus at most three transient resumptions.
Data/review failures latch; a new run row or a repackaging does not reset them.
Session loss prevents further reservation or publication through database checks.
The nonqueuing host lock covers dev, live, manual runs, approvals, rollback and daemon
cleanup. A second maintenance lock must also be held by **both scheduled and manual
backup entry points**. Runs caught between 04:00 and 05:15 Prague time defer.

The whole host invocation, including dev, live and cleanup, has a three-hour deadline.
The final two minutes are reserved for termination/cleanup. Inherited lock descriptors
and a child deadline survive host-process loss. Docker container names are durably
registered before creation and reconciled before scratch reuse. All MDBTools helpers
and exporters use `--log-driver=none`, no network, a read-only root, no capabilities,
an unprivileged UID and fixed memory/CPU/process limits. Attached stdout enters only
the bounded private projection pipeline. Killing a Docker CLI alone is not cleanup.

Write-time limits are 200 MiB compressed, 1 GiB expanded MDB, 2 GiB aggregate raw
exports, 1 GiB projected CSV, 5 GiB workspace and 10 GiB managed root, with a 2 GiB
filesystem free-space reserve checked during writes. Private JSON reports are at
most 4 MiB each; all also count against the root bound. Directories are 0700 and
files 0600. CSV hashes are checked again at use; complete artifacts use fsync,
read-back checks and atomic rename. Reuse/deletion never follows symlinks.

These are application bounds and sampled filesystem checks, **not a filesystem
quota**. Installation must measure/protect capacity for archive scratch, retained and
candidate PostgreSQL/ES copies, WAL/temp files and ES merge/build overhead, including
unrelated writers. The worker reports a conservative allocation high-water bound
(`peakBytes`); the release exercise also needs measured filesystem high-water marks.
Protected data takes precedence over deletion targets; insufficient space stops work.

Retention keeps active/previous generations, 48-hour supersession grace, unresolved
import references, and existing private evidence/brief references. Host cleanup only
touches registered owned artifacts; it consults both environments before releasing
shared files. Completed run history is bounded while retaining last source/success
and unresolved evidence. Artifact identity, first-reservation markers and spend
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

Only allowlisted worker variables are read; existing nonempty process values win.
Conflicting process/database/ES project settings refuse rather than mix environments.
The database must be `aviation_<environment>` with the `aviation_ingest` role switch,
and the index prefix must be `ai-aviation-<environment>`, as in the Compose wrapper.
The provider key is loaded lazily, only for an admitted nonzero miss plan. No auth,
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
and sorted `reasons` from the bounded private comparison report. There is no blanket
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

## Installation gate

Do not install as part of implementation testing. Before the controller installs:

1. Merge the reviewed app/worker code, apply migrations in order and regenerate/check
   privileges. Run the local no-change exercise, then the single forced cache-only dev
   publication/canary; record cost, misses, every reservation/settlement, disk and time.
2. Measure the actual backing filesystems and operating headroom above. Verify the
   same maintenance flock really excludes both scheduled and manual backups in both
   directions. Put `backupMutexConfirmed: true` and the approved headroom report's
   SHA-256 in `installation`. The worker does not invent that evidence.
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
