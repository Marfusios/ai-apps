/**
 * One brief step (DESIGN §5 "The online pipeline is fixed"), after admission:
 *
 * 1. **Scope** (10 s): the planner classifies the question. Anything other than a case
 *    search ends here with a static reply (server/briefs/static-replies.ts) and gives the
 *    free search back (`releaseQuota`); its cost is settled before the reply is sent.
 * 2. **Retrieve** (8 s): the `EvidenceRetriever` port (hybrid retrieval,
 *    server/briefs/retriever.ts) returns at most 6 cases / 12 passages: the question
 *    (and text refinement) feeds the dense channel, the scope stage's `keywordText` the
 *    BM25 channel. Query-embedding usage is recorded once, through the port's callback.
 *    **The bundle is then checked, fail closed** (gate G6 #2, #4): every passage against
 *    its canonical `passages` row and section revision (`resolvePassage`), at most 6
 *    cases and 12 passages, and every case holding its best retrieved passage and all its
 *    probable-cause passages. Any violation fails the step; nothing is dropped or cut.
 * 3. **Compose** (35 s): the full compose input is counted with the provider's own token
 *    counter; above the 16,000-token cap the same candidates are packed again with a
 *    smaller evidence budget (amendment A11), and the re-packed bundle is checked like the
 *    first. One model call. The answer model may abstain (`no_supported_match`).
 * 4. **Validate**: `validateComposition` (code); then the reader's criteria in code
 *    (server/briefs/criteria.ts: a presented case outside the timing window, first-flight
 *    requirement or failure type withholds the summary); then the model checker (12 s)
 *    over every claim, with every verified passage of each case and the criteria. Only
 *    `supported: true` with no problems passes.
 * 5. **Settle**: itemized ledger lines per stage; any call without reliable usage makes
 *    the settlement uncertain, charging the full reservation (Task 15).
 *
 * Every stage enforces its own complete-input cap with the provider's counter (the
 * provider counts the exact request before sending and refuses above the cap, unbilled):
 * scope and check fail the stage; compose re-packs first. A failed or inconclusive check,
 * a failed criterion or a failed compose call withholds the summary and returns the case
 * cards; there is no repair loop. Results are written stage by stage and only stage
 * status and counts are visible before the end. The whole step has a 60-second deadline
 * (each stage's timeout is cut to what is left). Cancel aborts the running call and keeps
 * the search counted (UI_DESIGN §4.4); a server shutdown aborts it too and fails the step.
 *
 * Counting (UI_DESIGN §5): scope replies and empty results give the free search back,
 * as does a failure before anything was spent; withheld summaries, abstentions,
 * cancellations and failures after spending keep it.
 *
 * Traces carry only content-free attributes (server/observability): stage, provider,
 * model, prompt version, token counts, cost, outcome and counts.
 */
import {
  BriefResultSchema,
  type BriefResult,
  type Checklist,
  type ComposeOutput,
  type CriterionDecision,
  type ScopeReply,
} from '../../shared/contracts/briefs.js';
import type { Db } from '../db/client.js';
import { stageCostUsd, STAGE_CAPS } from '../ai/pricing.js';
import { COMPOSE_PROMPT_VERSION } from '../ai/prompts/compose.v2.js';
import {
  StageError,
  stageCtx,
  type LlmProvider,
  type LlmStage,
  type ScopeOutput,
  type StageResult,
  type StageUsage,
} from '../ai/provider.js';
import { hashBrief } from '../observability/attributes.js';
import { stageSpan, startRequestSpan, type StageSpanHandle } from '../observability/tracing.js';
import type { BriefStepStatus } from '../db/schema/index.js';
import { microsToNumeric, toMicros } from '../quota/pacing.js';
import { PIPELINE_DEADLINE_MS, type QuotaPolicy } from '../quota/policy.js';
import { releaseQuota, type Admission } from '../quota/admit.js';
import { settle, type SpendLine } from '../quota/settle.js';
import { PASSAGES_CONTRACT } from '../search/passages-contract.js';
import { clarificationReadings, composeInterpretations, interpretationChips } from './clarify.js';
import { criteriaLines, evaluateCase } from './criteria.js';
import { RetrievalFailure, type CaseCatalog, type EvidenceBundle, type EvidenceRetriever, type RetrievedEvidence } from './evidence.js';
import { resolveIntent, retrievalText, scopeInput, type StepIntent, type StepRequest } from './intent.js';
import { answerResult, checkInput, composeInput, noMatchResult, plainCard, storedDimensions, storedEvidence, type VerifiedCase } from './render.js';
import { clarificationReply, comparisonReply, operationalReply, outOfScopeReply, statisticsReply } from './static-replies.js';
import { finishStep, readBrief, readStepById, writeStage, type StoredEvidence } from './store.js';
import { QUOTE_MATCH_RULE_VERSION, resolvePassage, validateComposition, type AllowedPassage, type Allowlist } from './validate.js';

/** Per-stage timeouts and the total deadline, in milliseconds (DESIGN §8). */
export interface StageTimeouts {
  scope: number;
  retrieve: number;
  compose: number;
  check: number;
  total: number;
}

export const STAGE_TIMEOUTS: Readonly<StageTimeouts> = Object.freeze({
  scope: 10_000,
  retrieve: 8_000,
  compose: 35_000,
  check: 12_000,
  total: PIPELINE_DEADLINE_MS,
});

/** At most this many re-packs to fit the compose cap. */
export const MAX_REPACKS = 2;
/** Bundle bounds (DESIGN §5); a bundle over them is refused, never cut. */
export const MAX_BUNDLE_CASES = 6;
export const MAX_BUNDLE_PASSAGES = 12;

/** The abort reason a server shutdown gives running steps (server/app.ts `onClose`). */
export const SHUTDOWN_REASON = 'shutdown';

export interface PipelineLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface BriefDeps {
  /** PostgreSQL as aviation_app. */
  db: Db;
  llm: LlmProvider;
  retriever: EvidenceRetriever;
  catalog: CaseCatalog;
  policy: QuotaPolicy;
  now?: () => Date;
  log?: PipelineLog;
  timeouts?: Partial<StageTimeouts>;
  /** Salt of the brief hash in traces (never the raw brief id). */
  traceSalt?: string;
  /** The chunker version of the served passages (default the approved contract's). */
  chunkerVersion?: string;
}

/** What the scope stage decided, for a caller waiting to answer the request. */
export type ScopedOutcome =
  | { kind: 'continue' }
  | { kind: 'reply'; reply: ScopeReply }
  | { kind: 'ended'; stage: 'done' | 'failed' };

export interface RunHooks {
  onScoped?: (o: ScopedOutcome) => void;
  /** Cancel (any reason) or shutdown (`SHUTDOWN_REASON`): aborts the running stage. */
  signal?: AbortSignal;
  /** Content-free id of the request, kept in the step's record (the ledger lines carry it too). */
  requestId?: string;
}

export interface StepOutcome {
  status: Exclude<BriefStepStatus, 'running'>;
  /** USD charged; null when settlement did not finish (lease expiry then charges in full). */
  chargedUsd: number | null;
  /** True when the free search was given back. */
  released: boolean;
}

/** A bundle that breaks the provenance or completeness rules (a fixed, content-free reason). */
export class BundleIntegrityError extends Error {
  override readonly name = 'BundleIntegrityError';
  constructor(readonly reason: string) {
    super(`evidence bundle refused: ${reason}`);
  }
}

interface Meta {
  requestId?: string;
  promptVersions: Partial<Record<LlmStage, string>>;
  models: Partial<Record<LlmStage, string>>;
  timingsMs: Record<string, number>;
  repacks: number;
  /** `reason`: a fixed failure reason (retrieval's, or the bundle check's), when there is one. */
  failure?: { stage: string; category: string; reason?: string };
  clarificationDropped?: boolean;
  outcome?: ComposeOutput['outcome'];
  validation?: { ruleVersion: string; codes: string[] };
  criteria?: { ntsbNo: string; criterion: string; decision: string }[];
  check?: { supported: boolean; problems: { kind: string; reason: string }[] };
  settlement?: { status: string; uncertain?: boolean };
}

const NEVER = new AbortController().signal;

const tokensOf = (u: StageUsage) => ({
  input: u.inputTokens,
  output: u.outputTokens,
  cacheWrite: u.cacheWriteTokens,
  cacheRead: u.cacheReadTokens,
});

/**
 * Run step `stepId` to its end. Never throws: every failure ends the step (`failed`)
 * and settles. `admission` is the step's fresh admission (its fencing token settles it).
 */
export async function runBriefStep(deps: BriefDeps, stepId: string, admission: Admission, hooks: RunHooks = {}): Promise<StepOutcome> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? { info() {}, warn() {} };
  let scopedSent = false;
  const scoped = (o: ScopedOutcome) => {
    if (scopedSent) return;
    scopedSent = true;
    try {
      hooks.onScoped?.(o);
    } catch {
      // The listener's problem; the run goes on.
    }
  };
  try {
    const step = await readStepById(deps.db, stepId);
    const brief = step ? await readBrief(deps.db, step.briefId, now()) : null;
    if (!step || !brief || step.status !== 'running') throw new Error('the brief step is not running');
    const attrs = {
      ...(deps.traceSalt ? { briefHash: hashBrief(brief.id, deps.traceSalt) } : {}),
      datasetGeneration: String(brief.generationId),
    };
    return await startRequestSpan('brief.step', attrs, (span) =>
      new Run(deps, step.id, step.request, brief, admission, hooks, scoped, now, log, span).run(),
    );
  } catch (err) {
    log.warn({ err: { name: (err as Error)?.name } }, 'brief step failed unexpectedly');
    // Settle conservatively; lease expiry would do the same.
    const settled = await settle(deps.db, admission, 'uncertain', admission.fencingToken, now()).catch(() => null);
    await finishStep(deps.db, stepId, {
      stage: 'failed',
      status: 'failed',
      checklist: {},
      result: { kind: 'failed', countedAsSearch: true },
      provider: deps.llm.name,
      model: null,
      meta: { failure: { stage: 'pipeline', category: 'unexpected' }, ...(hooks.requestId ? { requestId: hooks.requestId } : {}) },
      costUsd: settled?.ok ? microsToNumeric(toMicros(settled.chargedUsd)) : null,
      now: now(),
    }).catch(() => false);
    scoped({ kind: 'ended', stage: 'failed' });
    return { status: 'failed', chargedUsd: settled?.ok ? settled.chargedUsd : null, released: false };
  }
}

type StageEnd = {
  status: Exclude<BriefStepStatus, 'running'>;
  stage: 'done' | 'failed';
  result: BriefResult;
  release: boolean;
  /** For a static reply: sent to the waiting request once the step is settled and stored. */
  reply?: ScopeReply;
};

class Run {
  private readonly t: StageTimeouts;
  private readonly started = performance.now();
  private readonly signal: AbortSignal;
  private readonly cancel: AbortSignal;
  private readonly chunkerVersion: string;
  private readonly lines: SpendLine[] = [];
  private uncertain = false;
  private spent = false;
  /** A cancel recorded in the database (another instance, or before the run's controller existed). */
  private cancelled = false;
  private checklist: Checklist = {};
  private intent: StepIntent | null = null;
  private evidence: StoredEvidence | null = null;
  private readonly meta: Meta = { promptVersions: {}, models: {}, timingsMs: {}, repacks: 0 };

  constructor(
    private readonly deps: BriefDeps,
    private readonly stepId: string,
    private readonly req: StepRequest,
    private readonly brief: { id: string; generationId: number; passagesIndex: string },
    private readonly admission: Admission,
    hooks: RunHooks,
    private readonly scoped: (o: ScopedOutcome) => void,
    private readonly now: () => Date,
    private readonly log: PipelineLog,
    private readonly span: StageSpanHandle,
  ) {
    this.t = { ...STAGE_TIMEOUTS, ...deps.timeouts };
    this.cancel = hooks.signal ?? NEVER;
    this.chunkerVersion = deps.chunkerVersion ?? PASSAGES_CONTRACT.chunkerVersion;
    if (hooks.requestId) this.meta.requestId = hooks.requestId;
    this.signal = AbortSignal.any([this.cancel, AbortSignal.timeout(this.t.total)]);
  }

  private get stopped(): 'cancelled' | 'shutdown' | null {
    if (this.cancel.aborted) return this.cancel.reason === SHUTDOWN_REASON ? 'shutdown' : 'cancelled';
    return this.cancelled ? 'cancelled' : null;
  }

  private remaining(): number {
    return this.t.total - (performance.now() - this.started);
  }

  /** A signal bound to the stage's timeout, cut to what is left of the deadline. */
  private stageSignal(ms: number): { signal: AbortSignal; budget: number } {
    const budget = Math.max(1, Math.floor(Math.min(ms, this.remaining())));
    return { signal: AbortSignal.any([this.signal, AbortSignal.timeout(budget)]), budget };
  }

  private charge<T>(stage: LlmStage, r: StageResult<T>): void {
    this.meta.promptVersions[stage] = r.promptVersion;
    this.meta.models[stage] = r.model;
    this.lines.push({ usd: stageCostUsd(r.model, r.usage), provider: r.provider, model: r.model, stage, tokens: tokensOf(r.usage) });
    this.spent = true;
  }

  /**
   * Record what a failed stage cost: billed usage, nothing, or uncertain. `called`: the
   * paid call had started, so an error that is not a `StageError` may have been billed.
   */
  private chargeFailure(err: unknown, stage: LlmStage, called: boolean): void {
    if (!(err instanceof StageError)) {
      if (called) {
        this.uncertain = true;
        this.spent = true;
      }
      return;
    }
    this.meta.promptVersions[stage] = err.promptVersion;
    this.meta.models[stage] = err.model;
    if (err.billing.kind === 'usage') {
      this.lines.push({ usd: stageCostUsd(err.model, err.billing.usage), provider: err.provider, model: err.model, stage, tokens: tokensOf(err.billing.usage) });
      this.spent = true;
    } else if (err.billing.kind === 'uncertain') {
      this.uncertain = true;
      this.spent = true;
    }
  }

  private failureOf(stage: string, err: unknown): Meta['failure'] {
    const category =
      err instanceof StageError
        ? err.category
        : err instanceof RetrievalFailure
          ? err.kind
          : err instanceof BundleIntegrityError
            ? 'integrity'
            : (err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError'
              ? 'timeout'
              : 'unexpected';
    const reason = err instanceof RetrievalFailure ? err.reason : err instanceof BundleIntegrityError ? err.reason : undefined;
    return { stage, category, ...(reason ? { reason } : {}) };
  }

  private async stage(stage: 'retrieve' | 'compose' | 'validate', checklist: Checklist, intent?: StepIntent): Promise<boolean> {
    this.checklist = checklist;
    const w = await writeStage(this.deps.db, this.stepId, { stage, checklist, ...(intent ? { intent } : {}), now: this.now() });
    if (w.cancelRequested) this.cancelled = true;
    return w.running && this.stopped === null;
  }

  /** The end of a stopped step: the reader's cancel keeps the search; a shutdown fails the step. */
  private stoppedEnd(): StageEnd {
    if (this.stopped === 'shutdown') {
      this.meta.failure = { stage: 'pipeline', category: 'shutdown' };
      return { status: 'failed', stage: 'failed', result: { kind: 'failed', countedAsSearch: this.spent }, release: !this.spent };
    }
    return { status: 'cancelled', stage: 'failed', result: { kind: 'cancelled' }, release: false };
  }

  private failedEnd(stage: string, err: unknown): StageEnd {
    if (this.stopped) return this.stoppedEnd();
    this.meta.failure = this.failureOf(stage, err);
    // Nothing spent: the search is given back ("This didn't use one of your searches").
    return { status: 'failed', stage: 'failed', result: { kind: 'failed', countedAsSearch: this.spent }, release: !this.spent };
  }

  private withheldEnd(
    reason: 'citation_check' | 'criteria_check' | 'evidence_check' | 'compose_failed',
    cases: VerifiedCase[],
    intent: StepIntent,
  ): StageEnd {
    if (this.stopped) return this.stoppedEnd();
    this.checklist = { ...this.checklist, ...(reason === 'compose_failed' ? {} : { written: true }), verified: 'withheld' };
    return {
      status: 'withheld',
      stage: 'done',
      result: { kind: 'withheld', interpretations: interpretationChips(intent.readings), filters: intent.filters, reason, cases: cases.map(plainCard) },
      release: false,
    };
  }

  async run(): Promise<StepOutcome> {
    const end = await this.stages();
    const outcome = await this.finish(end);
    // A static reply goes out only once the step is settled and stored.
    if (end.reply) this.scoped({ kind: 'reply', reply: end.reply });
    else this.scoped({ kind: 'ended', stage: end.stage });
    return outcome;
  }

  private async stages(): Promise<StageEnd> {
    const { deps, req } = this;
    const { llm } = deps;

    // 1. Scope.
    let intent: StepIntent;
    {
      const t0 = performance.now();
      const { signal, budget } = this.stageSignal(this.t.scope);
      let r: StageResult<ScopeOutput>;
      try {
        r = await stageSpan('brief.scope', { stage: 'scope', provider: llm.name, model: llm.models.scope }, async (s) => {
          const out = await llm.scope(scopeInput(req), stageCtx('scope', signal, budget));
          s.setAttrs({ promptVersion: out.promptVersion, ...usageAttrs(out.usage), outcome: out.output.intent });
          return out;
        });
      } catch (err) {
        this.chargeFailure(err, 'scope', true);
        this.meta.timingsMs.scope = Math.round(performance.now() - t0);
        return this.failedEnd('scope', err);
      }
      this.charge('scope', r);
      this.meta.timingsMs.scope = Math.round(performance.now() - t0);
      intent = resolveIntent(req, r.output);
      this.intent = intent;

      const reply = await this.scopeReply(r.output, intent);
      if (reply) {
        this.checklist = {};
        return { status: 'scope_reply', stage: 'done', result: { kind: 'scope_reply', reply }, release: true, reply };
      }
    }

    // 2. Retrieve, then check the bundle (fail closed).
    if (!(await this.stage('retrieve', { question: 'in_scope' }, intent))) return this.stoppedEnd();
    this.scoped({ kind: 'continue' });
    let retrieved: RetrievedEvidence;
    let cases: VerifiedCase[];
    {
      const t0 = performance.now();
      const { signal } = this.stageSignal(this.t.retrieve);
      try {
        retrieved = await stageSpan('brief.retrieve', { stage: 'retrieve' }, async (s) => {
          const out = await deps.retriever.retrieve(
            {
              dataset: { generationId: this.brief.generationId, passagesIndex: this.brief.passagesIndex },
              text: retrievalText(req),
              keywordText: intent.keywordText,
              filters: intent.filters,
            },
            signal,
            (u) => {
              this.lines.push({ usd: u.usd, provider: u.provider, model: u.model, stage: 'embed', tokens: { input: u.tokens } });
              this.spent = true;
              if (u.billing === 'uncertain') this.uncertain = true;
            },
          );
          s.setAttrs({ caseCount: out.bundle.cases.length, passageCount: out.bundle.passages });
          return out;
        });
        cases = await this.verify(retrieved.bundle);
      } catch (err) {
        if (err instanceof RetrievalFailure) {
          if (err.embedding === 'uncertain') {
            this.uncertain = true;
            this.spent = true;
          }
        } else if (!(err instanceof BundleIntegrityError) && !this.lines.some((l) => l.stage === 'embed')) {
          // Retrieval broke without reporting its embedding: it may have been billed.
          this.uncertain = true;
          this.spent = true;
        }
        this.meta.timingsMs.retrieve = Math.round(performance.now() - t0);
        if (err instanceof BundleIntegrityError) this.log.warn({ reason: err.reason }, 'brief evidence refused');
        return this.failedEnd('retrieve', err);
      }
      this.meta.timingsMs.retrieve = Math.round(performance.now() - t0);
    }
    intent = { ...intent, caseNumbers: cases.map((c) => c.ntsbNo) };
    this.intent = intent;
    this.evidence = storedEvidence(cases, null);
    if (cases.length === 0) {
      this.checklist = { question: 'in_scope', searched: { cases: 0, passages: 0 } };
      if (this.stopped) return this.stoppedEnd();
      return {
        status: 'no_results',
        stage: 'done',
        result: { kind: 'no_results', interpretations: interpretationChips(intent.readings), filters: intent.filters },
        release: true,
      };
    }
    const searched = () => ({ cases: cases.length, passages: cases.reduce((n, c) => n + c.passages.length, 0) });
    if (!(await this.stage('compose', { question: 'in_scope', searched: searched() }, intent))) return this.stoppedEnd();

    // 3. Compose, within the measured input cap; a re-packed bundle is checked again.
    let composition: ComposeOutput;
    {
      const t0 = performance.now();
      const { signal, budget } = this.stageSignal(this.t.compose);
      const ctx = stageCtx('compose', signal, budget);
      const interpretations = composeInterpretations(intent.readings);
      const build = (cs: VerifiedCase[]) =>
        composeInput(cs, {
          question: req.question,
          ...(req.refinement ? { refinement: req.refinement } : {}),
          mechanicalCause: intent.mechanicalCause,
          interpretations,
        });
      let called = false;
      try {
        composition = await stageSpan('brief.compose', { stage: 'compose', provider: llm.name, model: llm.models.answer }, async (s) => {
          let input = build(cases);
          let bundle = retrieved.bundle;
          for (;;) {
            const count = await llm.countInputTokens('compose', input, ctx);
            if (count <= STAGE_CAPS.answer.input) break;
            if (this.meta.repacks >= MAX_REPACKS) {
              throw new StageError('cap_exceeded', {
                stage: 'compose',
                provider: llm.name,
                model: llm.models.answer,
                promptVersion: COMPOSE_PROMPT_VERSION,
                billing: { kind: 'none' },
                countedInputTokens: count,
              });
            }
            const target = Math.max(1, Math.floor(bundle.evidenceTokens * (STAGE_CAPS.answer.input / count) * 0.9));
            bundle = await retrieved.repack(target, signal);
            this.meta.repacks += 1;
            cases = await this.verify(bundle);
            if (cases.length === 0) throw new BundleIntegrityError('empty_after_repack');
            this.evidence = storedEvidence(cases, null);
            input = build(cases);
          }
          s.setAttrs({ caseCount: cases.length, passageCount: input.cases.reduce((n, c) => n + c.passages.length, 0) });
          called = true;
          const out = await llm.compose(input, ctx);
          s.setAttrs({ promptVersion: out.promptVersion, ...usageAttrs(out.usage), outcome: out.output.outcome });
          this.charge('compose', out);
          return out.output;
        });
      } catch (err) {
        this.chargeFailure(err, 'compose', called);
        this.meta.timingsMs.compose = Math.round(performance.now() - t0);
        if (err instanceof BundleIntegrityError || err instanceof RetrievalFailure) {
          // The re-packed bundle failed its checks: no evidence to show.
          if (err instanceof BundleIntegrityError) this.log.warn({ reason: err.reason }, 'brief evidence refused after re-packing');
          return this.failedEnd('compose', err);
        }
        this.meta.failure = this.failureOf('compose', err);
        return this.withheldEnd('compose_failed', cases, intent);
      }
      this.meta.timingsMs.compose = Math.round(performance.now() - t0);
    }
    this.meta.outcome = composition.outcome;
    if (!(await this.stage('validate', { question: 'in_scope', searched: searched(), written: true }))) return this.stoppedEnd();

    // 4. Validate: code checks, the reader's criteria, then the evidence checker.
    const byCase = new Map(cases.map((c) => [c.ntsbNo, c]));
    const allow: Allowlist = {
      passages: new Map(cases.flatMap((c) => c.passages.map((p): [string, AllowedPassage] => [p.passageId, p.allowed]))),
      cases: new Set(cases.flatMap((c) => [c.ntsbNo, ...c.summary.aircraftNumbers])),
    };
    const validated = validateComposition(composition, allow, { mechanicalCause: intent.mechanicalCause });
    this.meta.validation = { ruleVersion: validated.ruleVersion, codes: validated.ok ? [] : validated.reasons.map((r) => r.code) };
    if (!validated.ok) return this.withheldEnd('citation_check', cases, intent);

    const decisions = new Map<string, CriterionDecision[]>();
    const criterionClaims = new Map<string, string[]>();
    this.meta.criteria = [];
    let outside = false;
    for (const k of composition.cases) {
      const e = evaluateCase(intent.readings, k, intent.mechanicalCause);
      for (const d of e.decisions) {
        this.meta.criteria.push({ ntsbNo: k.ntsbNo, criterion: d.criterion, decision: d.decision });
        if (d.decision === 'does_not_match') outside = true;
      }
      decisions.set(
        k.ntsbNo,
        e.decisions.map((d) => ({ criterion: d.criterion, decision: d.decision === 'matches' ? 'matches' : 'unknown' })),
      );
      criterionClaims.set(k.ntsbNo, e.claims);
    }
    // A case outside the reader's criteria is never presented as a match.
    if (outside) return this.withheldEnd('criteria_check', cases, intent);

    const context = { interpretations: interpretationChips(intent.readings), filters: intent.filters };
    const { input, claims, overflow } = checkInput(composition, validated.citations, byCase, {
      mechanicalCause: intent.mechanicalCause,
      criteria: criteriaLines(intent.readings),
      criterionClaims,
    });
    if (overflow) {
      // A claim that cannot be checked is never shown.
      this.meta.failure = { stage: 'check', category: 'claims_overflow' };
      return this.withheldEnd('evidence_check', cases, intent);
    }
    if (input.claims.length > 0) {
      const t0 = performance.now();
      const { signal, budget } = this.stageSignal(this.t.check);
      try {
        const out = await stageSpan('brief.check', { stage: 'check', provider: llm.name, model: llm.models.check }, async (s) => {
          const r = await llm.check(input, stageCtx('check', signal, budget));
          s.setAttrs({ promptVersion: r.promptVersion, ...usageAttrs(r.usage), outcome: r.output.supported && r.output.problems.length === 0 ? 'supported' : 'problems' });
          return r;
        });
        this.charge('check', out);
        this.meta.timingsMs.check = Math.round(performance.now() - t0);
        this.meta.check = {
          supported: out.output.supported,
          problems: out.output.problems.map((p) => ({ kind: claims[p.claimIndex]?.kind ?? 'unknown', reason: p.reason })),
        };
        // Conservative: any problem, or "supported" without being sure of every claim, withholds.
        if (!out.output.supported || out.output.problems.length > 0) return this.withheldEnd('evidence_check', cases, intent);
      } catch (err) {
        this.chargeFailure(err, 'check', true);
        this.meta.failure = this.failureOf('check', err);
        this.meta.timingsMs.check = Math.round(performance.now() - t0);
        return this.withheldEnd('evidence_check', cases, intent);
      }
    }
    if (this.stopped) return this.stoppedEnd();

    this.checklist = { question: 'in_scope', searched: searched(), written: true, verified: 'passed' };
    if (composition.outcome === 'no_supported_match') {
      this.evidence = storedEvidence(cases, QUOTE_MATCH_RULE_VERSION);
      return { status: 'no_match', stage: 'done', result: noMatchResult(composition, cases, context), release: false };
    }
    this.evidence = storedEvidence(cases, QUOTE_MATCH_RULE_VERSION, storedDimensions(composition, intent.mechanicalCause));
    return {
      status: 'answered',
      stage: 'done',
      result: answerResult({
        composition,
        citations: validated.citations,
        cases: byCase,
        mechanicalCause: intent.mechanicalCause,
        ...context,
        criteria: decisions,
      }),
      release: false,
    };
  }

  /** The static reply for a scope outcome other than a case search, or null to search. */
  private async scopeReply(scope: ScopeOutput, intent: StepIntent): Promise<ScopeReply | null> {
    switch (intent.intent) {
      case 'case_search':
        return null;
      case 'out_of_scope':
        return outOfScopeReply();
      case 'operational_advice':
        return operationalReply();
      case 'corpus_statistics':
        return statisticsReply(intent.filters);
      case 'case_comparison': {
        // Only numbers the reader actually wrote (case-insensitive); the planner cannot add one.
        const written = (this.req.origin === 'text' && this.req.refinement ? this.req.refinement : this.req.question).toUpperCase();
        const asked = (scope.caseNumbers ?? []).filter((n) => written.includes(n.toUpperCase()));
        if (asked.length === 0) {
          intent.intent = 'case_search';
          return null;
        }
        const existing = await this.deps.catalog.summaries(this.brief.generationId, asked);
        return comparisonReply(asked, new Set(existing.keys()));
      }
      case 'needs_clarification': {
        const readings = scope.ambiguity ? clarificationReadings(scope.ambiguity, intent.filters) : [];
        if (readings.length >= 2) return clarificationReply(readings);
        // Nothing the server can offer: run the search with no reading of the term.
        this.meta.clarificationDropped = true;
        intent.intent = 'case_search';
        return null;
      }
    }
  }

  /**
   * Check a bundle, fail closed (gate G6 #2, #4): at most 6 cases and 12 passages, each
   * passage the canonical row it claims to be (`resolvePassage`), each case known to the
   * dataset and holding its best retrieved passage (reserved, ranked) and every
   * probable-cause passage it has. Any violation throws `BundleIntegrityError`; nothing is
   * dropped or cut.
   */
  private async verify(bundle: EvidenceBundle): Promise<VerifiedCase[]> {
    const { catalog } = this.deps;
    const g = this.brief.generationId;
    const all = bundle.cases.flatMap((c) => c.passages);
    if (bundle.cases.length > MAX_BUNDLE_CASES) throw new BundleIntegrityError('too_many_cases');
    if (all.length > MAX_BUNDLE_PASSAGES) throw new BundleIntegrityError('too_many_passages');
    const numbers = bundle.cases.map((c) => c.ntsbNo);
    if (new Set(numbers).size !== numbers.length) throw new BundleIntegrityError('duplicate_case');
    if (new Set(all.map((p) => p.passageId)).size !== all.length) throw new BundleIntegrityError('duplicate_passage');
    const [canonical, causes, summaries] = await Promise.all([
      catalog.passages(g, this.chunkerVersion, all.map((p) => p.passageId)),
      catalog.causePassageIds(g, this.chunkerVersion, numbers),
      catalog.summaries(g, numbers),
    ]);
    const out: VerifiedCase[] = [];
    for (const c of bundle.cases) {
      const summary = summaries.get(c.ntsbNo);
      if (!summary) throw new BundleIntegrityError('unknown_case');
      if (c.passages.length === 0) throw new BundleIntegrityError('empty_case');
      const passages: VerifiedCase['passages'] = [];
      for (const p of c.passages) {
        if (p.ntsbNo !== c.ntsbNo) throw new BundleIntegrityError('foreign_passage');
        const r = resolvePassage(p, canonical.get(p.passageId));
        if (!r.ok) throw new BundleIntegrityError(r.problem);
        passages.push({ passageId: p.passageId, role: p.role, reserved: p.reserved, rank: p.rank, sectionKind: r.allowed.sectionKind, allowed: r.allowed });
      }
      // The case's justification survived: its best retrieved passage and every cause.
      if (!passages.some((p) => p.reserved && p.rank !== null)) throw new BundleIntegrityError('missing_best_passage');
      const held = new Set(passages.map((p) => p.passageId));
      const required = causes.get(c.ntsbNo) ?? [];
      if (required.length === 0) throw new BundleIntegrityError('no_cause');
      if (required.some((id) => !held.has(id))) throw new BundleIntegrityError('missing_cause');
      out.push({ ntsbNo: c.ntsbNo, rank: c.rank, summary, passages });
    }
    return out;
  }

  private async finish(end: StageEnd): Promise<StepOutcome> {
    const { db, policy } = this.deps;
    // A result outside its contract would make the step unreadable: fail it cleanly instead.
    if (!BriefResultSchema.safeParse(end.result).success) {
      this.log.warn({ kind: end.result.kind }, 'brief step: the result failed its contract');
      this.meta.failure = { stage: 'pipeline', category: 'result_contract' };
      end = { status: 'failed', stage: 'failed', result: { kind: 'failed', countedAsSearch: this.spent }, release: !this.spent };
    }
    let released = false;
    if (end.release) {
      try {
        const r = await releaseQuota(db, this.admission, this.admission.fencingToken, { policy, now: this.now() });
        released = r.released;
      } catch (err) {
        this.log.warn({ err: { name: (err as Error)?.name } }, 'brief step: the free search could not be given back');
      }
    }
    let chargedUsd: number | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const s = await settle(db, this.admission, { lines: this.lines, uncertain: this.uncertain }, this.admission.fencingToken, this.now()).catch(
        (err: unknown) => {
          this.log.warn({ err: { name: (err as Error)?.name } }, 'brief step: settlement failed');
          return null;
        },
      );
      if (s?.ok) {
        chargedUsd = s.chargedUsd;
        this.meta.settlement = { status: 'settled', uncertain: s.uncertain };
        break;
      }
      if (s && !s.ok && s.reason !== 'busy') {
        if (s.reason === 'lease_expired') chargedUsd = s.chargedUsd ?? null;
        this.meta.settlement = { status: s.reason };
        break;
      }
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
    // A failure counts as a search unless its search was given back.
    if (end.result.kind === 'failed') end.result = { kind: 'failed', countedAsSearch: !released };
    this.span.setAttrs({ outcome: end.status, ...(chargedUsd !== null ? { usd: chargedUsd } : {}) });
    const written = await finishStep(db, this.stepId, {
      stage: end.stage,
      status: end.status,
      checklist: this.checklist,
      result: end.result,
      intent: this.intent,
      evidence: this.evidence,
      provider: this.deps.llm.name,
      model: this.meta.models.compose ?? null,
      meta: { ...this.meta },
      costUsd: chargedUsd === null ? null : microsToNumeric(toMicros(chargedUsd)),
      now: this.now(),
    }).catch((err: unknown) => {
      this.log.warn({ err: { name: (err as Error)?.name } }, 'brief step: the final state could not be written');
      return false;
    });
    if (!written) this.log.warn({}, 'brief step: final state not written (step no longer running)');
    this.log.info({ status: end.status, charged: chargedUsd, released }, 'brief step finished');
    return { status: end.status, chargedUsd, released };
  }
}

function usageAttrs(u: StageUsage) {
  return { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheWriteTokens: u.cacheWriteTokens, cacheReadTokens: u.cacheReadTokens };
}
