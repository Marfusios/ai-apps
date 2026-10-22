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

## Environments

| | dev | live |
| --- | --- | --- |
| Compose project | `ai-aviation-dev` | `ai-aviation-live` |
| `APP_ENV` | `dev` | `live` |
| PostgreSQL database | `aviation_dev` | `aviation_live` |
| Elasticsearch indices (`ELASTICSEARCH_INDEX_PREFIX`) | `aviation-dev-*` | `aviation-live-*` |
| Langfuse project (default) | `aviation-dev` | `aviation-prod` |
| App ingress | loopback port (`127.0.0.1:${PORT:-3000}`) | Cloudflare Tunnel, no published port |

Both projects can run at once: every container, the `edge` and `egress` networks
and the verification reports (`data/reports/<env>`) are per environment. Give
`live` its own image tag (`APP_VERSION`), so rebuilding `dev` never changes the
image `live` starts.

Each environment uses the same three PostgreSQL roles, created per database:
`aviation_app` (HTTP process), `aviation_ingest` (ingestion) and
`aviation_migrator` (schema owner), plus two Elasticsearch API keys limited to the
environment's indices: a reader for the HTTP process and a writer for ingestion.
The owner provisions databases, roles and keys on the shared services; the
application only consumes the resulting variables.

## Containers

| Service | Profile | Label `ai-apps.component` | Purpose |
| --- | --- | --- | --- |
| `app` | `app` | `app` | Fastify API and the built web client on one origin |
| `ingest` | `tools` | `ingest` | Worker CLI, one-shot (`run --rm`) |
| `migrate` | `tools` | `migrate` | Schema migrations, one-shot |
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
| `app` | `DATABASE_URL` (`aviation_app`) | `ELASTICSEARCH_READ_API_KEY` | Anthropic and OpenAI keys, `BETTER_AUTH_SECRET`, Google OAuth client, Turnstile keys, `IP_HMAC_SECRET`, `IDENTITY_HMAC_SECRET`; budgets and limits | CA file (read-only) |
| `ingest` | `DATABASE_INGEST_URL` (`aviation_ingest`) | `ELASTICSEARCH_WRITE_API_KEY` | OpenAI key and embedding settings; the total and ingestion budgets | `data/` read-only, `data/reports/<env>` writable, CA file (read-only) |
| `migrate` | `DATABASE_MIGRATOR_URL` (`aviation_migrator`) | none | none | none |
| `extract` | none | none | none | the MDB file read-only; no network |
| `tunnel` | none | none | `TUNNEL_TOKEN` | none |

With tracing on (see [Tracing](#tracing)), `app` and `ingest` also get
`LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`.

### Hardening

- The application image runs as uid 1000 (`node`); `ingest` runs as the host user
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
| `edge` | `app`, `tunnel` | Per project. App ingress and the outbound route to Cloudflare and the model, embedding, OAuth and Turnstile APIs. Nothing else joins it. |
| `egress` | `ingest` | Per project. Outbound route for the embeddings API. |
| `postgres` | `app`, `ingest`, `migrate` | External, `SHARED_POSTGRES_NETWORK`. |
| `elasticsearch` | `app`, `ingest` | External, `SHARED_ELASTICSEARCH_NETWORK`. |
| `observability` | `app`, `ingest` | External, `SHARED_OBSERVABILITY_NETWORK`; only with `compose.tracing.yaml`. |

The two shared-service networks may be the same Docker network. Docker registers
each container under its service name (`app`, `ingest`, `migrate`) on every
network it joins, so other stacks on the shared networks should not resolve those
generic names. The tunnel resolves `app` only on its own project's `edge`.

## Env files

Compose reads env files for interpolation only. Pass them through
`AVIATION_ENV_FILES` (comma-separated, highest priority first); nonempty
variables exported in the shell win over the files, as in Compose itself, so
unset host-side values such as `DATABASE_URL` before running the wrappers.
The variable names are documented in `.env.example`. An environment file holds:

```sh
APP_ENV=dev                      # or live
APP_VERSION=                     # image tag, for example a release name on live
APP_URL=                         # public origin on live
PORT=3000                        # dev only: loopback port of the app
SHARED_POSTGRES_NETWORK=         # Docker network names of the shared stacks
SHARED_ELASTICSEARCH_NETWORK=
DATABASE_URL=                    # postgres://aviation_app:...@<shared host>:5432/aviation_dev
DATABASE_INGEST_URL=             # aviation_ingest on the same database
DATABASE_MIGRATOR_URL=           # aviation_migrator on the same database
ELASTICSEARCH_URL=               # address on the shared Elasticsearch network
ELASTICSEARCH_CA_FILE=           # host path of the cluster CA (mounted read-only)
ELASTICSEARCH_INDEX_PREFIX=aviation-dev
ELASTICSEARCH_READ_API_KEY=
ELASTICSEARCH_WRITE_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
BETTER_AUTH_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
TURNSTILE_SECRET_KEY=
TURNSTILE_SITE_KEY=
IP_HMAC_SECRET=
IDENTITY_HMAC_SECRET=
AVIATION_TRACING_ENABLED=false   # true adds compose.tracing.yaml
SHARED_OBSERVABILITY_NETWORK=
LANGFUSE_BASE_URL=               # Langfuse web address on that network
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
TUNNEL_TOKEN=                    # live: set it to run tunnel mode
```

Hosts in the URLs are the shared services' names on their Docker networks, not
host loopback addresses. Budget and model variables from `.env.example` may be
added; unset ones keep the application defaults.

`docker compose config` prints every resolved value, secrets included. Use
`docker compose config --quiet` to validate, or `--no-interpolate` to share output.

## Commands

The pnpm wrappers (`scripts/compose.ts`) choose the project from `APP_ENV`, pass
the env files, add `compose.tunnel.yaml` when `TUNNEL_TOKEN` is set and
`compose.tracing.yaml` when `AVIATION_TRACING_ENABLED` is true. They check the
variables each command needs and never print values.

```sh
export AVIATION_ENV_FILES=/path/outside/the/repo/aviation-dev.env

pnpm app:migrate               # schema migrations (migrate container)
pnpm app:up                    # build the image, start app (and tunnel), wait until healthy
pnpm app:ps                    # this environment's containers, one-offs included
pnpm ingest generations        # any worker command in a one-shot ingest container
pnpm app:down                  # stop and remove this environment's containers
pnpm extract:image             # build ai-aviation/extract:mdbtools-1.0.0
```

The same with plain Compose, from the app directory:

```sh
docker compose -p ai-aviation-dev --env-file "$ENV_FILE" --profile tools run --rm migrate
docker compose -p ai-aviation-dev --env-file "$ENV_FILE" --profile app up -d --build
docker compose -p ai-aviation-dev --env-file "$ENV_FILE" --profile tools run --rm ingest generations
docker compose -p ai-aviation-dev --env-file "$ENV_FILE" --profile app --profile tools --profile tunnel down
```

`compose.yaml` refuses to load without `APP_ENV`. Run `ingest` with
`AVIATION_UID=$(id -u) AVIATION_GID=$(id -g)` and create `data/reports/<env>`
first when not using the wrapper.

The HTTP entry `server/main.ts` and its `GET /api/health` route arrive with the
API server. Until then `pnpm app:up` stops with a message, and the image's
default command exits with `Cannot find module '/app/server/main.js'`. The image
and the tools (`ingest`, `migrate`) work already.

### Deploying an environment

1. The owner provisions the database, roles, index-scoped API keys and Langfuse
   project, and writes the env file outside the repository.
2. `pnpm app:migrate`.
3. Ingest data (next section).
4. `pnpm app:up`. On `live`, with `TUNNEL_TOKEN` set, this is tunnel mode.

To update: pull the code, set a new `APP_VERSION` on `live`, run
`pnpm app:migrate`, then `pnpm app:up`. To roll back, set the previous
`APP_VERSION` (its image is still local) and run `pnpm app:up`; migrations are
not reversed.

## Ingestion

Extraction needs the Docker CLI to start its sandbox containers, so it runs on the
host, never in the `ingest` container (which has no Docker socket):

```sh
pnpm extract:image
APP_ENV=dev pnpm worker extract --archive data/research/avall.zip --sha256 <hex> --out data/work/<dir>
```

Its containers are named `ai-aviation-<env>-extract-<hex>` and labelled as one-off
containers of service `extract` in project `ai-aviation-<env>`, so they appear in
`pnpm app:ps` while they run. They have no network, a read-only root, no
capabilities, uid 65534, 1 GB memory, 2 CPUs and 64 processes, and are always
removed afterwards.

Loading, verification and the other worker commands then run in the `ingest`
container against the environment's database:

```sh
pnpm ingest load --from data/work/<dir>
pnpm ingest verify --generation <id>     # report written to data/reports/<env>/
pnpm ingest generations
```

Paths are relative to the app directory, which the container sees at the same
relative location (`data/` is mounted at `/app/data`).

The extraction image was formerly tagged `aviation-extract:mdbtools-1.0.0`;
`pnpm extract:image` builds `ai-aviation/extract:mdbtools-1.0.0`, after which the
old tag can be removed (`docker image rm aviation-extract:mdbtools-1.0.0`).
Manifests of earlier extractions keep the old name; loading does not depend on it.

## Tunnel mode

`live` is reached only through a Cloudflare Tunnel; the app publishes no port.

1. In Cloudflare Zero Trust, create a remotely managed tunnel and add a public
   hostname whose service is `http://app:3000`.
2. Put its token in the live env file as `TUNNEL_TOKEN`, and the public origin in
   `APP_URL`.
3. `pnpm app:up`. The wrapper adds `compose.tunnel.yaml`, which removes the app's
   port and requires the token, and the `tunnel` profile:

   ```sh
   docker compose -p ai-aviation-live --env-file "$ENV_FILE" \
     -f compose.yaml -f compose.tunnel.yaml --profile app --profile tunnel up -d --build
   ```

4. Check that nothing is published: `APP_ENV=live pnpm app:ps` shows no ports
   for `app`.

The connector (`cloudflare/cloudflared:2026.10.0`, pinned) shares only the `edge`
network with `app`. Test origin restrictions from outside and from another
container on the host before launch (DESIGN §11).

## Tracing

Tracing is off unless `AVIATION_TRACING_ENABLED=true`. Then the wrappers add
`compose.tracing.yaml`, which joins `app` and `ingest` to the external network
`SHARED_OBSERVABILITY_NETWORK` and passes the Langfuse variables (all required).
`LANGFUSE_BASE_URL` is the Langfuse web service's address on that network. Use the
`aviation-dev` project's keys for `dev` and `aviation-prod`'s for `live`. The
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
pnpm services:up      # project ai-aviation-local: PostgreSQL 17.6 and Elasticsearch 9.5.5
pnpm services:setup   # roles, databases aviation and aviation_test, API keys into .env.local
pnpm db:migrate
pnpm services:down    # volumes are kept
```

Both services publish loopback-only ports (`POSTGRES_PORT`, default 55432, and
`ELASTICSEARCH_PORT`, default 59200) for host-side tools: setup, migrations, the
integration tests and `pnpm worker`. These ports are for development only.
Host-side commands read `.env.local`; its URLs point at those loopback ports.

To run the application containers against the local services instead of the
shared ones, write a separate env file (outside the repo or under an ignored
name) with `SHARED_POSTGRES_NETWORK=ai-aviation-local_default`,
`SHARED_ELASTICSEARCH_NETWORK=ai-aviation-local_default`, database URLs with host
`postgres:5432` and database `aviation`, `ELASTICSEARCH_URL=http://elasticsearch:9200`,
`ELASTICSEARCH_INDEX_PREFIX=aviation`, and the passwords and API keys from
`.env.local`.

Earlier checkouts ran these services as project `ai-aviation`. Stop that project
once with `docker compose -p ai-aviation down` (its volumes are kept) before
`pnpm services:up`; `ai-aviation-local` starts with empty volumes, so run
`services:setup` and `db:migrate` again and reload data.

## Application image

`Dockerfile` builds `ai-aviation/app:${APP_VERSION:-dev}` in stages: dependencies
with pnpm from corepack (version pinned by `packageManager`), the Vite and
TypeScript builds, production dependencies only, and a `node:24.21.0-trixie-slim`
runtime. The runtime keeps the checkout layout with compiled JavaScript
(`/app/server`, `/app/worker`, `/app/shared`, `/app/dist/web` with the font
licences), plus the SQL migrations, verification profiles and the report-link
seed; no TypeScript sources or development dependencies. `.dockerignore` keeps
`.env*` files, `data/`, `node_modules/`, build and test outputs, tests and docs out
of the build context.
