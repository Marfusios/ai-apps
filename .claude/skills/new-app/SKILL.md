---
name: new-app
description: Scaffolds a new app under apps/ with scripts/new_app.py and fills in its purpose in the README and the app catalog. Use when a person asks to create, add or scaffold a new app in this repository; factory-design follows it for an epic that creates one.
---

# Create a new app

A new app starts as a documentation scaffold: the template's files, a stated purpose and a row in
the catalog. Its design, written later by the `factory-design` skill for its first epic, chooses
the stack, the commands and the module map, so this skill leaves those parts as placeholders.

1. Settle the name and the purpose. In a factory run (`FACTORY_RUN=1`) the name is `app` in
   `$FACTORY_JOB_DIR/job.json` and the purpose comes from the epic. Otherwise ask the person for
   what they have not given: the name in kebab-case (lowercase letters, digits and single hyphens,
   at most 64 characters, such as `document-search`), which becomes the directory `apps/<name>/`
   and is costly to change later, and what the app is for.
2. Outside a factory run, first switch to a branch of your own, since the git rules of
   `AGENTS.md` send every change to `main` through a pull request. Then, from the repository
   root, run `python3 scripts/new_app.py <name>`. It copies `templates/app/` into `apps/<name>/`,
   fills in the name, and adds a row with status Scaffold to `apps/README.md`. If it refuses
   because `apps/<name>/` exists, stop and tell the person; it changed nothing.
3. In `apps/<name>/README.md`, replace the placeholder sentence under `## Purpose` with two to four
   sentences: the problem, the intended user and the expected result.
4. In the app's row of `apps/README.md`, replace `Describe the app's purpose.` with one sentence of
   purpose. If the app has a display name, from the person or the epic, use it for the row's link
   text and for the first heading of its `README.md` and `AGENTS.md`.
5. Leave the placeholders in `apps/<name>/AGENTS.md` and `apps/<name>/factory.toml`, although the
   script's last line suggests filling them in: the design does that, and the template's values
   pass the repository checker until then.
6. Run `python3 scripts/check_repo.py`; it must pass.
7. Commit the new files with a one-sentence message, as "Change discipline" in `AGENTS.md` asks.
   In a factory run, go back to the skill that sent you here. Otherwise tell the person what was
   created, and that the app's design starts from an epic issue labelled `factory:epic`.
