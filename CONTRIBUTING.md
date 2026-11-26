# Contributing

Start with a small, independently runnable app. Explain the question it answers,
the data it uses, and how someone can reproduce its behavior from a fresh clone.

1. Follow [the development guide](docs/development.md) to create an app directory.
2. Keep configuration portable and document required variables in `.env.example`.
3. Add small fixtures and tests for the behavior that matters. For retrieval apps,
   include representative questions and their expected supporting passages.
4. Run the app's checks and `python3 scripts/check_repo.py`.
5. Update the app README and [catalog](apps/README.md). Describe what changed and
   how it was validated in the pull request.

## Branches and releases

`main` is the only long-lived branch and holds every app's reviewed code. Make each
change on a short-lived branch, open a pull request into `main`, and delete the branch
after the merge. A push or a merge deploys nothing: a deployed app is released from a
tagged commit on `main` by its own release command (for AirCase, see
[Release command](apps/aviation-investigations/docs/RUNBOOK.md#release-command)).

Keep dependencies and generated data scoped to the app that needs them. Shared
packages should have a clear purpose, their own tests, and documented consumers.

Use public or synthetic examples in documentation and screenshots. Credentials,
private datasets, and machine-specific connection details stay outside Git.
