# AirCase: design security review

**Date:** 2026-10-16. **Reviewer:** Claude Opus, resolved model
`claude-opus-5-5`, invoked through Claude Code with tools, external integrations,
custom hooks, and session persistence disabled. Only the proposed design was
provided; credentials and private infrastructure details were not included.

**Scope:** [application design](DESIGN.md), not implemented code, a running service,
or a penetration test. The reviewed initial draft had SHA-256
`68fc2fa875a3e93db0a8bcfead1d53361435ac067b1daeddcf2728efd3a7f399`.

The table summarizes the independent findings and how they were incorporated.
“Addressed” means the document now specifies a control; implementation and testing
are still required. This review does not establish that the future app is secure.

| ID | Reviewer severity | Failure path | Design disposition |
| --- | --- | --- | --- |
| F1 | High | Timeouts or disconnects lose provider usage, allowing unjustified refunds or stuck reservations | Unknown usage settles at a maximum: since Task 22 each such call at its own stage's worst case (DESIGN §9 "Uncertain calls"), the whole reservation when no call can be named (lease expiry); no automatic refund. Operator reconciles dedicated-project billing; no organization billing credential in the public app |
| F2 | Medium–high | Expired leases allow duplicate requests or late settlement by stale workers | Hard deadline shorter than lease TTL; fencing/ownership checks; idempotent retries never silently rerun; money remains reserved independently of slots |
| F3 | High | Forged forwarding headers create unlimited network identities through another origin path | Explicit `trustProxy: false`, dedicated ingress network, actual connector peer checks, no published production port, denial when trusted client identity is missing, container-origin spoofing tests |
| F4 | Medium | A few identities consume the public budget or hold all AI slots | Anonymous share capped at 25%, one anonymous slot, signed-in network limits, smaller new-account allowance, monthly pacing and emergency login-required mode; uncertain charges bounded per principal and day (one reservation, DESIGN §9; before Task 22 each cancel was charged the whole $0.36 and nine cancels from one account paused AI for everyone); exhaustion by many identities remains a residual risk |
| F5 | Medium | Model/user terms interpreted as Lucene query syntax increase query power/cost | Fixed `match`/`multi_match` templates, field/filter allowlists, immutable completion/country clauses, bounded candidates/pages/timeouts |
| F6 | Medium | Event-wide text is misattributed to a particular aircraft | Explicit event/aircraft passage scope; event text alone cannot establish aircraft-specific claims; ambiguity is preserved |
| F7 | Medium | Free-text case numbers, biased verification, or arbitrary links bypass structured citation validation | Check free-text case references, render links from validated IDs/templates, verify bounded claim/span pairs without raw question/history |
| F8 | Medium | Binary archive parser compromise exposes ingestion secrets | Extraction runs without network/secrets, with limits and read-only root; separate validated loading; reject traversal/symlinks and unsafe redirects |
| F9 | Medium | Amendments leave stale classifications and cached answers | Source revisions invalidate dependent assertions; immutable citation text/offset conventions; versioned caches and aggregates |
| F10 | Low–medium | Undisclosed temporary content or email changes undermine consent/retention | Explicit 24-hour idempotency/context TTL; per-address reconfirmation; login-free unsubscribe; minimal documented suppression records |
| F11 | Low | Session caches delay revocation; cookie-setting responses get cached; visits flood trial rows | Disable session cookie cache, never cache Set-Cookie/auth responses, create trial identities only at challenged AI admission |

The initial reviewer treated F1–F7 as launch blockers and F8–F11 as later work.
The design adopts the latter controls before the corresponding functionality is
exposed too, especially parser isolation and revision invalidation.

Two details required engineering judgment rather than literal adoption: ordinary
app API keys should not be assumed to access organization billing APIs, and a
loopback listener alone does not distinguish the tunnel from other local
processes. The revised design makes billing reconciliation operator-side and
specifies a dedicated production ingress path with peer verification.

The review also checked the proposed price caps: approximately $0.022 worst-case
token cost fits a $0.03 reservation under the listed models. A more expensive
verification model can break that bound. The design now requires startup
validation of model prices/caps/reservations and measurement of output truncation.

## Follow-up review

Claude Opus (`claude-opus-5-5`) re-reviewed the revised design on 2026-10-16,
SHA-256 `d39c2c0d8bc647a0e12215e1a32402a42778ba12751a9cdeb7a9afc462c35d5b`.
It classified F1–F11 and the cost-envelope clarification as addressed at the design
level and identified no remaining concrete design blockers. Budget exhaustion by
multiple accounts remains an explicitly accepted availability risk.

The reviewer suggested four non-blocking clarifications. The final document adds:

- All network limiters, including auth and browsing, consume the validated client
  identity after connector peer verification; missing identity rejects dynamic
  requests rather than grouping clients under the connector IP.
- Unallowlisted case identifiers reject the generated answer, with a case-card
  fallback, rather than attempting to strip individual misleading references.
- A dedicated HMAC of the Google issuer/subject preserves quota through account
  deletion and re-registration for the quota window plus 7 days.
- Daily pacing subtracts the full value of unsettled/uncertain reservations.

Those clarifications were added after the follow-up review, so its hash identifies
the preceding draft, not the current document. Both reviews cover design only;
they cannot replace tests of the eventual implementation.

## Design addendum, 2026-10-21

The design now selects self-hosted Langfuse for tracing and evaluations, with
custom TypeScript evaluators. This addition and the
[tracing/evaluation guide](OBSERVABILITY_AND_EVALUATION.md) were **not covered by the
October 16 Claude reviews**. No new independent review or implementation test is
claimed by this documentation update.

The new design requires private dashboard access, server-side project credentials,
production metadata-only capture, filtering before export, bounded retention,
feedback ownership checks, and best-effort telemetry export. Experiments and
background judges use the existing paid-call gate; PostgreSQL accounting and inline
answer verification remain authoritative. Provider keys stay out of autonomous
Langfuse judge configurations in version one.

The implementation review must verify those controls, including secrets in error
spans, duplicate instrumentation, cross-project/feedback access, deletion across
tracing stores and exports, budget enforcement for judges, and behavior during
Langfuse outages. Missing evaluation results must not silently pass release gates.

Later clarifications on the same date are also outside the October 16 reviews:
report-link mapping from Aviation Search exports, brief refinements with
server-owned intent, and the runtime `GET /api/config` endpoint replacing a
build-time Turnstile site key. The implementation review must cover them.

The 2026-10-21 interface and provider decisions are also unreviewed:

- Language models move to Anthropic behind a deployment-time provider interface,
  with OpenAI kept for embeddings. This means two provider keys, per-request
  reservations of $0.36 (Opus answer model; $0.31 before gate 16c condition 6) instead of $0.03, and a $100 monthly
  ceiling instead of $25. (The reservation was $0.14 when this was written; it rose
  to $0.31 after the stage caps were measured with Anthropic's own token counter.
  The old caps were below the real request sizes, so every brief failed at scope; the
  new caps hold a full 12-passage bundle and a full check, and the reservation is their
  worst case. DESIGN §9 has the measurements.)
- A public AI-availability endpoint.
- Moving an anonymous brief to a new account at sign-in.
- Brief-only AI content: AI output appears only inside the viewer's own live
  brief.

The implementation review must cover these. It must check in particular that no
reachable model, including any refusal-fallback target, lacks an allowlisted
price.

**Summary citations** (Task 16, post-E2E rounds 4 and 5; the allow-list in Task 16c).
Every summary sentence must end with the case markers it cites, so a sentence the
validator does not see as its own could borrow another's citation past the deterministic
check. The splitter and validator therefore withhold (server/briefs/sentences.ts):
- a summary with any character outside an allow-list: printable ASCII except Markdown
  and decoration (`* _ ~ | [ ] { }`), the quotation marks `“ ” ‘ ’`, the dashes `– —`,
  `° ± × ½ ¼ ¾ §`, and Latin-1 letters with diacritics; and HTML character references (a
  numeric one with or without its `;`, `&#46` included, and a named one with its `;`;
  `&` and letters without one, as in "A&P mechanic", is text nothing decodes). Nothing
  is trimmed before this check, so leading or trailing characters are judged too (Task
  16d, 16c review M6). What it guarantees: the only characters left that can end a
  sentence are `.`, `!` and `?`, and the only space is U+0020, so no other script's
  terminator, lookalike, line break, invisible character or other space can hide a
  boundary;
- a sentence with any `.`, `!` or `?` inside it other than a decimal point or a declared
  abbreviation context;
- a marker anywhere but at a sentence's end.

It does not guarantee that every human-visible clause boundary is a split: clauses
joined by `;`, `:`, a comma or a dash, and the declared contexts below, form one
sentence, and the checker judges that sentence whole.

An adversarial review of efe27ce (more than 600,000 crafted and random summaries, families
A to F) found the bypasses this closes; its 237-string corpus is a committed test
(tests/support/summary-corpus.ts). **Accepted residual (family G):** the six declared
abbreviation contexts ("No."/"Nos." before a number, "approx."/"ca." before a number,
"Mr."/"Mrs."/"Ms." before a capitalised name, "U.S." before a lower-case word or "Code",
"U.S.C." before a number or "§", "e.g."/"i.e." before a lower-case word) are not sentence
ends. A sentence that really ends with one of them joins the next one ("Was anyone hurt?
No. 3 passengers were injured"), which the code cannot tell apart from one sentence. The
evidence checker still judges the joined claim whole against the case's passages, and
the compose prompt (v5 and later) asks for no abbreviations with periods. Compound sentences joined by ";", ":",
a dash or a comma are one sentence by the same policy.

**Withheld-summary diagnostics** (Task 16, after the first paid end-to-end run; verdicts
added in Task 16c). A withheld summary keeps its rejected composition in
`brief_steps.diagnostics` (migration 0016), with the passage alias map, the summary
sentences as the validator split them and, for an evidence check, the claims the checker
read and its verdicts and quotes (passage aliases, verdict values, and words copied from
public NTSB passages). It is model output about public NTSB
passages, but it may restate or quote the reader's question, so it is **treated as
potentially containing user data**: the same class as the step's `request` and `result`,
under the same controls. It lives only in the application database: no route selects the
column and it never reaches a trace, a log line, a response or the browser (the step's
`meta`, spans and log carry only fixed codes and paths). `aviation_app` and the schema
owner `aviation_migrator` can read it; `aviation_ingest` cannot. The 0014 guard makes it
immutable once its step finishes. Its brief expires 24 hours after it was created, and
the next maintenance pass (`prune_controls()`, about every 10 minutes) deletes it with its
steps; until then the expired row still exists. Only `pnpm worker brief-diagnose`, run
by hand with the app role's credentials, prints it, to that operator's terminal, and it
refuses an expired brief unless given `--include-expired`. Astra's G6 follow-up 2 accepted
this storage under the existing request/result controls; the implementation review must
still cover it. Task 16d keeps the same record, under the same controls, for an answer
shown with claims removed by the display projection (reason `partial_display`), so the
raw verdicts behind a partial display can be read.

**Claim-level display** (Task 16d, `display-deps-v2` since Task 16e; off in production
until gate G6 clears it, `AI_PARTIAL_DISPLAY`). A claim the evidence check did not confirm, and
everything that depends on it, is removed by one pure function (server/briefs/display.ts)
before any response is built: the step result, the stored dimensions the case context
reads, and the inputs of a refinement are rendered from the projection's outcome, so
removed text reaches no response, no later model call and no browser. Removal is of whole
sentences and whole fields; nothing is spliced or reworded, and a removed summary sentence
leaves only a count marker. A criterion decision is never recomputed after a removal, so
it can only be downgraded to unconfirmed. The integration tests check every route surface
for removed text (tests/integration/briefs.test.ts, "claim-level display"). Diagnostics
keep the raw verdicts server-side only, as above. Task 16e adds two deterministic rules
before the check (`excerpt-context-v1`, `ordinal-evidence-v2`): a claim they abstain from
is projected out like a rejected one, on every surface (tests "excerpt-context-v1 end to
end" and "ordinal-evidence-v2 end to end"), and the step keeps only its key, rule and
content-free problem codes (`meta.staticRules`). The new page and drawer copy for removals
(UI_DESIGN §4.3) is fixed templates and counts, never model text.

**Google sign-in, accounts and the brief handover** (Task 20). Better Auth 1.7.7 behind
an allowlisted `/api/auth` route (README, "Google sign-in and accounts"). A Claude
security review and the gate review of the first implementation found handover and
deletion races, private context left in the page's cache after sign-out, restores that
would bring deleted accounts back, deletion with any session, no check of suspicious
signed-in activity, and loose ID-token claim checks; the fixes below are not yet
re-reviewed. The implementation review must cover in particular:

- the OAuth flow: the state (encrypted and authenticated in this browser's HttpOnly cookie,
  so starting a sign-in writes nothing to the database, and claimed once, atomically, by
  the first callback that gets through Google's code exchange and the ID-token checks,
  before any user, session or handover), PKCE, the nonce this app adds through Better
  Auth hooks (its Google provider sends none in the redirect flow), and the ID-token
  checks: an RS256 header with a
  signature part, this client as the only audience, `azp`, finite `exp` and `iat`, the
  issuer, `sub`, a verified email and the nonce. The signature itself is not verified,
  which OIDC Core 3.1.3.7 step 6 allows only because the token comes straight from
  Google's token endpoint over TLS in exchange for the flow's code, verifier and client
  secret: ID-token sign-in is off and no other route takes a token. That precondition is
  configuration (`disableIdTokenSignIn`, the endpoint allowlist); a change that routed
  another token source to `getUserInfo` must add JWKS verification;
- that only sign-in, Google's callback and sign-out are reachable, the request the route
  rebuilds for Better Auth (the `APP_URL` origin, the header allowlist, the network
  identity for its rate limiter), return paths without dot segments or encoded
  separators (visible ASCII without `"`, `#` or a backslash, at most 384 bytes, so the
  state cookie stays under 4 KB whatever a client sends), and that a deletion's
  re-authentication, its start and Google's callback to the signed-in browser, is counted
  per account (5 an hour each) and exempt from the per-network limit, so no flood of
  other sign-ins can hold it up;
- the handover's compare-and-set at the callback and at signed-in refinements and
  retries (the latter beyond UI_DESIGN §5's wording, pending the owner's sign-off), the
  403 `moved` answer to the old trial, that billing principals and charges never move,
  that reads check the owner in the statement that reads the content, and that a
  refinement or a cancel locks the brief (`lock_brief()`) and checks its owner first;
- the account lifecycle lock (`server/auth/lifecycle.ts`): deletion, an account's
  admission (where it is taken first, before anything accounts share), its step
  transactions, takeovers and the callback's handover serialize on it and recheck the
  session, so nothing is created or moved for a deleted account and an admission is given
  back without a model call; and the lock order after it (brief, steps, idempotency,
  anti-abuse record, then sessions before their deletion confirmations and the user),
  which the maintenance pass follows too (migration 0019 for retention; its orphaned-step
  update skips locked rows), as does issuing a confirmation;
- account deletion: a recent Google sign-in first (5 minutes; otherwise Google again for
  the same account, which confirms that session once for 5 minutes and ends the old
  session; Google offers no `max_age` or `prompt=login`, so a person signed in to Google
  passes its account chooser without a password, and a session cookie stolen within 5
  minutes of its sign-in can still delete), what one transaction removes (content through
  `delete_account_content()`, which locks the briefs first and returns running steps),
  the end of every session, and the anti-abuse record kept through the quota window plus
  7 days;
- signed-in AI checks (`server/identity/step-up.ts`): the signals and thresholds, the
  operator's `always` mode, that ordinary use takes no check, and that the anonymous
  retry check spends nothing;
- the page forgetting the previous visitor on sign-out and deletion, in every open tab
  (a `BroadcastChannel` and a random marker in local storage, also checked when a tab
  starts listening and when a page returns from the back/forward cache, which forgets
  anyway when it cannot read local storage; every private
  query, late answers dropped, the questions and retry keys; an AI request
  under way is discarded, its open Turnstile check cancelled, and it never restores a
  question, a retry key or a navigation);
- storage and backups: no provider tokens, scopes, picture, IP address or user agent
  (database hooks clear them, CHECK constraints refuse them), the app role's grants on
  the auth tables (no UPDATE; no DELETE of an account link on its own), backups without
  the sign-in, brief and idempotency rows, and the restore check before a restored
  service opens (every owner and grant as in a freshly migrated database; the restore runs
  as the migrator in one transaction); a restored ledger holds every paid operation until
  the spend since the backup is charged (`pnpm worker restore-reconcile`).

Accepted for the beta (owner to confirm): the session cookie lifetime of 7 days without a
device binding; the HMAC of the Google identity under IDENTITY_HMAC_SECRET (shared with
trials, separated by prefix) and its rotation still detaching usage (DESIGN §7, deferred
from Task 15); Better Auth's per-instance rate-limit store; and that a restore makes
everyone sign in again, with re-created accounts on the new-account allowance.

## Required implementation review before launch

Review a fixed code commit and deployment configuration with Claude Fable or Opus,
record the actual model and findings, and verify changes made afterward. Include:

- All paid-call entry points, concurrent admission, idempotency, uncertain usage,
  process crashes, cost updates, and request cancellation.
- Google OAuth callbacks, CSRF, cookie flags, logout/deletion, cross-user access,
  account re-creation, and trusted-proxy/origin enforcement.
- Safe rendering, case/citation allowlists, injection from user and source text,
  restricted SQL/search queries, and evidence attribution.
- Ingestion/parser isolation, source changes, stale assertions, least-privilege
  credentials, image/dependency advisories, backups, and restore behavior.
- Actual CDN caching, Turnstile replay/hostname/action checks, trial creation
  limits, and budget fairness under anonymous abuse.

Block launch on unresolved critical/high findings or failed auth, origin,
budget, and evidence-integrity tests. Use synthetic secrets and public fixtures.
Record actual test results; a successful model review is not a certification or
a promise of zero vulnerabilities.


## Evidence ranking experiments (Task 24, pending review)

The new dev-only `rankEvidence` pipeline optionally uses validated scope terms in
fixed BM25 query bodies and adds `rerank.r1`. Its separate automatic-state policy
defaults to `none`; any accepted automatic state is disclosed by evidence.v3.
The live allowlist contains only the baseline, with original-question retrieval and
no reranker. Public `evidence.v3` discloses executed keywords, automatic filters,
ordering, marks and undo availability; experiment metadata stays private.
A future live alternative requires evaluation, a gate and the new UI disclosure.

Question, aircraft labels, phases, probable causes and excerpts are untrusted quoted
data. The fixed prompt refuses embedded instructions; there are no tools or arbitrary
output text. Request-local labels and strict exact-coverage integer grades can only
reorder the supplied prefix. Injection can still bias ordering: schema validation
does not prove relevance, and evaluation must include adversarial cases. It cannot
add cases, facts, filters, links or prose, or modify canonical displayed excerpts.
Bounds retain complete sentences, preserve cause-variant slots and mark truncation.
Unknown/missing/duplicate IDs, non-integer grades, extra fields, refusals, token limits,
timeouts and provider failures all keep the fused order without retry.

Stage reservation includes full input/output caps and cache-write premiums; actual
usage settles per call and uncertain usage costs that stage's worst case. HTTP keeps
settlement and saved-result publication atomic; evaluation uses the production spend
gate and its allocation wrapper. The daily uncertain-charge allowance skips both
scope and rerank (zero charge for either), with normal embedding settlement.
Deletion/shutdown guards run before each stage; a guard refusal is `stopped`.
The adapter asserts the full registered configuration before counts or generation.
Paging and idempotent replays never run a provider. Tracing carries only operational
metadata (including rerank depth and outcome). Questions, case texts and grades
are not exported to traces. Saved execution metadata inherits the search's ownership,
backup exclusion and 24-hour expiry.


## Evidence.v3 automatic-state and free-undo boundary (pending review)

The automatic-state policy is frozen/hashed separately from the evaluated rankings.
Live allows `none` (the default and rollback) and `state-explicit.v1.2`; v1.1 was
never deployed and is no longer accepted. The guard accepts only a complete explicit
model-emitted event-state set. State-named-place rejection reduces v1's applied set;
v1.2 adds a further `other_event` rejection after NFKC for other-event references or
title/headline wording. The case-insensitive rule allows at most two intervening
word or hyphenated-word tokens between its reference word and event noun (DESIGN).
It rejects "discuss another accident in Alaska" and "titles include accidents in
Alaska", while retaining "cases in Texas involving other aircraft". The rule is
a strict subset of v1.1, so it cannot introduce a new automatic application.
The controller replayed all 1,040 recorded C field answers: v1.1 and v1.2 both
produced 367 TP / 0 FP / 33 FN, with no applications lost. This is retrospective
evidence limited to those answers, not proof of complete semantic safety or future
recall. No other scope filter is applied automatically; live ranking remains
`er-q-v1` only. The old v1/v1.1 guard regressions remain intact, alongside independent
new-rule probes, actual-source mutation tests and a frozen-v1.1 subset sanity test.
Scope's evaluated schema remains non-nullable and unchanged despite nullable terms
in the public remaining suggestion. Private policy/reason/ledger metadata is never
spread into the strict public page.

The quota exemption is server-owned and bounded to **one admission per original
question search**. Eligibility requires a v3 parent, current ownership, an unexpired results row,
no explicit terms, removal of at least one automatic addition and no other change.
Its parent is locked before bucket/spend locks; a write-once parent reservation claim
commits with the exempt reservation. Concurrent keys, replays, sign-in/handover,
failed child searches and descendants cannot multiply the exemption. The child has
no automatic additions and is explicitly marked as edited. Removing a state-OR member
is a paid narrowing; undo removes the entire automatic state facet. A claim is not
restored after an admitted search fails, preventing repeated free paid attempts.
Pre-run abandonment also consumes the claim: its idempotency slot expires, so a same-key
retry requires an ordinary quota-counted admission. The trigger checks actual expiry,
current owner and original payer, in addition to the open, quota-free reservation.
A two-principal race proves that at most one admission claims the exemption; it does
not require the account to win. A separate deterministic trial → sign-in → undo test
proves that the claim-time handover succeeds with the account as current owner and
the trial as original payer. Direct SQL violations test the owner/payer bindings.
If the database clock finds the parent expired while the app clock still considers
it eligible, the expiry-specific refusal returns the same 404 as an expired parent;
the admission transaction rolls back its reservation, claim and quota changes.

An eligible undo can pass exhausted visitor quota, but never bypasses Turnstile,
principal/network rate limits, concurrency, emergency modes, restore hold, budgets,
reservation fencing or settlement. The anonymous availability shortcut ignores only
its advisory `trial_used` outcome for a checked candidate; transactional admission
rechecks and claims eligibility. Every money gate remains authoritative. The request
schema refuses a client-supplied freeUndo or automaticFilters field. Account deletion
and retention remove parent claims with their already excluded private evidence rows.
The new claim column is private, non-resettable and included in restore privilege checks.

The scope guard is a conservative permission rule, not a proof of semantic safety for
all language. Relevance and incident interpretation remain research tasks; all public
filters, lexical changes, AI ordering and mark sources are disclosed and undoable.
