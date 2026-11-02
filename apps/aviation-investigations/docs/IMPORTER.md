# Automatic NTSB snapshots

The worker checks the NTSB avall listing every day at **05:30 Europe/Prague**. A new
file goes through dev and its site checks, then the identical file goes through live.
Routine updates need no approval, exception file or operator command. The Admin page
is the only alert channel. Scheduling is disabled by default until installation is complete.

## Data and discovery

The fixed HTTPS listing and ZIP endpoints are under `https://data.ntsb.gov/avdata/`.
The worker refuses redirects, ambiguous listing rows, unexpected encoding, changed
metadata during a download and oversized streams. Listing dates have no timezone.
It fetches new advertisements daily, and fetches unchanged advertisements unconditionally
at least every seven days to discover files replaced without a new date. Suppression
never disables discovery. A local seed or listing read does not reset the fetch clock.
The existing retirement cutoff remains **2027-04-05T00:00:00Z**, with a fixed reminder
from **2027-03-01 UTC**. A replacement source requires an adapter with its own completeness
contract. Deltas and pre-2008 backfill are outside this worker.

`snapshot-automatic.v2` makes every source comparison informational: additions,
changes, removals, reassociations, US membership, eligibility, codes, dictionaries,
quarantine and narrative differences, same-date reissues, long gaps and absent history.
New/updated/removed counts appear in Recent runs; detailed differences stay in bounded
private reports. If the old archive is unavailable, canonical PostgreSQL records and
revisions provide the baseline; unavailable raw comparisons remain unknown.

The one comparative refusal is **shrunk**: either normalized total cases or US
answer-eligible cases are less than 90% of the serving data. Exactly 90% passes.
Dev checks against both environments before loading, through the host's metadata bridge.
Each environment checks again under the publication lock immediately before switching.
If live changes after dev finishes and the file is then too small for live, dev can have
the new file while live keeps its previous one; the alert states this. There is no override.

Structural and safety checks remain: bounded extraction, explicit columns, unique keys,
canonical provenance, normalization, generic verification, coherent generation/index
contracts, complete Elasticsearch responses and application checks. They are not
comparison limits. Probes sample the candidate deterministically, including available
multi-aircraft, eligibility and cause boundaries, and check removed IDs are absent.
No particular historical case or phrase has to survive. Vector probes use cached inputs;
they make no AI question or query-embedding call.

## Durable processing and failures

Migration **0029** is forward-only and idempotent. It leaves 0027/0028 intact and keeps
artifact, run, acceptance and financial history. Legacy pending flags and stopped or
abandoned records no longer block processing. Their original money and identity remain.
The first daily cycle after upgrade resumes a waiting file automatically.

Permanent artifact identity separates money from processing: canonical content and
pinned bytes identify the environment's original allowance; repackaging identical content
reuses it. `import_processing` stores builds and recovery phases for new code/image
attempts. New processing never resets reservations, first-reservation time or counters.

A failure that needs a fix suppresses the same **environment + archive digest + code
commit + image digest**. Before bytes exist, source advertisement substitutes for the
archive identity. Daily discovery still runs; identical suppressed work records a waiting
run and retains the original alert. Different bytes, code or image permit a retry.
Successful work resolves its issue; a suppressed check or serving-data re-certification
cannot clear a waiting-file issue.

| Kind | Reasons | Behavior |
| --- | --- | --- |
| Temporary | NTSB/app unavailable, file changed during download, busy/backup window, lost lock, timeout, interrupted worker, monthly budget, cache unavailable | Retry daily, without an attempt limit. |
| Needs a fix | Schema, integrity, verification, mapping, probe/site check, per-file cap, storage, configuration, cleanup, restore/accounting hold, changed listing, retired source, shrunk file, unclassified error | Alert immediately; suppress identical work until new bytes or a release. |
| Unknown switch or failed restoration | Alias state unknown, rollback failed | Keep both datasets protected. Block switches; a release permits reconciliation, never a timed waiver. |

Historical attempt counters remain for accounting and diagnostics. Four interruptions
no longer stop retries. A dead worker is recorded once when the next fenced run recovers it.
Errors are sanitized to fixed categories; raw provider messages never enter normal logs.

## Publication and automatic recovery

PostgreSQL's manifest is the **only serving switch**. Elasticsearch aliases remain
independent operational aliases. Each candidate binds archive/content, baseline, verified
generation, concrete index pair/builds, comparison/probe reports, code and image in a
certificate. Candidate and previous data stay pinned through the switch and recovery.
Baseline changes outside the importer are adopted under the lifecycle lock. They do not
require a separate command. A third-party publication is never blindly overwritten.

Before switching, persist the exact previous pair, candidate and phase. Activation and
its publication identity commit together under the import fence and lifecycle lock.
A lost acknowledgement is reconciled against that record and the actual manifest.
After switching, the app must expose the coherent revision within five minutes, then pass
two checks ten minutes apart. Live requires the exact dev result, code and image, with
a successful dev canary no older than 24 hours. The observed dev app must still match.
The importer never starts or deploys an app.

Any failure after a possible switch and before recorded canary success starts automatic
restoration of the exact previous publication. The restored site's checks must pass
before the status says **restored**. If the worker dies, the next run resumes the recorded
switch or restoration before any new work. A committed switch-back whose site check fails
stays unverified, with the file suppressed as `site_check`; the next daily run repeats
propagation and the restored site checks without a switch hold. Only a failed rollback
commit or ambiguous alias state keeps a durable switch hold and the alert that the site may show mixed data. New code/image
allows recovery to be attempted; uncertainty itself never expires.

Recorded success cannot be downgraded by a later error. A report or cleanup failure after
success is a separate incident, with the import still shown as done. Storage is an
immediate fix; other post-success errors follow the temporary 3/7-day rule. Data is never
rolled back solely for a failure after recorded success.
Cleanup/report incidents clear only after cleanup and the final report write succeed.
The host's final cleanup records its own incidents and clears them itself; a child
worker's successful check cannot clear a recurring host cleanup failure. Ordinary
unchanged checks keep their recorded success if a later report write fails too.

`recertify` proves the currently serving pair for a new code/image even while a candidate
waits. It preserves pending work, money and acquisition clocks and returns `complete` /
`unchanged`. The release command needs no bypass. The next daily cycle handles the waiting
file with the new code. Re-certification includes the full site canary, without provider calls.
Failures in re-certification or preflight are per-run incidents; they never suppress a
waiting file that was not processed. A successful retry resolves that incident, without
clearing an unrelated file failure or changing acquisition dates or monetary identity.

## Money, isolation and retention

The **$2.00 per logical artifact and environment** limit is enforced both in the worker
and in the reservation transaction. Settled, uncertain, open and expired-outstanding
charges across all attempts and months count. Up to three provider attempts are included
in plan admission. Every attempt also passes the configured total and ingestion monthly
budgets; those budgets are unchanged by this task. Cache-only mode cannot call a provider.
At **89 days** from the immutable first reservation, resumption refuses before the
90-day ledger pruning boundary, even with cached vectors. Neither a release nor a new
processing row creates another allowance.

A database restore keeps both the general spending hold and importer accounting
protections. Reconcile actual missing spend and importer provenance before enabling work;
there is no automatic reset, age waiver or routine command that clears these protections.
See [the restore procedure](RUNBOOK.md#paid-operations-after-a-restore).

The nonqueuing host lock covers both environments, emergency commands and cleanup. A
shared maintenance lock excludes every scheduled/manual AirCase backup and restore in
both directions. The 04:00–05:15 Prague backup window defers runs. The host deadline is
three hours with two minutes reserved for termination; inherited locks and child deadlines
survive host loss. Database fencing prevents a lost session from spending or publishing.

MDB helpers are networkless, read-only-root, capability-free containers, UID/GID 65534,
with CPU/memory/process bounds and Docker logging disabled. The one MDB bind mount is
0644 under an owner-only 0700 directory; other users cannot traverse it. Containers are
registered before creation and reconciled before scratch reuse. Killing the CLI alone
is not cleanup.

Bounds: ZIP 200 MiB, expanded MDB 1 GiB, raw export aggregate 2 GiB, projected CSV 1 GiB,
workspace 5 GiB, managed root 10 GiB, filesystem free-space reserve 2 GiB, individual private
JSON reports 4 MiB. Atomic writes use fsync and read-back checks; CSV hashes are checked
at use and symlinks are refused. These checks are not a filesystem quota. Installation
must measure PG/ES/WAL/merge headroom, concurrent writers and backup I/O.

Retention preserves active/previous data, at least 48 hours after supersession, unresolved
processing and private evidence references. File retention consults both environments
through bounded host metadata; a worker never opens the other environment's database or
loads its keys. Completed run history is bounded, but durable issues retain distinct
failure dates beyond the 20 visible runs. Financial identity and original reservation
markers never disappear to create a new allowance. Protected data takes precedence
over disk targets; insufficient space stops work.

## Admin status

The app role can only execute narrow status projections; it cannot read importer tables
or private reports. Status includes dates, counts, costs, fixed enums and typed diagnostic
IDs, not case text, exception messages, paths, URLs or credentials. Admin authorization,
private/no-store responses and client forgetting remain unchanged.

When enabled, a needs-fix cause alerts at once. No run **start** for 36 hours is a fix,
including an installation that has never started (measured from migration/monitoring start).
Overdue takes priority over an existing file issue or hold, while that earlier cause stays
in Waiting and details. The delayed Since date is the earliest unresolved temporary
failure, not the latest run.
Temporary failures on **three distinct dates in the schedule zone** give a delayed alert;
**seven dates** give a fix. Several failures on one day count once. Monthly-budget failure
uses the same rule and says the import continues on the first of next month. A good check
clears resolved temporary failures; candidate failures remain until dealt with.

Off means **Off**, “Automatic import is turned off.”, and no alert. While enabled,
unreadable status, restore trouble and uncertain switches fail closed to a fix alert.
Live skips include dev's actual reason and originating run. The newest finished check and
last good check are separate. Serving metadata comes from the actual manifest, not the
last successful run in the recent window. A process outage is replayed from a bounded
private spool; it does not invent a successful check. An unreadable status shows unknown
facts rather than claiming history is missing; its Since date is unknown too. Normal
pending alias switches and declared-abandoned attempts do not create a mixed-data alert.
An unresolved unknown outcome or a durable switch hold does. Recent runs show the file’s
total cost only on published rows, never as a new charge on every waiting check.

## Configuration and commands

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

An initial local seed can prove the existing dataset without downloading or paying:

```sh
pnpm importer run --config "$IMPORT_CONFIG" --env dev --no-change --cache-only \
  --seed-archive "$PINNED_ZIP" --sha256 "$PINNED_SHA256" \
  --seed-advertised-at "$PINNED_ADVERTISED_LOCAL_TIME"
pnpm importer run --config "$IMPORT_CONFIG" --env dev --forced-dev --cache-only
```

A forced dev exercise uses the original artifact allowance. Repeating it reuses the
original artifact and generation, increments the attempt count and records another
successful exercise; it does not create a new financial allowance or reset history. Normal scheduled operation
is `pnpm importer cycle --config "$IMPORT_CONFIG"`; a single environment can be run with
`pnpm importer run --config "$IMPORT_CONFIG" --env dev`. `cycle` requires enabled intent
and installation evidence. Paid misses remain subject to all budgets; `--cache-only`
requires all vectors already cached.

A release uses `pnpm importer recertify --config "$IMPORT_CONFIG" --env dev` after deploying
its pinned apps. It remains valid with pending work. The emergency-only rollback command
is documented in [RUNBOOK](RUNBOOK.md#automatic-import-alerts-and-emergency-rollback).
Routine processing needs none of these manual commands.

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
lock or clear restore/accounting state to obtain another allowance.

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
