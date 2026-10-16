# Configuration and data

## Credentials

An app reads provider keys from its process environment or an explicitly loaded
dotenv file. A nonempty process value takes precedence over dotenv defaults. Empty
or absent values mean the provider is not configured.

For a local app configuration, copy its `.env.example` to `.env` and enter the
required values in your editor. Both process-level credentials and `.env` should
work without requiring a particular secrets file elsewhere on the machine.

Do not put provider keys in frontend code, repository files, Docker build
arguments, image layers, screenshots, or logs. Inject only the credentials needed
by each backend process or container at runtime. When sharing error output,
report whether a key is configured without including its value.

The root `.gitignore` excludes local credential files. `.dockerignore` protects
builds using the repository root as their context. Apps using a separate build
context must include equivalent exclusions in their own `.dockerignore`.

## Services

Prefer `localhost` or loopback IP addresses in development examples. Make service
URLs, ports, database/index names, and credentials configurable. Describe a local
startup path for each dependency and any supported external-service alternative.
Document TLS trust when a service requires a custom CA; keep verification enabled.

Docker Compose service names resolve only on their Docker network. Document which
URL the app uses when running on the host versus inside a container.

## Data and generated files

Use small synthetic or redistributable fixtures in `fixtures/`. Keep downloaded
data and generated artifacts under ignored directories such as `data/`,
`artifacts/`, and `outputs/`. Record source URLs, attribution, expected versions,
and regeneration commands in the app README.

Avoid committing private records, database dumps, prompts containing personal
data, model weights, or large ingestion outputs. If public sample data requires
registration or has redistribution limits, document how users can obtain their
own copy.
