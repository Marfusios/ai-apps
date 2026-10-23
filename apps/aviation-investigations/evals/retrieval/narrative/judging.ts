/**
 * Judging Track N pairs (task 10c protocol v4, sections 2, 3, 6 and 7): a pair is one
 * question family and one case, judged for case relevance (the complete record) or for
 * bundle answerability (the passages a bundle delivered).
 *
 * **Judges.** Both judges grade every pair independently, blinded to retrieval method
 * and rank (the request holds neither). Each output is validated in code
 * (`judgment.ts`); an invalid output (also a refusal or a truncated output) gets one
 * retry with a content-free feedback line, then the judge's grade is `unjudgeable`.
 * Transient provider failures (rate limits, overload, network, timeouts, 5xx) are
 * retried at most twice with a backoff; after that the judge's result is `failed`,
 * which is never cached, so a later run judges it again. Authentication and request
 * errors stop the run. A long case is judged part by part and consolidated
 * (`evidence.ts`); a part that cannot be judged leaves the case `uncovered`.
 *
 * **Adjudication.** When the judges' grades differ, or exactly one of them gave a valid
 * grade, the pair escalates to the adjudicator: first it grades the case blind, with
 * the judges' prompt (its initial decision, recorded), then it sees that decision and
 * both verdicts (labelled A and B in an order fixed by a hash of the case) and decides,
 * or abstains. Escalations run after every pair is judged, in the caller's priority
 * order, up to `maxEscalationShare` of the pairs; the rest are `unknown`
 * (`escalation-budget-exhausted`), as are abstentions, unjudgeable adjudications and
 * pairs both judges could not judge.
 *
 * **Money.** Every attempt counts its input (Anthropic's free counter, OpenAI's local
 * estimate), reserves the attempt's worst case on the evaluation ledger before it is
 * sent, and settles with its billed cost (zero when nothing can have been billed, the
 * full reservation when it is uncertain). Before each reservation the run stops if it
 * would take the run's spend log above its limit or the ledger's remaining evaluation
 * allowance (the $20 monthly indexing and evaluation allowance) below zero. A budget
 * stop starts nothing new and keeps what the run has: pairs both judges finished are
 * recorded (escalations the stop prevented are `escalation-budget-exhausted`), pairs
 * not judged are left out (no judgment is `unknown`), and every finished outcome is in
 * the cache, so the next run continues where this one stopped without paying again.
 *
 * **Cache.** Judge outcomes are keyed by (kind, question version, rubric version, case,
 * complete-input or bundle fingerprint, provider, model with its frozen settings and
 * caps, prompt version, the pinned request-format and schema hashes, validator version,
 * chunk budget); the adjudicator's blind grade by the same key and its step, its decision
 * also by the two verdicts and the blind grade it saw. A cached outcome is reused, never
 * re-bought; a failed one is never cached.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SpendGate } from '../../../worker/index/spend-gate.js';
import { SpendRefusedError } from '../../../worker/index/spend-gate.js';
import {
  JudgeCallError,
  attemptReserveUsd,
  judgeCostUsd,
  judgeIdentity,
  type JudgeCaller,
  type JudgeFailureCategory,
  type JudgeRole,
  type JudgeUsage,
} from './clients.js';
import { CASE_TOKEN_BUDGET, renderBundleCase, type CaseEvidence, type ChunkPlan, type DeliveredPassage } from './evidence.js';
import {
  caseSources,
  passageSources,
  retryFeedback,
  validateAnswerability,
  validateChunk,
  validateVerdict,
  VALIDATOR_VERSION,
  type ValidatedChunk,
  type ValidatedVerdict,
  type Validation,
} from './judgment.js';
import {
  ADJUDICATOR_PROMPTS_VERSION,
  ANSWERABILITY_PROMPTS_VERSION,
  JUDGE_PROMPTS_VERSION,
  adjudicationRequest,
  adjudicationRequestForParts,
  answerabilityAdjudicationRequest,
  answerabilityRequest,
  chunkRequest,
  consolidateRequest,
  relevanceRequest,
  type JudgeRequest,
  type PartSummary,
  type ShownVerdict,
} from './prompts.js';
import { LABEL_OF, type Answerability, type ChunkVerdict, type Verdict } from './schemas.js';
import { REQUEST_FORMAT_SHA256, SCHEMAS_SHA256 } from './identity.js';
import { canonicalJson, sha256, type Grade, type Rubric } from './spec.js';

/** Bound on escalations: at most this share of a run's pairs goes to the adjudicator. */
export const MAX_ESCALATION_SHARE = 0.25;
/** Transient provider failures are retried this many times (each retry its own reservation). */
export const TRANSIENT_RETRIES = 2;
const RETRY_DELAYS_MS = [5_000, 20_000];
const TRANSIENT: ReadonlySet<JudgeFailureCategory> = new Set(['rate_limited', 'overloaded', 'network', 'timeout', 'provider_error', 'unexpected']);
const OUTPUT_FAILURES: ReadonlySet<JudgeFailureCategory> = new Set(['refusal', 'truncated', 'invalid_output']);

// ---------------------------------------------------------------------------
// Money

/** The run cannot reserve another attempt: its limit or the ledger's allowance would be exceeded. */
export class BudgetStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetStop';
  }
}

/** A configuration or request error: the run stops (nothing more is sent). */
export class FatalJudgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalJudgeError';
  }
}

export interface AttemptRecord {
  purpose: JudgeRequest['purpose'];
  role: JudgeRole;
  provider: string;
  model: string;
  status: 'ok' | 'failed';
  category: JudgeFailureCategory | null;
  billing: 'usage' | 'none' | 'uncertain';
  /** Counted (Anthropic) or estimated (OpenAI) input tokens. */
  inputTokens: number;
  reservedUsd: number;
  chargedUsd: number;
  usage: JudgeUsage | null;
  latencyMs: number;
  /** Validation problems of an output that parsed but failed validation. */
  problems?: string[];
}

export interface SpendLogEntry {
  at: string;
  run: string;
  purpose: string;
  provider: string;
  model: string;
  reservedUsd: number;
  chargedUsd: number;
}

/** Logged spend of a spend or allocation log (0 when missing; header lines carry no charge). */
export function loggedSpendUsd(path: string | null): number {
  if (!path || !existsSync(path)) return 0;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .reduce((n, l) => n + ((JSON.parse(l) as Partial<SpendLogEntry>).chargedUsd ?? 0), 0);
}

/**
 * A named budget allocation shared by the runs of one phase or month (for example
 * `track-n-2026-10`): every attempt of every run under it is appended to its log, and no
 * run may take the log above its cap. The cap is written once, in the log's first line,
 * and a later run cannot change it (a new allocation needs a new name). Reusable outputs
 * (the judgment cache) are kept apart from allocations, so a new month's allocation
 * resumes from the same cache with its own cap.
 */
export interface Allocation {
  name: string;
  capUsd: number;
  log: string;
}

interface AllocationHeader {
  kind: 'track-n-allocation';
  name: string;
  capUsd: number;
  createdAt: string;
}

/** Open (or create) the allocation `name` under `dir`; `capUsd` is required to create it and must match an existing one. */
export function openAllocation(dir: string, name: string, capUsd: number | undefined): Allocation {
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(name)) throw new Error(`allocation name "${name}": use 3 to 64 lower-case letters, digits, dots, hyphens or underscores`);
  const log = join(dir, 'allocations', `${name}.jsonl`);
  if (existsSync(log)) {
    const first = readFileSync(log, 'utf8').split('\n')[0] ?? '';
    const header = JSON.parse(first) as Partial<AllocationHeader>;
    if (header.kind !== 'track-n-allocation' || header.name !== name || typeof header.capUsd !== 'number') throw new Error(`${log} is not a Track N allocation log`);
    if (capUsd !== undefined && Math.abs(capUsd - header.capUsd) > 1e-9) {
      throw new Error(`allocation ${name} has a cap of $${header.capUsd}; it cannot be changed (use a new allocation name)`);
    }
    return { name, capUsd: header.capUsd, log };
  }
  if (capUsd === undefined || !(capUsd > 0)) throw new Error(`allocation ${name} does not exist yet: give its cap with --allocation-usd`);
  mkdirSync(dirname(log), { recursive: true });
  const header: AllocationHeader = { kind: 'track-n-allocation', name, capUsd, createdAt: new Date().toISOString() };
  writeFileSync(log, `${JSON.stringify(header)}\n`, { flag: 'wx' });
  return { name, capUsd, log };
}

export interface RunMoney {
  /** The evaluation ledger's gate for a judge (its provider, model and stage label the reservations). */
  gate: SpendGate | ((judge: JudgeCaller['config']) => SpendGate);
  /** This run's limit (USD) over its own spend only. */
  limitUsd: number;
  /** This run's spend log (one file per run, never shared with another run). */
  spendLog: string | null;
  /** The allocation this run spends from, shared with the other runs of its phase or month; null in tests. */
  allocation: Allocation | null;
  run: string;
}

/** Sends attempts with their reservations (module comment). */
export class AttemptSender {
  private spent: number;
  private allocationSpent: number;
  /** Reservations of attempts in flight (concurrent attempts count against the limits before they settle). */
  private inFlight = 0;
  /** A ledger settle failed: the run sends nothing more (the reservation stays open, which keeps the ledger conservative). */
  private ledgerFailure: string | null = null;
  constructor(
    private readonly money: RunMoney,
    private readonly timeoutMs: number,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.spent = loggedSpendUsd(money.spendLog);
    this.allocationSpent = money.allocation ? loggedSpendUsd(money.allocation.log) : 0;
  }

  get spentUsd(): number {
    return this.spent;
  }

  get allocationSpentUsd(): number {
    return this.allocationSpent;
  }

  wait(ms: number): Promise<void> {
    return this.sleep(ms);
  }

  async send(caller: JudgeCaller, req: JudgeRequest): Promise<{ output: unknown; record: AttemptRecord } | { error: JudgeCallError; record: AttemptRecord }> {
    if (this.ledgerFailure !== null) throw new FatalJudgeError(`the evaluation ledger could not settle an attempt (${this.ledgerFailure}); the run stops`);
    const c = caller.config;
    let counted: number | null = null;
    for (let i = 0; counted === null; i += 1) {
      try {
        counted = await caller.inputTokens(req, this.timeoutMs);
      } catch (err) {
        if (i >= 3) throw err;
        await this.sleep(2_000 * (i + 1));
      }
    }
    const reserve = attemptReserveUsd(c, counted);
    if (this.spent + this.inFlight + reserve > this.money.limitUsd + 1e-12) {
      throw new BudgetStop(
        `the next attempt's reservation ($${reserve.toFixed(6)}) would take this run's spend ($${this.spent.toFixed(6)}) and open reservations ($${this.inFlight.toFixed(6)}) above its limit of $${this.money.limitUsd}`,
      );
    }
    const a = this.money.allocation;
    if (a && this.allocationSpent + this.inFlight + reserve > a.capUsd + 1e-12) {
      throw new BudgetStop(
        `the next attempt's reservation ($${reserve.toFixed(6)}) would take allocation ${a.name} ($${this.allocationSpent.toFixed(6)} spent, $${this.inFlight.toFixed(6)} open) above its cap of $${a.capUsd}`,
      );
    }
    // Claimed in the same synchronous turn as the checks, so a concurrent attempt sees it;
    // released only after the attempt's charge is added to the spend.
    this.inFlight += reserve;
    try {
      return await this.sendReserved(caller, req, counted, reserve);
    } finally {
      this.inFlight -= reserve;
    }
  }

  private async sendReserved(
    caller: JudgeCaller,
    req: JudgeRequest,
    counted: number,
    reserve: number,
  ): Promise<{ output: unknown; record: AttemptRecord } | { error: JudgeCallError; record: AttemptRecord }> {
    const c = caller.config;
    const gate = typeof this.money.gate === 'function' ? this.money.gate(c) : this.money.gate;
    const remaining = await gate.remainingUsd('evaluation');
    if (reserve > remaining + 1e-12) {
      throw new BudgetStop(`the next attempt's reservation ($${reserve.toFixed(6)}) is more than what remains of the evaluation allowance ($${remaining.toFixed(6)})`);
    }
    let reservation;
    try {
      reservation = await gate.reserve({ category: 'evaluation', usd: reserve, purpose: `${this.money.run}-${req.purpose}-${c.role}`.slice(0, 200) });
    } catch (err) {
      if (err instanceof SpendRefusedError) throw new BudgetStop(err.message);
      throw err;
    }
    const t0 = performance.now();
    const base = { purpose: req.purpose, role: c.role, provider: c.provider, model: c.model, inputTokens: counted, reservedUsd: reserve };
    let out: { output: unknown; record: AttemptRecord } | { error: JudgeCallError; record: AttemptRecord };
    let settlement: Parameters<SpendGate['settle']>[1];
    try {
      const r = await caller.call(req, this.timeoutMs, caller.countsWithProvider ? counted : undefined);
      const cost = judgeCostUsd(c.model, r.usage);
      settlement = { usd: cost, tokens: r.usage.inputTokens + r.usage.cacheWriteTokens + r.usage.cacheReadTokens + r.usage.outputTokens };
      out = { output: r.output, record: { ...base, status: 'ok', category: null, billing: 'usage', chargedUsd: cost, usage: r.usage, latencyMs: Math.round(performance.now() - t0) } };
    } catch (err) {
      const e = err instanceof JudgeCallError ? err : new JudgeCallError('unexpected', { kind: 'uncertain' });
      let charged: number;
      if (e.billing.kind === 'usage') {
        charged = judgeCostUsd(c.model, e.billing.usage);
        settlement = { usd: charged };
      } else if (e.billing.kind === 'none') {
        charged = 0;
        settlement = { usd: 0 };
      } else {
        charged = reserve;
        settlement = 'uncertain';
      }
      out = {
        error: e,
        record: { ...base, status: 'failed', category: e.category, billing: e.billing.kind, chargedUsd: charged, usage: e.billing.kind === 'usage' ? e.billing.usage : null, latencyMs: Math.round(performance.now() - t0) },
      };
    }
    // The money is spent: record it before settling, so a settle failure cannot lose a paid output.
    this.spent += out.record.chargedUsd;
    this.allocationSpent += out.record.chargedUsd;
    const entry: SpendLogEntry = { at: new Date().toISOString(), run: this.money.run, purpose: req.purpose, provider: c.provider, model: c.model, reservedUsd: reserve, chargedUsd: out.record.chargedUsd };
    for (const log of [this.money.spendLog, this.money.allocation?.log ?? null]) {
      if (!log) continue;
      mkdirSync(dirname(log), { recursive: true });
      appendFileSync(log, `${JSON.stringify(entry)}\n`);
    }
    try {
      await gate.settle(reservation, settlement);
    } catch (err) {
      this.ledgerFailure = err instanceof Error ? err.message : String(err);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// One step: an output validated, with one retry for an invalid output

export type StepOutcome<T> =
  | { status: 'valid'; value: T; attempts: AttemptRecord[] }
  | { status: 'unjudgeable'; reason: string; attempts: AttemptRecord[] }
  | { status: 'failed'; reason: string; attempts: AttemptRecord[] };

/** Send `build(feedback)`, validate, retry an invalid output once (module comment). */
export async function step<T>(
  sender: AttemptSender,
  caller: JudgeCaller,
  build: (feedback: string | null) => JudgeRequest,
  validate: (output: unknown) => Validation<T>,
): Promise<StepOutcome<T>> {
  const attempts: AttemptRecord[] = [];
  let invalid = 0;
  let transient = 0;
  let feedback: string | null = null;
  for (;;) {
    const sent = await sender.send(caller, build(feedback));
    attempts.push(sent.record);
    if ('error' in sent) {
      const cat = sent.error.category;
      if (cat === 'auth' || cat === 'bad_request' || cat === 'count_failed') {
        throw new FatalJudgeError(`${caller.config.role} (${caller.config.model}): ${sent.error.message}; the run stops`);
      }
      if (cat === 'cap_exceeded') return { status: 'unjudgeable', reason: 'cap_exceeded', attempts };
      if (OUTPUT_FAILURES.has(cat)) {
        invalid += 1;
        if (invalid > 1) return { status: 'unjudgeable', reason: cat, attempts };
        feedback = null;
        continue;
      }
      if (TRANSIENT.has(cat) && transient < TRANSIENT_RETRIES) {
        await sender.wait(RETRY_DELAYS_MS[transient] ?? 20_000);
        transient += 1;
        continue;
      }
      return { status: 'failed', reason: cat, attempts };
    }
    const v = validate(sent.output);
    if (v.ok) return { status: 'valid', value: v.value, attempts };
    sent.record.problems = v.problems;
    invalid += 1;
    if (invalid > 1) return { status: 'unjudgeable', reason: `invalid:${v.problems.slice(0, 3).join(',')}`, attempts };
    feedback = retryFeedback(v.problems);
  }
}

/** A request with the retry feedback appended as its own last block. */
export const withFeedback = (req: JudgeRequest, feedback: string | null): JudgeRequest => (feedback ? { ...req, blocks: [...req.blocks, { text: feedback }] } : req);

// ---------------------------------------------------------------------------
// Subjects: what a judge reads for one pair

export interface FamilyRef {
  family: string;
  question: string;
  rubric: Rubric;
  questionVersion: string;
  rubricVersion: string;
}

/** A judge's final outcome for one pair. */
export type JudgeOutcome =
  | { status: 'valid'; verdict: ValidatedVerdict; parts?: PartSummary[]; attempts: AttemptRecord[] }
  | { status: 'unjudgeable' | 'uncovered' | 'failed'; reason: string; attempts: AttemptRecord[] };

export interface Subject {
  kind: 'relevance' | 'answerability';
  ref: FamilyRef;
  ntsbNo: string;
  /** The complete-input fingerprint (relevance) or the bundle fingerprint (answerability). */
  fingerprint: string;
  /** Answerability: the delivered passages' ids and text hashes, in delivered order (how runs find their judgment). */
  bundleKey?: string;
  /** `purpose` labels the ledger reservation of a single-request judgment (the adjudicator's blind step). */
  judge(sender: AttemptSender, caller: JudgeCaller, opts: { cacheCase: boolean; purpose?: 'adjudicate-initial' }): Promise<JudgeOutcome>;
  adjudicate(sender: AttemptSender, caller: JudgeCaller, initial: Extract<JudgeOutcome, { status: 'valid' }>, shown: readonly [ShownVerdict | null, ShownVerdict | null]): Promise<StepOutcome<ValidatedVerdict>>;
}

const shownOf = (v: ValidatedVerdict): ShownVerdict => ({
  grade: v.grade === 'abstain' ? 'not_relevant' : LABEL_OF[v.grade],
  evidence: v.evidence.map((e) => ({ source: e.source, quote: e.quote })),
  absent: v.absentWhat,
  rationale: v.rationale,
});

/** Case relevance on the complete record, part by part for a long case. */
export function relevanceSubject(ref: FamilyRef, evidence: CaseEvidence, plan: ChunkPlan, fingerprint: string): Subject {
  const q = { question: ref.question, rubric: ref.rubric };
  const whole = caseSources(evidence);
  return {
    kind: 'relevance',
    ref,
    ntsbNo: evidence.ntsbNo,
    fingerprint,
    async judge(sender, caller, opts) {
      if (plan.uncovered !== null || plan.chunks.length === 0) return { status: 'uncovered', reason: plan.uncovered ?? 'no chunks', attempts: [] };
      if (plan.chunks.length === 1) {
        const r = await step(sender, caller, (f) => withFeedback(relevanceRequest(q, evidence, { cacheCase: opts.cacheCase, ...(opts.purpose ? { purpose: opts.purpose } : {}) }), f), (o) =>
          validateVerdict(o as Verdict, { sources: whole, allowAbstain: false, allowAbsence: true }),
        );
        return r.status === 'valid' ? { status: 'valid', verdict: r.value, attempts: r.attempts } : { status: r.status, reason: r.reason, attempts: r.attempts };
      }
      const attempts: AttemptRecord[] = [];
      const parts: PartSummary[] = [];
      let notes = '';
      for (const [i, pieces] of plan.chunks.entries()) {
        const sources = caseSources(evidence, pieces);
        const r = await step(sender, caller, (f) => withFeedback(chunkRequest(q, evidence, pieces, i + 1, plan.chunks.length, notes), f), (o) =>
          validateChunk(o as ChunkVerdict, { sources, allowAbstain: false, allowAbsence: false }),
        );
        attempts.push(...r.attempts);
        if (r.status !== 'valid') return { status: r.status === 'failed' ? 'failed' : 'uncovered', reason: `part ${i + 1}: ${r.reason}`, attempts };
        const chunk: ValidatedChunk = r.value;
        parts.push({ part: i + 1, grade: chunk.grade, evidence: chunk.evidence.map((e) => ({ source: e.source, quote: e.quote })), notes: chunk.notes });
        notes = chunk.notes;
      }
      const c = await step(sender, caller, (f) => withFeedback(consolidateRequest(q, evidence, parts), f), (o) =>
        validateVerdict(o as Verdict, { sources: whole, allowAbstain: false, allowAbsence: true }),
      );
      attempts.push(...c.attempts);
      return c.status === 'valid' ? { status: 'valid', verdict: c.value, parts, attempts } : { status: c.status, reason: `consolidation: ${c.reason}`, attempts };
    },
    async adjudicate(sender, caller, initial, shown) {
      const req = initial.parts
        ? adjudicationRequestForParts(q, evidence, initial.parts, shownOf(initial.verdict), shown)
        : adjudicationRequest(q, evidence, shownOf(initial.verdict), shown);
      return step(sender, caller, (f) => withFeedback(req, f), (o) => validateVerdict(o as Verdict, { sources: whole, allowAbstain: true, allowAbsence: true }));
    },
  };
}

/** Bundle answerability on the passages a bundle delivered for the case. */
/** The key a run uses to find a delivered case's answerability judgment. */
export const bundleKeyOf = (passages: readonly { passageId: string; textSha256: string }[]): string => passages.map((p) => `${p.passageId}:${p.textSha256}`).join(',');

export function answerabilitySubject(ref: FamilyRef, header: Pick<CaseEvidence, 'ntsbNo' | 'event' | 'aircraft'>, passages: readonly DeliveredPassage[], fingerprint: string): Subject {
  const q = { question: ref.question, rubric: ref.rubric };
  const block = renderBundleCase(header, passages);
  const sources = passageSources(passages);
  return {
    kind: 'answerability',
    ref,
    ntsbNo: header.ntsbNo,
    fingerprint,
    bundleKey: bundleKeyOf(passages.map((p) => ({ passageId: p.passageId, textSha256: sha256(p.text) }))),
    async judge(sender, caller, opts) {
      const r = await step(sender, caller, (f) => withFeedback(answerabilityRequest(q, block, { cacheCase: opts.cacheCase, ...(opts.purpose ? { purpose: opts.purpose } : {}) }), f), (o) =>
        validateAnswerability(o as Answerability, { sources, allowAbstain: false, allowAbsence: true }),
      );
      return r.status === 'valid' ? { status: 'valid', verdict: r.value, attempts: r.attempts } : { status: r.status, reason: r.reason, attempts: r.attempts };
    },
    async adjudicate(sender, caller, initial, shown) {
      return step(sender, caller, (f) => withFeedback(answerabilityAdjudicationRequest(q, block, shownOf(initial.verdict), shown), f), (o) =>
        validateAnswerability(o as Answerability, { sources, allowAbstain: true, allowAbsence: true }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Cache

export interface CacheEntry {
  key: string;
  kind: 'judge' | 'adjudication-initial' | 'adjudication';
  identity: Record<string, unknown>;
  outcome: unknown;
  at: string;
}

/** Append-only JSONL cache of final outcomes (module comment). */
export class JudgmentCache {
  private readonly entries = new Map<string, CacheEntry>();
  constructor(private readonly path: string | null) {
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        const e = JSON.parse(line) as CacheEntry;
        this.entries.set(e.key, e);
      }
    }
  }
  get(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }
  put(e: Omit<CacheEntry, 'at'>): void {
    const entry = { ...e, at: new Date().toISOString() };
    this.entries.set(e.key, entry);
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    }
  }
  get size(): number {
    return this.entries.size;
  }
}

/** The identity tuple of one judge's outcome for a subject (protocol section 6, plus the frozen settings and the chunk budget). */
export function judgeKeyIdentity(s: Pick<Subject, 'kind' | 'ref' | 'ntsbNo' | 'fingerprint'>, caller: Pick<JudgeCaller, 'config'>): Record<string, unknown> {
  return {
    kind: s.kind,
    questionVersion: s.ref.questionVersion,
    rubricVersion: s.ref.rubricVersion,
    ntsbNo: s.ntsbNo,
    fingerprint: s.fingerprint,
    provider: caller.config.provider,
    model: caller.config.model,
    judge: judgeIdentity(caller.config),
    prompts: s.kind === 'relevance' ? JUDGE_PROMPTS_VERSION : ANSWERABILITY_PROMPTS_VERSION,
    // The pinned request formats and schemas (identity.ts): an edited prompt or format re-judges even without a version bump.
    requests: REQUEST_FORMAT_SHA256,
    schemas: SCHEMAS_SHA256,
    validator: VALIDATOR_VERSION,
    chunkBudget: s.kind === 'relevance' ? CASE_TOKEN_BUDGET : null,
  };
}

export const keyOf = (identity: Record<string, unknown>): string => sha256(canonicalJson(identity));

/** A short hash of an outcome (an adjudication's identity includes the verdicts it saw). */
export const outcomeHash = (o: JudgeOutcome): string =>
  sha256(canonicalJson(o.status === 'valid' ? { status: o.status, verdict: o.verdict } : { status: o.status, reason: o.reason })).slice(0, 32);

// ---------------------------------------------------------------------------
// Pairs

export type PairStatus =
  | 'agreed'
  | 'adjudicated'
  | 'abstained'
  | 'adjudication-unjudgeable'
  | 'escalation-budget-exhausted'
  | 'unjudgeable'
  | 'uncovered'
  | 'incomplete';

export interface PairRecord {
  kind: Subject['kind'];
  family: string;
  ntsbNo: string;
  /** Answerability: the delivered passages' key (`bundleKeyOf`); null for relevance. */
  bundleKey: string | null;
  questionVersion: string;
  rubricVersion: string;
  fingerprint: string;
  /** `outcome` is the hash of the judge's outcome (`outcomeHash`): records of one pair agree on it unless one of them failed. */
  judges: { role: JudgeRole; provider: string; model: string; key: string; outcome: string; status: JudgeOutcome['status']; grade: Grade | null; reason: string | null; absent: boolean | null; cached: boolean }[];
  adjudication: null | {
    /** The cache key of the blind first step, and of the decision (null when the first step gave no valid grade). */
    initialKey: string;
    key: string | null;
    order: [JudgeRole, JudgeRole];
    initial: Grade | null;
    initialStatus: JudgeOutcome['status'];
    final: Grade | 'abstain' | null;
    status: StepOutcome<ValidatedVerdict>['status'] | 'uncovered';
    cached: boolean;
  };
  /** The label: a grade, or `unknown` (never dropped). */
  label: Grade | 'unknown';
  status: PairStatus;
  /** Every attempt this run paid for (cached outcomes add none). */
  attempts: AttemptRecord[];
  /** Validated verdicts (evidence with canonical identities) of each judge and of the adjudicator's final decision. */
  verdicts: { role: JudgeRole | 'adjudicator-initial' | 'adjudicator-final'; verdict: ValidatedVerdict }[];
}

export interface PairPlanItem {
  subject: Subject;
  /** Lower is more important: pairs are judged, and escalated, in this order (the frozen schedule, `pool.ts`). */
  priority: number;
}

/** Stable priority order: priority, then case, then family (the frozen schedule). */
export const byPriority = (x: PairPlanItem, y: PairPlanItem): number =>
  x.priority - y.priority ||
  (x.subject.ntsbNo < y.subject.ntsbNo ? -1 : x.subject.ntsbNo > y.subject.ntsbNo ? 1 : 0) ||
  (x.subject.ref.family < y.subject.ref.family ? -1 : x.subject.ref.family > y.subject.ref.family ? 1 : 0) ||
  ((x.subject.bundleKey ?? '') < (y.subject.bundleKey ?? '') ? -1 : (x.subject.bundleKey ?? '') > (y.subject.bundleKey ?? '') ? 1 : 0);

export interface JudgingOptions {
  judges: readonly [JudgeCaller, JudgeCaller];
  adjudicator: JudgeCaller;
  sender: AttemptSender;
  cache: JudgmentCache;
  concurrency: number;
  maxEscalationShare?: number;
  log?: (m: string) => void;
}

const gradeOf = (o: JudgeOutcome): Grade | null => (o.status === 'valid' && o.verdict.grade !== 'abstain' ? o.verdict.grade : null);

/** Run `worker` over `items` with at most `concurrency` at a time, stopping all on the first thrown error. */
export async function runPool<T>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (failure === null) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        await worker(items[i] as T, i);
      } catch (err) {
        failure ??= err;
      }
    }
  });
  await Promise.all(lanes);
  if (failure !== null) throw failure;
}

async function judgeOnce(o: JudgingOptions, subject: Subject, caller: JudgeCaller): Promise<{ outcome: JudgeOutcome; key: string; cached: boolean }> {
  const identity = judgeKeyIdentity(subject, caller);
  const key = keyOf(identity);
  const hit = o.cache.get(key);
  if (hit) return { outcome: hit.outcome as JudgeOutcome, key, cached: true };
  const outcome = await subject.judge(o.sender, caller, { cacheCase: false });
  if (outcome.status !== 'failed') o.cache.put({ key, kind: 'judge', identity, outcome: { ...outcome, attempts: [] } });
  return { outcome, key, cached: false };
}

/** The A/B order the adjudicator sees: fixed by a hash of the pair, never by provider. */
export const adjudicationOrder = (s: Pick<Subject, 'ntsbNo' | 'ref' | 'kind'>): [0 | 1, 0 | 1] =>
  parseInt(sha256(`${s.kind}|${s.ref.family}|${s.ntsbNo}`).slice(0, 8), 16) % 2 === 0 ? [0, 1] : [1, 0];

/** Judge every pair in priority order, then escalate disagreements in that order (module comment). */
export async function judgePairs(items: readonly PairPlanItem[], o: JudgingOptions): Promise<{ records: PairRecord[]; stopped: string | null }> {
  const log = o.log ?? (() => undefined);
  let stopped: string | null = null;
  /** A budget stop is recorded (the run starts nothing new); any other error propagates. */
  const budgetStop = (err: unknown): void => {
    if (!(err instanceof BudgetStop)) throw err;
    stopped ??= err.message;
  };
  const schedule = [...items].sort(byPriority);
  const results: { item: PairPlanItem; outcomes: [Awaited<ReturnType<typeof judgeOnce>>, Awaited<ReturnType<typeof judgeOnce>>] }[] = [];
  await runPool(schedule, o.concurrency, async (item) => {
    if (stopped !== null) return;
    const settled = await Promise.allSettled([judgeOnce(o, item.subject, o.judges[0]), judgeOnce(o, item.subject, o.judges[1])]);
    const [a, b] = settled;
    if (a?.status === 'fulfilled' && b?.status === 'fulfilled') {
      results.push({ item, outcomes: [a.value, b.value] });
      log(`judged ${item.subject.kind} ${item.subject.ref.family} ${item.subject.ntsbNo}: ${a.value.outcome.status}/${b.value.outcome.status}`);
      return;
    }
    // A fatal error wins over a budget stop; a judge that finished is in the cache.
    const errors = settled.flatMap((x) => (x.status === 'rejected' ? [x.reason as unknown] : []));
    const fatal = errors.find((e) => !(e instanceof BudgetStop));
    if (fatal !== undefined) throw fatal;
    budgetStop(errors[0]);
  });
  const share = o.maxEscalationShare ?? MAX_ESCALATION_SHARE;
  const cap = Math.floor(share * items.length);
  const ordered = [...results].sort((x, y) => byPriority(x.item, y.item));
  const records: PairRecord[] = [];
  let escalated = 0;
  const toAdjudicate: { r: (typeof ordered)[number]; record: PairRecord }[] = [];
  for (const r of ordered) {
    const s = r.item.subject;
    const [a, b] = r.outcomes;
    const record: PairRecord = {
      kind: s.kind,
      family: s.ref.family,
      ntsbNo: s.ntsbNo,
      bundleKey: s.bundleKey ?? null,
      questionVersion: s.ref.questionVersion,
      rubricVersion: s.ref.rubricVersion,
      fingerprint: s.fingerprint,
      judges: [a, b].map((x, i) => {
        const caller = o.judges[i] as JudgeCaller;
        return {
          role: caller.config.role,
          provider: caller.config.provider,
          model: caller.config.model,
          key: x.key,
          outcome: outcomeHash(x.outcome),
          status: x.outcome.status,
          grade: gradeOf(x.outcome),
          reason: x.outcome.status === 'valid' ? null : x.outcome.reason,
          absent: x.outcome.status === 'valid' ? x.outcome.verdict.absent : null,
          cached: x.cached,
        };
      }),
      adjudication: null,
      label: 'unknown',
      status: 'unjudgeable',
      attempts: [...a.outcome.attempts, ...b.outcome.attempts],
      verdicts: [a, b].flatMap((x, i) => (x.outcome.status === 'valid' ? [{ role: (o.judges[i] as JudgeCaller).config.role, verdict: x.outcome.verdict }] : [])),
    };
    const ga = gradeOf(a.outcome);
    const gb = gradeOf(b.outcome);
    records.push(record);
    if (a.outcome.status === 'failed' || b.outcome.status === 'failed') {
      record.status = 'incomplete';
      continue;
    }
    if (ga !== null && gb !== null && ga === gb) {
      record.label = ga;
      record.status = 'agreed';
      continue;
    }
    if (ga === null && gb === null) {
      record.status = a.outcome.status === 'uncovered' || b.outcome.status === 'uncovered' ? 'uncovered' : 'unjudgeable';
      continue;
    }
    if (escalated >= cap) {
      record.status = 'escalation-budget-exhausted';
      continue;
    }
    escalated += 1;
    toAdjudicate.push({ r, record });
  }
  /**
   * One escalation: the adjudicator's blind grade, then its decision. Each step is cached
   * on its own as soon as it is paid for, so a budget stop between them never makes the
   * next run buy the blind grade again.
   */
  const adjudicate = async (r: (typeof ordered)[number], record: PairRecord): Promise<void> => {
    const s = r.item.subject;
    const [a, b] = r.outcomes;
    const order = adjudicationOrder(s);
    const shown = order.map((i) => {
      const x = (i === 0 ? a : b).outcome;
      return x.status === 'valid' ? shownOf(x.verdict) : null;
    }) as [ShownVerdict | null, ShownVerdict | null];
    const initialIdentity = { ...judgeKeyIdentity(s, o.adjudicator), step: 'adjudicate-initial' };
    const initialKey = keyOf(initialIdentity);
    const hitInitial = o.cache.get(initialKey);
    let initial: JudgeOutcome;
    let initialCached = false;
    if (hitInitial) {
      initial = hitInitial.outcome as JudgeOutcome;
      initialCached = true;
    } else {
      initial = await s.judge(o.sender, o.adjudicator, { cacheCase: true, purpose: 'adjudicate-initial' });
      record.attempts.push(...initial.attempts);
      if (initial.status !== 'failed') o.cache.put({ key: initialKey, kind: 'adjudication-initial', identity: initialIdentity, outcome: { ...initial, attempts: [] } });
    }
    let final: StepOutcome<ValidatedVerdict> | null = null;
    let finalKey: string | null = null;
    let finalCached = false;
    if (initial.status === 'valid') {
      const identity = {
        ...judgeKeyIdentity(s, o.adjudicator),
        step: 'adjudicate-final',
        prompts: `${s.kind === 'relevance' ? JUDGE_PROMPTS_VERSION : ANSWERABILITY_PROMPTS_VERSION}+${ADJUDICATOR_PROMPTS_VERSION}`,
        verdicts: order.map((i) => outcomeHash((i === 0 ? a : b).outcome)),
        initial: outcomeHash(initial),
      };
      finalKey = keyOf(identity);
      const hit = o.cache.get(finalKey);
      if (hit) {
        final = hit.outcome as StepOutcome<ValidatedVerdict>;
        finalCached = true;
      } else {
        final = await s.adjudicate(o.sender, o.adjudicator, initial, shown);
        record.attempts.push(...final.attempts);
        if (final.status !== 'failed') o.cache.put({ key: finalKey, kind: 'adjudication', identity, outcome: { ...final, attempts: [] } });
      }
    }
    const roles = o.judges.map((j) => j.config.role) as [JudgeRole, JudgeRole];
    record.adjudication = {
      initialKey,
      key: finalKey,
      order: [roles[order[0]], roles[order[1]]],
      initial: gradeOf(initial),
      initialStatus: initial.status,
      final: final?.status === 'valid' ? final.value.grade : null,
      status: initial.status === 'valid' ? (final?.status ?? 'unjudgeable') : initial.status === 'uncovered' ? 'uncovered' : initial.status === 'failed' ? 'failed' : 'unjudgeable',
      cached: initialCached && (final === null || finalCached),
    };
    if (initial.status === 'valid') record.verdicts.push({ role: 'adjudicator-initial', verdict: initial.verdict });
    if (initial.status === 'failed' || final?.status === 'failed') {
      record.status = 'incomplete';
    } else if (final?.status === 'valid') {
      record.verdicts.push({ role: 'adjudicator-final', verdict: final.value });
      if (final.value.grade === 'abstain') record.status = 'abstained';
      else {
        record.label = final.value.grade;
        record.status = 'adjudicated';
      }
    } else {
      record.status = 'adjudication-unjudgeable';
    }
    log(`adjudicated ${s.kind} ${s.ref.family} ${s.ntsbNo}: ${record.status}`);
  };
  await runPool(toAdjudicate, o.concurrency, async ({ r, record }) => {
    if (stopped !== null) {
      record.status = 'escalation-budget-exhausted';
      return;
    }
    try {
      await adjudicate(r, record);
    } catch (err) {
      budgetStop(err);
      // The blind step, when it was paid for, is cached: the next run decides from it.
      record.status = 'escalation-budget-exhausted';
      record.adjudication = null;
    }
  });
  return { records, stopped };
}
