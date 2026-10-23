# Aviation Casebook runbook: containers and deployment

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

## Containers

| Service | Profile | Label `ai-apps.component` | Purpose |
| --- | --- | --- | --- |
| `aviation-app` | `app` | `app` | Fastify API and the built web client on one origin |
| `aviation-ingest` | `tools` | `ingest` | Worker CLI, one-shot (`run --rm`) |
| `aviation-migrate` | `tools` | `migrate` | Schema migrations, one-shot |
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
| `extract` | none | none | none | the MDB file read-only; no network |
| `tunnel` | none | none | `TUNNEL_TOKEN` | none |

With tracing on (see [Tracing](#tracing)), `aviation-app` and `aviation-ingest` also get
`LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`.

### Hardening

- The application image runs as uid 1000 (`node`); `aviation-ingest` runs as the host user
  that owns `data/` (`pnpm ingest` sets `AVIATION_UID`/`AVIATION_GID`; the
  extraction outputs are mode 0600). Extraction containers run as uid 65534.
- Read-only root filesystem with a 64 MB `/tmp` tmpfs, all Linux capabilities
  dropped, `no-new-privileges`, and memory/CPU limits (app 1 GB, ingest 2 GB).
- No Docker socket, no home-directory mounts. The only host paths mounted are
  the app's `data/` directory (ingest) and the Elasticsearch CA file.
- Logs use the `json-file` driver, 10 MB × 3 files per container. Long-running
  services restart `unless-stopped`; one-shot tools never restart.
- Images built here use `pull_policy: never`: `ai-aviation/*` names are never
  fetched from a registry.

## Networks

| Network | Members | Notes |
| --- | --- | --- |
| `edge` | `aviation-app`, `tunnel` | Per project. App ingress and the outbound route to Cloudflare and the model, embedding, OAuth and Turnstile APIs. Nothing else joins it. Pinned to `EDGE_SUBNET` in tunnel mode. |
| `egress` | `aviation-ingest` | Per project. Outbound route for the embeddings API. |
| `postgres` | `aviation-app`, `aviation-ingest`, `aviation-migrate` | External, `SHARED_POSTGRES_NETWORK`. |
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
host-side values such as `DATABASE_URL` before running the wrappers. The variable
names are documented in `.env.example`.

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
APP_URL=                         # public origin on live (https: Turnstile hostname, Secure trial cookie)
PORT=3000                        # dev only: loopback port of the app
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
BETTER_AUTH_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
TURNSTILE_SECRET_KEY=            # a widget for APP_URL's hostname; dev may use Cloudflare's test keys, live refuses them
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
the env files, and add `compose.tracing.yaml` when `AVIATION_TRACING_ENABLED` is
true. They never print values, and they refuse to run when:

- Docker Compose is older than 2.24;
- `APP_ENV` is not `dev` or `live`, the env files disagree on it, or the shell's
  `APP_ENV` differs from the files';
- a variable the command needs is missing;
- the command's database URL (`DATABASE_URL` for `app:up`, `DATABASE_INGEST_URL`
  for `ingest`, `DATABASE_MIGRATOR_URL` for `app:migrate`) does not name
  `aviation_<APP_ENV>` or lacks the `options=-c role=<group>` switch;
- `ELASTICSEARCH_INDEX_PREFIX` is not `ai-aviation-<APP_ENV>`;
- on `live`: `APP_VERSION` is missing or `dev` (for `app:up`, `ingest` and
  `app:migrate`), or `TUNNEL_TOKEN` is missing for `app:up`;
- in tunnel mode: `EDGE_SUBNET` is missing or not a private, aligned /16 to /29.

`app:up` always runs tunnel mode on `live` (`compose.tunnel.yaml` and the `tunnel`
profile), so `live` never publishes a port. On `dev` it runs tunnel mode when
`TUNNEL_TOKEN` is set and otherwise publishes `127.0.0.1:${PORT:-3000}`.

```sh
export AVIATION_ENV_FILES=...       # see Env files

pnpm app:migrate               # schema migrations (aviation-migrate container)
pnpm app:up                    # build the image, start app (and tunnel), wait until healthy
pnpm app:ps                    # this environment's containers, one-offs included
pnpm ingest generations        # any worker command in a one-shot ingest container
pnpm app:down                  # stop and remove this environment's containers
pnpm extract:image             # build ai-aviation/extract:mdbtools-1.0.0
```

The same with plain Compose, from the app directory:

```sh
docker compose -p ai-aviation-dev --env-file "$ENV_FILE" --profile tools run --rm aviation-migrate
docker compose -p ai-aviation-dev --env-file "$ENV_FILE" --profile app up -d --build
docker compose -p ai-aviation-dev --env-file "$ENV_FILE" --profile tools run --rm aviation-ingest generations
docker compose -p ai-aviation-dev --env-file "$ENV_FILE" --profile app --profile tools --profile tunnel down
```

Pass one `--env-file` per file, lowest priority first. `compose.yaml` refuses to
load without `APP_ENV`. Plain Compose does not apply the wrappers' checks: on
`live` always add `-f compose.tunnel.yaml --profile tunnel`, or the app publishes
its loopback port. Run `aviation-ingest` with
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

To update: pull the code, set a new `APP_VERSION` on `live`, run
`pnpm app:migrate` and the [AI preflight](#ai-preflight), then `pnpm app:up`. To roll
back, set the previous `APP_VERSION` (its image is still local) and run `pnpm app:up`;
migrations are not reversed.

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
`meta.retrieval` (`casesIndex`, `casesIndexVersion`, with the mapping counts). The
pairing ties a cases index to a generation, not to a brief: republishing the passages
index invalidates the briefs made from the old one (their later steps fail
`no_cases_index`), and republishing only the cases index can change what later
retrieval returns for the same question (compare a step's `meta.retrieval.casesIndex`
with the manifest when that matters).

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

Extraction needs the Docker CLI to start its sandbox containers, so it runs on the
host, never in the `aviation-ingest` container (which has no Docker socket):

```sh
pnpm extract:image
APP_ENV=dev pnpm worker extract --archive data/research/avall.zip --sha256 <hex> --out data/work/<dir>
```

Its containers are named `ai-aviation-<env>-extract-<hex>` and labelled as one-off
containers of service `extract` in project `ai-aviation-<env>`, so they appear in
`pnpm app:ps` while they run. They have no network, a read-only root, no
capabilities, uid 65534, 1 GB memory, 2 CPUs and 64 processes, and are always
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
within seconds; public responses may stay cached for up to five minutes.

The `index` commands (README, "Cases index") use the environment's write API key,
so they create and switch only `ai-aviation-<env>-*` indices. A build deletes only
its own index, and only when it failed before any alias request; every other index
stays until an explicit `index delete-unused --older-than <hours> --yes`.

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
   container; `AI_PARTIAL_DISPLAY` is read at start.
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
| AI briefs | the scope, answer and check models per request | about $0.11 a typical request with the Opus answer model, reserving its worst case of $0.36 until it settles (DESIGN §9); capped by the budgets below |
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
- trial, usage, lease, idempotency and abuse records (`trial_identities`,
  `usage_buckets`, `leases`, `idempotency`, `abuse_records`);
- the report links (`report_links`) and their provenance, and the passage embedding
  cache (`embedding_cache`), which is what keeps a rebuild from paying again;
- the generation pins and the index build records.

Rebuildable: the Elasticsearch indices. They are built from PostgreSQL (the cases
index) and PostgreSQL plus `embedding_cache` (the passages index), so after a restore
run `index cases`, `index passages` (free while the cache is complete) and `publish`.
Verification reports under `data/reports/` and the extraction directories are
derived and need no backup; the source archive is kept wherever you keep it.

```sh
# One environment's database, as a role that can read everything in it. Run it on the
# host that can reach the database; keep the file off the repository and encrypted.
pg_dump --format=custom --no-owner --file "<backup-dir>/aviation_<env>-$(date +%F).dump" \
  "postgresql://<backup-role>@<db-host>:<port>/aviation_<env>"

# Restore into an empty database, then re-run the migrations to check the schema.
pg_restore --no-owner --dbname "postgresql://<admin-role>@<db-host>:<port>/aviation_<env>" "<backup-dir>/<file>.dump"
pnpm app:migrate
```

Roles and grants are part of provisioning, not of the dump (`pnpm provision:shared`).

## Retention and maintenance

Nothing grows without bound, but two kinds of retention run differently:

- **Control data** (idempotency records, quota buckets, abuse records, trial
  identities, redeemed Turnstile tokens, ledger lines and closed reservations) and
  **expired leases** are handled by the API server itself. About every 10 minutes (jittered), each
  `aviation-app` instance tries a PostgreSQL advisory lock and, if it gets it, expires
  leases of unsettled reservations (charged in full, as the cost gate requires) and calls
  `prune_controls()`. Several instances do not overlap; a failure is logged (the error
  type only) and retried at the next pass, and never stops the server. This runs as
  `aviation_app`, which already holds `EXECUTE` on `prune_controls()` and the table
  privileges lease expiry needs (migration 0008), so no grant was added and no host
  cron or systemd timer is needed. To run it by hand (a host with `DATABASE_URL`, the
  `aviation_app` login, in `AVIATION_ENV_FILES` or `.env.local`; the ingest container does not hold
  that credential): `pnpm worker prune-controls`.
- **Generations** are pruned only on request. Run it after publishing a new generation
  (and after a rollback has settled):

  ```sh
  pnpm ingest prune-generations --dry-run    # lists what would be deleted; deletes nothing
  pnpm ingest prune-generations              # keeps the active, pinned and the two most recently published
  pnpm ingest prune-generations --grace-hours 48   # never-published generations are kept this long (default 24)
  ```

  Pruned generations take their case rows with them, so run the dry run first, and
  delete the indices that belonged to them afterwards with
  `index delete-unused --older-than <hours>` (above).

## Tunnel mode

`live` is reached only through a Cloudflare Tunnel; the app publishes no port.

1. In Cloudflare Zero Trust, create a remotely managed tunnel and add a public
   hostname whose service is `http://aviation-app:3000`.
2. Put its token in the live settings file as `TUNNEL_TOKEN`, the public origin in
   `APP_URL`, a release tag in `APP_VERSION` and an unused private /28 in
   `EDGE_SUBNET`.
3. `pnpm app:up`. The wrapper adds `compose.tunnel.yaml`, which removes the app's
   port, requires the token, pins the edge subnet and sets `TRUSTED_PROXY_CIDRS`,
   and the `tunnel` profile:

   ```sh
   docker compose -p ai-aviation-live --env-file "$ENV_FILE" \
     -f compose.yaml -f compose.tunnel.yaml --profile app --profile tunnel up -d --build
   ```

4. Check that nothing is published: `APP_ENV=live pnpm app:ps` shows no ports
   for `aviation-app`.

In tunnel mode the app serves only peers inside `TRUSTED_PROXY_CIDRS` (anything else
gets 403, except its own loopback health check) and takes the client address from
`CF-Connecting-IP`, which the API requires (400 when it is missing or invalid). Rate
limits count per client address (IPv6 per /64).

The connector (`cloudflare/cloudflared:2026.10.0`, pinned) shares only the `edge`
network with `aviation-app`. Test origin restrictions from outside and from another
container on the host before launch (DESIGN §11).

## Tracing

Tracing is off unless `AVIATION_TRACING_ENABLED=true`. Then the wrappers add
`compose.tracing.yaml`, which joins `aviation-app` and `aviation-ingest` to the external network
`SHARED_OBSERVABILITY_NETWORK` and passes the Langfuse variables (all required).
`LANGFUSE_BASE_URL` is the Langfuse web service's address on that network. Use the
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

Earlier checkouts ran these services as project `ai-aviation`, with login-capable
group roles and databases `aviation` and `aviation_test`. Stop that project once
with `docker compose -p ai-aviation down` (its volumes are kept) before
`pnpm services:up`; `ai-aviation-local` starts with empty volumes, so run
`services:setup` and `db:migrate` again and reload data. Running the new
`services:setup` against an old server instead converts its group roles to
`NOLOGIN`, which locks out checkouts still using the old URLs.

The local PostgreSQL ran 17.6 before it was pinned to 16.2, the shared server's
version. A data directory cannot be reused across major versions, and the 16.2
image refuses to start on one made by 17. A checkout whose `ai-aviation-local`
PostgreSQL volume was made by 17.6 removes that volume once and provisions again
(this deletes the local `aviation_dev` and `aviation_test` databases, which hold
only disposable data; the Elasticsearch volume is not touched):

```sh
pnpm services:down
docker volume rm ai-aviation-local_postgres-data
pnpm services:up
pnpm services:setup   # keeps the passwords and keys that .env.local still holds
pnpm db:migrate
```

## PostgreSQL 16 compatibility

The shared server and the local services both run PostgreSQL 16.2 (the local
services ran 17.6 until they were pinned to the shared server's version, so that
the integration tests exercise the version the deployments use). The `MAINTAIN`
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
them and the suite on 16.2. `pnpm test:pg16` keeps its name from the time a
throwaway `postgres16` service (profile `pg16`, data in tmpfs) provided 16.2 next to
a 17.6 stack; that service no longer exists. The command checks that the test
database's server is PostgreSQL 16 and then runs the same integration suite, so
existing instructions keep working.

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
`node_modules/`, build and test outputs, tests and docs out of the build context.
