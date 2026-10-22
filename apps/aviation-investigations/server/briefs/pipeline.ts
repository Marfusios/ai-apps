/**
 * One brief step (DESIGN §5 "The online pipeline is fixed"), after admission:
 *
 * 1. **Scope** (10 s): the planner classifies the question. Anything other than a case
 *    search ends here with a static reply (server/briefs/static-replies.ts) and gives the
 *    free search back (`releaseQuota`); its cost is still settled.
 * 2. **Retrieve** (8 s): the `EvidenceRetriever` port (hybrid retrieval,
 *    server/briefs/retriever.ts) returns at most 6 cases / 12 passages: the question
 *    (and text refinement) feeds the dense channel, the scope stage's `keywordText` the
 *    BM25 channel. Each passage's provenance is checked against its stored section
 *    revision before it can be quoted. Query-embedding usage is recorded once, through
 *    the port's callback.
 * 3. **Compose** (35 s): the full compose input is counted with the provider's own token
 *    counter; above the 16,000-token cap the same candidates are packed again with a
 *    smaller evidence budget (amendment A11). One model call.
 * 4. **Validate** (12 s for the check call): `validateComposition` (code), then the model
 *    checker over every claim. Only `supported: true` with no problems passes.
 * 5. **Settle**: itemized ledger lines per stage; any call without reliable usage makes
 *    the settlement uncertain, charging the full reservation (Task 15).
 *
 * A failed or inconclusive check, or a failed compose call, withholds the summary and
 * returns the case cards; there is no repair loop. Results are written stage by stage
 * and only stage status and counts are visible before the end. The whole step has a
 * 60-second deadline (each stage's timeout is cut to what is left). Cancel aborts the
 * running call and keeps the search counted (UI_DESIGN §4.4).
 *
 * Counting (UI_DESIGN §5): scope replies and empty results give the free search back,
 * as does a failure before anything was spent; withheld summaries, cancellations and
 * failures after spending keep it.
 *
 * Traces carry only content-free attributes (server/observability): stage, provider,
 * model, prompt version, token counts, cost, outcome and counts.
 */
import type { BriefResult, Checklist, ComposeOutput, ScopeReply } from '../../shared/contracts/briefs.js';
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
import { clarificationReadings, composeInterpretations, interpretationChips } from './clarify.js';
import { RetrievalFailure, type CaseCatalog, type EvidenceBundle, type EvidenceRetriever, type RetrievedEvidence } from './evidence.js';
import { resolveIntent, retrievalText, scopeInput, type StepIntent, type StepRequest } from './intent.js';
import { answerResult, checkInput, composeInput, plainCard, storedEvidence, type VerifiedCase } from './render.js';
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
  /** Cancel: aborts the running stage; the step ends `cancelled`. */
  signal?: AbortSignal;
}

export interface StepOutcome {
  status: Exclude<BriefStepStatus, 'running'>;
  /** USD charged; null when settlement did not finish (lease expiry then charges in full). */
  chargedUsd: number | null;
  /** True when the free search was given back. */
  released: boolean;
}

interface Meta {
  promptVersions: Partial<Record<LlmStage, string>>;
  models: Partial<Record<LlmStage, string>>;
  timingsMs: Record<string, number>;
  repacks: number;
  provenanceDropped: number;
  /** `reason`: retrieval's fixed failure reason, when it has one. */
  failure?: { stage: string; category: string; reason?: string };
  clarificationDropped?: boolean;
  validation?: { ruleVersion: string; codes: string[] };
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
    const outcome = await startRequestSpan('brief.step', attrs, (span) =>
      new Run(deps, step.id, step.request, brief, admission, hooks, scoped, now, log, span).run(),
    );
    return outcome;
  } catch (err) {
    log.warn({ err: { name: (err as Error)?.name } }, 'brief step failed unexpectedly');
    scoped({ kind: 'ended', stage: 'failed' });
    // Settle conservatively; lease expiry would do the same.
    const settled = await settle(deps.db, admission, 'uncertain', admission.fencingToken, now()).catch(() => null);
    await finishStep(deps.db, stepId, {
      stage: 'failed',
      status: 'failed',
      checklist: {},
      result: { kind: 'failed', countedAsSearch: true },
      provider: deps.llm.name,
      model: null,
      meta: { failure: { stage: 'pipeline', category: 'unexpected' } },
      costUsd: settled?.ok ? microsToNumeric(toMicros(settled.chargedUsd)) : null,
      now: now(),
    }).catch(() => false);
    return { status: 'failed', chargedUsd: settled?.ok ? settled.chargedUsd : null, released: false };
  }
}

type StageEnd = { status: Exclude<BriefStepStatus, 'running'>; stage: 'done' | 'failed'; result: BriefResult; release: boolean };

class Run {
  private readonly t: StageTimeouts;
  private readonly started = performance.now();
  private readonly signal: AbortSignal;
  private readonly lines: SpendLine[] = [];
  private uncertain = false;
  private spent = false;
  private cancelled = false;
  private checklist: Checklist = {};
  private intent: StepIntent | null = null;
  private evidence: StoredEvidence | null = null;
  private readonly meta: Meta = { promptVersions: {}, models: {}, timingsMs: {}, repacks: 0, provenanceDropped: 0 };

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
    const cancel = hooks.signal ?? NEVER;
    if (cancel.aborted) this.cancelled = true;
    cancel.addEventListener('abort', () => (this.cancelled = true), { once: true });
    this.signal = AbortSignal.any([cancel, AbortSignal.timeout(this.t.total)]);
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

  private failureCategory(err: unknown): string {
    if (err instanceof StageError) return err.category;
    if (err instanceof RetrievalFailure) return err.kind;
    return (err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError' ? 'timeout' : 'unexpected';
  }

  private async stage(stage: 'retrieve' | 'compose' | 'validate', checklist: Checklist, intent?: StepIntent): Promise<boolean> {
    this.checklist = checklist;
    const w = await writeStage(this.deps.db, this.stepId, { stage, checklist, ...(intent ? { intent } : {}), now: this.now() });
    if (w.cancelRequested) this.cancelled = true;
    return w.running && !this.cancelled;
  }

  private cancelledEnd(): StageEnd {
    return { status: 'cancelled', stage: 'failed', result: { kind: 'cancelled' }, release: false };
  }

  private failedEnd(stage: string, err: unknown): StageEnd {
    if (this.cancelled) return this.cancelledEnd();
    this.meta.failure = {
      stage,
      category: this.failureCategory(err),
      ...(err instanceof RetrievalFailure && err.reason ? { reason: err.reason } : {}),
    };
    // Nothing spent: the search is given back ("This didn't use one of your searches").
    return { status: 'failed', stage: 'failed', result: { kind: 'failed', countedAsSearch: this.spent }, release: !this.spent };
  }

  private withheldEnd(reason: 'citation_check' | 'evidence_check' | 'compose_failed', cases: VerifiedCase[], intent: StepIntent): StageEnd {
    if (this.cancelled) return this.cancelledEnd();
    this.checklist = { ...this.checklist, ...(reason === 'compose_failed' ? {} : { written: true }), verified: 'withheld' };
    return {
      status: 'withheld',
      stage: 'done',
      result: {
        kind: 'withheld',
        interpretations: interpretationChips(intent.readings),
        filters: intent.filters,
        reason,
        cases: cases.map(plainCard),
      },
      release: false,
    };
  }

  async run(): Promise<StepOutcome> {
    const end = await this.stages();
    return this.finish(end);
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
        this.scoped({ kind: 'ended', stage: 'failed' });
        return this.failedEnd('scope', err);
      }
      this.charge('scope', r);
      this.meta.timingsMs.scope = Math.round(performance.now() - t0);
      intent = resolveIntent(req, r.output);
      this.intent = intent;

      const reply = await this.scopeReply(r.output, intent);
      if (reply) {
        this.checklist = {};
        this.scoped({ kind: 'reply', reply });
        return { status: 'scope_reply', stage: 'done', result: { kind: 'scope_reply', reply }, release: true };
      }
    }

    // 2. Retrieve.
    if (!(await this.stage('retrieve', { question: 'in_scope' }, intent))) {
      this.scoped({ kind: 'ended', stage: 'failed' });
      return this.cancelledEnd();
    }
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
        } else if (!this.lines.some((l) => l.stage === 'embed')) {
          // Retrieval broke without reporting its embedding: it may have been billed.
          this.uncertain = true;
          this.spent = true;
        }
        this.meta.timingsMs.retrieve = Math.round(performance.now() - t0);
        return this.failedEnd('retrieve', err);
      }
      this.meta.timingsMs.retrieve = Math.round(performance.now() - t0);
    }
    intent = { ...intent, caseNumbers: cases.map((c) => c.ntsbNo) };
    this.intent = intent;
    this.evidence = storedEvidence(cases, null);
    if (cases.length === 0) {
      this.checklist = { question: 'in_scope', searched: { cases: 0, passages: 0 } };
      if (this.cancelled) return this.cancelledEnd();
      return {
        status: 'no_results',
        stage: 'done',
        result: { kind: 'no_results', interpretations: interpretationChips(intent.readings), filters: intent.filters },
        release: true,
      };
    }
    const searched = { cases: cases.length, passages: cases.reduce((n, c) => n + c.passages.length, 0) };
    if (!(await this.stage('compose', { question: 'in_scope', searched }, intent))) return this.cancelledEnd();

    // 3. Compose, within the measured input cap.
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
            if (cases.length === 0) throw new RetrievalFailure('failed', 'none', 'the re-packed bundle is empty');
            this.evidence = storedEvidence(cases, null);
            input = build(cases);
          }
          s.setAttrs({ caseCount: cases.length, passageCount: input.cases.reduce((n, c) => n + c.passages.length, 0) });
          called = true;
          const out = await llm.compose(input, ctx);
          s.setAttrs({ promptVersion: out.promptVersion, ...usageAttrs(out.usage), outcome: 'ok' });
          this.charge('compose', out);
          return out.output;
        });
      } catch (err) {
        this.chargeFailure(err, 'compose', called);
        this.meta.failure = { stage: 'compose', category: this.failureCategory(err) };
        this.meta.timingsMs.compose = Math.round(performance.now() - t0);
        return this.withheldEnd('compose_failed', cases, intent);
      }
      this.meta.timingsMs.compose = Math.round(performance.now() - t0);
    }
    const searchedNow = { cases: cases.length, passages: cases.reduce((n, c) => n + c.passages.length, 0) };
    if (!(await this.stage('validate', { question: 'in_scope', searched: searchedNow, written: true }))) return this.cancelledEnd();

    // 4. Validate: code checks, then the evidence checker.
    const byCase = new Map(cases.map((c) => [c.ntsbNo, c]));
    const allow: Allowlist = {
      passages: new Map(cases.flatMap((c) => c.passages.map((p): [string, AllowedPassage] => [p.passageId, p.allowed]))),
      cases: new Set(cases.flatMap((c) => [c.ntsbNo, ...c.summary.aircraftNumbers])),
    };
    const validated = validateComposition(composition, allow, { mechanicalCause: intent.mechanicalCause });
    this.meta.validation = { ruleVersion: validated.ruleVersion, codes: validated.ok ? [] : validated.reasons.map((r) => r.code) };
    if (!validated.ok) return this.withheldEnd('citation_check', cases, intent);

    {
      const t0 = performance.now();
      const { signal, budget } = this.stageSignal(this.t.check);
      const { input, claims, overflow } = checkInput(composition, validated.citations, byCase, { mechanicalCause: intent.mechanicalCause });
      if (overflow) {
        // A claim that cannot be checked is never shown.
        this.meta.failure = { stage: 'check', category: 'claims_overflow' };
        return this.withheldEnd('evidence_check', cases, intent);
      }
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
        this.meta.failure = { stage: 'check', category: this.failureCategory(err) };
        this.meta.timingsMs.check = Math.round(performance.now() - t0);
        return this.withheldEnd('evidence_check', cases, intent);
      }
    }
    if (this.cancelled) return this.cancelledEnd();

    this.checklist = { question: 'in_scope', searched: searchedNow, written: true, verified: 'passed' };
    this.evidence = {
      ...storedEvidence(cases, QUOTE_MATCH_RULE_VERSION),
      dimensions: composition.cases.map((k) => ({
        ntsbNo: k.ntsbNo,
        ...(intent.mechanicalCause && k.maintenance ? { maintenance: k.maintenance } : {}),
        ...(intent.mechanicalCause && k.symptom ? { symptom: k.symptom } : {}),
      })),
    };
    return {
      status: 'answered',
      stage: 'done',
      result: answerResult({
        composition,
        citations: validated.citations,
        cases: byCase,
        mechanicalCause: intent.mechanicalCause,
        interpretations: interpretationChips(intent.readings),
        filters: intent.filters,
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
        const asked = scope.caseNumbers ?? [];
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
   * Check every passage of the bundle against its stored section revision and load the
   * case summaries. A passage whose chain does not hold is dropped (and counted); a case
   * left without passages or without a summary is dropped.
   */
  private async verify(bundle: EvidenceBundle): Promise<VerifiedCase[]> {
    const { catalog } = this.deps;
    const g = this.brief.generationId;
    const [sections, summaries] = await Promise.all([
      catalog.sections(g, bundle.cases.flatMap((c) => c.passages.map((p) => p.revisionId))),
      catalog.summaries(g, bundle.cases.map((c) => c.ntsbNo)),
    ]);
    const out: VerifiedCase[] = [];
    let dropped = 0;
    for (const c of bundle.cases.slice(0, 6)) {
      const summary = summaries.get(c.ntsbNo);
      const passages: VerifiedCase['passages'] = [];
      for (const p of c.passages) {
        if (p.ntsbNo !== c.ntsbNo) {
          dropped += 1;
          continue;
        }
        const r = resolvePassage(p, sections.get(p.revisionId));
        if (!r.ok) {
          dropped += 1;
          continue;
        }
        passages.push({ passageId: p.passageId, role: p.role, rank: p.rank, sectionKind: p.sectionKind, allowed: r.allowed });
      }
      if (summary && passages.length > 0) out.push({ ntsbNo: c.ntsbNo, rank: c.rank, summary, passages });
      else dropped += passages.length;
    }
    // Twelve passages at most, whatever the retriever returned.
    let room = 12;
    const bounded = out
      .map((c) => {
        const keep = c.passages.slice(0, Math.max(0, room));
        room -= keep.length;
        return { ...c, passages: keep };
      })
      .filter((c) => c.passages.length > 0);
    this.meta.provenanceDropped = dropped;
    if (dropped > 0) this.log.warn({ dropped }, 'brief evidence: passages failed the provenance check');
    return bounded;
  }

  private async finish(end: StageEnd): Promise<StepOutcome> {
    const { db, policy } = this.deps;
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
