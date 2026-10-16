# Working in AI Apps

- Read the root README and the relevant app README before changing an application.
- Put each app in `apps/<kebab-case-name>/`. Keep its source, dependency manifests,
  lockfiles, tests, and setup instructions together. Update `apps/README.md` when
  adding an app or changing its status.
- Choose a framework only when implementing an app. Keep repository tooling free
  of unnecessary runtime dependencies. Add code to `packages/` after multiple
  apps have a concrete shared need.
- Keep all committed content suitable for eventual public release: no credentials,
  personal filesystem paths, private hostnames, internal network addresses, or
  references to private infrastructure repositories.
- Read credentials from environment variables or explicit local dotenv files.
  Preserve existing nonempty environment values. Document variable names using
  empty values in `.env.example`; never copy private credential files into this
  repository or expose keys in browser code, logs, test output, or images.
- Document supported runtimes and installation commands. Commit lockfiles and
  provide a local setup for required services, with configurable ports and URLs.
- Use synthetic or redistributable fixtures. Keep downloads, model weights,
  ingestion outputs, and private datasets outside Git. Record provenance and
  ingestion steps without storing private source data.
- Keep tests offline by default. Make provider-backed tests explicit opt-ins and
  document their costs. Run checks appropriate to the affected app plus
  `python3 scripts/check_repo.py` before committing.
- Avoid including operational notes about a particular developer's machine in
  shared documentation. Record machine-specific instructions outside the repo.
