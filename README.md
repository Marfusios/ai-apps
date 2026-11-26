# AI Apps

A collection of independently runnable applications exploring language models,
semantic search, retrieval-augmented generation (RAG), and agent workflows.

Each application lives in `apps/<name>/` and owns its dependencies, configuration,
tests, and setup instructions. Shared code is introduced when multiple apps need
the same functionality. The repository does not require a particular cloud account,
private network, or shared development server.

**Status:** the first app, [AirCase](apps/aviation-investigations/README.md), is live at
`https://aircase.app`. It searches and compares NTSB aviation investigations with keyword
search and an AI evidence search, and imports each new NTSB snapshot automatically. Its
design, runbook and
[tracing and evaluation](apps/aviation-investigations/docs/OBSERVABILITY_AND_EVALUATION.md)
documents are in `apps/aviation-investigations/docs/`. See the
[application catalog](apps/README.md) as projects are added.

## Repository layout

```text
apps/                 Individual applications and the application catalog
packages/             Reusable code shared by multiple applications
templates/app/        Starting documentation and configuration for a new app
docs/                 Development and configuration conventions, engineering
                      standards, and the software factory's design
factory/              The software factory's code and configuration
scripts/              Portable repository tools (Python standard library only)
.claude/              Hooks, skills and subagents for coding-agent sessions
.github/              Issue forms, pull request template, and automated checks
```

## How apps are built here

Apps are built by coding agents from GitHub issues. An epic issue becomes a design, a
plan, and then one pull request per plan step, and a smaller issue becomes a single fix
pull request. A second model reviews each pull request, and a person approves and merges
every one. The dispatcher that runs agents from issues is still being built; the harness
in this change is the first step. Read the [design](docs/factory/DESIGN.md), the
[agent instructions](AGENTS.md), and the [engineering standards](docs/engineering.md) for
the details.

## Getting started

The repository tools require **Git and Python 3.11 or newer**. Individual apps will
document their own language runtime, package manager, provider accounts, and optional
Docker requirements.

```bash
git clone https://github.com/Marfusios/ai-apps.git
cd ai-apps
python3 scripts/check_repo.py
python3 -m unittest discover -s factory/tests -t .
```

On Windows, use `py -3` in place of `python3` if that is how Python is installed.
There are no root-level packages to install or API keys needed for these checks.

To create a new application directory:

```bash
python3 scripts/new_app.py document-search
```

This generates a README and an empty `.env.example`, and adds the new app to the
catalog as a scaffold. Follow [Adding an application](docs/development.md#adding-an-application)
to add an implementation, locked dependencies, fixtures, and run/test commands.

## Running applications

Choose an app from the [catalog](apps/README.md), then follow its README. Each app
must provide installation, configuration, and startup commands that work from a
fresh clone. Services such as a database or search engine must have a documented
local setup, with configurable connections to existing services when useful.

Provider credentials belong in the process environment or an app's gitignored
`.env` file. Copy the app's `.env.example` and fill only the variables it requires.
Examples contain empty credentials, and existing nonempty environment variables
take precedence. See [Configuration and data](docs/configuration.md).

API-backed features may incur provider charges. Each app documents which actions
make external calls; automated checks and tests should work offline by default.

## Development principles

- **Independent apps:** choose frameworks per application and avoid coupling
  unrelated experiments through a mandatory root runtime.
- **Reproducible setup:** declare supported runtimes, commit dependency lockfiles,
  and document service versions and setup commands.
- **Portable configuration:** use environment variables and local development
  defaults, keeping personal paths and private infrastructure out of the source.
- **Evidence-based answers:** retrieval apps retain source references and evaluate
  retrieved passages separately from generated answers.
- **Small, shareable fixtures:** use synthetic or redistributable data in tests;
  fetch larger datasets through documented ingestion steps.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before adding an app or shared package.
Coding agents should also follow [AGENTS.md](AGENTS.md).

## Checks

```bash
python3 scripts/check_repo.py
python3 -m unittest discover -s factory/tests -t .
```

The same two commands run in GitHub Actions. The checker verifies app structure, local Markdown
links, empty secret placeholders, and common accidental credential/private-path
patterns in tracked or non-ignored files. These checks are useful safeguards, not
a complete secret audit of repository history.

## License

The code and documentation in this repository are released under the
[MIT License](LICENSE).

The license does not cover third-party material that an app includes as test or
evaluation data. Each app's README says what that material is and where it came from.
