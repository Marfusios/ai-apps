# {{APP_TITLE}}

**Status:** Scaffold. Add the implementation before marking this app runnable.

## Purpose

Describe the problem, intended user, and expected result for `{{APP_SLUG}}`.

## Requirements

Document supported runtime and package-manager versions, required services,
provider accounts, and resource requirements.

## Installation and configuration

`AGENTS.md` (notes for agents) and `factory.toml` (commands and quality tools,
read by CI and the factory) belong to the app; its design fills them in.

Add exact dependency installation commands using a committed lockfile. Copy
`.env.example` to `.env`, fill required values, and document what each variable
controls. Existing nonempty process environment values take precedence.

## Run

Add startup commands, the local URL or CLI entry point, and a minimal example.
If services are required, include their local setup and teardown commands.

## Data

Document the source, redistribution terms, fixtures, ingestion steps, and how to
regenerate ignored data or artifacts.

## Tests and evaluation

Add offline test commands and expected behavior. Document any optional live API
checks separately, including when they incur provider charges.

## Limitations

Describe known gaps, failure modes, and assumptions needed to interpret results.
