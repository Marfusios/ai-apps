# AirCase runbook: containers and deployment

How the application runs under Docker Compose, which container holds which
credential, and the commands for each environment. Design background:
[DESIGN.md §11](DESIGN.md#11-deployment-and-trust-boundaries).

There are two modes:

- **Shared-infrastructure mode (default).** `compose.yaml` runs the application
  containers once per environment, as Compose projects `ai-aviation-dev` and
  `ai-aviation-live`. They connect to PostgreSQL, Elasticsearch and Langfuse that
  already run on the host as shared services, through those stacks' Docker
  networks. This project runs no database or search engine of its own.
- **Local-services mode.** `compose.local-services.yaml` (project
  `ai-aviation-local`) runs a pinned PostgreSQL and Elasticsearch for contributors
  without the shared stack and for the offline integration tests. See
  [Local-services mode](#local-services-mode).

Names and addresses of the shared services are machine-specific. They live only
in the env files described below, which are kept outside the repository.

Requirements: Docker Engine with Docker Compose 2.24 or later (`compose.tunnel.yaml`
uses `!reset`; the wrappers check the version), Node 24 and pnpm for the wrappers.
With `AVIATION_MAINTENANCE_LOCK` set, also install `flock` from util-linux; unlocked
invocations do not need it. The offline flock-dependent tests skip when it is absent.

## Enabling the evidence view

Only enable after the independent evidence-view review, scope preflight and UI gates
clear. Software tests do not establish scope-filter quality or excerpt context safety.
Generated summaries remain gated; keep **`AI_BRIEFS_ENABLED=false`** and
**`AI_PARTIAL_DISPLAY=false`** in both environments.

1. Migrate with the environment's migrator role (including `0022_evidence_searches`,
   `0023_evidence_storage_bound` and `0024_evidence_query`).
   Verify the privilege baseline and backup exclusions. The app role owns no schema
   objects; the ingest role cannot read evidence searches.
2. Publish a verified generation with compatible cases and passages indices. Evidence
   uses `retrieval.v2`; private saved pages retain that generation and both index names.
3. Supply only the backend's `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, identity/network
   HMAC secrets, and the environment's Turnstile pair (real keys and HTTPS in `live`).
   Existing Google settings enable signed-in ownership. Do not expose provider or
   Langfuse credentials through public runtime config.
4. Confirm the configured budgets and limits in `.env.example`: at most $3/day,
   $80 interactive/month, $20 indexing+evaluation/month, $100 total/month; 25% of the
   paced daily allowance for anonymous users. Limits are 10/trial/day, 50/account/day,
   20/day in an account's first 3 days, 600/account/month. Daily resets are 00:00 UTC.
   The old name `AI_ANONYMOUS_TRIAL_REQUESTS` now denotes the daily allowance.
5. Run `pnpm worker ai-preflight` (free counts only, no generation), including `scope.e3` and every rerank model/depth.
   Require no OVER rows. Evidence has separate 10,000/2,500 input/output caps; measured
   5,701 fixed / 5,674 cached input, 6,192 Latin / 7,190 dense input and 1,118 output.
   Check the derived reservation: $0.0024325 worst case → $0.0025 reserved.
   Keep evidence.v3 and the evaluated scope.e3 prompt/schema/model/settings frozen.
   The gate accepted recorded confirmation for fixed capability notes instead of blocking
   policy replies; no new paid suggestion threshold is required. This is not a pass of
   the earlier scope quality gate. Require the final server, excerpt/UI, security, budget
   and lifecycle gates before public launch. Scope intents never block search: only
   validated out_of_scope/operational_advice select the fixed scope/operational_advice
   notes. All other outputs, failures, edits and skipped scope have no note. Render
   EVIDENCE_NOTE_TEXT, keep the research boundary and EVIDENCE_NOTICE unconditional,
   and never treat no note as assurance. With the default automatic policy (`none`),
   suggestions remain unapplied; the opt-in state policy below applies only guarded
   state and discloses it. Filter-only edits
   retain both executed parent query texts. Server-owned statistics hints carry no filters; comparison
   hints name only the matched IDs. All successful searches return 201 results.
   At the daily uncertain-charge limit, evidence searches skip scope and any reranker
   (`skipped_uncertain_allowance`) while retaining the full reservation, embedding
   accounting and other limits; they are not refused
   solely for that limit. Generated summaries keep their old refusal rule.
   Restart with the new environment settings, then use `pnpm worker ai-switch --on`
   only after clearance. A restore hold still blocks payment until reconciliation.
6. Check `/api/config.aiLimits` and `/api/ai/status`, the default-off brief POST/refine
   gate (404), and metadata-only traces. The web client states only the limits these two
   report (Ask AI, the counter, the first check, the welcome), and its Ask AI starts an
   evidence search, never a brief. Start any authorized paid smoke test with one
   request inside the existing ledger; do not bypass admission for a demonstration.

`pnpm worker ai-switch --off` immediately refuses new paid evidence searches; saved
pages and canonical context remain readable by their owner until their 24-hour expiry.
New searches use the current publication; republishing never reranks existing pages.
Do not delete indices or generations manually: cleanup and pruning honor saved search
references. Migration 0022 extends those existing brief-reference functions. Migration 0024 freezes
the executed query and filters. Pre-v2 searches return 404 and cannot be edited; their
rows and generation/index protections remain until the original 24-hour expiry.

`evidence_searches` is excluded from every backup and checked empty after restore,
like briefs and sign-in state. Maintenance deletes expired searches and marks orphaned
ones failed after closing their leases. Normal failures settle known provider usage
and return the quota unit. A process/storage outage retains the full reservation until
lease recovery charges it conservatively and returns the search unit; never subtract
unknown provider spend from budgets. Account deletion removes searches and their replay
records; it keeps only the already documented content-free accounting/anti-abuse rows.

## Environments

| | dev | live |
| --- | --- | --- |
| Compose project | `ai-aviation-dev` | `ai-aviation-live` |
| `APP_ENV` | `dev` | `live` |
| PostgreSQL database | `aviation_dev` | `aviation_live` |
| PostgreSQL logins | `aviation_dev_{app,ingest,migrator}` | `aviation_live_{app,ingest,migrator}` |
| Elasticsearch indices (`ELASTICSEARCH_INDEX_PREFIX`) | `ai-aviation-dev-*` | `ai-aviation-live-*` |
| Elasticsearch roles and API keys | `aviation_dev_reader`/`_writer` | `aviation_live_reader`/`_writer` |
| Langfuse project (default) | `aviation-dev` | `aviation-live` |
| App ingress | loopback port (`127.0.0.1:${PORT:-3000}`) | Cloudflare Tunnel, no published port |

Both projects can run at once: every container, the `edge` and `egress` networks
and the verification reports (`data/reports/<env>`) are per environment. Give
`live` its own image tag (`APP_VERSION`), so rebuilding `dev` never changes the
image `live` starts.

The index prefix starts with `ai-` because the shared cluster applies its `ai-*`
index template to those indices; `compose.yaml` defaults it to
`ai-aviation-<APP_ENV>` and the wrappers refuse any other value.

## Role model

PostgreSQL roles are cluster-wide, and the shared cluster also holds other
applications' databases. The model keeps every environment inside its own
database:

- **Group roles** `aviation_migrator`, `aviation_ingest` and `aviation_app` are
  `NOLOGIN` and shared by all environments. The migrations grant to them, and
  `aviation_migrator` owns every schema object. They hold no privilege on any
  database.
- **Login roles** `aviation_<env>_migrator`, `aviation_<env>_ingest` and
  `aviation_<env>_app` are `NOINHERIT` members of their group role, with
  generated passwords (sent to the server as SCRAM verifiers, never in clear).
- **Owner role** `aviation_<env>_owner` (`NOLOGIN`, no members) owns database
  `aviation_<env>` and its schema `public`. Only the owner (and the cluster
  administrator) can grant on the database, and nobody can act as the owner.
- **Database privileges.** `CONNECT` is revoked from `PUBLIC` and granted only to
  the environment's three logins, without grant option; nobody else holds any
  privilege on the database. A `dev` login therefore cannot connect to
  `aviation_live`, and a `dev` migrator login acting as `aviation_migrator` cannot
  grant itself access (PostgreSQL answers `permission denied`; the integration
  tests reproduce this attack). Other applications' databases are closed to the
  aviation logins only if they, too, revoke `CONNECT` from `PUBLIC`; `postgres` and
  `template1` keep it by default, so the logins can connect there (they hold no
  other privilege). Provisioning does not change other databases. The owner of
  the shared stack can close that gap in `pg_hba.conf`, for example (PostgreSQL 16
  accepts regular expressions; the lines go before the general rules):

  ```
  host  aviation_dev   aviation_dev_app,aviation_dev_ingest,aviation_dev_migrator     samenet  scram-sha-256
  host  aviation_live  aviation_live_app,aviation_live_ingest,aviation_live_migrator  samenet  scram-sha-256
  host  all            /^aviation_                                                    all      reject
  ```

- **Inside the database**, `aviation_migrator` gets `USAGE` and `CREATE` on schema
  `public` and owns schema `drizzle` (the migration journal), which provisioning
  creates. `aviation_ingest` and `aviation_app` get `USAGE` on `public` and, by
  default privileges, `SELECT` on the migrator's new tables and sequences; the
  migrations grant the rest. The migration runner (`server/db/migrate.ts`) is
  drizzle's, minus its `CREATE SCHEMA IF NOT EXISTS drizzle`, which PostgreSQL
  would check against database-level `CREATE`.
- **Acting as the group role.** Every connection URL ends in
  `?options=-c%20role%3D<group role>` (for example `aviation_app`). The server
  switches the session to the group role at connection start, so `current_user`
  is the group role for the pool, the worker, the migrator and the tests alike,
  and `RESET ROLE` returns to it. A login without the option holds no privileges
  (it is `NOINHERIT`). The migration runner refuses to run unless `current_user`
  is `aviation_migrator`, so objects are always owned by the group role. Both
  node-postgres and `psql` read the option from the URL; a connection pooler in
  transaction mode would not keep it.
- **Connection timeouts.** Opening a PostgreSQL connection, or waiting for a free
  pooled one, fails after 5 s in the API, the tools and the migration runner, and
  after 120 s in the worker (`server/db/client.ts`). A database that accepts
  connections but never answers therefore shows up as failing requests within seconds
  (a brief step's cases index lookup ends at its own 2 s bound, `cases_index_lookup`),
  the API still shuts down within its grace, and a worker command fails after two
  minutes instead of hanging.

Elasticsearch has one role pair per environment: `aviation_<env>_reader`
(`read`, `view_index_metadata`) and `aviation_<env>_writer` (`create_index`,
`write`, `manage`, `read`), both on `ai-aviation-<env>-*` and with no cluster
privilege, so neither key can list other tenants' indices, read the cluster state
or see running tasks (the integration tests check `403` on `_cluster/state`,
`_tasks` and `_cat/indices`). Their API keys are `aviation-<env>-read` and
`aviation-<env>-write`; each records a hash of its role definition, and
provisioning re-mints a key whose definition has changed.

## Provisioning

`pnpm provision:shared` (`scripts/provision-shared.ts`) creates or updates one
environment on the shared servers and writes its connection files. It is
idempotent and runs from the host with administrative access, which it reads
only from two explicit files:

- `--pg-admin-env <file>`: `PG_ADMIN_URL`, which must connect as a superuser (it
  changes database owners, resets privileges held by other roles and sets default
  privileges for `aviation_migrator`); the script stops before changing anything
  otherwise.
- `--es-admin-env <file>`: `ELASTIC_PASSWORD` (user `elastic`) and
  `ELASTICSEARCH_ADMIN_URL`.

Only these names are read from the files; no value is printed or written to the
output. Either side may be provisioned alone.

```sh
pnpm provision:shared --env dev --out <private dir outside the repo> \
  --pg-admin-env <file> --pg-docker-host <postgres host:port on its network> \
  --pg-network <postgres network> [--pg-host-url postgres://<host>:<port>] \
  --es-admin-env <file> --es-docker-url <https://es host:port on its network> \
  --es-network <es network> --es-ca-file <cluster CA> [--es-host-url <url>] \
  [--rotate] [--dry-run]
```

It creates the group roles if absent, creates or updates the three logins
(keeping their passwords unless `--rotate`), creates the owner role and removes
any membership in it, creates `aviation_<env>` owned by that role (or changes the
owner of an existing database), resets the database privileges to the `CONNECT`
rules above, and sets the schema owners, grants and default privileges. In Elasticsearch it puts the two roles and
mints their API keys, keeping a key that still authenticates unless `--rotate`
(re-minting invalidates the old key). `--dry-run` connects, reports what it would
do and changes nothing.

It writes, with mode 0600 in 0700 directories, and refuses any `--out` inside the
repository:

| File | Contents |
| --- | --- |
| `postgres/aviation-<env>.env` | `APP_ENV`, `DATABASE_URL`, `DATABASE_INGEST_URL`, `DATABASE_MIGRATOR_URL` for host-side use (`--pg-host-url`, default the admin URL's host) |
| `postgres/aviation-<env>.docker.env` | the same URLs with `--pg-docker-host`, and `SHARED_POSTGRES_NETWORK` |
| `elasticsearch/aviation-<env>.env` | `APP_ENV`, `ELASTICSEARCH_URL` (`--es-host-url`, default the admin URL), both API keys, `ELASTICSEARCH_CA_FILE`, `ELASTICSEARCH_INDEX_PREFIX` |
| `elasticsearch/aviation-<env>.docker.env` | the same with `--es-docker-url`, and `SHARED_ELASTICSEARCH_NETWORK` |

Passwords and keys are reused from these files on the next run, so keep them.
Then run `pnpm app:migrate` for the environment. Langfuse projects
(`aviation-dev`, `aviation-live`) and their keys are created in Langfuse itself.

### Rotating credentials

`--rotate` replaces the three login passwords at once (`ALTER ROLE ... PASSWORD`) and
invalidates both Elasticsearch API keys before minting new ones. There is no overlap
period: from that moment the running app's new database connections fail
(`28P01`) and its searches answer 401, and a running `pnpm ingest`, backup or
evaluation fails. Rotate in a quiet moment:

1. Make sure no ingestion, index build, evaluation or backup is running.
2. `pnpm provision:shared ... --rotate` (both admin files for both sides, or one side
   alone). It writes the new values into the connection files.
3. At once, `pnpm app:up`: Compose recreates the app container because its environment
   changed (on `live` from the same image; nothing is rebuilt). Expect errors and a
   failing health check for the seconds in between.
4. Check `GET /api/health` and one search; the next ingestion and backup read the new
   files.

The application secrets live in the settings file; change one there, then
`pnpm app:up`:

- `BETTER_AUTH_SECRET`: signs everyone out and fails sign-ins in flight
  ([Google sign-in](#google-sign-in)).
- `IDENTITY_HMAC_SECRET`: ends every trial cookie and detaches every account from its
  usage counts and anti-abuse record (they are keyed by it); only after a leak.
- `IP_HMAC_SECRET`: network identities start over, so per-network rate limits reset.
- `TUNNEL_TOKEN`: rotate it in Cloudflare Zero Trust first; the connector restarts with
  the new token ([Tunnel mode](#tunnel-mode)).
- Provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), the Google OAuth client secret
  and the Turnstile secret: create the new one at the provider, deploy it, then revoke
  the old one, so nothing fails in between.
- Langfuse keys: in Langfuse, then in the Langfuse connection file.

## Containers

| Service | Profile | Label `ai-apps.component` | Purpose |
| --- | --- | --- | --- |
| `aviation-app` | `app` | `app` | Fastify API and the built web client on one origin |
| `aviation-ingest` | `tools` | `ingest` | Worker CLI, one-shot (`run --rm`) |
| `aviation-migrate` | `tools` | `migrate` | Schema migrations, one-shot |
| `aviation-backup`, `aviation-restore` | `tools` | `backup`, `restore` | `pg_dump` and `pg_restore` (PostgreSQL 16 client tools), one-shot ([Backups](#backups)) |
| `extract-image` | `tools` | `extract` | Builds the extraction image; never runs a service |
| `extract` (one-offs) | none | `extract` | Sandboxed `mdb-export` containers the host worker starts |
| `tunnel` | `tunnel` | `tunnel` | Cloudflare Tunnel connector |

Every container carries the labels `ai-apps.app=aviation-investigations` and
`ai-apps.component`, and the per-environment ones also `ai-apps.environment`.

### What each container receives

Containers get only the variables listed under their `environment` in
`compose.yaml`; no service uses `env_file`, so unrelated keys in an env file never
reach a container.

| Container | Database | Elasticsearch | Other credentials | Mounts |
| --- | --- | --- | --- | --- |
| `aviation-app` | `DATABASE_URL` (as `aviation_app`) | `ELASTICSEARCH_READ_API_KEY` | Anthropic and OpenAI keys, `BETTER_AUTH_SECRET`, Google OAuth client, Turnstile keys, `IP_HMAC_SECRET`, `IDENTITY_HMAC_SECRET`; budgets and limits | CA file (read-only) |
| `aviation-ingest` | `DATABASE_INGEST_URL` (as `aviation_ingest`) | `ELASTICSEARCH_WRITE_API_KEY` | OpenAI key and embedding settings; the total and ingestion budgets | `data/` read-only, `data/reports/<env>` writable, CA file (read-only) |
| `aviation-migrate` | `DATABASE_MIGRATOR_URL` (as `aviation_migrator`) | none | none | none |
| `aviation-backup`, `aviation-restore` | `DATABASE_MIGRATOR_URL` (as `aviation_migrator`) | none | none | `AVIATION_BACKUP_DIR` (read-only for the restore), the scripts in `docker/postgres` (read-only) |
| `extract` | none | none | none | the MDB file read-only; no network |
| `tunnel` | none | none | `TUNNEL_TOKEN` | none |

With tracing on (see [Tracing](#tracing)), `aviation-app` and `aviation-ingest` also get
`LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`.

The CA file (`ELASTICSEARCH_CA_FILE`, a host path) is mounted read-only into containers
that run as uid 1000 (`aviation-app`) and as the host user (`aviation-ingest`), not as
its owner: make it world-readable (`chmod 644`; it is a public certificate). A root-only
file makes them fail at start with `EACCES`.

### Hardening

- The application image runs as uid 1000 (`node`); `aviation-ingest` runs as the host user
  that owns `data/` (`pnpm ingest` sets `AVIATION_UID`/`AVIATION_GID`; the
  extraction outputs are mode 0600), and the backup containers as the host user that owns
  `AVIATION_BACKUP_DIR`. Extraction containers run as uid 65534.
- Read-only root filesystem with a 64 MB `/tmp` tmpfs, all Linux capabilities
  dropped, `no-new-privileges`, and memory/CPU limits (app 1 GB, ingest 2 GB).
- No Docker socket, no home-directory mounts. The only host paths mounted are
  the app's `data/` directory (ingest) and the Elasticsearch CA file.
- Logs use the `json-file` driver, 10 MB × 3 files per container. Long-running
  services restart `unless-stopped`; one-shot tools never restart. `aviation-app` gets
  15 s to stop (`stop_grace_period`), more than its own 10 s forced exit.
- Images built here use `pull_policy: never`: `ai-aviation/*` names are never
  fetched from a registry.

## Networks

| Network | Members | Notes |
| --- | --- | --- |
| `edge` | `aviation-app`, `tunnel` | Per project. App ingress and the outbound route to Cloudflare and the model, embedding, OAuth and Turnstile APIs. Nothing else joins it. Pinned to `EDGE_SUBNET` in tunnel mode. |
| `egress` | `aviation-ingest` | Per project. Outbound route for the embeddings API. |
| `postgres` | `aviation-app`, `aviation-ingest`, `aviation-migrate`, `aviation-backup`, `aviation-restore` | External, `SHARED_POSTGRES_NETWORK`. |
| `elasticsearch` | `aviation-app`, `aviation-ingest` | External, `SHARED_ELASTICSEARCH_NETWORK`. |
| `observability` | `aviation-app`, `aviation-ingest` | External, `SHARED_OBSERVABILITY_NETWORK`; only with `compose.tracing.yaml`. |

The two shared-service networks may be the same Docker network. Docker registers
each container under its service name on every network it joins, which is why
the services are named `aviation-app`, `aviation-ingest` and `aviation-migrate`
rather than generic names that other stacks on the shared networks might use.
`dev` and `live` register the same names there; nothing addresses them over the
shared networks. The tunnel resolves `aviation-app` only on its own project's `edge`.

The app is still reachable on the shared networks: any container there can open
`aviation-app:3000` without passing through the tunnel. In tunnel mode the edge
network is pinned to `EDGE_SUBNET` and the app receives it as
`TRUSTED_PROXY_CIDRS`: only peers in that subnet (the connector) are trusted, so
their `CF-Connecting-IP` is the client address, and the API server rejects
requests from every other peer. Pick an unused private (RFC 1918) /28 per
environment, outside Docker's default address pools (`default-address-pools`) so
Docker never hands it to another network while the project is down; Docker
refuses overlapping subnets. Changing it needs
`pnpm app:down` first, because Docker keeps an existing network's subnet.

## Env files

Compose reads env files for interpolation only. Pass them through
`AVIATION_ENV_FILES`: comma-separated, highest priority first. Nonempty variables
exported in the shell win over the files, as in Compose itself, so unset
host-side values such as `DATABASE_URL` before running the wrappers. (Compose lets a
variable exported empty win too; the wrappers drop empty values of the names they check,
so the containers get the values that were checked.) The variable names are documented
in `.env.example`.

An environment combines the generated connection files with the Langfuse
connection file and a private file of application settings, all outside the
repository. For containers use the `.docker.env` variants:

```sh
export AVIATION_ENV_FILES=<conn>/postgres/aviation-dev.docker.env,\
<conn>/elasticsearch/aviation-dev.docker.env,\
<langfuse connection file for aviation-dev>,\
<private aviation-dev settings file>
```

Each name should come from one file; when two files set it, the first listed
wins. Host-side tools (`pnpm worker`, `pnpm db:migrate`) use the host variants
(`aviation-dev.env`) instead, where the server publishes a host port.

The generated files supply `APP_ENV`, the three `DATABASE_*` URLs,
`SHARED_POSTGRES_NETWORK`, `ELASTICSEARCH_URL`, both API keys,
`ELASTICSEARCH_CA_FILE`, `ELASTICSEARCH_INDEX_PREFIX` and
`SHARED_ELASTICSEARCH_NETWORK`. The Langfuse file supplies `LANGFUSE_BASE_URL`,
`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and, if it names it,
`SHARED_OBSERVABILITY_NETWORK`. The settings file holds the rest:

```sh
APP_VERSION=                     # image tag; live needs an explicit release tag (not dev)
APP_URL=                         # public origin on live: https://aircase.app (https: Turnstile hostname, Secure trial cookie)
PORT=3000                        # dev only: loopback port of the app
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
BETTER_AUTH_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
TURNSTILE_SECRET_KEY=            # a widget for APP_URL's hostname (aircase.app on live); dev may use Cloudflare's test keys, live refuses them
TURNSTILE_SITE_KEY=
IP_HMAC_SECRET=
IDENTITY_HMAC_SECRET=            # rotating it ends every trial cookie
AVIATION_TRACING_ENABLED=false   # true adds compose.tracing.yaml
AVIATION_RETRIEVAL_VERSION=      # empty: retrieval.v2; retrieval.v1 rolls retrieval back (Retrieval version)
SHARED_OBSERVABILITY_NETWORK=    # unless the Langfuse file sets it
TUNNEL_TOKEN=                    # required on live; on dev it switches to tunnel mode
EDGE_SUBNET=                     # tunnel mode: a private /28, distinct per environment
```

Hosts in the `.docker.env` URLs are the shared services' names on their Docker
networks, not host loopback addresses. Budget and model variables from
`.env.example` may be added; unset ones keep the application defaults.

`docker compose config` prints every resolved value, secrets included. Use
`docker compose config --quiet` to validate, or `--no-interpolate` to share output.

## Commands

The pnpm wrappers (`scripts/compose.ts`) choose the project from `APP_ENV`, pass
the env files, add `compose.tracing.yaml` when `AVIATION_TRACING_ENABLED` is true, and
`compose.dev-release.yaml` for a pinned dev release. They print no secrets, and they
refuse to run when:

- Docker Compose is older than 2.24;
- `APP_ENV` is not `dev` or `live`, the env files disagree on it, or the shell's
  `APP_ENV` differs from the files';
- a variable the command needs is missing;
- the command's database URL (`DATABASE_URL` for `app:up`, `DATABASE_INGEST_URL`
  for `ingest`, `DATABASE_MIGRATOR_URL` for `app:migrate`, `app:backup` and
  `app:restore`) does not name `aviation_<APP_ENV>` or lacks the
  `options=-c role=<group>` switch;
- for `app:backup` and `app:restore`: `AVIATION_BACKUP_DIR` is missing, not a directory or
  inside the repository, or the restore does not name one `.dump` file in it;
- when `AVIATION_MAINTENANCE_LOCK` is set for either: the file is not an absolute,
  existing regular file owned by the invoking user with mode 0600, or is a symlink;
  or its parent is not a directory owned by that user, is a symlink, or has any group
  or other write permission;
- `ELASTICSEARCH_INDEX_PREFIX` is not `ai-aviation-<APP_ENV>`;
- on `live`: `APP_VERSION` is missing or `dev` (for `app:up`, `ingest` and
  `app:migrate`), or `TUNNEL_TOKEN` is missing for `app:up`;
- for an ordinary dev build: the effective `APP_VERSION` (default `dev`) names an
  existing Git tag, or Git cannot identify the checkout; this protects release images;
- with `AVIATION_DEV_RELEASE_IMAGE=true`: the environment is not `dev`, `--rebuild`
  is requested, or extra `app:up` arguments are given; for application-image commands,
  `APP_VERSION` is missing/`dev`/invalid, its Git tag is absent, or its local image is
  missing, has a different revision or lacks a valid immutable ID; canary `app:up`
  also refuses tunnel or tracing mode;
- in tunnel mode: `EDGE_SUBNET` is missing or not a private, aligned /16 to /29.

A successful locked backup/restore prints its environment banner after completion.
Release mode prints `release-image sha256:<short ID>` in its banner before running.

`app:up` always runs tunnel mode on `live` (`compose.tunnel.yaml` and the `tunnel`
profile), so `live` never publishes a port. On `dev` it runs tunnel mode when
`TUNNEL_TOKEN` is set and otherwise publishes `127.0.0.1:${PORT:-3000}`.

```sh
export AVIATION_ENV_FILES=...       # see Env files

pnpm app:migrate               # schema migrations (aviation-migrate container)
pnpm app:backup                # dump the database into AVIATION_BACKUP_DIR (Backups)
pnpm app:restore <file>        # restore a backup into a freshly provisioned database (Backups)
pnpm app:up                    # start app (and tunnel), wait until healthy; builds the image (below)
pnpm app:ps                    # this environment's containers, one-offs included
pnpm ingest generations        # any worker command in a one-shot ingest container
pnpm app:down                  # stop and remove this environment's containers
pnpm extract:image             # build ai-aviation/extract:mdbtools-1.0.0
```

The same with plain Compose, from the app directory:

```sh
docker compose -p ai-aviation-dev --env-file "$ENV_FILE" --profile tools run --build --rm aviation-migrate
docker compose -p ai-aviation-dev --env-file "$ENV_FILE" --profile app up -d --build
docker compose -p ai-aviation-dev --env-file "$ENV_FILE" --profile tools run --build --rm aviation-ingest generations
docker compose -p ai-aviation-dev --env-file "$ENV_FILE" --profile app --profile tools --profile tunnel down
```

Pass one `--env-file` per file, lowest priority first. `compose.yaml` refuses to
load without `APP_ENV`. Plain Compose does not apply the wrappers' checks: on
`live` always add `-f compose.tunnel.yaml --profile tunnel`, or the app publishes
its loopback port, and leave out `--build` (see below). Run `aviation-ingest` with
`AVIATION_UID=$(id -u) AVIATION_GID=$(id -g)` and create `data/reports/<env>`
first when not using the wrapper.

The image's default command is the API server (`server/main.js`, listening on
`0.0.0.0:3000` inside the container). Its health check calls `GET /api/health` over
loopback, which tunnel mode still accepts; the check reports 503 until a dataset
manifest is published (next section). With `APP_ENV=live` the server refuses to start
without `TRUSTED_PROXY_CIDRS`.

### Deploying an environment

1. Provision the environment (`pnpm provision:shared`, see
   [Provisioning](#provisioning)) and its Langfuse project; write the settings file.
2. `pnpm app:migrate`.
3. Ingest data and publish its manifest (next section).
4. Run the [AI preflight](#ai-preflight) with the environment's settings file.
5. `pnpm app:up` (tunnel mode on `live`).

**Images.** On `dev`, `pnpm app:up`, `pnpm app:migrate` and `pnpm ingest` rebuild
`ai-aviation/app:dev` from the checkout every time (seconds when nothing changed), so the
migrations, the worker and the server always come from the same code. The explicit
[dev canary option](#dev-canary-app) below reuses a release image instead. On `live` every
release tag (`APP_VERSION`) is also a git tag, on the release's commit. Its image is built
once, by the first command that needs it, and only from a clean checkout of that commit (no
changed, staged or untracked file under the app directory that git does not ignore: an
untracked file would enter the image too); it records the commit (label
`org.opencontainers.image.revision`), and later commands
start it as built, even after the checkout moved on. The wrappers refuse a live tag
without a git tag, an image that records another commit than its tag, and a missing image
unless the checkout is exactly the tagged commit: a rollback never builds the current
code under an old tag. `--rebuild` as the first argument (`pnpm app:up --rebuild`, `pnpm
app:migrate --rebuild`, `pnpm ingest --rebuild ...`) rebuilds a tag on purpose, again only
from a clean checkout of its tagged commit.

For updates after the initial deployment, use [the release command](#release-command).
It includes both environments, privilege checks, the importer pins and free dev
re-certification. To roll back, set
the previous `APP_VERSION` and run `pnpm app:up`: its image is still local and starts
unchanged. If that image was removed, the wrapper refuses; check out the clean commit of
its git tag and run the command again to build it from that commit.

Releases from before these checks have no git tag, and their images no revision label (the
release running when the checks shipped is one), so the wrappers of later releases refuse
to start them. The first tagged release replaces such a release like any update: tag its
commit, check it out clean, `pnpm app:migrate` builds its labelled image, `pnpm app:up`
recreates the app container from it. A later wrapper never builds an earlier release either:
it builds only the commit it was checked out at. To roll back to a release from before the
checks, use that release's own checkout, whose wrapper predates them: check out its commit
(clean) and run `pnpm app:up` there; that wrapper rebuilds the image from that commit, as it
always did, and starts it. Keep that commit noted with the release (or tag it), since its
image records none.
Migrations are not reversed, so roll back only to a release that runs on the current
schema (the migrations add, and every release so far reads the tables it knows); after a
migration that changes what an earlier release relies on, roll forward instead. Each
release image takes about 350 MB: keep the current and the previous two tags as rollback
inventory and remove older ones (`docker image rm ai-aviation/app:<tag>`); `docker image
prune` removes the untagged layers that `dev` rebuilds leave behind.

### Release command

After the reviewed merge, create an **annotated** tag on the clean release commit,
named `YYYY.MM.DD-<first seven characters of HEAD>` (for example with
`git tag -a <tag> -m <release-note>`). Exactly one tag matching that form may name HEAD;
its suffix must match the commit. The command creates no tags, merges or pushes.

Use a **tmux or screen session** for the release so a dropped SSH connection does not
interrupt it. The launcher uses `node --import tsx`, without the tsx CLI's signal relay.

Run it from the configured main checkout, not a different worktree:

```sh
pnpm app:release --config /abs/private/release.json --dry-run
pnpm app:release --config /abs/private/release.json
```

The strict JSON config has these fields; all filesystem paths are absolute and outside
the repository. Keep this config owner-only. The importer config and the release's
dotenv/version files must be mode 0600. The importer's worker env files and existing lock
files need owner-only permissions (no group or other access); they are not rewritten:

```json
{
  "version": "aircase-release.v1",
  "checkout": "/abs/ai-apps",
  "branch": "aviation-casebook",
  "importerConfig": "/abs/private/importer.json",
  "publicUrl": "https://example.org",
  "logDir": "/abs/private/release-logs",
  "live": {
    "versionFile": "/abs/private/live.env",
    "composeEnvFiles": ["/abs/private/live.env", "/abs/private/live-compose.env"],
    "preflightEnvFiles": ["/abs/private/live-host.env"],
    "migratorEnvFile": "/abs/private/live-migrator.env"
  },
  "dev": {
    "versionFile": "/abs/private/dev-canary.env",
    "migrateEnvFiles": ["/abs/private/dev-migrate.env"],
    "canaryEnvFiles": ["/abs/private/dev-canary.env"],
    "migratorEnvFile": "/abs/private/dev-migrator.env"
  }
}
```

File lists have the usual highest-priority-first ordering; empty values do not override
a nonempty value in a lower-priority file. Each version file contains
exactly one `APP_VERSION=` assignment and must supply the effective version to its
Compose invocation. Dev migration settings select `APP_ENV=dev`, ordinary dev tools
(`APP_VERSION` absent or `dev`, no release-image mode) and the dev migrator; this migration
runs before the new release image exists. The canary settings select
`AVIATION_DEV_RELEASE_IMAGE=true` and the private dev app described below. Host migrator
files hold `DATABASE_MIGRATOR_URL` for the correct database and `aviation_migrator` role.
They are not the container connection files. Preflight settings select live and provide
the configured models and Anthropic key. The existing preflight uses the **free Anthropic
token-count endpoint**, with generation disabled; it needs provider connectivity but
makes no paid model call.

Containers, application health URLs, locks, image pins and worker commit come only from
the importer config. Both containers and the existing lock files must already exist.
The config and env reads reject symlinks, unsafe ownership/permissions and files over
64 KiB. The checkout must resolve to the script's own repo, use the configured branch,
and contain no tracked or untracked changes. Starts from **03:30 inclusive to 06:00
exclusive Europe/Prague** are refused, including across DST. Both non-blocking importer
locks are held through installation, migration, deployment and the pin update. The
maintenance lock also excludes the actual AirCase backup commands. Before acquiring them,
the command checks that both version files and the importer config have parent directories
owned by this user without group or other write permission. It also checks the log path
without creating it: the deepest existing ancestor must be safely owned and not a symlink,
and an existing log directory (including the tag's directory) must be mode 0700. These
checks apply to dry runs too; a log-directory problem exits 2.

After those checks, the command:

1. Runs `pnpm install --frozen-lockfile` and atomically changes only the `APP_VERSION`
   assignment in the live and canary files, retaining their line endings and mode 0600.
2. Migrates **dev first** and compares its read-only privilege snapshot against the
   committed baseline. Only then does it migrate and check live. A dev failure never
   migrates or restarts live; the version files may already hold the target tag.
3. Runs the live host preflight, then starts live. Compose builds the release image at
   its first required use (normally the live migration) and subsequently reuses it.
   Each app gets at most 180 seconds for `/api/config` to return 200. **Live only:**
   app-level log entries at level 40 or above (including 50 and 60) before the first
   `Server listening at` line in the container's first 180 seconds fail. Later app-logged
   visitor warnings, such as an evidence rerank fallback, do not fail the release.
   One configuration warning is checked after listening too:
   `passages index not servable: AI evidence stays off` at level 40 or above fails anywhere
   in the window unless its `code` is `unavailable`. That transient code is ignored; the
   app rechecks it on demand after 30 seconds.
   Every request-scoped entry carrying `reqId` is ignored, including `api request`.
   Without a listening line, all non-request lines in that window are checked. A
   no-restart retry rechecks the same window from `StartedAt` to `StartedAt + 180 s`.
   Signed-out public `/` and `/privacy` must return
   200, and `/admin` and `/api/admin/overview` must return 404, without following redirects.
4. Starts the private dev canary, checks health, verifies a readable `APP_VERSION`, and
   requires equal valid immutable live/dev image IDs. It has no startup-log gate:
   `AI feature off` and `Google sign-in off` are expected on this private app.
5. Validates and atomically writes the importer config with HEAD's full commit and that
   image in both environments. It preserves schedule, installation evidence and other
   settings, and refuses to overwrite a concurrent operator edit.
6. Closes **both** locks, then runs the importer's own free dev re-certification, which
   acquires them itself and runs the full ten-minute canary. Success requires exit 0 and
   a final `complete/unchanged` step. Another maintenance job winning that handoff causes
   a safe refusal, not a lock bypass. The release's recertification timeout is the importer's
   own three-hour deadline plus a fifteen-minute cleanup margin.

Release children receive a fresh environment containing only `PATH`, `HOME`,
the applicable `AVIATION_ENV_FILES`, and nonempty `DOCKER_HOST`, `DOCKER_CONTEXT` and
`DOCKER_CONFIG` from the release's own environment. This includes lock helpers and the
release's `docker inspect`/`docker logs`: deployment, checks and recertification all use
the same Docker endpoint. **Recertify only** also receives
the importer host's existing allowlist from the operator's environment (`USER`, `LOGNAME`,
`LANG`, `LC_ALL`, `TZ`, `TMPDIR`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`,
`XDG_RUNTIME_DIR`). This preserves the daily importer's CA and host settings.
Neither path inherits provider keys, database URLs,
`NODE_OPTIONS` or arbitrary exported application settings. Child diagnostics go to
`<logDir>/<tag>/<NN>-<step>.log` (directory 0700, files 0600); repeated runs append.
Treat those logs as private: deployment tooling can print sensitive diagnostics.
The console has fixed step results, a version/image/pin summary and only validated
importer JSON step lines. Privilege differences contain found/expected catalog lines
in the private log, never the connection URL. Dry-run checks files, Git, time, both
locks and existing containers, prints the entire plan, and creates no logs or other
files; it does not install, migrate, deploy or re-certify.

Exit codes: **0** success, **1** step failure, **2** usage/config, **75** busy/quiet window.
There is no automatic rollback of earlier completed steps. **Fix the cause and run the
same command again:** every step is idempotent, equal version/pin values are no-ops,
migrations are no-ops when current, and Compose reuses the existing tagged image.
A warning before the first listening line persists in the checked window: fix its cause,
then recreate the live app before rerunning. When the window has no listening line, the
same recovery applies to any non-request warning it contains; check for a changed log
format too. The definitive `passages index not servable: AI evidence stays off` warning
is checked after listening too: fix the index or the embedding settings, recreate the
app, then rerun. Its transient `unavailable` code does not fail the release. Visitor
warnings after listening need no recreation. From the application directory, set
`LIVE_COMPOSE_ENV_FILES` to the comma-joined `live.composeEnvFiles` from
the private release config and run, preserving the release's Docker endpoint settings:

```bash
release_docker_env=()
for release_docker_name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG; do
  if [ -n "${!release_docker_name:-}" ]; then
    release_docker_env+=("$release_docker_name=${!release_docker_name}")
  fi
done
env -i PATH="$PATH" HOME="$HOME" "${release_docker_env[@]}" AVIATION_ENV_FILES="$LIVE_COMPOSE_ENV_FILES" pnpm app:up --force-recreate aviation-app
```

Re-certification failure leaves the new pins in place; rerun after repair, or let the
daily importer perform its own re-certification. A long release can reach the importer's
own backup exclusion window at the lock handoff; do not bypass it. SIGINT, SIGTERM and SIGHUP
abort the release, stopping the active child before releasing locks. Another signal escalates
that child to SIGKILL; the release process stays alive to close locks and print the failure
and summary. A release cannot guarantee completion merely
because it started before 03:30.
An interrupted step always reports `release interrupted` and exits 1. If closing a lock
also fails, its separate failure line follows the original failure without changing the
original exit code.

### Dev canary app

The importer reads an **already running** private dev app for its HTTP canary. It never
starts, builds or deploys an app. Deploy the dev app separately using the exact immutable
image the approved live release runs, before enabling the importer. This uses the existing
`ai-aviation-dev` project, replacing any ordinary development app in that project.

Set `AVIATION_DEV_RELEASE_IMAGE=true` and `APP_VERSION` to that release's existing Git tag.
The wrapper checks that `ai-aviation/app:<APP_VERSION>` exists locally and its
`org.opencontainers.image.revision` matches the Git tag. It resolves its `sha256` image ID
once, then `compose.dev-release.yaml` uses that ID for the app, migrations and ingest,
removes their build configuration and retains `pull_policy: never`. A missing or mismatched
image fails; it is never built or pulled, even from a clean tagged checkout. The wrapper
may run from a newer checkout. `--rebuild` is refused, and `app:up` takes no extra arguments
in this mode. With the flag unset or false, normal dev builds still rebuild, but refuse
any image tag that is an existing Git tag.
Never use the canary settings without `AVIATION_DEV_RELEASE_IMAGE=true`: an ordinary
dev build must not overwrite a release image name.

Use a dedicated private settings file (0600, outside the repository), with only:

- `APP_ENV=dev`, `AVIATION_DEV_RELEASE_IMAGE=true`, `APP_VERSION=<approved release tag>`,
  `APP_URL=http://127.0.0.1:3100` and an unused loopback host `PORT` (3100 in this example).
- `DATABASE_URL`: the **dev app login**, acting as `aviation_app` in `aviation_dev`;
  `SHARED_POSTGRES_NETWORK`. No live, administrator, migrator or ingest credential is
  needed to run the app. Apply any necessary dev migrations separately beforehand.
- `ELASTICSEARCH_URL`, the **dev** `ELASTICSEARCH_READ_API_KEY`,
  `ELASTICSEARCH_INDEX_PREFIX=ai-aviation-dev`, `SHARED_ELASTICSEARCH_NETWORK` and
  `ELASTICSEARCH_CA_FILE` when using TLS. Keep certificate verification on.
- Independently generated `BETTER_AUTH_SECRET`, `IP_HMAC_SECRET` and `IDENTITY_HMAC_SECRET`
  (at least 32 random characters each, written directly into that private file). Never
  copy live identity secrets. These are optional for the canary's public reads; generate
  them anyway so later authentication/AI checks use independent dev identities.
- `AI_BRIEFS_ENABLED=false`, `AVIATION_TRACING_ENABLED=false`. `compose.yaml` does not
  pass `AI_PARTIAL_DISPLAY`; the image's default keeps generated partial summaries off.
  Leave provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), Google client settings,
  Langfuse settings, `TUNNEL_TOKEN` and both Turnstile keys **unset**. The canary's public
  keyword/config/case reads require no Turnstile or paid call; no test keys are needed.

Do not include the shared provider-key file or a live connection file. Start from a clean
process environment so exported credentials cannot override the private canary settings:

```sh
# CANARY_ENV names the private dev settings file, not a secret value.
env -i PATH="$PATH" HOME="$HOME" AVIATION_ENV_FILES="$CANARY_ENV" pnpm app:up
```

The wrapper refuses tunnel or tracing mode for this canary; the base Compose file binds
only `127.0.0.1:${PORT}:3000`, with no tunnel. Do not expose this port through a proxy or
public tunnel. Verify health, config, keyword search and case reads against loopback, and
verify the actual image IDs of the running dev and live app containers before installing
or re-certifying the importer:

```sh
docker inspect --type container --format '{{.Image}}' ai-aviation-dev-aviation-app-1
docker inspect --type container --format '{{.Image}}' ai-aviation-live-aviation-app-1
```

They must be identical; matching version strings alone is insufficient. These commands
print image IDs only, never container environments. Keep release tags immutable. To update
live and its canary together, use [the release command](#release-command), including its
lock, image-ID/HTTP checks and new-image dev certification. The initial standalone
canary setup still uses the steps above. The importer uses its separate private worker settings;
the canary app receives neither worker credentials nor provider keys.

### AI preflight

**Mandatory before every paid test and every deployment** (and after changing a
prompt, a schema, a model or `STAGE_CAPS`). It is free: it only counts tokens with the
provider's own counter (Anthropic `messages.countTokens`), and its client refuses to
generate. It needs no database or Elasticsearch, so run it host-side with the
environment's settings file, which holds `ANTHROPIC_API_KEY` and the
`ANTHROPIC_*_MODEL` settings the app will use:

```sh
AVIATION_ENV_FILES=<the environment's settings file> pnpm worker ai-preflight
```

For each stage it counts the fixed request (system prompt and structured-output
schema), a synthetic worst case at the server's input bounds (a full bundle of 12
chunker-maximum passages within the evidence budget, the longest question and
refinement, the most claims the composition allows), the output at its schema bounds
and the cached prefix (against `CACHED_PREFIX_MAX`), and prints each against its cap
(`server/ai/pricing.ts`, DESIGN §9). It exits
1 when anything is over: do not run paid tests or deploy until the cap or the request
is fixed. A cap below a stage's fixed request refuses every brief at that stage, free
but useless (the first paid end-to-end test stopped this way at scope).

### Evidence ranking

`AVIATION_EVIDENCE_RANKING` selects evidence-view behaviour independently of
`AVIATION_RETRIEVAL_VERSION` (generated briefs). Empty means `er-q-v1`.
Unknown values fail configuration. Live permits **`er-q-v1` and `er-q-h50-v1`** (the
Haiku rerank of the top 50 cases); any other value fails startup rather than silently
reverting. Live runs `AVIATION_EVIDENCE_RANKING=er-q-h50-v1` since 31 October 2026.
Rollback: set `er-q-v1` and run `app:up`; nothing is migrated, and saved searches keep
their own stored order. After a change, watch the private `rerankOutcome` mix, the
`evidence.rerank` spans and the spend ledger's cost per search (about $0.003 with
the rerank, against $0.009 reserved).

| Versions | Lexical text | Reranker |
| --- | --- | --- |
| `er-q-v1`, `er-t-v1`, `er-qt-v1` | question / scope terms / question + terms | none |
| `er-q-h50-v1`, `er-t-h50-v1`, `er-qt-h50-v1` | same choices | Haiku 5.5, 50 cases |
| `er-q-h100-v1`, `er-t-h100-v1`, `er-qt-h100-v1` | same choices | Haiku 5.5, 100 cases |
| `er-t-s50-v1`, `er-qt-s50-v1` | terms / question + terms | Sonnet 5.5, 50 cases; evaluation |

To evaluate on dev, select a version in that environment's settings, run the free
`pnpm worker ai-preflight` and require no OVER row, then recreate the app container.
The Compose service passes the setting through. Scope/embedding models are fixed
by the evidence ranking object; incompatible model overrides fail its price check.
Only the baseline retains suggestion-based highlights (executed words if absent);
every alternative highlights executed lexical words. This policy is part of the hash.
The conservative reservations are $0.0025 without rerank, $0.0090 for Haiku/50,
$0.0140 for Haiku/100 and $0.1332 for Sonnet/50. Confirm budget capacity before
authorizing any paid test; preflight does not generate.

For a non-HTTP evaluation use `rankEvidence(config, input, providers, spendGate)`
from `server/evidence/pipeline.ts`, `evidenceRankingConfig(version)`, and
`ledgerRankingSpendGate(db, budgets, runId)` from `server/evidence/spend.ts`.
An allocation runner can instead wrap production gates through
`evaluationRankingSpendGate(gateFor, runId)`. Preserve that runner's allocation
admission, accounting and recovery rules. Do not replace the production gate with
an unmetered fake outside offline tests. Cache keys/reports include the returned
configuration identity, exact question/edited texts, filters and pinned dataset/index
identity. The hash also covers the rerank user-turn template and rendered input
fixture. Direct adapter callers pass the complete registered ranking config.
Errors expose fixed categories; spend lines survive downstream failures. An evaluator
can set `skipScope` without disabling reranking; `uncertainAllowanceReached` skips
both optional stages, matching HTTP admission.

To roll back, set `AVIATION_EVIDENCE_RANKING=er-q-v1`, run preflight and recreate
the app. New searches use the baseline; saved pages retain their order and old
configuration. New edits inherit the parent's executed lexical/vector texts unless
the visitor supplies replacement terms, then use the selected ranking version.
No reindex or data migration is needed.

Adding a ranking to the live allowlist needs a reviewed code change and the matching
`evidence.v3` client disclosures. `er-q-h50-v1` was added by the owner's decision of
31 October 2026: its Task 24 confirmation was inconclusive (every endpoint positive,
intervals too wide), not cleared, and it only reorders the retrieved cases.

### Evidence automatic filters and v3 rollout

`AVIATION_EVIDENCE_AUTO_FILTERS` selects `none` (empty/default) or
`state-explicit.v1.3`. Both are allowed on dev and live following the state policy's
field confirmation and review. Unknown values fail startup. The default stays
`none`. To enable it, deploy the matching v3 client and complete these steps:

1. In `live.env`, set `AVIATION_EVIDENCE_AUTO_FILTERS=state-explicit.v1.3` and keep
   `AVIATION_EVIDENCE_RANKING=er-q-v1`.
2. Run `pnpm worker ai-preflight` with those same environment settings **before**
   `pnpm app:up`. Require successful configuration validation and no OVER rows.
   This catches an invalid policy before the app is recreated.
3. Run `pnpm app:up` with those settings, then check that `/api/config` reports
   `aiAutomaticFilters: ['state']` after its cache expires. Confirm that an applied
   state is disclosed and can be removed without a visitor quota unit.
4. Monitor the private `autoFilterReason` mix and the ratio of free-undo claims to
   state-applied original searches. Removals are the live precision signal, not a
   labelled precision estimate: a claim may also remove added keywords or precede
   a failed search. Keep these diagnostics and question text out of logs/traces.

This setting is independent of `AVIATION_EVIDENCE_RANKING`; changing
it does not change any evaluated ranking hash. The Docker service passes it through.
The live ranking allowlist is `er-q-v1` and `er-q-h50-v1`.
Each saved search records both configuration identities. No reindex is needed.
v1.1 and v1.2 were never deployed and are no longer accepted. Replace any unreleased
older setting with `none` or v1.3 before preflight. v1.3 is built on v1.1, adding five
rejections for other-event wording, references before the first mention, title/text
language, locations attributed to destinations/departures/attributes, and definite
singular events at a state mention. It removes v1.2's overbroad `like` alternative:
"I'd like to see accidents in Alaska" remains eligible. See DESIGN for the bounded
rules and deliberate abstentions. Its accepted set is a strict subset of v1.1
(and a subset of v1). The 1,040-answer offline replay gives 365 TP / 0 FP / 35 FN
for the guard, two applications lost from v1.1. The pipeline's separate case-search
intent requirement yields 363 TP / 0 FP / 37 FN. Neither result proves semantic
attribution for future wording; other fields and rankings remain restricted.
`GET /api/config` reports `aiAutomaticFilters: []` for `none` and `['state']` for
the state policy. The field is optional for cached pre-deploy configs: missing means
unknown, so the client uses cautious "suggests filters" wording. Client copy follows
this field, not a fixed claim about states.
A policy change changes the response ETag even on the same dataset; the existing
public cache lifetime is five minutes.
The automatic-policy identity includes `state-probes.v5` outputs. Current hashes:

| Policy | SHA-256 |
| --- | --- |
| `none` | `f586929efd8c2254ec18d3ac2141d2be48fad1125b3708160686b31a67766715` |
| `state-explicit.v1.3` | `8e1491adf18797055438498cd49bec694ec265d3698b8ea0049ee34c4575f6de` |

The state policy hashes its fixed probes' inputs and actual guard outputs; `none`
records no active guard. Do not relabel older cached results with these identities.
The v1.3 policy binds `state-probes.v5` (499 probes, including all review challenges
and witnesses for every new regex alternative). The eleven ranking identities are unchanged.


Apply migration 0025 before serving v3. Its known local-test-only round-2 and round-3 versions are
reapplied transactionally by the migrator without removing existing undo claims; other
unknown migration drift is still refused. Its columns/grants and snapshot are unchanged.
Deploy the matching evidence.v3 web client for keyword, automatic-state, ordering,
mark-source, suggestion and undo disclosures. v2 stored pages upgrade on read;
pre-v2 pages remain unavailable. Unexpired v2 retries of the identical compatible
body replay the existing result (including running/failed searches), with the usual
ownership and Turnstile checks and no new quota or provider call. Different bodies
still conflict; v3-only `keywords` can never be discarded to match a v2 hash.
Old tabs reject v3 page responses until reloaded; reload them after deployment.
To roll back automatic state on live, set `AVIATION_EVIDENCE_AUTO_FILTERS=none`
in the live settings, run `pnpm worker ai-preflight`, then run `pnpm app:up`
with those settings. New question-search pages disclose no automatic filters;
Explore and About switch wording through `aiAutomaticFilters: []`, subject to the
five-minute config cache above. Saved pages retain their own facts; new edits use
explicit filters only. Do not roll back the database
schema or old private result data to disable this policy.

Free undo is allowed once per original question, even at a visitor quota limit.
Its attempt, concurrency, Turnstile and money checks are unchanged. The parent claim
is taken atomically at admission and is not reset after a downstream failure; retries
with the same key replay its result/failure once a search row exists. A pre-run abandon
expires the idempotency slot without restoring the undo claim, so even a same-key retry
is an ordinary quota-counted admission (or is refused at the quota limit).
Confirm quota_counted=false for the free request and normal ledger settlement. No
public request field can ask for free quota directly. Automatic state is cleared for
live opt-in; a non-baseline ranking still requires its own evaluation and allowlist
decision. Deploy the matching v3 web client before enabling automatic state.

### Retrieval version

AI evidence is retrieved under one frozen configuration, chosen by
`AVIATION_RETRIEVAL_VERSION` in the settings file (README, "Evidence retrieval";
`server/search/retrieval-config.ts`):

- empty or `retrieval.v2`: the default; case-level fusion of passage BM25, passage
  kNN and BM25 over the cases index's narratives;
- `retrieval.v1`: the rollback, the passage-only retrieval before task 10e;
- `retrieval.v2-nf`: experimental, `dev` only. The app refuses to start with it on
  `live`.

Nothing is rebuilt or migrated to switch: index mappings and the published manifest
are the same for every version. `retrieval.v2` reads the cases index the active
manifest already serves, so it needs nothing beyond a published manifest: the brief's
generation must still have its manifest row pairing that cases index with the brief's
passages index (`worker publish` writes both together), and the cases index must be a
servable `cases-v3` index of that generation: the version the validation covered. A
`cases-v2` index still serves keyword search but not AI retrieval; republish with a
`cases-v3` index first. If either fails, AI answers 503 `unavailable` (status
`dependency`) and steps fail with `meta.failure.reason` `no_cases_index` or
`index_mismatch`. The manifest lookup is bounded (2 s, and the request's cancel); a
lookup that fails or times out fails the step with `cases_index_lookup` before the
question is embedded.

Each step under `retrieval.v2` records the cases index it read in its private
`meta.retrieval` (`casesIndex`, `casesIndexVersion`, with the mapping counts). Every pair
a generation was published with stays resolvable while the generation exists
(`manifest_pairings`, migration 0021), so republishing the passages index (passages-v2)
leaves the briefs made from the old one working until they expire: `index delete-unused`
keeps every index an unexpired brief uses. Republishing only the cases index can change
what later retrieval returns for the same question (compare a step's
`meta.retrieval.casesIndex` with the manifest when that matters).

To switch, or to roll back:

1. Set `AVIATION_RETRIEVAL_VERSION` in the environment's settings file
   (`retrieval.v1` to roll back; empty for the default).
2. `pnpm app:up`. Compose recreates the app container with the new value; steps
   running in the old container are stopped by its shutdown (they fail as
   `shutdown` and settle).
3. Check: the app's start log line `AI retrieval configuration` names the version;
   new brief steps record it in `meta.retrievalVersion`, and their `brief.retrieve`
   spans carry `retrievalVersion` in Langfuse. A refinement of an older brief runs
   under the version in force when it runs; each step keeps its own.

The task 10e validation (`pnpm eval:retrieval:adoption`, README) is bound to the
frozen phase A target on `dev` (generation 1 and its two indexes): its preflight
refuses any other target. Its numbers say nothing about another generation; validate
again there before relying on them.

## Ingestion

The automatic snapshot worker is documented in [IMPORTER.md](IMPORTER.md), including
migrations 0027–0028, the no-change/forced-dev exercises, the fixed $0.50 artifact
cap and 89-day resumption boundary, concrete-index protection, named approvals,
rollback/rebaseline, free re-certification and the installation gate. Rebaseline is
the explicit dry-run-first recovery step after rollback or a manual publication;
it never clears an accounting or restore hold. The importer is disabled by default. Do not enable its timer before mutual exclusion with AirCase's
own manual and scheduled database backups, a separately running pinned dev app, and
actual PG/ES/filesystem headroom have been verified. Langfuse backup I/O belongs in
the headroom assessment; its mutex is optional. The manual commands below remain useful
for reviewed operator work; only the PostgreSQL manifest selects the serving pair.

Extraction needs the Docker CLI to start its sandbox containers, so it runs on the
host, never in the `aviation-ingest` container (which has no Docker socket):

```sh
pnpm extract:image
APP_ENV=dev pnpm worker extract --archive data/research/avall.zip --sha256 <hex> --out data/work/<dir>
```

Its containers are named `ai-aviation-<env>-extract-<hex>` and labelled as one-off
containers of service `extract` in project `ai-aviation-<env>`, so they appear in
`pnpm app:ps` while they run. They have no network, a read-only root, no
capabilities, uid 65534, 1 GB memory and no swap, 2 CPUs and 64 processes, and are always
removed afterwards.

Loading, verification and the other worker commands then run in the
`aviation-ingest` container against the environment's database:

```sh
pnpm ingest load --from data/work/<dir>
pnpm ingest verify --generation <id>     # report written to data/reports/<env>/
pnpm ingest generations
pnpm ingest index cases --generation <id>  # cases index <prefix>-cases-v3-g<id>-...; alias <prefix>-cases
pnpm ingest index passages --generation <id>                 # dry run: passages, tokens, cost ("to embed"); writes nothing
pnpm ingest index passages --generation <id> --confirm-cost  # paid embeddings; passages index <prefix>-passages-v2-g<id>-...
pnpm ingest index passages --generation <id> --cache-only    # from embedding_cache only: no OpenAI client, fails if one vector is missing
pnpm ingest index reconcile --alias <alias>
pnpm ingest publish --generation <id> --cases-index <index name> [--passages-index <index name>]
```

`index passages --confirm-cost` meters every embedding request on the indexing
ledger (shared with evaluations, `AI_INGESTION_MONTHLY_BUDGET_USD`) and refuses
when the planned reservations exceed what is left. If OpenAI asks for a wait longer
than 10 minutes, the run stops and prints when to rerun it; vectors paid for so far
are cached in `embedding_cache`, so the rerun pays only for the rest.

### Rebuilding passages as `passages-v2` from the cache

`passages-v2` stores each multi-aircraft event's complete aircraft set as a nested
field, so retrieval can let an event-scoped passage satisfy an aircraft filter when
every aircraft of its event does (DATA_PIPELINE section 2.12). Its chunks and embedding
inputs are those of `passages-v1`, so a generation already indexed as v1 is rebuilt
from `embedding_cache` without a paid call. The API keeps serving a published v1
index, with event-scoped passages excluded under aircraft filters, until a v2 index is
published.

```sh
# 1. Dry run: must report "to embed: 0 inputs, 0 tokens, 0 requests" and
#    "event aircraft sets (checked against case_aircraft): <n> events complete".
pnpm ingest index passages --generation <id>
# 2. Build from the cache. No OPENAI_API_KEY is read and no OpenAI client exists; the
#    build stops before creating an index if any vector is missing, or if any
#    event-scoped passage's aircraft set differs from case_aircraft.
pnpm ingest index passages --generation <id> --cache-only
# 3. Publish the cases index the active manifest already serves (its
#    dataset_manifests.cases_index) with the passages index name step 2 printed.
pnpm ingest publish --generation <id> --cases-index <cases index name> --passages-index <prefix>-passages-v2-g<id>-...
```

The build's report shows `mode: cache only (no embedder; nothing paid)` and
`embedded: 0 inputs`. If the dry run reports anything to embed, stop: a cache-only
build would refuse, and a paid build needs a new review. Rolling back is publishing
the v1 passages index again (still servable).

`publish` makes the generation the one the API serves (the active
`dataset_manifests` row). Pass the concrete index name the build printed, never the
alias: the command refuses an alias, an index built for another generation or with
a mapping version the API does not serve (it serves `cases-v3` and, until every
environment has a v3 index, `cases-v2`), and a document count that differs from the
generation's US events, and changes nothing then. Without `--passages-index` the manifest is
keyword-only: search, case pages and the dashboard work and AI stays off. Publishing
an earlier generation again is the rollback. The running API picks up a new manifest
within seconds; public responses may stay cached for up to five minutes. It also refuses
an index whose deletion `index delete-unused` requested, even one Elasticsearch still has,
and it holds the lifecycle lock from its first check to the manifest it writes, so a
cleanup running meanwhile waits and then keeps the index the manifest names.

The `index` commands (README, "Cases index") use the environment's write API key,
so they create and switch only `ai-aviation-<env>-*` indices. A build deletes only
its own index, and only when it failed before any alias request; every other index
stays until an explicit `index delete-unused --older-than <hours> --yes`, which deletes
indices that are older than the threshold, no alias target, in no manifest (active or
retained) and used by no unexpired AI brief (briefs being created wait while it decides;
one that would cite the index is refused), and refuses any with a switch request
still pending or unknown. Run it
without `--yes` first: it lists what it would delete. A deleted index cannot be
published again, so pick a threshold above the age of any index you may roll back to.

Each deletion is recorded as requested before Elasticsearch is asked, and as done once
Elasticsearch confirmed it (or reports the index missing). From the request on, the index
is gone for the app: no new brief, publication or alias switch takes it, whatever became
of the request. If the command fails or stops meanwhile (a lost response, a database
error, the process killed), run it again with `--yes`: it completes every requested
deletion, at any age. A dry run lists them apart (`deletion requested by an earlier run,
not yet confirmed`).

Paths are relative to the app directory, which the container sees at the same
relative location (`data/` is mounted at `/app/data`).

The extraction image was formerly tagged `aviation-extract:mdbtools-1.0.0`;
`pnpm extract:image` builds `ai-aviation/extract:mdbtools-1.0.0`, after which the
old tag can be removed (`docker image rm aviation-extract:mdbtools-1.0.0`).
Manifests of earlier extractions keep the old name; loading does not depend on it.

### Diagnosing a withheld summary

A withheld summary shows as `withheld` (with `withheldCodes`) on the `brief.step` span
and as `withheld: {reason, codes}` on its `brief step finished` log line. To see why,
with the brief's id, on a host that holds the environment's `DATABASE_URL` (the
`aviation_app` login; the ingest container does not hold it):

```sh
AVIATION_ENV_FILES=<the environment's settings file> pnpm worker brief-diagnose <brief-id> [--step <n>] [--include-expired]
```

It reads the step (the latest without `--step`) and prints its reasons with what they
point at: each validation code with its path and text (the offending summary sentence
as the validator split it, the `why` line, quote or gap note, the passage alias and its
id), the failed criteria with the case's chronology, or the judged check: its verdict
counts and codes, then each claim the checker read (id, kind, citations, absence) with
its verdict, the passages the verdict named, any quote and any `chronology_missed`, then
the summary's sentences as split, the failure category and each stage's stop reason. The text is the rejected composition: model output about public
NTSB passages that may restate the reader's question, so treat it as user data. It is
printed to your terminal only. The command is read-only and free, and nothing runs it
automatically. A brief expires 24 hours after it was created; the next maintenance pass
(about every 10 minutes, or `pnpm worker prune-controls`) then deletes it with its steps
and their diagnostics. Until that pass the expired rows still exist: the command refuses
an expired brief (exit 1) unless you pass `--include-expired`, and after the pass it finds
nothing. A summary withheld because the answer call failed (`compose_failed`) has no
composition; the command prints the failure and the stop reason instead.

The same command reads an answer that was shown with claims removed (Task 16d's
claim-level display, `meta.display`; its diagnostics have the reason `partial_display`):
it prints the display projection (rules, mode, what was removed and why, by claim key)
beside the raw verdicts, with the claims the deterministic rules abstained from
(`meta.staticRules`: `excerpt_context` or `ordinal_evidence`, by claim key). Claim-level
display stays off in production until gate G6 clears it: with `AI_PARTIAL_DISPLAY` unset
the projection runs in `whole` mode, and any claim the check did not confirm, or a rule
abstained from, withholds the summary as before (code `display_whole_brief`). Do not set
`AI_PARTIAL_DISPLAY` on a shared or public environment without that decision.

### Enabling partial display

`AI_PARTIAL_DISPLAY=true` makes the projection run in `claims` mode: confirmed statements
are shown and the rest are removed with markers (DESIGN §3; the copy in UI_DESIGN §4.3).
Enabling it on an environment requires, in this order:

1. **Gate G6's written clearance** of claim-level display, from the reviewer's reading of
   the latest calibration results (Task 16e: README "Task 16e result", DESIGN §12 and
   `evals/checker/results/16e-*.json`); the held-out run is a pilot and never a pass by
   itself.
2. **Production equal to the frozen checker selection**: `selection.v3.json` names the
   candidate (model, thinking, effort, `check.v9`, schema, caps, maximum claims) and the
   check timeout derived from its measured latency, and the unit test "production runs
   the frozen selection" passes on the commit being deployed.
3. **The same commit for server and web**: the web client must render the projection's
   states (unclassified cases, cards without a reading, removal markers, the factual
   checklist count, the drawer's READING and QUOTES lines, Compare's markers); an older
   client would drop or mislabel them.
4. **The setting** in the environment's settings file, then a restart of the app
   container; `AI_PARTIAL_DISPLAY` is read at start. Until gate G6 clears it, compose.yaml
   does not pass `AI_PARTIAL_DISPLAY` to `aviation-app`, so a Compose deployment stays in
   `whole` mode whatever the settings file says (a unit test keeps it that way): the commit
   that records the clearance adds `AI_PARTIAL_DISPLAY: ${AI_PARTIAL_DISPLAY:-}` to the
   service's `environment` and updates that test.
5. **A smoke check**: one brief on the environment, then `pnpm worker brief-diagnose
   <brief-id>` shows `display.mode: claims`, and the page shows "Evidence check completed ·
   N statements removed".

To turn it off, unset the variable and restart: briefs are projected again in `whole`
mode (stored results keep the projection they were shown with until they expire).

## Costs of the opt-in commands

Nothing in the test suite or in a default command calls a paid provider. These do,
and each needs an explicit flag or key:

| Command | What it pays for | Cost |
| --- | --- | --- |
| `pnpm ingest index passages --generation <id> --confirm-cost` | OpenAI embeddings of every passage (`text-embedding-3-small`) | about $0.57 for the full corpus, measured; the dry run (no flag) prints the planned tokens and cost and spends nothing; `--cache-only` never pays |
| `pnpm eval:retrieval --confirm-cost` (README, "Evidence retrieval") | embeddings of the evaluation queries (69 questions) | about $0.00002 |
| `pnpm eval:retrieval --track coded --confirm-cost` (README, "Coded-reference track") | embeddings of the 43 coded-reference questions | about $0.00002 |
| `pnpm eval:retrieval:experiments ... --confirm-cost` (README, "Retrieval experiments") | query embeddings, and three scope-stage samples per question (each attempt reserved at the stage's worst case) | about $0.03 for the dev questions; refused above the registered phase limit ($0.50) |
| `pnpm eval:retrieval:narrative plan` (README, "Narrative-relevance track") | nothing: Anthropic token counts (free) and local estimates | free |
| `pnpm eval:retrieval:narrative recover --allocation <name> --run <id> [--confirm]` | nothing: it reads the run's reservations on the ledger, appends the charges the allocation's log lacks (and, on its own, those the run's spend log lacks) and removes the run's lock. Needed after any paid Track N run that ended with its allocation still locked: an interrupted run, or one whose books did not balance (a charge that could not be written, a ledger settlement or connection close that failed); that run's error names the command | free |
| `pnpm eval:retrieval:narrative judge --set calibration --split dev --max-pairs 1 --max-usd 0.11 --concurrency 1 --confirm-cost --allocation <name>` (the canary) | both judges on one calibration pair, and the adjudicator's two steps if they disagree | about $0.01; at most $0.11, which covers one full escalation at its caps (`plan` prints the figure) |
| `pnpm eval:retrieval:narrative judge --set calibration --split dev\|holdout --confirm-cost --allocation <name>` | both judges on the split's calibration items (dev 99, holdout 103), every disagreement adjudicated | about $1.00 (dev) and $1.12 (holdout) expected, $2.64 and $2.95 if every item were adjudicated; each run stops at its limit ($3 unless `--max-usd`) and at its allocation's cap; one run at a time per allocation |
| `pnpm eval:retrieval:narrative pools [--vectors <file>] --confirm-cost --allocation <name>` | the pools' cached inputs: three scope-stage samples per benchmark question (75 calls; the diagnostic keeps its frozen scope output) and the query embeddings (25, or fewer when `--vectors` holds some); the pools are then built through the production retrievers for free, and their identity is frozen (`frozen-pools.json`, commit it) | about $0.05 planned, $0.007 measured on 2026-10-23; reservations about $0.08; `pools --inputs <file>` rebuilds from the saved inputs and is free |
| `pnpm eval:retrieval:narrative judge --set relevance --stage 1` and `answerability ... --confirm-cost --allocation <name>` | both judges on stage 1 of the frozen pools (about 1,190 pairs: the bounded cohorts, the broad questions' delivered and first-20 cases, the diagnostics) and on every delivered bundle (about 430, the mapping diagnostic's included), escalations up to 25% | about $2.90 and $0.60 expected before the pools were built ($7.11 and $1.59 at the escalation bound), from the measured calibration usage. Measured on 2026-10-23: $6.39 for 1,397 pairs and $1.08 for 449 bundles. The judges cost what was planned, but they disagreed on about 15% of the pool pairs against 5.9% of the calibration items, at about $0.02 an escalation. Refused unless the pool file is the frozen, committed identity |
| `pnpm eval:retrieval:narrative judge --set relevance --confirm-cost --allocation <name>` (stage 2) | the rest of the pools (about 2,110 pairs; 2,627 in the built pools) | about $6.01 expected before the pools were built ($14.47 at the bound); the cache keeps stage 1, so it is not paid again. Measured on 2026-10-23: $4.10, nearly all of it both judges on the 2,627 pairs; the allocation's cap stopped the escalations after one. The 455 left cost about $9.70 in a later month, from the cache, under a fresh allocation; run it with `--concurrency 3` or lower until the ledger's connection pressure is fixed (at 6, a ledger connection timed out) |
| `pnpm eval:checker retrieve [--questions 16d\|16e] --confirm-cost` (README, "Checker calibration") | embeddings of the calibration questions (9; 17 with `16d`; 16 with `16e`) | about $0.000005 |
| `pnpm eval:checker run --candidate <name> --split dev\|holdout --confirm-cost` | the check stage on every calibration input of a split (Task 16e: 179 development or 105 held-out calls) | $0.46 a development pass at effort `low`, $0.62 at `medium`, $0.39 the held-out pilot at `medium`; `inventory` (free) prints the expected and worst-case cost first; charged to the allocation `checker-16e-2026-10` and stopped before a call that would take it over $2.50 or the ledger's evaluation allowance below the $12 protected for another track |
| Evidence search | advisory scope.e3 and one query embedding; edits skip scope | baseline at most $0.0024325, reserving $0.0025; dev rerank versions: see Evidence ranking; same global budgets |
| AI briefs (disabled) | the scope, answer and check models per request | about $0.11 a typical request with the Opus answer model, reserving its worst case of $0.36 until it settles (DESIGN §9); capped by the budgets below |
| `pnpm worker ai-preflight` | nothing: token counts only | free |
| `pnpm worker brief-diagnose <brief-id>` | nothing: one database read | free |

Embeddings and evaluations are metered on the indexing ledger and stop at
`AI_INGESTION_MONTHLY_BUDGET_USD`; vectors already paid for are kept in
`embedding_cache`, so a rerun pays only for what is missing. Interactive AI is capped
by `AI_MONTHLY_BUDGET_USD` (total), `AI_INTERACTIVE_MONTHLY_BUDGET_USD`,
`AI_INTERACTIVE_DAILY_BUDGET_USD` and `AI_ANONYMOUS_BUDGET_SHARE`, and by the per-visitor
request limits (`AI_ANONYMOUS_TRIAL_REQUESTS`, `AI_USER_DAILY_REQUESTS`, ...); see
`.env.example`. `pnpm worker ai-switch --off` pauses interactive AI at once.

## Backups

What lives only in PostgreSQL, and must be backed up:

- the corpus generations and manifests (`dataset_generations`, `dataset_manifests`,
  the case tables), which are the product of an ingestion you would otherwise redo
  from the source archive;
- the cost ledger, reservations and the budget switch (`cost_ledger`, `reservations`,
  `ai_switch`), which are the only record of spend;
- trial, usage, lease and abuse records (`trial_identities`, `usage_buckets`, `leases`,
  `abuse_records`): with them a restore keeps every quota and the anti-abuse record of
  deleted accounts;
- the report links (`report_links`) and their provenance, and the passage embedding
  cache (`embedding_cache`), which is what keeps a rebuild from paying again;
- the generation pins and the index build records.

**Never in a backup** (server/db/backup.ts): the rows of the account and sign-in tables
(`auth_users`, `auth_accounts`, `auth_sessions`, `auth_verifications`, `auth_state_uses`,
`auth_deletion_confirmations`), of the AI searches and briefs (`evidence_searches`, `briefs`, `brief_steps`) and of the
idempotency records (`idempotency`); their definitions are kept. They hold people's
accounts and what they asked, which deleting an account removes for good, so a backup
that held them would bring a deleted account and its content back on restore; and
sessions and OAuth state, which must never come back (a session token together with
BETTER_AUTH_SECRET makes a valid cookie). A restore therefore starts them empty:
everyone signs in again and finds the same usage counts and anti-abuse record (keyed by
HMAC, and restored), a re-created account is new again for its first days, and briefs
are 24-hour temporary processing anyway. Backups expire within 30 days.

Rebuildable: the Elasticsearch indices. They are built from PostgreSQL (the cases
index) and PostgreSQL plus `embedding_cache` (the passages index), so after a restore
run `index cases`, `index passages` (free while the cache is complete) and `publish`.
Verification reports under `data/reports/` and the extraction directories are
derived and need no backup; the source archive is kept wherever you keep it.

### Taking a backup

```sh
export AVIATION_ENV_FILES=...          # the environment's .docker.env files, as for pnpm app:migrate
export AVIATION_BACKUP_DIR=<private directory outside the repository>
export AVIATION_MAINTENANCE_LOCK=<absolute path to the importer's existing maintenance lock>
pnpm app:backup                        # writes aviation_<env>-<UTC time>.dump, mode 0600
```

`app:backup` runs `pg_dump` (docker/postgres/backup.sh) in the one-shot `aviation-backup`
container, with the PostgreSQL 16 client tools of the shared server's version, as the
environment's migrator login (`DATABASE_MIGRATOR_URL`). That is the only login that can
dump the database: `pg_dump` locks every table it dumps, those whose rows it leaves out
too, and the app and ingest logins are refused (`permission denied for schema drizzle`).
The file appears under its final name only once it is complete. The container runs as
the host user that owns the directory (the wrapper sets `AVIATION_UID`/`AVIATION_GID`)
and sees only that directory and the scripts. Backup and restore connect through a private
libpq service file (docker/postgres/libpq-service.sh, mode 0600 on the container's tmpfs,
removed on exit, also after a failure), so the migrator password never appears in a
process's arguments, which every local user can read in `ps`. Use the wrapper so the
maintenance lock validation and wait apply; plain Compose does not enforce them.

### Maintenance lock

With an importer installed, **every manual and scheduled AirCase database backup and
restore, for dev and live, must set `AVIATION_MAINTENANCE_LOCK`** to the exact same host
file as the importer's `maintenanceLock`. Put it in each maintenance settings file or
timer's environment, not just an interactive shell. This lock protects AirCase's database
maintenance; unrelated services' backups do not use it. The optional setting leaves the
old behavior unchanged on installations without an importer.

Prepare the file once, owned by the user running both the importer and maintenance,
outside the repository in a dedicated private 0700 directory. `LOCK_DIR` must also be
outside the importer's managed root. Set `LOCK_DIR` to that directory before running:

```sh
# Creates the directory, or sets an existing dedicated directory's mode to 0700.
install -d -m 700 "$LOCK_DIR"
# Only this step refuses to replace an existing lock file.
(umask 077; set -C; : > "$LOCK_DIR/aircase-maintenance.lock")
```

The wrapper refuses a relative or missing path, directory, symlink, wrong owner or any
mode other than 0600. It also checks that the parent is a directory (not a symlink),
owned by the invoking user, with no group or other write bit. Keep it private and never
unlink, replace or rotate the file: `flock` locks its inode, so different files would not
exclude each other.
This is a host-local lock; use a local filesystem with working `flock` semantics.

The wrapper runs the Docker command under
`flock -w <seconds> -E 75 -- <lockfile> docker compose ...`, retaining the exclusive lock
until the command ends. `AVIATION_MAINTENANCE_LOCK_WAIT_SECONDS` defaults to **1500**;
it accepts whole seconds from 0 to 86400 (0 means no wait). A busy lock that reaches its
deadline exits **75** and emits exactly:

```text
AirCase maintenance lock timed out; backup/restore was not started.
```

No dump or restore container starts on that path. Once acquired, the Docker command's
exit status is propagated. Exit 75 means the lock timed out; no shipped script returns
75, so keep that status reserved for the wrapper's lock conflict. The importer uses a
nonqueuing exclusive flock on the same file: while maintenance owns it, import reports
`busy`; while import owns it,
maintenance waits only its configured interval. The 1500-second default leaves five
minutes after waiting in a timer with `TimeoutStartSec=30min`; size that timeout for
**wait plus actual dump time**, and alert on a timeout rather than bypassing the lock.
Stop with Ctrl-C or by stopping the systemd unit (its whole process group), not
`kill <pid>`: killing only the Node wrapper can leave a waiting `flock` that starts work
later. Before retrying, use `pgrep -x flock` (PIDs only) and check the unit's state to
ensure no earlier flock is waiting, and check that no previous one-shot container is
still running. Stop importer scheduling and wait for its active run before the wider
restore procedure (database removal, provisioning, migrations and reconciliation);
the wrapper's lock covers the restore command itself.

Run the offline contention proof before installation, then have the operator confirm
the configured importer and every maintenance entry point use the same file:

```sh
pnpm exec tsx scripts/maintenance-lock-proof.ts
```

It creates a private scratch file, holds it using the importer's inherited-descriptor
flock, verifies a waiting stand-in backup exits 75 without running, then holds it with
the wrapper's command form and verifies the nonqueuing importer fails. It also checks
release afterward and deletes its scratch files. Only harmless local Node processes
run: no database, Docker container, dump, shared lock or provider call is touched.

#### Controller proof against the configured host lock

After the importer and ops changes are merged, pause both schedules and wait for all
existing work to finish. Run as the common non-root owner, outside the importer's backup
deferral window. Export `IMPORTER_CONFIG` naming the private importer config and
`AVIATION_MAINTENANCE_LOCK` naming that config's lock file, and load the maintenance environment's normal
`AVIATION_ENV_FILES`/backup directory. First verify they name the same existing inode
without displaying either file's contents:

```sh
python3 - <<'PY'
import json, os
with open(os.environ['IMPORTER_CONFIG']) as source:
    config = json.load(source)
assert os.path.samefile(config['maintenanceLock'], os.environ['AVIATION_MAINTENANCE_LOCK'])
print('Maintenance lock identity matches.')
PY
# From the app directory; the parent holds fd 9 throughout the real wrapper attempt.
(
  set -eu
  exec 9<>"$AVIATION_MAINTENANCE_LOCK"
  flock -n 9
  result=0
  AVIATION_MAINTENANCE_LOCK_WAIT_SECONDS=1 pnpm app:backup 9>&- || result=$?
  test "$result" -eq 75
)
pnpm app:ps
```

Require the fixed timeout message and no backup container. Repeat for each maintenance
environment/entry point using its own settings; do not proceed on a configuration error
or an unexpected result. The fd closes on subshell exit; never delete the lock file.
For the reverse direction, use two terminals, with the same explicitly exported lock
path and importer config:

```sh
# Terminal A: harmless stand-in for the wrapper's locked command; leave it running.
flock -n -- "$AVIATION_MAINTENANCE_LOCK" sleep 300
# Terminal B: from the merged importer app directory, while A still owns the lock.
pnpm exec tsx worker/importer/host.ts run --config "$IMPORTER_CONFIG" --env dev --cache-only --no-change
```

Require a nonzero importer result with reason `busy`, before any acquisition or database
work; another refusal such as `backup_window` is not a passing proof. End the stand-in
in terminal A with Ctrl-C, confirm no waiter/one-shot remains, then resume scheduling
only after the remaining importer installation gates pass. This is the backup-exclusion
proof referred to by the importer's installation guide.

### Schedule, encryption, expiry and drills

Nothing in this repository schedules backups or copies them off the host: that is the
operator's duty, at least for `live`.

1. **Daily**, a host timer (cron or a systemd timer) runs, as the user that owns the
   backup directory, `cd <checkout>/apps/aviation-investigations && pnpm app:backup` with
   the environment's `AVIATION_ENV_FILES`, `AVIATION_BACKUP_DIR` and the shared
   `AVIATION_MAINTENANCE_LOCK` ([Maintenance lock](#maintenance-lock)).
2. **Encrypted, off the host** (DESIGN §11): encrypt each new file to a key that is not on
   the host (for example `age -r <recipient> -o <file>.age <file>`, then remove the plain
   file) and copy the encrypted file to a destination off the host. A backup holds the
   ledger and the HMAC-keyed quota and abuse records; treat it like the database.
3. **Expiry**: backups expire within 30 days. Delete local and off-host copies older than
   that (`find <dir> -name 'aviation_<env>-*.dump*' -mtime +30 -delete`, and the off-host
   store's own lifecycle rule).
4. **Restore drill**, monthly and after any migration that adds tables or changes grants:
   decrypt the newest backup into a private directory and run
   `pnpm db:restore-drill <file>`. It needs Docker only: it restores the file with the same
   script as `app:restore` into a throwaway PostgreSQL 16 server, applies the migrations,
   runs the restore check, confirms that paid operations are blocked (held for the app
   login, spend refused for the ingest login), removes the server again, and ends with
   `drill passed`; anything else fails it.

### Restoring

With the app stopped (`pnpm app:down`), and the backup decrypted into
`AVIATION_BACKUP_DIR`, with `AVIATION_MAINTENANCE_LOCK` set as above and importer
scheduling paused with no active run:

```sh
# 1. As the cluster administrator: drop the damaged database if it still exists, then
#    provision the environment again (Provisioning). It creates an empty database with the
#    roles, schemas and default privileges, and keeps the passwords of the connection files.
psql "<administrator URL of the database server>" -c 'DROP DATABASE IF EXISTS aviation_<env> WITH (FORCE)'
pnpm provision:shared --env <env> --out <dir> --pg-admin-env <file> ...
# 2. Restore as the migrator login, in one transaction that also holds paid operations. It
#    refuses a database that is not empty, and a restore that fails leaves the database
#    empty: fix the cause, run it again.
pnpm app:restore aviation_<env>-<time>.dump
# 3. The migrations newer than the backup.
pnpm app:migrate
# 4. On a host with the environment's host-side DATABASE_MIGRATOR_URL (as for pnpm worker
#    migrate): holds paid operations (next section), then checks that every owner and grant
#    is the one a freshly migrated database has and that the tables a backup never holds
#    are empty, naming every difference. Only for a dump made before those exclusions:
#    `pnpm worker restore-check --empty` empties those tables and checks again.
pnpm worker restore-check
# 5. Only after it passed, open the service. Paid operations stay held.
pnpm app:up
# 6. Charge the spend the restored ledger lacks, which releases them (next section).
pnpm worker restore-reconcile --interactive-usd <n> --ingestion-usd <n> --note "<source of the figures>"
```

Why it is done this way (docker/postgres/restore.sh):

- **The migrator restores.** Every object is created by `aviation_migrator` and so owned
  by it, as the migrations expect, and the dump's grants are applied as they were.
  Restoring as the administrator with `--no-owner`, as this runbook once said, makes the
  administrator own every table and `SECURITY DEFINER` function: `app:migrate` then fails
  with `permission denied for table __drizzle_migrations`, and functions such as
  `prune_controls()` and `publish_manifest()` run as a superuser.
- **Provisioning's default privileges are suspended during the restore.** They let the
  runtime roles read every table the migrator creates, and `pg_dump`'s grants never revoke
  them. Restored with them in force, both runtime roles read tables they must not:
  `aviation_ingest` the 14 sign-in, brief, idempotency, quota, lease, trial, Turnstile and
  abuse tables, `aviation_app` all of `cases` (the internal event ids too),
  `embedding_cache`, `quarantine` and `ingestion_runs`. The restore clears them in its
  transaction; the dump puts them back at its end. `restore-check` names any such grant.
- **One transaction.** `COMMIT` is sent only after `pg_restore` produced the whole dump, so
  a truncated or corrupt file restores nothing. The schema `drizzle` (provisioning created
  it) and the grants on schema `public` (provisioning sets them) are skipped.

`restore-check` fails on any other owner, any grant too many or too few, and on an excluded
table the migrator cannot read. Do not open a service whose database fails it: restore
again into a freshly provisioned database. Roles, the database, its schemas and their
grants come from provisioning (`pnpm provision:shared`); grants on tables, sequences and
functions come from the dump and are checked against `server/db/privileges-expected.ts`
(regenerate it with `pnpm db:privileges` after a migration that changes them).

### Paid operations after a restore

A backup's ledger (`cost_ledger`, `reservations`) ends when the backup was taken. What was
spent afterwards is missing from the restored database but still billed by the providers,
so a service opened on it could spend the same daily and monthly allowance again. A
restored database therefore holds every paid operation (`server/quota/hold.ts`, migration
0020): AI answers are paused for maintenance (`GET /api/ai/status` says `paused`,
`maintenance`) and indexing and evaluation spend is refused (`restore_hold`). Search, case
pages and the dashboard work as usual.

The restore itself holds them, in its own transaction (`pnpm app:restore` ends with
docker/postgres/after-restore.sql, which also records the restore in `drizzle.restores`),
so a restored database never opens with paid operations allowed. A backup taken before
migration 0020 has no hold table yet: its restore only records itself, and `pnpm
app:migrate` then starts held. `pnpm worker restore-check` sets the hold again. Nothing
depends on database OIDs, which a new cluster can repeat. `pnpm worker ai-switch --on` does
not release the hold (`pnpm worker ai-switch` shows it). Only the reconciliation does. It runs as `aviation_migrator`, with the environment's host-side
`DATABASE_MIGRATOR_URL` and the same budget settings as the app (its settings file in
`AVIATION_ENV_FILES`):

```sh
# The spend since the backup (its file name carries the time) that the ledger lacks, from the
# providers' usage pages for this environment's keys: Anthropic and OpenAI usage of AI
# answers as --interactive-usd, embeddings for indexing and evaluation calls as
# --ingestion-usd. Preview first; nothing changes.
pnpm worker restore-reconcile --interactive-usd <n> --ingestion-usd <n> --note "<source>" --dry-run
pnpm worker restore-reconcile --interactive-usd <n> --ingestion-usd <n> --note "<source>"
# Without those figures: charge everything the budgets still allow this month. Paid
# operations then stay at zero until the next UTC month. Preview it with --dry-run too.
pnpm worker restore-reconcile --charge-remaining --note "<why>"
```

`--charge-remaining` computes what is left from the budgets the app runs with, so it
refuses unless `AI_MONTHLY_BUDGET_USD`, `AI_INTERACTIVE_MONTHLY_BUDGET_USD` and
`AI_INGESTION_MONTHLY_BUDGET_USD` are set (normally by the app's settings file in
`AVIATION_ENV_FILES`); it never falls back to the defaults, which would leave larger real
budgets spendable. For an app that runs on the defaults, set the three to them explicitly.
It prints the budgets it used (`budgets used: ...`); check them against the app's before
the real run.

In one transaction under the spend lock it charges every reservation the backup left open
at its full amount (the outcome of those requests is unknown), then the given amounts
(interactive, and indexing and evaluation together, which share one allowance) to the
current day, and releases the hold. It refuses, changing nothing, when nothing is held or
while a reservation of the backup still has a running lease (it names the time to wait
for). A provider's usage page counts every use of a key: when a key also serves something
else, or a figure cannot be split between the two amounts, the larger figure is the safe
one. After moving the database to another server by dump and restore, the ledger is
complete: reconcile with `--interactive-usd 0 --ingestion-usd 0`.

## Retention and maintenance

Nothing grows without bound, but two kinds of retention run differently:

- **Control data** (idempotency records, quota buckets, abuse records, trial
  identities, redeemed Turnstile tokens, ledger lines and closed reservations), expired
  sign-in sessions and OAuth state, and **expired leases** are handled by the API server itself. About every 10 minutes (jittered), each
  `aviation-app` instance tries a PostgreSQL advisory lock and, if it gets it, expires
  leases of unsettled reservations (charged in full, as the cost gate requires) and calls
  `prune_controls()`. Several instances do not overlap; a failure is logged (the error
  type only) and retried at the next pass, and never stops the server. This runs as
  `aviation_app`, which already holds `EXECUTE` on `prune_controls()` and the table
  privileges lease expiry needs (migration 0008), so no grant was added and no host
  cron or systemd timer is needed. The pass also marks brief steps whose process died as
  failed and deletes expired sign-in rows. To run the same pass once by hand, under the
  same lock (a host with `DATABASE_URL`, the `aviation_app` login, in `AVIATION_ENV_FILES`
  or `.env.local`; the ingest container does not hold that credential):
  `pnpm worker prune-controls`. It prints what each step did and exits 1 if one failed.
- **Generations** are pruned only on request. Run it after publishing a new generation
  (and after a rollback has settled):

  ```sh
  pnpm ingest prune-generations --dry-run    # lists what would be deleted; deletes nothing
  pnpm ingest prune-generations              # keeps the active, pinned and the two most recently published, and any an unexpired AI brief cites
  pnpm ingest prune-generations --grace-hours 48   # never-published generations are kept this long (default 24)
  ```

  Pruned generations take their case rows and manifest rows with them, so run the dry
  run first. Their indices then belong to no manifest; delete them afterwards with
  `pnpm ingest index delete-unused --older-than <hours>`, first without `--yes`
  ([Ingestion](#ingestion)).

## Google sign-in

Sign-in is off until the environment has a Google OAuth client (README, "Google sign-in
and accounts"); the site then offers no sign-in and `/api/auth` answers 404. To turn it
on for an environment:

0. Publish the owner's final privacy notice first (DESIGN §7: before collecting real
   users): replace the text of `web/src/pages/Privacy.tsx` and set `final: true` in
   `shared/privacy.ts`, and deploy (done: the owner approved the notice on 24 October
   2026). Without a final notice live keeps sign-in off whatever is
   configured, and says so in the startup log ("Google sign-in off ... final privacy
   notice"). The About page's AI line follows the AI status (Task 23): "AI features are
   not available yet." while `/api/ai/status` says AI is off, and the evidence view's line
   once AI searches are offered, so opening AI needs no change there
   (`tests/web/brand.test.tsx` checks both).
1. In the Google Cloud console, configure the OAuth consent screen (External; the app
   name AirCase, support email and the privacy notice URL `<APP_URL>/privacy`; scopes `openid`,
   `email` and `profile` only, which need no verification) and create an OAuth client of
   type *Web application*, one per environment, with the authorized redirect URI
   `<APP_URL>/api/auth/callback/google`. No JavaScript origin is needed: the browser
   never talks to Google's APIs.
2. Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the environment's settings
   file, with a `BETTER_AUTH_SECRET` of at least 32 random characters (for example
   `openssl rand -base64 32`), and redeploy. `IDENTITY_HMAC_SECRET` must already be set.
3. Check: `GET /api/config` answers `googleEnabled: true`, and the startup log no longer
   says "Google sign-in off".

Changing `BETTER_AUTH_SECRET` signs everyone out and fails sign-ins in flight; changing
`IDENTITY_HMAC_SECRET` also detaches every account from its usage counts and anti-abuse
record, like the trials'. Revoking the client in Google stops new sign-ins; sessions
already issued last until they expire (7 days) unless their users sign out, or the
secret is changed.

Starting a sign-in writes nothing to the database: the OAuth state lives in an encrypted
cookie for 10 minutes. Better Auth limits starts and Google's callbacks to 10 a minute
each per network identity (in each instance's memory). A deletion's re-authentication is
counted per account instead, so other sign-in traffic from its network never holds it up:
its start (5 an hour; past that it answers 429 with Retry-After) and Google's callback to
the signed-in browser (5 an hour; past that the network's limit applies to it).

**Deleting an account needs a recent Google sign-in** (server/auth/deletion.ts): a
session signed in within the last 5 minutes may delete at once; any other is sent through
Google again (for the same account, with Google's account chooser) and comes back with a
5-minute, single-use confirmation, and the session it had before ends. The log line
"sign-in re-authentication" says `confirmed`, `not_confirmed` or `other_account`.

**Extra checks for signed-in AI** (DESIGN §8; server/identity/step-up.ts). Ordinary
signed-in AI requests take no Turnstile check. One does when its account made 3 AI
attempts in the current minute, has used half of today's allowance, or its network made
10 signed-in attempts in the current hour; the log line "signed-in AI request checked"
names the signal and whether the check passed. During an attack on signed-in AI, check
every signed-in request, and go back afterwards:

```sh
pnpm worker ai-switch --account-check always
pnpm worker ai-switch --account-check suspicious
```

## Tunnel mode

`live` is reached only through a Cloudflare Tunnel; the app publishes no port.

1. In Cloudflare Zero Trust, create a remotely managed tunnel and add a public
   hostname whose service is `http://aviation-app:3000`. Live's is `aircase.app`.
2. Put its token in the live settings file as `TUNNEL_TOKEN`, the public origin in
   `APP_URL` (`APP_URL=https://aircase.app` on live), a release tag in `APP_VERSION` and
   an unused private /28 in `EDGE_SUBNET`.
3. `pnpm app:up`. The wrapper adds `compose.tunnel.yaml`, which removes the app's
   port, requires the token, pins the edge subnet and sets `TRUSTED_PROXY_CIDRS`,
   and the `tunnel` profile:

   ```sh
   docker compose -p ai-aviation-live --env-file "$ENV_FILE" \
     -f compose.yaml -f compose.tunnel.yaml --profile app --profile tunnel up -d
   ```

4. Check that nothing is published: `APP_ENV=live pnpm app:ps` shows no ports
   for `aviation-app`.
5. Check the connector: the `tunnel` service has no health check (its image has no
   shell or HTTP client), so `pnpm app:up --wait` succeeds even with a wrong
   `TUNNEL_TOKEN` while `cloudflared` keeps restarting. Read
   `docker compose -p ai-aviation-live logs tunnel` for a registered connection and
   check that the tunnel shows as healthy in Cloudflare Zero Trust, then open the public
   hostname.

In tunnel mode the app serves only peers inside `TRUSTED_PROXY_CIDRS` (anything else
gets 403, except its own loopback health check) and takes the client address from
`CF-Connecting-IP`, which the API requires (400 when it is missing or invalid). Rate
limits count per client address (IPv6 per /64).

The connector (`cloudflare/cloudflared:2026.10.0`, pinned) shares only the `edge`
network with `aviation-app`. Test origin restrictions from outside and from another
container on the host before launch (DESIGN §11).

## Search engines

Only live is open to crawlers: its `/robots.txt` allows everything and names
`https://aircase.app/sitemap.xml`, while every other environment disallows everything and sends
`X-Robots-Tag: noindex, nofollow` on every response (README, "Search engines and link
previews"). Registering live with the search engines is an owner step, done once:

1. **Google Search Console** (search.google.com/search-console): add a property of type
   *Domain* for `aircase.app`. Google shows a TXT record (`google-site-verification=…`). In
   Cloudflare, under the zone's DNS records, add a record of type TXT, name `@` (the apex),
   with that value as content, then select *Verify* in Search Console. A domain property
   covers `https://aircase.app` and any subdomain; keep the record, since Google checks it
   again later.
2. In the property, under *Sitemaps*, submit `https://aircase.app/sitemap.xml`. It lists the
   page sitemap and one file per 10,000 case pages; it changes with each published dataset,
   and search engines read it again on their own.
3. **Bing Webmaster Tools** (bing.com/webmasters): sign in and import the site from Google
   Search Console, which verifies it through the Google property; or add `https://aircase.app`
   and verify it with the DNS record Bing shows, added in Cloudflare like Google's. Under
   *Sitemaps*, submit `https://aircase.app/sitemap.xml`.
4. Check: `curl -s https://aircase.app/robots.txt` shows Cloudflare's content-signals comments
   followed by `User-agent: *`, `Allow: /` and the `Sitemap:` line; `curl -sI
   https://aircase.app/cases/<a number>` answers 200 without an `X-Robots-Tag`, and an unknown
   number 404. Search Console's URL inspection of a case page shows that the canonical URL it
   found is the page's own.

## Tracing

Tracing is off unless `AVIATION_TRACING_ENABLED=true`. Then the wrappers add
`compose.tracing.yaml`, which joins `aviation-app` and `aviation-ingest` to the external network
`SHARED_OBSERVABILITY_NETWORK` and passes the Langfuse variables (all required).
`LANGFUSE_BASE_URL` is the Langfuse web service's address on that network. The server
accepts https, or plain http only to a host listed in `AVIATION_TRACING_HTTP_HOSTS`: a
Langfuse reached over plain http by its service name on that network needs that name
there (for example `AVIATION_TRACING_HTTP_HOSTS=langfuse-web` for
`http://langfuse-web:3000`). Otherwise the server logs `tracing off` with the reason at
startup and exports nothing; `tracing on` confirms export. Use the
`aviation-dev` project's keys for `dev` and `aviation-live`'s for `live`. The
network may not exist on other machines, which is why it is an override.

```sh
docker compose -p ai-aviation-dev --env-file "$ENV_FILE" \
  -f compose.yaml -f compose.tracing.yaml --profile app up -d --build
```

## Listing this app's containers

```sh
pnpm app:ps                                                  # current APP_ENV
docker compose -p ai-aviation-live ps -a                     # one environment
docker ps -a --filter label=ai-apps.app=aviation-investigations
docker ps -a --filter label=ai-apps.app=aviation-investigations --filter label=ai-apps.environment=dev
docker compose -p ai-aviation-local ps                       # local services
```

In the app directory `compose.yaml` needs `APP_ENV`, so run the `docker compose -p`
lines with `APP_ENV` set or from another directory. Container UIs group the
containers by Compose project. Nothing here uses `container_name`.

## Local-services mode

For contributors without the shared stack and for `pnpm test:integration`:

```sh
pnpm services:up      # project ai-aviation-local: PostgreSQL 16.2 and Elasticsearch 9.5.5
pnpm services:setup   # environments dev and test with the role model above, into .env.local
pnpm db:migrate       # aviation_dev; the integration tests migrate aviation_test
pnpm test:pg16        # the same suite after checking the server is PostgreSQL 16
pnpm services:down    # volumes are kept
```

`services:setup` provisions two local environments with the same code as the
shared provisioning: `dev` (database `aviation_dev`, indices `ai-aviation-dev-*`,
the `DATABASE_*` and `ELASTICSEARCH_*` variables) and `test` (database
`aviation_test`, indices `aviation-test-*`, the `TEST_DATABASE_*` and
`TEST_ELASTICSEARCH_*_API_KEY` variables of the integration tests).

`pnpm db:migrate` and the integration tests refuse a database whose recorded migrations
differ from the checkout's: one recorded with other content (edited after it was applied),
or missing below a later one (another checkout migrated it). Over a database that recorded
an earlier version of migration 0020 or 0021, which changed after the local test database
had recorded them, the migrator runs the current version again instead (it converges). For
any other difference, reset the local test database, which holds only disposable test data:

```sh
docker compose -f compose.local-services.yaml --env-file .env.local exec postgres \
  psql -U postgres -c 'DROP DATABASE aviation_test WITH (FORCE)'
pnpm services:setup        # provisions aviation_test again, keeping the passwords
pnpm db:migrate --test     # or the next pnpm test:integration
```

Both services publish loopback-only ports (`POSTGRES_PORT`, default 55432, and
`ELASTICSEARCH_PORT`, default 59200) for host-side tools: setup, migrations, the
integration tests and `pnpm worker`. These ports are for development only.
Host-side commands read `.env.local`; its URLs point at those loopback ports.

To run the application containers against the local services instead of the
shared ones, write a separate env file (outside the repo or under an ignored
name) with `SHARED_POSTGRES_NETWORK=ai-aviation-local_default`,
`SHARED_ELASTICSEARCH_NETWORK=ai-aviation-local_default`, the `dev` URLs from
`.env.local` with host `postgres:5432`, `ELASTICSEARCH_URL=http://elasticsearch:9200`
and the API keys from `.env.local`.

The local PostgreSQL is pinned to 16.2, the shared server's version. A data directory
cannot be reused across major versions, and the 16.2 image refuses to start on one
another major version made. If that happens, remove the volume once and provision again
(this deletes the local `aviation_dev` and `aviation_test` databases, which hold only
disposable data; the Elasticsearch volume is not touched):

```sh
pnpm services:down
docker volume rm ai-aviation-local_postgres-data
pnpm services:up
pnpm services:setup   # keeps the passwords and keys that .env.local still holds
pnpm db:migrate
```

## PostgreSQL 16 compatibility

The shared server and the local services both run PostgreSQL 16.2, so that the
integration tests exercise the version the deployments use. The `MAINTAIN`
privilege exists only from 17, so every `MAINTAIN` grant or revoke in the
migrations runs inside a `DO` block guarded by `server_version_num >= 170000`; the
guards keep the migrations valid on a later server.
The loader refreshes statistics through `analyze_corpus()`, a `SECURITY DEFINER`
function owned by `aviation_migrator` with a fixed `search_path` (migration 0003),
so it needs no `MAINTAIN`. Already-migrated databases are unaffected by the
guards; no new migration was needed. Later migrations follow the same pattern
(0010, the index build and alias switch tables, revokes `MAINTAIN` only on 17+;
0012, `passages` and `embedding_cache`, uses `REVOKE ALL`, which covers `MAINTAIN`
on 17 and is valid on 16; 0011 changes no privileges). The integration suite
migrates `aviation_test` through every migration, so `pnpm test:integration` checks
them and the suite on 16.2. `pnpm test:pg16` checks that the test database's server is PostgreSQL 16 and then
runs the same integration suite.

## Application image

`Dockerfile` builds `ai-aviation/app:${APP_VERSION:-dev}` in stages: dependencies
with pnpm from corepack (version pinned by `packageManager`), the Vite and
TypeScript builds, production dependencies only, and a `node:24.21.0-trixie-slim`
runtime pinned by tag and digest, from which npm, npx, corepack and yarn are
removed. The runtime keeps the checkout layout with compiled JavaScript
(`/app/server`, `/app/worker`, `/app/shared`, `/app/dist/web` with the font
licences), plus the SQL migrations, verification profiles and the report-link
seed; no TypeScript sources or development dependencies. `.dockerignore` keeps
the `.gitignore` secret patterns (`.env*` except `.env.example`, keys,
certificates, `credentials/`, `secrets/`) at any depth, every `data/` and
`node_modules/`, build and test outputs, tests, docs and evaluations out of the build
context. pnpm itself is pinned by version and sha512 (`packageManager`), which corepack
checks when the image is built.

Before each release, check advisories: `pnpm audit --prod` for the runtime dependencies,
and an image scanner (for example `docker scout cves ai-aviation/app:<tag>`) for the
release image and the pinned base images (node, `postgres:16.2`, `cloudflared`, and the
extraction image's Debian). Fix or record each finding before deploying; update a pin's
tag and digest together.

## Task 25: prompt mirrors, ratings and the admin overview

1. Deploy the release as in [Deploying an environment](#deploying-an-environment): run
   `pnpm app:migrate`, which applies migration **0026_search_observability** with the
   migrator, then the free [AI preflight](#ai-preflight), then `pnpm app:up`. The migration adds
   private trace/rating columns, identity-free daily feedback totals and
   reservation-lifetime outcome metadata. Existing evidence.v3 responses are unchanged.
   Regenerated privilege checks include all new tables/functions; backups include daily
   totals and 90-day outcome metadata and still exclude private evidence rows.
2. Set `AIRCASE_ADMIN_EMAILS` in the environment's private configuration (comma-separated
   verified Google emails). An empty value means no admins. Restart the app after a
   change. Never commit real addresses. Test that an ordinary signed-in account and a
   signed-out visitor both get 404 at `/api/admin/overview`.
3. Load the matching environment's Langfuse project credentials through the existing
   `AVIATION_ENV_FILES` mechanism. Host Node clients must start with the appropriate
   `NODE_EXTRA_CA_CERTS`; Docker uses its configured trusted endpoint. Run
   `pnpm -s worker langfuse-prompts --sync` before releasing linked generation spans.
   It only calls Langfuse, never a model provider. Run it again to verify idempotence.
   The two returned content hashes must match; a modified mirror or a version other
   than 1 is a release failure. Do not edit the mirror in the Langfuse UI; resolve drift
   against the frozen code and review any deliberate prompt version change.
4. In the admin overview, check tracing enabled, last successful export and failed
   export count. A null success timestamp before the first export is normal. An outage
   logs `tracing_export_failed` with a cumulative count no more than once per five
   minutes; never enable verbose upstream response/error logging to investigate it.
   The counts reset on process restart. Scores are best effort and may lag or be lost;
   use PostgreSQL feedback totals as the authoritative rating count.

**Open tabs.** A tab left open across the deploy keeps the previous client, whose strict account
schema refuses the new `user.id`: it shows the account read as failed until it is reloaded.

**Record with the release** (Task 25 security review, condition 4): the live migrator applied
0026 and the privilege baseline was verified; the live allowlist holds only the intended verified
accounts; the prompt sync used the live project and its second run returned the same content
hashes at version 1; and the free preflight passed with the final live settings.

**Rolling back.** Keep migration 0026: set the previous release's `APP_VERSION` and run
`pnpm app:up`, which starts its tagged image unchanged (rollback in
[Deploying an environment](#deploying-an-environment)). There is no down migration and no
database restore. The migration only adds nullable columns, two tables and their triggers:
the previous release never writes the new columns, the triggers go on recording search
usage, and its retention still prunes those records with their reservations after 90 days.
Ratings, progress reads and the admin overview return with the next deployment of this
release; the daily rating totals already kept stay.

Progress reads have their own polling allowance (shared with brief polling), no model
calls and no identity creation. The browser should poll at about 2 Hz, retain its random
idempotency key, and display generic loading on 404 or after a process restart. For a
cookieless first search, changing the normalized network identity invalidates progress;
this does not cancel the search or change its charge. Later searches use the signed
trial or account presented when their POST arrived. All progress, feedback and admin
responses, including errors, are private/no-store.

Admin usage dates are UTC accounting days. Search counts, active visitors, failures
and free undos cover evidence searches only; AI briefs are excluded. Charged searches
exclude quota-refunded failures and exempt undos; mean cost divides all settled
interactive spend in the month (including any brief spend) by charged evidence searches.
`costs.today` includes every category for the UTC day; `costs.interactiveToday` includes
only interactive spend, for comparison with the daily interactive budget. Undos are
admissions, including failed undo attempts; failures are also reported separately. The first rating chooses its aggregate day, even if the
visitor changes it after midnight. All-time feedback totals survive search expiry and
account deletion, without identities. The migration cannot reconstruct already-expired
pre-0026 free undos; without outcome metadata a reservation counts as neither a failure
nor a free undo. Per-account search counts stop at 90 days. The overview is bounded
to 1,000 returned users, 50 cost groups, and 10,000 accounts processed; it refuses beyond
that processing bound with 503 and log category `admin_overview_user_limit`.
The whole overview has a 15-second deadline in addition to five-second SQL statement
limits; timeout returns 503 with `admin_overview_timeout`. Any held overview transaction
is destroyed on timeout. Expand this implementation before reaching the account bound.
The dataset's next automatic import stays null: none is scheduled.
