# Development guide

## Adding an application

From the repository root:

```bash
python3 scripts/new_app.py document-search
```

Use a short kebab-case name. The command copies `templates/app/`, replaces its
name placeholders, and registers the directory in the catalog. It refuses to
overwrite an existing app. The generated app starts as a documentation scaffold.

Choose the implementation stack for the app, then add:

- Source code and the dependency manifest/lockfile for the chosen package manager.
- `AGENTS.md` and `factory.toml`, which the scaffold already includes (see below).
- A README describing the purpose, supported runtime versions, installation,
  configuration, startup, ingestion, tests, and limitations.
- An `.env.example` listing only variables the app actually uses.
- Small fixtures under `fixtures/` and relevant tests under `tests/`.
- Local service configuration when needed, such as a version-pinned Compose file
  with loopback-bound ports and persistent named volumes.

A typical implemented app can look like:

```text
apps/document-search/
  README.md
  AGENTS.md
  factory.toml
  .env.example
  <dependency manifest and lockfile>
  src/
  tests/
  fixtures/
  compose.yml         # When the app needs local services
```

The exact source layout belongs to the selected framework. A frontend/backend
app may have separate directories and lockfiles. Root-level Python is only for
repository tools; it does not require applications to be written in Python.

`AGENTS.md` holds the app's instructions for coding agents, and the app's design
fills it in. `factory.toml` declares the app's commands and quality tools, and the
app's first plan step sets them. Its `check` command is the app's quality gate;
per-app CI from that file is a later step of the factory.

Dependency installation must use the lockfile. Document CPU/memory requirements and optional
GPU usage for apps running local models. Keep unit tests independent of paid APIs;
provide explicit commands for any live integration tests.

## Repository tools

```bash
python3 scripts/check_repo.py
python3 -m unittest discover -s factory/tests -t .
```

The first command checks repository conventions and the second runs the tests of the
tools in `factory/`, `scripts/` and the hooks in `.claude/hooks/`, which guard agent
sessions; the hook tests live in `factory/tests/`.

## Shared code

Start with code inside the app. Extract a shared package after there are multiple
consumers and a clear boundary. Avoid importing another app's private modules or
assuming that a sibling app has already installed a service.

## Retrieval and agent experiments

Record embedding model, dimensions, chunking settings, source identifiers, and
ingestion versions so retrieval results can be reproduced. Keep dataset download
and indexing commands separate from normal application startup.

Use a small evaluation set to compare retrieval strategies. Record expected source
passages and distinguish retrieval quality from answer quality. For tool-using
agents, test tool arguments, error handling, and behavior when evidence is missing.
