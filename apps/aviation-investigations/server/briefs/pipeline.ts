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
 *    its canonical `passages` row (under the chunker of the served index's passages
 *    contract, which the port reports) and section revision (`resolvePassage`), at most 6
 *    cases and 12 passages, and every case holding its best retrieved passage and all its
 *    probable-cause passages. Any violation fails the step; nothing is dropped or cut.
 * 3. **Compose** (35 s): the full compose input is counted with the provider's own token
 *    counter; above the answer input cap (`STAGE_CAPS.answer`) the same candidates are
 *    packed again with a smaller evidence budget (amendment A11), and the re-packed bundle
 *    is checked like the first. One model call. The answer model may abstain
 *    (`no_supported_match`). The compose and check stages read passages under short
 *    aliases (`P1`..), mapped back to canonical ids before validation (aliases.ts).
 * 4. **Validate**: `validateComposition` (code); then the reader's criteria in code
 *    (server/briefs/criteria.ts, under the versioned timing rules: a presented case
 *    outside the timing window, first-flight requirement or failure type withholds the
 *    summary); then the model checker over every claim, with every verified passage of
 *    each case and the criteria. Every criterion decision is a claim, an unconfirmed one
 *    included ("under the timing rules, the supplied passages of this case do not settle
 *    whether..."), so a fact the composition left out settles nothing. The checker returns
 *    one verdict per server-issued claim id, judged in code (server/briefs/verdicts.ts):
 *    the summary passes only when every claim has exactly one valid `supported` verdict.
 *    A contradicted "do not settle" claim is recorded as `chronology_missed` and
 *    withholds like any other. A check input over the checker's cap withholds the summary
 *    with the cap failure in the step's `meta`; the evidence is never cut to fit.
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
 * the search counted (UI_DESIGN §4.4); a server shutdown aborts it too and fails the step
 * (a step started after shutdown began stops before its first provider call, gives the
 * search back and settles at zero).
 *
 * Counting (UI_DESIGN §5): scope replies and empty results give the free search back,
 * as does a failure before anything was spent; withheld summaries, abstentions,
 * cancellations and failures after spending keep it.
 *
 * Traces carry only content-free attributes (server/observability): stage, provider,
 * model, prompt version, token counts, cost, stop reason, outcome and counts, with the
 * GenAI usage and cost keys derived from them on model calls; a withheld step adds its
 * reason and codes. The step's `meta` records each validation reason with its path and
 * the summary's sentence count; a withheld step also keeps its rejected composition, with
 * what the validator and checker saw, in the server-side `diagnostics` column
 * (`StepDiagnostics`; read only by `pnpm worker brief-diagnose`).
 */
import {
  BriefResultSchema,
  type BriefResult,
  type Checklist,
  type ComposeOutput,
  type CriterionDecision,
  type ScopeReply,
  type WithheldReason,
} from '../../shared/contracts/briefs.js';
import type { Db } from '../db/client.js';
import { stageCostUsd, STAGE_CAPS } from '../ai/pricing.js';
import { COMPOSE_PROMPT_VERSION } from '../ai/prompts/compose.v6.js';
import {
  StageError,
  stageCtx,
  type LlmProvider,
  type LlmStage,
  type ScopeOutput,
  type StageResult,
  type StageUsage,
  type StageWarning,
} from '../ai/provider.js';
import { enumList, hashBrief, stopReasonOf, type FailureCategory, type FailureStage, type StopReason } from '../observability/attributes.js';
import { stageSpan, startRequestSpan, type AllowedAttrs, type StageSpanHandle } from '../observability/tracing.js';
import type { BriefStepStatus } from '../db/schema/index.js';
import { microsToNumeric, toMicros } from '../quota/pacing.js';
import { PIPELINE_DEADLINE_MS, type QuotaPolicy } from '../quota/policy.js';
import { releaseQuota, type Admission } from '../quota/admit.js';
import { settle, type SpendLine } from '../quota/settle.js';
import { clarificationReadings, composeInterpretations, interpretationChips } from './clarify.js';
import { checkForModel, citationsFromModel, composeForModel, compositionFromModel, passageAliases } from './aliases.js';
import { CHRONOLOGY_RULES_VERSION, criteriaLines, evaluateCase, type CriterionCheck } from './criteria.js';
import { RetrievalFailure, type CaseCatalog, type EvidenceBundle, type EvidenceRetriever, type RetrievedEvidence } from './evidence.js';
import { resolveIntent, retrievalText, scopeInput, type StepIntent, type StepRequest } from './intent.js';
import { answerResult, caseEvidence, checkInput, composeInput, noMatchResult, plainCard, storedDimensions, storedEvidence, type VerifiedCase } from './render.js';
import { clarificationReply, comparisonReply, operationalReply, outOfScopeReply, statisticsReply } from './static-replies.js';
import { finishStep, readBrief, readStepById, writeStage, type StepDiagnostics, type StoredEvidence } from './store.js';
import { QUOTE_MATCH_RULE_VERSION, resolvePassage, validateComposition, type AllowedPassage, type Allowlist } from './validate.js';
import { judgeCheck } from './verdicts.js';

/** Per-stage timeouts and the total deadline, in milliseconds (DESIGN §8). */
export interface StageTimeouts {
  scope: number;
  retrieve: number;
  compose: number;
  check: number;
  total: number;
}

/**
 * The check stage's 45 s is the calibrated checker's (Haiku 5.5 with adaptive thinking,
 * evals/checker): on development briefs of 15 to 42 claims it took 13 s at the median,
 * 21 s at the 95th percentile and 27 s at most, about 0.7 s a claim at the largest. A
 * check that runs out of time withholds the summary, like any failed check.
 */
export const STAGE_TIMEOUTS: Readonly<StageTimeouts> = Object.freeze({
  scope: 10_000,
  retrieve: 8_000,
  compose: 35_000,
  check: 45_000,
  total: PIPELINE_DEADLINE_MS,
});

/** At most this many re-packs to fit the compose cap. */
export const MAX_REPACKS = 2;
/** Bundle bounds (DESIGN §5); a bundle over them is refused, never cut. */
export const MAX_BUNDLE_CASES = 6;
export const MAX_BUNDLE_PASSAGES = 12;

/** The abort reason a server shutdown gives running steps (server/app.ts `preClose`). */
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
  /**
   * `category` and `stage` from closed sets (FAILURE_CATEGORIES, FAILURE_STAGES; also on the
   * step's log line and spans); `reason`: a fixed failure reason (retrieval's, or the bundle
   * check's), when there is one; `inputTokens`: the counted input of a stage refused over its cap.
   */
  failure?: { stage: FailureStage; category: FailureCategory; reason?: string; inputTokens?: number };
  /** The chunker of the served index's passages contract the bundle was checked under. */
  chunkerVersion?: string;
  /** The frozen retrieval configuration the step retrieved under (`AVIATION_RETRIEVAL_VERSION`). */
  retrievalVersion?: string;
  /** A case-level retrieval version's mapping of cases no passage channel returned: counts only. */
  retrieval?: { mapped: number; unmapped: number };
  /**
   * Per stage, the reasoning tokens the provider reported within its billed output
   * (`output_tokens_details.thinking_tokens`), when it reports them.
   */
  thinkingTokens?: Partial<Record<LlmStage, number>>;
  /** Per stage, the provider's stop reason when a response arrived (STOP_REASONS; `other` for anything else). */
  stopReasons?: Partial<Record<LlmStage, StopReason>>;
  /** Per stage, the adapter's warnings (STAGE_WARNINGS), when there are any. */
  warnings?: Partial<Record<LlmStage, StageWarning[]>>;
  clarificationDropped?: boolean;
  outcome?: ComposeOutput['outcome'];
  /**
   * The code checks: every reason's code (`codes`) and, with it, where (`reasons`: a path
   * such as `summary.2` or `cases.1.why`, never text), and how many sentences the
   * validator split the summary into (`summary.<i>` names sentence `i`, from 0).
   */
  validation?: { ruleVersion: string; codes: string[]; reasons: { code: string; path: string }[]; summarySentences: number };
  /**
   * Every criterion decision, with the timing rules that decided it (`rules`) or why it
   * stayed unknown (`reason`), under `criteriaRules` (CHRONOLOGY_RULES_VERSION).
   */
  criteria?: { ntsbNo: string; criterion: string; decision: string; rules: string[]; reason?: string }[];
  criteriaRules?: string;
  /**
   * The checker's verdicts judged in code (server/briefs/verdicts.ts): `supported` only
   * when every claim has one valid `supported` verdict; per-verdict counts; the codes;
   * each problem with its claim id (`claim`, `claimIndex` naming the claim in the step's
   * diagnostics) and kind; `chronologyMissed`: contradicted "do not settle" criterion
   * claims (diagnostic).
   */
  check?: {
    supported: boolean;
    claims: number;
    counts: Record<string, number>;
    codes: string[];
    problems: { claim: string; claimIndex: number; kind: string; code: string }[];
    chronologyMissed: { claim: string; ntsbNo: string | null; criterion: string }[];
  };
  settlement?: { status: string; uncertain?: boolean };
}

/** Why a withheld step's summary was withheld, with its fixed codes (WITHHELD_CODES). */
interface Withheld {
  reason: WithheldReason;
  codes: string[];
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
  private readonly lines: SpendLine[] = [];
  private uncertain = false;
  private spent = false;
  /** A cancel recorded in the database (another instance, or before the run's controller existed). */
  private cancelled = false;
  private checklist: Checklist = {};
  private intent: StepIntent | null = null;
  private evidence: StoredEvidence | null = null;
  private readonly meta: Meta = { promptVersions: {}, models: {}, timingsMs: {}, repacks: 0 };
  private withheld: Withheld | null = null;
  /** A withheld composition, for developers only (`StepDiagnostics`). */
  private diagnostics: StepDiagnostics | null = null;

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
    this.noteThinking(stage, r.usage);
    this.noteStop(stage, r.stopReason, r.warnings);
    this.spent = true;
  }

  /** The provider's reported reasoning tokens of a billed call, for calibration (never billed separately). */
  private noteThinking(stage: LlmStage, usage: StageUsage): void {
    if (usage.thinkingTokens !== undefined) this.meta.thinkingTokens = { ...this.meta.thinkingTokens, [stage]: usage.thinkingTokens };
  }

  /** A response's stop reason and the adapter's warnings, as fixed values. */
  private noteStop(stage: LlmStage, stopReason: string | null, warnings: readonly StageWarning[]): void {
    const reason = stopReasonOf(stopReason);
    if (reason) this.meta.stopReasons = { ...this.meta.stopReasons, [stage]: reason };
    if (warnings.length > 0) this.meta.warnings = { ...this.meta.warnings, [stage]: [...warnings] };
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
    this.noteStop(stage, err.stopReason, err.warnings);
    if (err.billing.kind === 'usage') {
      this.lines.push({ usd: stageCostUsd(err.model, err.billing.usage), provider: err.provider, model: err.model, stage, tokens: tokensOf(err.billing.usage) });
      this.noteThinking(stage, err.billing.usage);
      this.spent = true;
    } else if (err.billing.kind === 'uncertain') {
      this.uncertain = true;
      this.spent = true;
    }
  }

  /** The fixed category of a stage failure (FAILURE_CATEGORIES). */
  private categoryOf(err: unknown): FailureCategory {
    if (err instanceof StageError) return err.category;
    if (err instanceof RetrievalFailure) return err.kind;
    if (err instanceof BundleIntegrityError) return 'integrity';
    const name = (err as Error)?.name;
    return name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'unexpected';
  }

  private failureOf(stage: FailureStage, err: unknown): NonNullable<Meta['failure']> {
    const category = this.categoryOf(err);
    const reason = err instanceof RetrievalFailure ? err.reason : err instanceof BundleIntegrityError ? err.reason : undefined;
    const inputTokens = err instanceof StageError && err.category === 'cap_exceeded' ? err.countedInputTokens : null;
    return { stage, category, ...(reason ? { reason } : {}), ...(inputTokens !== null ? { inputTokens } : {}) };
  }

  /**
   * A stage span's body; a failure leaves its fixed category (and prompt version) on the
   * span, which ends with an error status. A stage stopped by the reader's cancel is
   * `outcome: cancelled`, not a failure; one stopped by a shutdown is `outcome: shutdown`
   * and fails the step as `failure: shutdown`. Neither stop ends its span with an error
   * status.
   */
  private async recorded<T>(s: StageSpanHandle, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      // A failed call's prompt version and, when a response arrived, its usage, cost and stop reason.
      const call: AllowedAttrs =
        err instanceof StageError
          ? {
              promptVersion: err.promptVersion,
              ...(err.billing.kind === 'usage' ? callAttrs(err.model, err.billing.usage, err.stopReason, err.warnings) : stopAttrs(err.stopReason, err.warnings)),
            }
          : {};
      const stopped = this.stopped;
      if (stopped) s.markStopped();
      if (stopped === 'cancelled') s.setAttrs({ outcome: 'cancelled', ...call });
      else if (stopped === 'shutdown') s.setAttrs({ outcome: 'shutdown', failure: 'shutdown', ...call });
      else s.setAttrs({ failure: this.categoryOf(err), ...call });
      throw err;
    }
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

  private failedEnd(stage: FailureStage, err: unknown): StageEnd {
    if (this.stopped) return this.stoppedEnd();
    this.meta.failure = this.failureOf(stage, err);
    // Nothing spent: the search is given back ("This didn't use one of your searches").
    return { status: 'failed', stage: 'failed', result: { kind: 'failed', countedAsSearch: this.spent }, release: !this.spent };
  }

  /**
   * The end of a withheld summary. `codes`: its fixed codes (validation codes, failed
   * criteria, check problem reasons) for the request span and the log line;
   * `diagnostics`: the rejected composition, kept server-side for developers.
   */
  private withheldEnd(
    reason: WithheldReason,
    cases: VerifiedCase[],
    intent: StepIntent,
    why: { codes?: readonly string[]; diagnostics?: StepDiagnostics } = {},
  ): StageEnd {
    if (this.stopped) return this.stoppedEnd();
    this.withheld = { reason, codes: [...new Set(why.codes ?? [])] };
    this.diagnostics = why.diagnostics ?? null;
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

    // Stopped before any provider call (a step started after shutdown began): nothing was
    // spent, so the search is given back and the step settles at zero.
    if (this.stopped) return this.stoppedEnd();

    // 1. Scope.
    let intent: StepIntent;
    {
      const t0 = performance.now();
      const { signal, budget } = this.stageSignal(this.t.scope);
      let r: StageResult<ScopeOutput>;
      try {
        r = await stageSpan('brief.scope', { stage: 'scope', provider: llm.name, model: llm.models.scope }, (s) =>
          this.recorded(s, async () => {
            const out = await llm.scope(scopeInput(req), stageCtx('scope', signal, budget));
            s.setAttrs({ promptVersion: out.promptVersion, ...callAttrs(out.model, out.usage, out.stopReason, out.warnings), outcome: out.output.intent });
            return out;
          }),
        );
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
      this.meta.retrievalVersion = deps.retriever.version;
      try {
        const got = await stageSpan('brief.retrieve', { stage: 'retrieve', retrievalVersion: deps.retriever.version }, (s) =>
          this.recorded(s, async () => {
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
            this.meta.chunkerVersion = out.chunkerVersion;
            if (out.mapping) this.meta.retrieval = { ...out.mapping };
            return { out, verified: await this.verify(out.bundle, out.chunkerVersion) };
          }),
        );
        retrieved = got.out;
        cases = got.verified;
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
      // The model reads short passage aliases (`P1`..), not 64-character ids (server/briefs/aliases.ts).
      const build = (cs: VerifiedCase[]) =>
        composeForModel(
          composeInput(cs, {
            question: req.question,
            ...(req.refinement ? { refinement: req.refinement } : {}),
            mechanicalCause: intent.mechanicalCause,
            interpretations,
          }),
          passageAliases(cs),
        );
      let called = false;
      try {
        composition = await stageSpan('brief.compose', { stage: 'compose', provider: llm.name, model: llm.models.answer }, (s) =>
          this.recorded(s, async () => {
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
              cases = await this.verify(bundle, retrieved.chunkerVersion);
              if (cases.length === 0) throw new BundleIntegrityError('empty_after_repack');
              this.evidence = storedEvidence(cases, null);
              input = build(cases);
            }
            s.setAttrs({ caseCount: cases.length, passageCount: input.cases.reduce((n, c) => n + c.passages.length, 0) });
            called = true;
            const out = await llm.compose(input, ctx);
            s.setAttrs({ promptVersion: out.promptVersion, ...callAttrs(out.model, out.usage, out.stopReason, out.warnings), outcome: out.output.outcome });
            this.charge('compose', out);
            return out.output;
          }),
        );
      } catch (err) {
        this.chargeFailure(err, 'compose', called);
        this.meta.timingsMs.compose = Math.round(performance.now() - t0);
        if (err instanceof BundleIntegrityError || err instanceof RetrievalFailure) {
          // The re-packed bundle failed its checks: no evidence to show.
          if (err instanceof BundleIntegrityError) this.log.warn({ reason: err.reason }, 'brief evidence refused after re-packing');
          return this.failedEnd('compose', err);
        }
        // A reader's cancel is not a failure (stoppedEnd records a shutdown itself).
        if (this.stopped) return this.stoppedEnd();
        this.meta.failure = this.failureOf('compose', err);
        return this.withheldEnd('compose_failed', cases, intent);
      }
      this.meta.timingsMs.compose = Math.round(performance.now() - t0);
    }
    this.meta.outcome = composition.outcome;
    if (!(await this.stage('validate', { question: 'in_scope', searched: searched(), written: true }))) return this.stoppedEnd();

    // 4. Validate: code checks, the reader's criteria, then the evidence checker. The
    // composition is validated as the model wrote it, against the aliases it was shown,
    // so an id field holding anything but an alias of this bundle fails (`unknown_passage`);
    // then it is mapped back to canonical ids for everything after (aliases.ts).
    const aliases = passageAliases(cases);
    const byCase = new Map(cases.map((c) => [c.ntsbNo, c]));
    const allow: Allowlist = {
      passages: new Map(cases.flatMap((c) => c.passages.map((p): [string, AllowedPassage] => [aliases.toModel.get(p.passageId)!, p.allowed]))),
      cases: new Set(cases.flatMap((c) => [c.ntsbNo, ...c.summary.aircraftNumbers])),
    };
    const written = composition;
    const checked = validateComposition(written, allow, {
      mechanicalCause: intent.mechanicalCause,
      // What the reader wrote may name an alias-shaped token ("P3 air line") the model can repeat.
      readerText: [req.question, ...(req.refinement ? [req.refinement] : [])].join('\n'),
    });
    const reasons = checked.ok ? [] : checked.reasons;
    this.meta.validation = {
      ruleVersion: checked.ruleVersion,
      codes: reasons.map((r) => r.code),
      reasons: reasons.map((r) => ({ code: r.code, path: r.path })),
      summarySentences: checked.summarySentences.length,
    };
    // What a developer needs to see why a summary was withheld (server-side only).
    const diagnostics = (
      reason: StepDiagnostics['reason'],
      claims?: StepDiagnostics['claims'],
      verdicts?: StepDiagnostics['verdicts'],
    ): StepDiagnostics => ({
      reason,
      composition: written,
      aliases: Object.fromEntries(aliases.fromModel),
      summarySentences: checked.summarySentences,
      ...(claims ? { claims } : {}),
      ...(verdicts ? { verdicts } : {}),
    });
    if (!checked.ok) {
      return this.withheldEnd('citation_check', cases, intent, { codes: reasons.map((r) => r.code), diagnostics: diagnostics('citation_check') });
    }
    composition = compositionFromModel(written, aliases);
    const validated = { ...checked, citations: citationsFromModel(checked.citations, aliases) };

    // Every criterion decision of every presented case, each a claim for the checker.
    const decisions = new Map<string, CriterionDecision[]>();
    const criterionChecks = new Map<string, CriterionCheck[]>();
    this.meta.criteria = [];
    this.meta.criteriaRules = CHRONOLOGY_RULES_VERSION;
    let outside = false;
    for (const k of composition.cases) {
      const checks = evaluateCase(intent.readings, k, intent.mechanicalCause, caseEvidence(byCase.get(k.ntsbNo)));
      for (const d of checks) {
        this.meta.criteria.push({ ntsbNo: k.ntsbNo, criterion: d.criterion, decision: d.decision, rules: [...d.rules], ...(d.reason ? { reason: d.reason } : {}) });
        if (d.decision === 'does_not_match') outside = true;
      }
      decisions.set(
        k.ntsbNo,
        checks.map((d) => ({ criterion: d.criterion, decision: d.decision === 'matches' ? 'matches' : 'unconfirmed' })),
      );
      criterionChecks.set(k.ntsbNo, checks);
    }
    // A case outside the reader's criteria is never presented as a match.
    if (outside) {
      const failed = this.meta.criteria.filter((d) => d.decision === 'does_not_match').map((d) => d.criterion);
      return this.withheldEnd('criteria_check', cases, intent, { codes: failed, diagnostics: diagnostics('criteria_check') });
    }

    const context = { interpretations: interpretationChips(intent.readings), filters: intent.filters };
    const { input, claims, overflow } = checkInput(composition, validated.citations, byCase, {
      mechanicalCause: intent.mechanicalCause,
      criteria: criteriaLines(intent.readings),
      criterionChecks,
    });
    // The check input as the checker reads it (passage aliases); its claims, by id, are a withheld step's diagnostics.
    const forModel = checkForModel(input, aliases);
    const checkDiagnostics = (verdicts?: StepDiagnostics['verdicts']) => diagnostics('evidence_check', forModel.claims, verdicts);
    if (overflow) {
      // A claim that cannot be checked is never shown.
      this.meta.failure = { stage: 'check', category: 'claims_overflow' };
      return this.withheldEnd('evidence_check', cases, intent, { diagnostics: checkDiagnostics() });
    }
    if (input.claims.length > 0) {
      const t0 = performance.now();
      const { signal, budget } = this.stageSignal(this.t.check);
      try {
        const out = await stageSpan('brief.check', { stage: 'check', provider: llm.name, model: llm.models.check }, (s) =>
          this.recorded(s, async () => {
            const r = await llm.check(forModel, stageCtx('check', signal, budget));
            const judged = judgeCheck(forModel, r.output, claims);
            s.setAttrs({
              promptVersion: r.promptVersion,
              ...callAttrs(r.model, r.usage, r.stopReason, r.warnings),
              outcome: judged.ok ? 'supported' : 'problems',
            });
            return { r, judged };
          }),
        );
        this.charge('check', out.r);
        this.meta.timingsMs.check = Math.round(performance.now() - t0);
        const j = out.judged;
        this.meta.check = {
          supported: j.ok,
          claims: forModel.claims.length,
          counts: { ...j.counts },
          codes: [...j.codes],
          problems: j.problems.map((p) => ({ claim: p.claim, claimIndex: p.index, kind: p.kind, code: p.code })),
          chronologyMissed: j.chronologyMissed.map((c) => ({ claim: c.claim, ntsbNo: c.ntsbNo, criterion: c.criterion })),
        };
        // Only every claim judged `supported`, completely and validly, lets the summary through.
        if (!j.ok) {
          const verdicts = { verdicts: out.r.output.verdicts.map((v) => ({ ...v, passages: [...v.passages] })), quotes: out.r.output.quotes.map((q) => ({ ...q })) };
          return this.withheldEnd('evidence_check', cases, intent, { codes: j.codes, diagnostics: checkDiagnostics(verdicts) });
        }
      } catch (err) {
        // Over the checker's cap (counted, unbilled) or a failed call: withheld with the
        // failure recorded; the complete evidence is kept, never cut to fit (ruling 5).
        // A reader's cancel is not a failure (stoppedEnd records a shutdown itself).
        this.chargeFailure(err, 'check', true);
        this.meta.timingsMs.check = Math.round(performance.now() - t0);
        if (this.stopped) return this.stoppedEnd();
        this.meta.failure = this.failureOf('check', err);
        return this.withheldEnd('evidence_check', cases, intent, { diagnostics: checkDiagnostics() });
      }
    }
    if (this.stopped) return this.stoppedEnd();

    this.checklist = { question: 'in_scope', searched: searched(), written: true, verified: 'passed' };
    if (composition.outcome === 'no_supported_match') {
      this.evidence = storedEvidence(cases, QUOTE_MATCH_RULE_VERSION);
      return { status: 'no_match', stage: 'done', result: noMatchResult(composition, cases, context), release: false };
    }
    this.evidence = storedEvidence(cases, QUOTE_MATCH_RULE_VERSION, storedDimensions(composition, intent.mechanicalCause, criterionChecks));
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
        // Only numbers the reader actually wrote (case-insensitive), in the question or the
        // text refinement in effect; the planner cannot add one.
        const written = [this.req.question, ...(this.req.refinement ? [this.req.refinement] : [])].join('\n').toUpperCase();
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

  /** Check a bundle, fail closed (`verifyBundle`). */
  private async verify(bundle: EvidenceBundle, chunkerVersion: string): Promise<VerifiedCase[]> {
    return verifyBundle(this.deps.catalog, this.brief.generationId, bundle, chunkerVersion);
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
    const failure = this.meta.failure;
    const withheld = end.status === 'withheld' ? this.withheld : null;
    this.span.setAttrs({
      outcome: end.status,
      ...(chargedUsd !== null ? { usd: chargedUsd } : {}),
      ...(failure ? { failure: failure.category, failureStage: failure.stage } : {}),
      ...(withheld ? { withheld: withheld.reason, withheldCodes: enumList(withheld.codes) } : {}),
    });
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
      diagnostics: withheld ? this.diagnostics : null,
      now: this.now(),
    }).catch((err: unknown) => {
      this.log.warn({ err: { name: (err as Error)?.name } }, 'brief step: the final state could not be written');
      return false;
    });
    if (!written) this.log.warn({}, 'brief step: final state not written (step no longer running)');
    this.log.info(
      {
        status: end.status,
        charged: chargedUsd,
        released,
        ...(failure ? { failure: { stage: failure.stage, category: failure.category } } : {}),
        ...(withheld ? { withheld: { reason: withheld.reason, codes: withheld.codes } } : {}),
      },
      'brief step finished',
    );
    return { status: end.status, chargedUsd, released };
  }
}

/**
 * Check a bundle, fail closed (gate G6 #2, #4): at most 6 cases and 12 passages, each
 * passage the canonical row it claims to be (`resolvePassage`), each case known to the
 * dataset and holding its best retrieved passage (reserved, ranked) and every
 * probable-cause passage it has. Any violation throws `BundleIntegrityError`; nothing is
 * dropped or cut. The checker calibration (evals/checker) builds its bundles with it too.
 */
export async function verifyBundle(catalog: CaseCatalog, generationId: number, bundle: EvidenceBundle, chunkerVersion: string): Promise<VerifiedCase[]> {
  const g = generationId;
  const all = bundle.cases.flatMap((c) => c.passages);
  if (bundle.cases.length > MAX_BUNDLE_CASES) throw new BundleIntegrityError('too_many_cases');
  if (all.length > MAX_BUNDLE_PASSAGES) throw new BundleIntegrityError('too_many_passages');
  const numbers = bundle.cases.map((c) => c.ntsbNo);
  if (new Set(numbers).size !== numbers.length) throw new BundleIntegrityError('duplicate_case');
  if (new Set(all.map((p) => p.passageId)).size !== all.length) throw new BundleIntegrityError('duplicate_passage');
  const [canonical, causes, summaries] = await Promise.all([
    catalog.passages(g, chunkerVersion, all.map((p) => p.passageId)),
    catalog.causePassageIds(g, chunkerVersion, numbers),
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

function usageAttrs(u: StageUsage) {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    cacheReadTokens: u.cacheReadTokens,
    ...(u.thinkingTokens !== undefined ? { thinkingTokens: u.thinkingTokens } : {}),
  };
}

/** A response's stop reason and warnings as span attributes (fixed values). */
function stopAttrs(stopReason: string | null, warnings: readonly StageWarning[]): AllowedAttrs {
  const reason = stopReasonOf(stopReason);
  const listed = enumList(warnings);
  return { ...(reason ? { stopReason: reason } : {}), ...(listed ? { warnings: listed } : {}) };
}

/** A billed call's span attributes: usage, the stage's cost (`usd`), stop reason and warnings. */
function callAttrs(model: string, u: StageUsage, stopReason: string | null, warnings: readonly StageWarning[]): AllowedAttrs {
  return { ...usageAttrs(u), usd: stageCostUsd(model, u), ...stopAttrs(stopReason, warnings) };
}
