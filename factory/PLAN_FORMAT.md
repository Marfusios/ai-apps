# Plan format

This file is the authority for the format of an epic's `PLAN.md`: the `factory-plan` skill writes
plans in it, and the plan linter and the dispatcher that splits a plan into step issues follow it.

A plan lives at `apps/<app>/docs/epics/<issue number>-<slug>/PLAN.md`, beside the epic's
`DESIGN.md`. It starts with a title, the epic's issue number and a short overview:

```markdown
# Plan: <epic title>

Epic: #<issue number>

## Overview

<a few sentences: what the steps build, in what order, and why that order>
```

Then comes one section per step, each with exactly this shape:

```markdown
## S<n>: <title>

- **Depends on:** none
- **Risk:** low
- **Scope:** <the modules or directories this step may touch>

### Acceptance criteria

- <an observable behaviour, checkable by a test or a command>

### Verification

- `<a command that proves the step, run from the app directory>`
```

## Rules

- Identifiers are `S1`, `S2`, ... in order, with no gaps in a new plan.
- An identifier never changes once its step has an issue. A removed step's identifier is not
  reused, so its number stays a gap, and a step added later takes the next unused number.
- `Depends on` is `none` or a comma-separated list of earlier identifiers, such as `S1, S3`.
- `Risk` is `low`, `medium` or `high`.
- The three fields appear in the order shown, each on one line, and none is empty.
- Every step has at least one acceptance criterion and at least one verification command, each a
  list item; a verification item is one command in backticks.
- Each step is one pull request that leaves `main` working: the app's checks pass after it merges.
- After the Overview, nothing but step sections may appear at heading level 2.
