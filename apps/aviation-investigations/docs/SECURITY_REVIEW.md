# Aviation Casebook: design security review

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
| F1 | High | Timeouts or disconnects lose provider usage, allowing unjustified refunds or stuck reservations | Unknown usage settles at the reserved maximum; no automatic refund. Operator reconciles dedicated-project billing; no organization billing credential in the public app |
| F2 | Medium–high | Expired leases allow duplicate requests or late settlement by stale workers | Hard deadline shorter than lease TTL; fencing/ownership checks; idempotent retries never silently rerun; money remains reserved independently of slots |
| F3 | High | Forged forwarding headers create unlimited network identities through another origin path | Explicit `trustProxy: false`, dedicated ingress network, actual connector peer checks, no published production port, denial when trusted client identity is missing, container-origin spoofing tests |
| F4 | Medium | A few identities consume the public budget or hold all AI slots | Anonymous share capped at 25%, one anonymous slot, signed-in network limits, smaller new-account allowance, monthly pacing and emergency login-required mode; exhaustion remains a residual risk |
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
  reservations of $0.31 (Opus answer model) instead of $0.03, and a $100 monthly
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

**Withheld-summary diagnostics** (Task 16, after the first paid end-to-end run; also
unreviewed). A withheld summary keeps its rejected composition in
`brief_steps.diagnostics` (migration 0016): model output about public NTSB passages,
which may restate the reader's question, with the passage alias map, the summary
sentences as the validator split them and, for an evidence check, the claims the checker
read. It is the same class of data as the step's `request` and `result` and shares
their controls. It lives only in the application database: no route selects the column
and it never reaches a trace, a log line, a response or the browser (the step's `meta`,
spans and log carry only fixed codes and paths). `aviation_app` and the schema owner
`aviation_migrator` can read it; `aviation_ingest` cannot. The 0014 guard makes it
immutable once its step finishes, and `prune_controls()` deletes it with its brief 24
hours after the brief was created. Only `pnpm worker brief-diagnose`, run by hand with
the app role's credentials, prints it, to that operator's terminal. The implementation
review must cover it.

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
