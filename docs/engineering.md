# Engineering standards

Every app in this repository is held to these standards, whoever writes the change. The root
[AGENTS.md](../AGENTS.md) summarises them; this file says why each exists, what it means in
practice, and what the wrong and the right shape look like. Tools enforce what they can: the app's
linter and check command, and the `guard_quality` and `finish_check` hooks. Review covers the rest.

## Proportion

The standards scale with the change. A typo fix needs the corrected word and nothing else: no
domain model, no new module, no new test unless the typo was in behaviour. A bug fix needs a test
that reproduces it and the smallest fix that makes it pass. A new feature gets the full treatment.
Heavier domain-driven patterns (value types that cannot hold an invalid value, entities that guard
their own invariants, repositories in front of storage) belong only where the domain has real
rules to protect, such as a state that must never be reached or totals that must always balance.
Plain data handling stays plain: reading a CSV row into a record is a function, not an aggregate.
Reviewers weigh proportion both ways: structure a change does not need is a finding too.

## 1. Tests first

**Why.** A test written before the code has been seen to fail, so its passing means something. A
test written afterwards tends to restate what the code happens to do. Tests through public
interfaces survive refactoring, which is what lets the next agent tidy without fear.

**In practice.**
- Write the test, run it, and see it fail for the reason you expect; then write the least code
  that passes it; then tidy while it stays green.
- Start a bug fix with a test that reproduces the bug.
- Test through the public interface: inputs, outputs and visible effects, not private helpers or
  the order of internal calls.
- Name each test for the behaviour it states, such as `rejects a range that ends before it starts`.
- Keep tests offline and deterministic: fake the clock, the network and providers at the edges.

**Example.**
```ts
// Wrong: mirrors the implementation, and breaks on any refactor
expect(splitTerms).toHaveBeenCalledWith("red apple");

// Right: states the behaviour through the public function
expect(search(index, "red apple").map((hit) => hit.id)).toEqual(["doc-2", "doc-7"]);
```

## 2. Separation of concerns

**Why.** Domain rules that know nothing about the framework, the database or a provider can be read
in one place, tested in milliseconds, and kept when any of those is replaced. When the dependency
points the other way, every change at an edge reaches into the rules.

**In practice.**
- Keep domain rules in modules that import no web framework, database client or provider SDK.
- Put input and output at the edges (HTTP handlers, command lines, storage, provider adapters), and
  validate everything that crosses: parse it into domain types or reject it with a clear error.
- Let the edges depend on the domain, not the reverse. The app's `AGENTS.md` records the allowed
  direction, and the linter's import rules enforce it where the language has them.
- Pass collaborators in as arguments rather than reaching for a global client.
- Keep handlers thin: parse the input, call the domain, map the result to a response.

**Example.**
```ts
// Wrong: the refund rule lives in the handler, between SQL and HTTP
app.post("/refunds", async (req, res) => {
  const order = await db.one("select * from orders where id = $1", [req.body.orderId]);
  if (Date.now() - order.placed_at > 30 * DAY_MS) return res.status(422).end();
});

// Right: the rule is plain code that the handler calls
export function isRefundable(order: Order, now: Date): boolean {
  return now.getTime() - order.placedAt.getTime() <= REFUND_WINDOW_MS;
}
```

## 3. Domain language

**Why.** When the code uses the words of the epic and the design, a search leads from a requirement
to its code, and a reviewer can see when a rule is wrong. Two words for one concept read as two
concepts, and the next agent will treat them that way.

**In practice.**
- Name types, functions, modules and tests with the terms of the epic and the design: one concept,
  one word.
- Keep the glossary under **Domain vocabulary** in the app's `AGENTS.md` current: add a term when
  you introduce a concept, and rename the code when a term changes.
- Split modules along the domain's own seams (`search`, `ingestion`, `citations`) rather than by
  technical layer alone (`utils`, `services`, `helpers`).
- Use richer domain types where the domain has rules to protect, and keep plain data plain.

**Example.**
```python
# Wrong: technical words, and two names for one concept
def process(data: dict, flag: bool) -> dict: ...
def handle_record(item: dict) -> None: ...

# Right: the glossary's words, one per concept
def cite_passage(document: Document, passage: Passage) -> Citation: ...
```

## 4. Clean code

**Why.** The next reader has only the code. Small units with honest names can be understood one at
a time; dead code, speculative options and swallowed errors each send that reader the wrong way.

**In practice.**
- Give each function, class and module one reason to change; split a unit when it does two things.
- Name things for what they are for: `unpaid_invoices`, not `data2` or `tmp_list`.
- Delete dead and commented-out code; git keeps the history.
- Add no option, parameter or abstraction that no current caller needs.
- Fail loudly with context: say what failed and with which input, and do not swallow an exception
  to keep going.
- Write comments that explain why: a constraint, a workaround and its cause, a surprising choice.

**Example.**
```python
# Wrong: hides the failure, and the caller carries on with empty settings
try:
    settings = load_settings(path)
except Exception:
    settings = {}

# Right: fails with context the reader can act on
try:
    settings = load_settings(path)
except OSError as error:
    raise SettingsError(f"cannot read {path}: {error}") from error
```

## 5. Linted, formatted, typed

**Why.** Tools check what they can on every run, so reviewers can spend their attention on what
tools cannot judge. A silenced finding is a decision, and a reviewer can weigh it only when its
reason is written where it is made.

**In practice.**
- Each app chooses its formatter, linter, type checker and test runner in its design, records them
  under `quality` in its `factory.toml`, and runs all four in its `check` command.
- Fix a finding rather than silencing it. When silencing is right, use the narrowest marker, name
  the rule, and give the reason on the same line (below).
- Do not skip, focus or weaken a test to get a green run; a failing or flaky test is a bug to fix
  or to report.
- Do not silence the type checker by other means (`any`, casts, non-null assertions on data from
  outside); validate at the edge instead.
- Loosening a rule for the whole app is a design decision: name it in the pull request.

**Example.**
```ts
// Wrong: a cast silences the type checker and moves the crash to run time
const count = (await response.json() as any).results.length;

// Right: validate at the edge, and the types are true from there on
const page = SearchPage.parse(await response.json());
const count = page.results.length;
```

**Writing a suppression.** ESLint takes the reason after ` -- `. Other markers take at least two
words of reason after the marker and its rule names, on the same line. A test skipped because of
its environment gives the reason as the skip's argument. The `guard_quality` hook refuses a new
marker in a source file when it has no reason or only a rule name.

```ts
// eslint-disable-next-line no-console -- the command-line report is this script's output
// @ts-expect-error -- the driver's types omit the stream option; remove after upgrading to 3.2
```

```python
import app  # noqa: E402  the path must be set before this import
from legacy_pdf import extract  # type: ignore[import-untyped]  the package ships no type hints
```

## 6. Continuous care

**Why.** No cleanup phase comes later. A small repair made while the code is in your head is cheap;
debt left in silence grows, and the next agent pays for it without knowing why.

**In practice.**
- Tidy what your change touches: rename what misleads, extract what you had to read twice, add the
  missing test for code you changed, delete what your change made dead.
- Put tidying of more than a few lines in its own commit, so the reviewer sees behaviour and
  structure apart.
- Write anything larger than the change (splitting a module, replacing a library, a redesign) down
  as a follow-up. Do not ignore it, and do not slip it into the change.
- Give a follow-up a title that names the problem and a reason that says why it matters and where.
  A factory run puts it in the result's `follow_ups`; otherwise it goes in the pull request. A
  person decides which follow-ups become issues.

**Example.**
```text
Wrong:  title "Refactor"
        reason "search code is messy"
Right:  title "Split apps/document-search/server/search.ts by responsibility"
        reason "It parses queries, ranks results and formats snippets in one 500-line module,
                so ranking cannot be tested without building a full HTTP request."
```

## 7. Documents are part of the code

**Why.** The next agent reads the README, the app's `AGENTS.md` and the design before the code. A
document that describes old behaviour is worse than none, because it is believed.

**In practice.**
- When behaviour, a command or a configuration value changes, update the part of the README that
  describes it in the same pull request.
- When structure changes (a module added, moved or removed, a dependency direction changed), update
  the module map in the app's `AGENTS.md`, and its glossary when a term changes.
- When the code has to depart from the design, update the design and say why in the pull request;
  if the departure changes the architecture, ask first.
- List every new environment variable in the app's `.env.example` with an empty value.

**Example.**
```text
Wrong:  the code renames SEARCH_URL to SEARCH_ENDPOINT; .env.example and the README still say
        SEARCH_URL, so the next setup that follows the README fails.
Right:  the same commit renames it in the code, in .env.example and in the README's table of
        configuration values.
```

## 8. Dependencies are a decision

**Why.** Each dependency is code the app now ships, trusts and has to keep up to date. Naming it
with its reason lets a reviewer weigh that cost, and a lockfile that matches its manifest makes
every install the same.

**In practice.**
- Prefer the standard library or a dependency the app already has; add one when it saves real work
  or removes real risk.
- Name each new dependency in the pull request: what it is for, and why existing code will not do.
- Change a lockfile only through the package manager and only with the manifest change it
  reflects; install from the lockfile.
- Keep a dependency in the app that uses it. Repository tooling in `scripts/` and `factory/` uses
  the Python standard library only.

**Example.**
```text
Wrong:  pnpm-lock.yaml changes by 3,000 lines in a pull request titled "Fix result ranking",
        and the description names no new package.
Right:  "Adds fast-xml-parser to read the publisher's XML feed: the app has no XML parser, and
        parsing by hand would mishandle entities." package.json and the lockfile change together.
```
