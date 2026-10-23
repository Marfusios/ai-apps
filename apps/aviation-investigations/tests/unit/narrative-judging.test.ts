/**
 * Track N judging: the evaluation-only judge clients (the Anthropic one classifies
 * failures exactly as the production adapter does; the OpenAI one mirrors it, with
 * strict structured outputs, explicit caching, reasoning tokens and billing), and the
 * pair procedure: independent judges, one retry of an invalid output, adjudication with
 * a recorded blind first decision, abstentions and unresolved pairs as `unknown`, the
 * escalation bound, per-attempt ledger reservations, budget stops and the cache.
 * No request leaves the process.
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../../server/ai/anthropic.js';
import { StageError, stageCtx } from '../../server/ai/provider.js';
import { createMemorySpendGate, type MemorySpendGate, type SpendGate } from '../../worker/index/spend-gate.js';
import { createFakeProvider } from '../../server/ai/fake.js';
import { providerScopeCaller, runScopeSamples } from '../../evals/retrieval/experiments/scope.js';
import {
  JudgeCallError,
  attemptReserveUsd,
  createAnthropicJudge,
  createFakeJudge,
  createOpenAIJudge,
  judgeCostUsd,
  openAIUsage,
  type JudgeModelConfig,
  type OpenAIResponsesClient,
} from '../../evals/retrieval/narrative/clients.js';
import { fingerprint, planChunks } from '../../evals/retrieval/narrative/evidence.js';
import {
  AttemptSender,
  BudgetStop,
  FILE_WRITER,
  FatalJudgeError,
  JudgmentCache,
  RunBooks,
  UnrecordedSpendError,
  holdingAllocation,
  adjudicationOrder,
  judgePairs,
  lockAllocation,
  loggedRunUsd,
  loggedSpendUsd,
  openAllocation,
  recoverAllocation,
  relevanceSubject,
  type ChargeWriter,
  type RecoveryLedger,
  type RunReservation,
  type FamilyRef,
  type PairPlanItem,
  type PairRecord,
} from '../../evals/retrieval/narrative/judging.js';
import { payForPoolInputs, runJudging, scheduleInfo } from '../../evals/retrieval/narrative/commands.js';
import { describeWorkerError } from '../../worker/errors.js';
import { SCHEDULE, casePriority, tierOf } from '../../evals/retrieval/narrative/pool.js';
import { relevanceRequest, type JudgeRequest } from '../../evals/retrieval/narrative/prompts.js';
import { NARRATIVE_QUESTIONS } from '../../evals/retrieval/narrative/questions.js';
import { questionVersion, rubricVersion } from '../../evals/retrieval/narrative/spec.js';
import { evidence } from '../support/narrative-fixtures.js';

const HAIKU: JudgeModelConfig = { role: 'judge-a', provider: 'anthropic', model: 'claude-haiku-5-5', settings: { thinking: 'adaptive', effort: 'low' }, maxOutputTokens: 6_000, maxInputTokens: 30_000 };
const LUNA: JudgeModelConfig = { role: 'judge-b', provider: 'openai', model: 'gpt-5.6-luna', settings: { reasoning: 'low' }, maxOutputTokens: 6_000, maxInputTokens: 30_000 };
const SONNET: JudgeModelConfig = { role: 'adjudicator', provider: 'anthropic', model: 'claude-sonnet-5-5', settings: { thinking: 'off', effort: 'low' }, maxOutputTokens: 4_000, maxInputTokens: 30_000 };

const q = NARRATIVE_QUESTIONS[0] as (typeof NARRATIVE_QUESTIONS)[number];
const ref: FamilyRef = { family: q.id, question: q.question, rubric: q.rubric, questionVersion: questionVersion(q), rubricVersion: rubricVersion(q.rubric) };

const VERDICT = {
  relevant: { grade: 'relevant', evidence: [{ source: 'S1', quote: 'the engine lost total power during the climb' }, { source: 'S1', quote: 'revealed no mechanical malfunctions or anomalies' }], absent_from_record: false, absent: null, rationale: 'Both conditions.' },
  partial: { grade: 'partial', evidence: [{ source: 'S1', quote: 'the engine lost total power during the climb' }], absent_from_record: false, absent: null, rationale: 'Power loss only.' },
  invalid: { grade: 'relevant', evidence: [{ source: 'S1', quote: 'a quote that is not in the record at all' }], absent_from_record: false, absent: null, rationale: 'x' },
  abstain: { grade: 'abstain', evidence: [], absent_from_record: false, absent: null, rationale: 'The rubric does not settle it.' },
} as const;

// ---------------------------------------------------------------------------
// Anthropic: a real SDK client with a stubbed fetch

type Body = Record<string, unknown>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
const anthropicError = (status: number, type: string) => json(status, { type: 'error', error: { type, message: 'synthetic' } });
const message = (output: unknown, over: Body = {}) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'test',
  content: [{ type: 'text', text: JSON.stringify(output), citations: null }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  stop_details: null,
  usage: { input_tokens: 900, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_200, output_tokens_details: { thinking_tokens: 120 } },
  ...over,
});

function anthropicStub(reply: () => Response | Promise<Response>, count = 2_000) {
  const bodies: Body[] = [];
  const countBodies: Body[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Body;
    if (String(url).endsWith('/v1/messages/count_tokens')) {
      countBodies.push(body);
      return json(200, { input_tokens: count });
    }
    bodies.push(body);
    return reply();
  };
  return { client: new Anthropic({ apiKey: 'test-key', baseURL: 'https://api.invalid', maxRetries: 0, fetch }), bodies, countBodies };
}

async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: unknown) => e,
  );
}

describe('the Anthropic judge client', () => {
  const req = relevanceRequest(q, evidence());

  it('classifies every failure exactly as the production adapter does', async () => {
    const cases: [string, () => Response | Promise<Response>][] = [
      ['429', () => anthropicError(429, 'rate_limit_error')],
      ['401', () => anthropicError(401, 'authentication_error')],
      ['403', () => anthropicError(403, 'permission_error')],
      ['400', () => anthropicError(400, 'invalid_request_error')],
      ['404', () => anthropicError(404, 'not_found_error')],
      ['422', () => anthropicError(422, 'invalid_request_error')],
      ['409', () => anthropicError(409, 'conflict_error')],
      ['529', () => anthropicError(529, 'overloaded_error')],
      ['500', () => anthropicError(500, 'api_error')],
      ['network', () => Promise.reject(new TypeError('fetch failed'))],
      ['refusal', () => json(200, message(VERDICT.partial, { stop_reason: 'refusal' }))],
      ['max_tokens', () => json(200, message(VERDICT.partial, { stop_reason: 'max_tokens' }))],
      ['unparseable', () => json(200, message('not the schema'))],
    ];
    for (const [name, reply] of cases) {
      const adapter = createAnthropicProvider({ models: { scope: 'claude-haiku-5-5', answer: 'claude-haiku-5-5', check: 'claude-haiku-5-5' }, client: anthropicStub(reply).client });
      const stage = (await failure(adapter.scope({ question: 'Engine power loss after maintenance?' }, stageCtx('scope', new AbortController().signal, 5_000)))) as StageError;
      const judge = createAnthropicJudge(HAIKU, { client: anthropicStub(reply).client });
      const mine = (await failure(judge.call(req, 5_000))) as JudgeCallError;
      expect(stage).toBeInstanceOf(StageError);
      expect(mine).toBeInstanceOf(JudgeCallError);
      expect([name, mine.category, mine.billing.kind]).toEqual([name, stage.category, stage.billing.kind]);
    }
  });

  it('sends the frozen settings with cache marks on the system prompt and the cacheable blocks only', async () => {
    const stub = anthropicStub(() => json(200, message(VERDICT.relevant)));
    const r = await createAnthropicJudge(HAIKU, { client: stub.client }).call(req, 5_000);
    const body = stub.bodies[0] as { system: Body[]; messages: { content: Body[] }[]; output_config: Body; thinking: Body; max_tokens: number };
    expect(body.system[0]).toMatchObject({ cache_control: { type: 'ephemeral' } });
    expect(body.messages[0]?.content.map((c) => 'cache_control' in c)).toEqual([true, false, false]);
    expect(body.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.max_tokens).toBe(6_000);
    expect(r.output).toMatchObject({ grade: 'relevant' });
    expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 300, cacheWriteTokens: 0, cacheReadTokens: 1_200, reasoningTokens: 120 });
    expect(stub.countBodies).toHaveLength(1);
  });

  it('refuses a request above the input cap before sending it, and turns thinking off where configured', async () => {
    const stub = anthropicStub(() => json(200, message(VERDICT.relevant)), 40_000);
    expect(await failure(createAnthropicJudge(HAIKU, { client: stub.client }).call(req, 5_000))).toMatchObject({ category: 'cap_exceeded', billing: { kind: 'none' } });
    expect(stub.bodies).toHaveLength(0);
    const off = anthropicStub(() => json(200, message(VERDICT.relevant)));
    await createAnthropicJudge(SONNET, { client: off.client }).call(req, 5_000);
    expect((off.bodies[0] as { thinking: Body }).thinking).toEqual({ type: 'between_tools' });
  });
});

// ---------------------------------------------------------------------------
// OpenAI: a real SDK client with a stubbed fetch

const response = (output: unknown, over: Body = {}) => ({
  id: 'resp_test',
  object: 'response',
  status: 'completed',
  incomplete_details: null,
  output: [{ type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output), annotations: [] }] }],
  usage: { input_tokens: 2_400, input_tokens_details: { cached_tokens: 1_500, cache_write_tokens: 0 }, output_tokens: 700, output_tokens_details: { reasoning_tokens: 450 }, total_tokens: 3_100 },
  ...over,
});
const openAIError = (status: number, code: string) => json(status, { error: { message: 'synthetic', type: 'error', code } });

function openAIStub(reply: () => Response | Promise<Response>) {
  const bodies: Body[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body)) as Body);
    return reply();
  };
  const client = new OpenAI({ apiKey: 'test-key', baseURL: 'https://api.invalid/v1', maxRetries: 0, fetch }) as unknown as OpenAIResponsesClient;
  return { client, bodies };
}

describe('the OpenAI judge client', () => {
  const req = relevanceRequest(q, evidence());

  it('sends strict structured output, reasoning effort, explicit caching on the cacheable blocks and no storage', async () => {
    const stub = openAIStub(() => json(200, response(VERDICT.partial)));
    const r = await createOpenAIJudge(LUNA, { client: stub.client }).call(req, 5_000);
    const body = stub.bodies[0] as { input: { role: string; content: Body[] }[]; text: { format: Body }; reasoning: Body; prompt_cache_options: Body; store: boolean; max_output_tokens: number };
    expect(body.input.map((m) => m.role)).toEqual(['developer', 'user']);
    expect(body.input[1]?.content.map((c) => 'prompt_cache_breakpoint' in c)).toEqual([true, false, false]);
    expect(body.prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true, name: 'verdict' });
    expect(body.max_output_tokens).toBe(6_000);
    expect(r.output).toMatchObject({ grade: 'partial' });
    expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 700, cacheWriteTokens: 0, cacheReadTokens: 1_500, reasoningTokens: 450 });
  });

  it('mirrors the adapter classification for transport failures', async () => {
    const cases: [() => Response | Promise<Response>, string, string][] = [
      [() => openAIError(429, 'rate_limit_exceeded'), 'rate_limited', 'none'],
      [() => openAIError(401, 'invalid_api_key'), 'auth', 'none'],
      [() => openAIError(403, 'forbidden'), 'auth', 'none'],
      [() => openAIError(400, 'invalid_request'), 'bad_request', 'none'],
      [() => openAIError(404, 'model_not_found'), 'bad_request', 'none'],
      [() => openAIError(409, 'conflict'), 'provider_error', 'none'],
      [() => openAIError(500, 'server_error'), 'provider_error', 'uncertain'],
      [() => Promise.reject(new TypeError('fetch failed')), 'network', 'uncertain'],
    ];
    for (const [reply, category, billing] of cases) {
      const e = (await failure(createOpenAIJudge(LUNA, { client: openAIStub(reply).client }).call(req, 5_000))) as JudgeCallError;
      expect([e.category, e.billing.kind]).toEqual([category, billing]);
    }
  });

  it('bills truncated, filtered, refused and unparseable outputs at their usage', async () => {
    const usage = { kind: 'usage' };
    const run = async (body: unknown) => (await failure(createOpenAIJudge(LUNA, { client: openAIStub(() => json(200, body)).client }).call(req, 5_000))) as JudgeCallError;
    expect(await run(response(VERDICT.partial, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }))).toMatchObject({ category: 'truncated', billing: usage });
    expect(await run(response(VERDICT.partial, { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }))).toMatchObject({ category: 'refusal', billing: usage });
    expect(await run(response(null, { output: [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'no' }] }] }))).toMatchObject({ category: 'refusal', billing: usage });
    expect(await run(response({ grade: 'maybe' }))).toMatchObject({ category: 'invalid_output', billing: usage });
    expect(await run(response(VERDICT.partial, { usage: undefined }))).toMatchObject({ category: 'invalid_output', billing: { kind: 'uncertain' } });
  });

  it('maps usage: ordinary input excludes cached and written tokens', () => {
    expect(openAIUsage({ input_tokens: 3_000, input_tokens_details: { cached_tokens: 1_000, cache_write_tokens: 500 }, output_tokens: 400, output_tokens_details: { reasoning_tokens: 100 } })).toEqual({
      inputTokens: 1_500,
      outputTokens: 400,
      cacheWriteTokens: 500,
      cacheReadTokens: 1_000,
      reasoningTokens: 100,
    });
    expect(openAIUsage({ input_tokens: 10, input_tokens_details: { cached_tokens: 20 }, output_tokens: 1 })).toBeNull();
    expect(judgeCostUsd('gpt-5.6-luna', { inputTokens: 1_500, outputTokens: 400, cacheWriteTokens: 500, cacheReadTokens: 1_000 })).toBeCloseTo((1_500 * 0.2 + 400 * 1.2 + 500 * 0.25 + 1_000 * 0.02) / 1e6, 12);
  });
});

// ---------------------------------------------------------------------------
// Pairs

function subject(over: Partial<FamilyRef> = {}) {
  const e = evidence();
  return relevanceSubject({ ...ref, ...over }, e, planChunks(e), fingerprint(e));
}

function harness(opts: { allowance?: number; limit?: number; cache?: JudgmentCache } = {}) {
  const gate = createMemorySpendGate(opts.allowance ?? 20);
  const sender = new AttemptSender({ gate, limitUsd: opts.limit ?? 5, spendLog: null, allocation: null, run: 'test' }, 5_000, async () => undefined);
  return { gate, sender, cache: opts.cache ?? new JudgmentCache(null) };
}

const reply = (seq: readonly unknown[]) => (_req: JudgeRequest, n: number) => seq[Math.min(n - 1, seq.length - 1)];

describe('judging pairs', () => {
  it('labels an agreement, reserving and settling every attempt on the ledger', async () => {
    const h = harness();
    const a = createFakeJudge(HAIKU, reply([VERDICT.relevant]));
    const b = createFakeJudge(LUNA, reply([VERDICT.relevant]));
    const adj = createFakeJudge(SONNET, reply([VERDICT.relevant]));
    const [r] = (await judgePairs([{ subject: subject(), priority: 0 }], { judges: [a, b], adjudicator: adj, sender: h.sender, cache: h.cache, concurrency: 2 })).records;
    expect(r).toMatchObject({ label: 2, status: 'agreed', adjudication: null });
    expect(adj.calls).toHaveLength(0);
    expect(h.gate.records).toHaveLength(2);
    expect(h.gate.records.every((x) => x.status === 'settled')).toBe(true);
    expect(r?.attempts.map((x) => x.reservedUsd)).toEqual([attemptReserveUsd(HAIKU, r?.attempts[0]?.inputTokens as number), attemptReserveUsd(LUNA, r?.attempts[1]?.inputTokens as number)]);
  });

  it('adjudicates a disagreement: a blind first decision, then both verdicts as A and B', async () => {
    const h = harness();
    const a = createFakeJudge(HAIKU, reply([VERDICT.relevant]));
    const b = createFakeJudge(LUNA, reply([VERDICT.partial]));
    const adj = createFakeJudge(SONNET, reply([VERDICT.partial, VERDICT.relevant]));
    const [r] = (await judgePairs([{ subject: subject(), priority: 0 }], { judges: [a, b], adjudicator: adj, sender: h.sender, cache: h.cache, concurrency: 1, maxEscalationShare: 1 })).records;
    expect(r).toMatchObject({ label: 2, status: 'adjudicated', adjudication: { initial: 1, final: 2, status: 'valid' } });
    const [first, second] = adj.calls;
    const text = (x: JudgeRequest | undefined) => (x?.blocks ?? []).map((b2) => b2.text).join('\n');
    expect(text(first)).not.toMatch(/<verdicts>|<initial>|Both conditions|Power loss only/);
    expect(first?.blocks[1]?.cache).toBe(true);
    expect(text(second)).toContain('<initial>');
    expect(text(second)).toContain('<verdict grader="A">');
    expect(text(second)).toContain('Both conditions.');
    expect(text(second)).toContain('Power loss only.');
    expect(r?.adjudication?.order).toEqual(adjudicationOrder(subject()).map((i) => (i === 0 ? 'judge-a' : 'judge-b')));
  });

  it('turns an abstention, an invalid adjudication and two unjudgeable judges into unknown', async () => {
    const run = async (aSeq: unknown[], bSeq: unknown[], adjSeq: unknown[]) => {
      const h = harness();
      const [r] = (await judgePairs([{ subject: subject(), priority: 0 }], {
        judges: [createFakeJudge(HAIKU, reply(aSeq)), createFakeJudge(LUNA, reply(bSeq))],
        adjudicator: createFakeJudge(SONNET, reply(adjSeq)),
        sender: h.sender,
        cache: h.cache,
        concurrency: 1,
        maxEscalationShare: 1,
      })).records;
      return r;
    };
    expect(await run([VERDICT.relevant], [VERDICT.partial], [VERDICT.partial, VERDICT.abstain])).toMatchObject({ label: 'unknown', status: 'abstained' });
    expect(await run([VERDICT.relevant], [VERDICT.partial], [VERDICT.partial, VERDICT.invalid, VERDICT.invalid])).toMatchObject({ label: 'unknown', status: 'adjudication-unjudgeable' });
    expect(await run([VERDICT.invalid], [VERDICT.invalid], [VERDICT.relevant])).toMatchObject({ label: 'unknown', status: 'unjudgeable', adjudication: null });
  });

  it('retries an invalid output once with feedback, and escalates when only one judge is usable', async () => {
    const h = harness();
    const a = createFakeJudge(HAIKU, reply([VERDICT.invalid, VERDICT.relevant]));
    const b = createFakeJudge(LUNA, reply([VERDICT.invalid, VERDICT.invalid]));
    const adj = createFakeJudge(SONNET, reply([VERDICT.relevant, VERDICT.relevant]));
    const [r] = (await judgePairs([{ subject: subject(), priority: 0 }], { judges: [a, b], adjudicator: adj, sender: h.sender, cache: h.cache, concurrency: 1, maxEscalationShare: 1 })).records;
    expect(a.calls).toHaveLength(2);
    expect(a.calls[1]?.blocks.at(-1)?.text).toContain('quote_not_found:S1');
    expect(b.calls).toHaveLength(2);
    expect(r?.judges.map((j) => j.status)).toEqual(['valid', 'unjudgeable']);
    expect(r).toMatchObject({ label: 2, status: 'adjudicated' });
    expect(adj.calls[1]?.blocks.at(-1)?.text).toContain('no usable verdict');
  });

  it('bounds escalations to a share of the pairs, in priority order', async () => {
    const h = harness();
    const items: PairPlanItem[] = [3, 0, 2, 1].map((priority, i) => ({ subject: subject({ family: `f-${i}` }), priority }));
    const records = (await judgePairs(items, {
      judges: [createFakeJudge(HAIKU, reply([VERDICT.relevant])), createFakeJudge(LUNA, reply([VERDICT.partial]))],
      adjudicator: createFakeJudge(SONNET, reply([VERDICT.relevant])),
      sender: h.sender,
      cache: h.cache,
      concurrency: 2,
      maxEscalationShare: 0.25,
    })).records;
    expect(records.map((r) => [r.family, r.status])).toEqual([
      ['f-1', 'adjudicated'],
      ['f-3', 'escalation-budget-exhausted'],
      ['f-2', 'escalation-budget-exhausted'],
      ['f-0', 'escalation-budget-exhausted'],
    ]);
    expect(records.filter((r) => r.label === 'unknown')).toHaveLength(3);
  });

  it('retries transient failures, then leaves the pair incomplete and uncached', async () => {
    const h = harness();
    const flaky = createFakeJudge(HAIKU, reply([new JudgeCallError('overloaded', { kind: 'none' }), VERDICT.relevant]));
    const [ok] = (await judgePairs([{ subject: subject(), priority: 0 }], { judges: [flaky, createFakeJudge(LUNA, reply([VERDICT.relevant]))], adjudicator: createFakeJudge(SONNET, reply([VERDICT.relevant])), sender: h.sender, cache: h.cache, concurrency: 1 })).records;
    expect(ok).toMatchObject({ status: 'agreed', label: 2 });
    expect(flaky.calls).toHaveLength(2);
    const down = createFakeJudge(HAIKU, reply([new JudgeCallError('network', { kind: 'uncertain' })]));
    const h2 = harness();
    const [r] = (await judgePairs([{ subject: subject(), priority: 0 }], { judges: [down, createFakeJudge(LUNA, reply([VERDICT.relevant]))], adjudicator: createFakeJudge(SONNET, reply([VERDICT.relevant])), sender: h2.sender, cache: h2.cache, concurrency: 1 })).records;
    expect(r).toMatchObject({ status: 'incomplete', label: 'unknown' });
    expect(down.calls).toHaveLength(3);
    expect(h2.cache.size).toBe(1);
    expect(h2.gate.records.filter((x) => x.status === 'uncertain')).toHaveLength(3);
  });

  it('stops the run on an authentication error', async () => {
    const h = harness();
    await expect(
      judgePairs([{ subject: subject(), priority: 0 }], { judges: [createFakeJudge(HAIKU, reply([new JudgeCallError('auth', { kind: 'none' }, 401)])), createFakeJudge(LUNA, reply([VERDICT.relevant]))], adjudicator: createFakeJudge(SONNET, reply([VERDICT.relevant])), sender: h.sender, cache: h.cache, concurrency: 1 }),
    ).rejects.toBeInstanceOf(FatalJudgeError);
  });

  it('stops before a reservation above the run limit or the remaining evaluation allowance', async () => {
    for (const [h, why] of [[harness({ limit: 0.000001 }), /above its limit/], [harness({ allowance: 0.000001 }), /remains of the evaluation allowance/]] as const) {
      const a = createFakeJudge(HAIKU, reply([VERDICT.relevant]));
      const out = await judgePairs([{ subject: subject(), priority: 0 }], { judges: [a, createFakeJudge(LUNA, reply([VERDICT.relevant]))], adjudicator: createFakeJudge(SONNET, reply([VERDICT.relevant])), sender: h.sender, cache: h.cache, concurrency: 1 });
      expect(out.records).toEqual([]);
      expect(out.stopped).toMatch(why);
      expect(a.calls).toHaveLength(0);
      expect(h.gate.records).toHaveLength(0);
    }
  });

  it('keeps what a budget stop leaves: judged pairs recorded, stopped escalations unknown, outcomes cached for the next run', async () => {
    // Three pairs: the same case under three question versions (distinct cache keys).
    const make = (n: number) => Array.from({ length: n }, (_, i) => ({ subject: subject({ family: `fam-${i}`, questionVersion: `q-000000000000000${i}` }), priority: i }));
    const disagree = () => [createFakeJudge(HAIKU, () => VERDICT.relevant), createFakeJudge(LUNA, () => VERDICT.partial)] as const;
    // Room for the first pairs' judges, not for every adjudication: the stop comes in the escalations.
    const probe = harness();
    const one = (await judgePairs(make(1), { judges: disagree(), adjudicator: createFakeJudge(SONNET, () => VERDICT.relevant), sender: probe.sender, cache: new JudgmentCache(null), concurrency: 1, maxEscalationShare: 1 })).records[0] as PairRecord;
    const judgesUsd = one.attempts.filter((x) => x.role !== 'adjudicator').reduce((n, x) => n + x.reservedUsd, 0);
    const h = harness({ limit: judgesUsd * 3.2 });
    const cache = new JudgmentCache(null);
    const out = await judgePairs(make(3), { judges: disagree(), adjudicator: createFakeJudge(SONNET, () => VERDICT.relevant), sender: h.sender, cache, concurrency: 1, maxEscalationShare: 1 });
    expect(out.stopped).toMatch(/above its limit/);
    expect(out.records).toHaveLength(3);
    expect(out.records.every((r) => r.status === 'escalation-budget-exhausted' && r.label === 'unknown')).toBe(true);
    // The next run reuses every judge outcome and pays only for what is left.
    const next = disagree();
    const again = await judgePairs(make(3), { judges: next, adjudicator: createFakeJudge(SONNET, () => VERDICT.relevant), sender: harness().sender, cache, concurrency: 1, maxEscalationShare: 1 });
    expect(next[0].calls.length + next[1].calls.length).toBe(0);
    expect(again).toMatchObject({ stopped: null });
    expect(again.records.map((r) => r.status)).toEqual(['adjudicated', 'adjudicated', 'adjudicated']);
  });

  it('reuses cached outcomes, and re-judges when the rubric version changes', async () => {
    const cache = new JudgmentCache(null);
    const make = () => [createFakeJudge(HAIKU, reply([VERDICT.relevant])), createFakeJudge(LUNA, reply([VERDICT.partial]))] as const;
    const adj = createFakeJudge(SONNET, reply([VERDICT.relevant, VERDICT.relevant]));
    const first = make();
    await judgePairs([{ subject: subject(), priority: 0 }], { judges: first, adjudicator: adj, sender: harness().sender, cache, concurrency: 1, maxEscalationShare: 1 });
    const second = make();
    const adj2 = createFakeJudge(SONNET, reply([VERDICT.relevant, VERDICT.relevant]));
    const [r] = (await judgePairs([{ subject: subject(), priority: 0 }], { judges: second, adjudicator: adj2, sender: harness().sender, cache, concurrency: 1, maxEscalationShare: 1 })).records;
    expect(second[0].calls.length + second[1].calls.length + adj2.calls.length).toBe(0);
    expect(r).toMatchObject({ status: 'adjudicated', label: 2 });
    expect(r?.judges.every((j) => j.cached)).toBe(true);
    expect(r?.adjudication?.cached).toBe(true);
    const third = make();
    await judgePairs([{ subject: subject({ rubricVersion: 'r-0000000000000000' }), priority: 0 }], { judges: third, adjudicator: createFakeJudge(SONNET, reply([VERDICT.relevant, VERDICT.relevant])), sender: harness().sender, cache, concurrency: 1, maxEscalationShare: 1 });
    expect(third[0].calls).toHaveLength(1);
  });
});

describe('the paid judging step', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'narrative-judging-'));
  const items = (): PairPlanItem[] => [{ subject: subject(), priority: 0 }];
  const fakes = () => ({ judges: [createFakeJudge(HAIKU, reply([VERDICT.relevant])), createFakeJudge(LUNA, reply([VERDICT.relevant]))] as const, adjudicator: createFakeJudge(SONNET, reply([VERDICT.relevant])) });
  const opts = (outDir: string, over: Partial<Parameters<typeof runJudging>[1]> = {}): Parameters<typeof runJudging>[1] => ({
    set: 'calibration' as const,
    confirm: false,
    limitUsd: 1,
    allocation: { name: 'track-n-test', capUsd: 1 },
    maxEscalationShare: 1,
    concurrency: 1,
    outDir,
    reference: 'model-judged',
    schedule: scheduleInfo(items(), null),
    log: () => undefined,
    ...over,
  });

  it('creates no client and no ledger connection without --confirm-cost', async () => {
    const touched: string[] = [];
    const code = await runJudging(items(), opts(tmp()), {
      callers: () => {
        touched.push('callers');
        return fakes();
      },
      ledger: () => {
        touched.push('ledger');
        return { gate: createMemorySpendGate(20), close: async () => undefined };
      },
    });
    expect(code).toBe(0);
    expect(touched).toEqual([]);
  });

  it('judges with per-attempt reservations, logs the spend and writes the records', async () => {
    const dir = tmp();
    const gate = createMemorySpendGate(20);
    const code = await runJudging(items(), opts(dir, { confirm: true }), { callers: fakes, ledger: () => ({ gate, close: async () => undefined }) });
    expect(code).toBe(0);
    const file = readdirSync(dir).find((f) => f.startsWith('narrative-judgments-calibration-')) as string;
    const body = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { records: { status: string }[]; stopped: string | null; reference: string };
    expect(body).toMatchObject({ stopped: null, reference: 'model-judged' });
    expect(body.records.map((r) => r.status)).toEqual(['agreed']);
    expect(gate.records).toHaveLength(2);
    // The run's own spend log, and the allocation log (its header and the two attempts).
    const runLogs = readdirSync(join(dir, 'spend'));
    expect(runLogs).toHaveLength(1);
    expect(readFileSync(join(dir, 'spend', runLogs[0] as string), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(readFileSync(join(dir, 'allocations', 'track-n-test.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('refuses a paid run without an allocation, and an allocation whose cap would change', async () => {
    const dir = tmp();
    const deps = { callers: fakes, ledger: () => ({ gate: createMemorySpendGate(20), close: async () => undefined }) };
    await expect(runJudging(items(), opts(dir, { confirm: true, allocation: null }), deps)).rejects.toThrow(/--allocation is required/);
    await expect(runJudging(items(), opts(dir, { confirm: true, allocation: { name: 'track-n-test' } }), deps)).rejects.toThrow(/give its cap/);
    expect(await runJudging(items(), opts(dir, { confirm: true }), deps)).toBe(0);
    await expect(runJudging(items(), opts(dir, { confirm: true, allocation: { name: 'track-n-test', capUsd: 2 } }), deps)).rejects.toThrow(/cannot be changed/);
    // An existing allocation is reused without restating its cap.
    expect(await runJudging(items(), opts(dir, { confirm: true, allocation: { name: 'track-n-test' } }), deps)).toBe(0);
  });

  it("limits each run by its own spend and every run by its allocation's cap, never by earlier runs' logs", async () => {
    const dir = tmp();
    const deps = () => ({ callers: () => ({ judges: [createFakeJudge(HAIKU, () => VERDICT.relevant), createFakeJudge(LUNA, () => VERDICT.relevant)] as const, adjudicator: createFakeJudge(SONNET, () => VERDICT.relevant) }), ledger: () => ({ gate: createMemorySpendGate(20), close: async () => undefined }) });
    const pairs = (tag: string) => [0, 1].map((i) => ({ subject: subject({ family: `${tag}-${i}`, questionVersion: `q-00000000000000${tag}${i}` }), priority: i }));
    // A first run spends; a second run with a limit far below the first run's spend still runs.
    expect(await runJudging(pairs('a'), opts(dir, { confirm: true, allocation: { name: 'month', capUsd: 1 } }), deps())).toBe(0);
    const entries = readdirSync(join(dir, 'spend')).map((f) => readFileSync(join(dir, 'spend', f), 'utf8')).join('').trim().split('\n').map((l) => JSON.parse(l) as { chargedUsd: number; reservedUsd: number });
    const spentFirst = entries.reduce((n, e) => n + e.chargedUsd, 0);
    const reservedPerPair = (entries[0]?.reservedUsd ?? 0) + (entries[1]?.reservedUsd ?? 0);
    // Room for this run's own two pairs, but less than the first run's spend plus one pair: a summed log would refuse it.
    const limit = 2 * reservedPerPair;
    expect(limit).toBeLessThan(spentFirst + 2 * reservedPerPair);
    expect(await runJudging(pairs('b'), opts(dir, { confirm: true, limitUsd: limit, allocation: { name: 'month' } }), deps())).toBe(0);
    // A new allocation with a cap below one attempt stops at once; the old one is untouched.
    expect(await runJudging(pairs('c'), opts(dir, { confirm: true, allocation: { name: 'next-month', capUsd: 0.000001 } }), deps())).toBe(1);
    const stoppedFile = readdirSync(dir).filter((f) => f.startsWith('narrative-judgments-')).sort().at(-1) as string;
    expect((JSON.parse(readFileSync(join(dir, stoppedFile), 'utf8')) as { stopped: string }).stopped).toMatch(/allocation next-month/);
  });

  it('lets one run at a time spend from an allocation, and never removes an existing lock by itself (review N12, fix round 3)', async () => {
    const dir = tmp();
    const deps = { callers: fakes, ledger: () => ({ gate: createMemorySpendGate(20), close: async () => undefined }) };
    expect(await runJudging(items(), opts(dir, { confirm: true }), deps)).toBe(0);
    const lock = join(dir, 'allocations', 'track-n-test.lock');
    expect(existsSync(lock)).toBe(false);
    const held = lockAllocation(openAllocation(dir, 'track-n-test', undefined), 'other-run');
    await expect(runJudging(items(), opts(dir, { confirm: true }), deps)).rejects.toThrow(/held by run other-run/);
    held.release();
    expect(existsSync(lock)).toBe(false);
    // A stale lock (its process no longer runs on this host) is refused like any other: only `recover` removes it.
    const stale = JSON.stringify({ run: 'crashed', pid: 999_999_999, host: hostname(), at: '2026-10-01T00:00:00.000Z' });
    writeFileSync(lock, stale);
    await expect(runJudging(items(), opts(dir, { confirm: true }), deps)).rejects.toThrow(/held by run crashed.*recover --allocation track-n-test --run crashed/);
    expect(readFileSync(lock, 'utf8')).toBe(stale);
  });

  it('never lets two processes recovering the same stale lock both acquire the allocation (the gate\'s fix-round-2 item 1)', () => {
    const dir = tmp();
    const a = openAllocation(dir, 'race', 1);
    const lock = join(dir, 'allocations', 'race.lock');
    const stale = JSON.stringify({ run: 'crashed', pid: 999_999_999, host: hostname(), at: '2026-10-01T00:00:00.000Z' });
    writeFileSync(lock, stale);
    // The gate's interleaving: both competitors read the same stale holder, then both try to take the allocation.
    const first = (() => {
      try {
        return lockAllocation(a, 'first');
      } catch (err) {
        return err as Error;
      }
    })();
    const second = (() => {
      try {
        return lockAllocation(a, 'second');
      } catch (err) {
        return err as Error;
      }
    })();
    expect(first).toBeInstanceOf(Error);
    expect(second).toBeInstanceOf(Error);
    expect(readFileSync(lock, 'utf8')).toBe(stale);
  });

  describe('recovering an interrupted run', () => {
    const NOW = new Date('2026-10-24T12:00:00.000Z');
    const reservation = (id: string, status: string, reservedUsd: number, chargedUsd: number | null, uncertain: boolean | null, leaseMs: number): RunReservation => ({
      id,
      requestId: `crashed-relevance-judge-${id}`,
      status,
      reservedUsd,
      chargedUsd,
      uncertain,
      leaseExpiresAt: new Date(NOW.getTime() + leaseMs),
    });
    // A settled attempt the log holds, an uncertain one, one the ledger expired and one still open past its lease.
    const LEDGER = [
      reservation('1', 'settled', 0.02, 0.01, false, -60_000),
      reservation('2', 'settled', 0.03, 0.03, true, -60_000),
      reservation('3', 'expired_charged', 0.04, 0.04, true, -60_000),
      reservation('4', 'open', 0.05, null, null, -1_000),
    ];
    const ledgerOf = (rows: RunReservation[]): RecoveryLedger => ({ runReservations: async () => rows });
    const setup = () => {
      const dir = tmp();
      const a = openAllocation(dir, 'month', 1);
      appendFileSync(a.log, `${JSON.stringify({ at: 'x', run: 'crashed', purpose: 'relevance', provider: 'anthropic', model: 'm', reservedUsd: 0.02, chargedUsd: 0.01 })}\n`);
      appendFileSync(a.log, `${JSON.stringify({ at: 'x', run: 'earlier', purpose: 'relevance', provider: 'anthropic', model: 'm', reservedUsd: 0.5, chargedUsd: 0.2 })}\n`);
      const lock = join(dir, 'allocations', 'month.lock');
      writeFileSync(lock, JSON.stringify({ run: 'crashed', pid: 999_999_999, host: hostname(), at: '2026-10-24T11:00:00.000Z' }));
      return { dir, a, lock };
    };

    it('reconciles the ledger reservations and allocation charges before it removes the lock, and only with --confirm', async () => {
      const { dir, a, lock } = setup();
      const before = readFileSync(a.log, 'utf8');
      const report = await recoverAllocation(a, 'crashed', ledgerOf(LEDGER), { confirm: false, now: NOW });
      expect(report.ledger).toMatchObject({ reservations: 4, settled: { count: 1 }, chargedInFull: { count: 2 }, openPastLease: { count: 1 } });
      expect(report.ledger.chargedUsd).toBeCloseTo(0.01 + 0.03 + 0.04 + 0.05, 9);
      expect(report.loggedUsd).toBeCloseTo(0.01, 9);
      expect(report.appendedUsd).toBeCloseTo(0.12, 9);
      expect(report.recovered).toBe(false);
      // Without --confirm nothing changes.
      expect(readFileSync(a.log, 'utf8')).toBe(before);
      expect(existsSync(lock)).toBe(true);
      const spendLog = join(dir, 'spend', 'crashed.jsonl');
      const done = await recoverAllocation(a, 'crashed', ledgerOf(LEDGER), { confirm: true, now: NOW, spendLog });
      expect(done.recovered).toBe(true);
      expect(existsSync(lock)).toBe(false);
      expect(existsSync(join(dir, 'allocations', 'month.recovering'))).toBe(false);
      // The allocation now counts every ledger charge of the run, and the earlier run's spend is untouched.
      expect(loggedRunUsd(a.log, 'crashed')).toBeCloseTo(0.13, 9);
      expect(loggedSpendUsd(a.log)).toBeCloseTo(0.33, 9);
      // The run's spend log is reconciled to the ledger on its own (it held none of the run's charges here).
      expect(done.spendLog).toEqual({ loggedUsd: 0, appendedUsd: expect.closeTo(0.13, 9) as unknown as number });
      expect(loggedRunUsd(spendLog, 'crashed')).toBeCloseTo(0.13, 9);
      await expect(recoverAllocation(a, 'crashed', ledgerOf(LEDGER), { confirm: true, now: NOW })).rejects.toThrow(/not locked/);
    });

    it('lets one of two competing recoveries proceed, and then one of two competing runs acquire', async () => {
      const { a, lock } = setup();
      let release: () => void = () => undefined;
      const slow: RecoveryLedger = { runReservations: () => new Promise((r) => (release = () => r(LEDGER))) };
      const one = recoverAllocation(a, 'crashed', slow, { confirm: true, now: NOW });
      const two = recoverAllocation(a, 'crashed', slow, { confirm: true, now: NOW });
      await expect(two).rejects.toThrow(/another recovery of allocation month/);
      // The second recovery left the lock and the first recovery's claim alone.
      expect(existsSync(lock)).toBe(true);
      release();
      expect((await one).recovered).toBe(true);
      expect(loggedRunUsd(a.log, 'crashed')).toBeCloseTo(0.13, 9);
      // The lock is free again: of two competing runs, one acquires it and the other is refused.
      const first = lockAllocation(a, 'next-1');
      expect(() => lockAllocation(a, 'next-2')).toThrow(/held by run next-1/);
      first.release();
    });

    it('refuses another run, a holder still running, a reservation still within its lease, and changes nothing', async () => {
      const { a, lock } = setup();
      const before = readFileSync(a.log, 'utf8');
      await expect(recoverAllocation(a, 'other', ledgerOf(LEDGER), { confirm: true, now: NOW })).rejects.toThrow(/held by run crashed, not other/);
      const live = [...LEDGER, reservation('5', 'open', 0.05, null, null, 60_000)];
      await expect(recoverAllocation(a, 'crashed', ledgerOf(live), { confirm: true, now: NOW })).rejects.toThrow(/still open, the last until 2026-10-24T12:01:00.000Z/);
      writeFileSync(lock, JSON.stringify({ run: 'crashed', pid: process.pid, host: hostname(), at: '2026-10-24T11:00:00.000Z' }));
      await expect(recoverAllocation(a, 'crashed', ledgerOf(LEDGER), { confirm: true, now: NOW })).rejects.toThrow(/still running/);
      expect(readFileSync(a.log, 'utf8')).toBe(before);
      expect(existsSync(lock)).toBe(true);
      expect(existsSync(join(dirname(a.log), 'month.recovering'))).toBe(false);
    });
  });

  it('stops before the run limit and keeps what it has', async () => {
    const dir = tmp();
    const code = await runJudging(items(), opts(dir, { confirm: true, limitUsd: 0.000001 }), { callers: fakes, ledger: () => ({ gate: createMemorySpendGate(20), close: async () => undefined }) });
    expect(code).toBe(1);
    const file = readdirSync(dir).find((f) => f.startsWith('narrative-judgments-')) as string;
    expect((JSON.parse(readFileSync(join(dir, file), 'utf8')) as { stopped: string }).stopped).toMatch(/above its limit/);
  });
});

describe('the frozen schedule', () => {
  it('judges pairs in priority order, so a stopped run has judged the lowest priorities', async () => {
    const priorities = [50_001, 10_000, 2, 40_000, 10_001, 1];
    const items: PairPlanItem[] = priorities.map((priority, i) => ({ subject: subject({ family: `fam-${String.fromCharCode(97 + i)}`, questionVersion: `q-00000000000000${String(i).padStart(2, '0')}` }), priority }));
    const probe = harness();
    const one = (await judgePairs(items.slice(0, 1), { judges: [createFakeJudge(HAIKU, () => VERDICT.relevant), createFakeJudge(LUNA, () => VERDICT.relevant)], adjudicator: createFakeJudge(SONNET, () => VERDICT.relevant), sender: probe.sender, cache: new JudgmentCache(null), concurrency: 1 })).records[0] as PairRecord;
    const charge = one.attempts.reduce((n, x) => n + x.chargedUsd, 0);
    const reserve = one.attempts.reduce((n, x) => n + x.reservedUsd, 0);
    // The third pair's reservations fit after two charged pairs, the fourth's do not after three.
    const h = harness({ limit: 2.5 * charge + reserve });
    const out = await judgePairs(items, { judges: [createFakeJudge(HAIKU, () => VERDICT.relevant), createFakeJudge(LUNA, () => VERDICT.relevant)], adjudicator: createFakeJudge(SONNET, () => VERDICT.relevant), sender: h.sender, cache: new JudgmentCache(null), concurrency: 1 });
    expect(out.stopped).not.toBeNull();
    const judged = new Set(out.records.map((r) => r.family));
    // The three lowest priorities (1, 2, 10,000) are judged; 10,001, 40,000 and 50,001 wait.
    expect([...judged].sort()).toEqual(['fam-b', 'fam-c', 'fam-f']);
  });

  it('gives every pool case its tier: delivered, first 20, bounded cohort, other method or related, lure or tail', () => {
    const base = { ntsbNo: 'X', sources: ['method' as const], lureRank: null, delivered: false };
    expect(tierOf(casePriority({ ...base, bestRank: { a: 3 }, delivered: true }, 'broad'))).toBe(0);
    expect(tierOf(casePriority({ ...base, bestRank: { a: 15 } }, 'broad'))).toBe(1);
    expect(tierOf(casePriority({ ...base, bestRank: { a: 60 } }, 'bounded-cohort'))).toBe(2);
    expect(tierOf(casePriority({ ...base, sources: ['cohort'], bestRank: { a: null } }, 'bounded-cohort'))).toBe(2);
    expect(tierOf(casePriority({ ...base, bestRank: { a: 60 } }, 'broad'))).toBe(3);
    expect(tierOf(casePriority({ ...base, sources: ['related'], bestRank: { a: null } }, 'broad'))).toBe(3);
    expect(tierOf(casePriority({ ...base, sources: ['hard-negative'], bestRank: { a: null }, lureRank: 4 }, 'broad'))).toBe(4);
    expect(SCHEDULE.stages[1]).toBe(2);
    expect(scheduleInfo([{ subject: subject(), priority: 3 }, { subject: subject({ family: 'g' }), priority: 20_005 }], 1)).toEqual({ version: SCHEDULE.version, stage: 1, tiers: { '0': 1, '2': 1 } });
  });
});

describe('adjudication across a budget stop', () => {
  it('keeps a paid blind grade: a stop before the decision leaves it cached, and the next run buys only the decision', async () => {
    const cache = new JudgmentCache(null);
    const judges = () => [createFakeJudge(HAIKU, () => VERDICT.relevant), createFakeJudge(LUNA, () => VERDICT.partial)] as const;
    // Budget: the two judges and the blind step fit, the decision does not.
    const probe = harness();
    const full = (await judgePairs([{ subject: subject(), priority: 0 }], { judges: judges(), adjudicator: createFakeJudge(SONNET, () => VERDICT.relevant), sender: probe.sender, cache: new JudgmentCache(null), concurrency: 1, maxEscalationShare: 1 })).records[0] as PairRecord;
    const chargedBeforeDecision = full.attempts.slice(0, 3).reduce((n, x) => n + x.chargedUsd, 0);
    const decisionReserve = full.attempts[3]?.reservedUsd as number;
    const h = harness({ limit: chargedBeforeDecision + decisionReserve - 1e-9 });
    const adj1 = createFakeJudge(SONNET, () => VERDICT.relevant);
    const out = await judgePairs([{ subject: subject(), priority: 0 }], { judges: judges(), adjudicator: adj1, sender: h.sender, cache, concurrency: 1, maxEscalationShare: 1 });
    expect(out.stopped).not.toBeNull();
    expect(adj1.calls).toHaveLength(1);
    expect(out.records[0]).toMatchObject({ status: 'escalation-budget-exhausted', label: 'unknown' });
    expect(h.gate.records.some((r) => r.purpose.includes('adjudicate-initial-adjudicator'))).toBe(true);
    const adj2 = createFakeJudge(SONNET, () => VERDICT.relevant);
    const again = await judgePairs([{ subject: subject(), priority: 0 }], { judges: judges(), adjudicator: adj2, sender: harness().sender, cache, concurrency: 1, maxEscalationShare: 1 });
    expect(adj2.calls).toHaveLength(1);
    expect(adj2.calls[0]?.blocks.map((b) => b.text).join('\n')).toContain('<initial>');
    expect(again.records[0]).toMatchObject({ status: 'adjudicated', label: 2 });
  });
});

describe('the attempt sender', () => {
  it('keeps a paid output when the ledger cannot settle it, and stops the run before the next attempt', async () => {
    const base = createMemorySpendGate(20);
    const gate = { ...base, settle: async () => Promise.reject(new Error('connection reset')) };
    const sender = new AttemptSender({ gate, limitUsd: 5, spendLog: null, allocation: null, run: 't' }, 5_000, async () => undefined);
    const judge = createFakeJudge(HAIKU, () => VERDICT.relevant);
    const req = relevanceRequest(q, evidence());
    await expect(sender.send(judge, req)).resolves.toMatchObject({ record: { status: 'ok' } });
    expect(sender.spentUsd).toBeGreaterThan(0);
    await expect(sender.send(judge, req)).rejects.toBeInstanceOf(FatalJudgeError);
    expect(judge.calls).toHaveLength(1);
  });

  it('counts reservations in flight against the run limit, so concurrent attempts cannot overshoot it', async () => {
    const gate = createMemorySpendGate(20);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const slow = createFakeJudge(HAIKU, () => VERDICT.relevant);
    const caller = { ...slow, call: async (req: JudgeRequest, t: number) => {
      await held;
      return slow.call(req, t);
    } };
    const req = relevanceRequest(q, evidence());
    const one = attemptReserveUsd(HAIKU, await caller.inputTokens(req, 5_000));
    const sender = new AttemptSender({ gate, limitUsd: one * 1.5, spendLog: null, allocation: null, run: 't' }, 5_000, async () => undefined);
    // Both start in the same turn: the second must see the first's open reservation.
    const first = sender.send(caller, req);
    const second = sender.send(caller, req);
    await expect(second).rejects.toBeInstanceOf(BudgetStop);
    release();
    await first;
    expect(gate.records).toHaveLength(1);
    // Settled, the first's charge (below its reservation) leaves room under the limit again.
    expect(sender.spentUsd).toBeLessThanOrEqual(one);
    await expect(sender.send(caller, req)).resolves.toMatchObject({ record: { status: 'ok' } });
  });
});

// ---------------------------------------------------------------------------
// Round 5: a run keeps its allocation's lock until every charge is in the allocation's log

/** The run's reservations on a memory ledger as `recover` reads them (an open one is past its lease). */
const ledgerFromGate = (gate: MemorySpendGate): RecoveryLedger => ({
  runReservations: async (run) =>
    gate.records
      .filter((r) => r.purpose === run || r.purpose.startsWith(`${run}-`))
      .map((r, i) => ({
        id: String(i),
        requestId: r.purpose,
        status: r.status === 'open' ? 'open' : 'settled',
        reservedUsd: r.reservedUsd,
        chargedUsd: r.status === 'open' ? null : r.chargedUsd,
        uncertain: r.status === 'open' ? null : r.status === 'uncertain',
        leaseExpiresAt: new Date(0),
      })),
});
/** What the ledger charges a run: settled costs, uncertain and open reservations in full. */
const ledgerTotal = (gate: MemorySpendGate, run: string) => gate.records.filter((r) => r.purpose === run || r.purpose.startsWith(`${run}-`)).reduce((n, r) => n + r.chargedUsd, 0);
/** The files, except that the `nth` write to a matching log fails, as a full disk does. */
const failingWriter = (match: (path: string) => boolean, nth = 1): ChargeWriter => {
  let seen = 0;
  return {
    append(path, line) {
      if (match(path)) {
        seen += 1;
        if (seen === nth) throw new Error('ENOSPC: no space left on device, write');
      }
      FILE_WRITER.append(path, line);
    },
  };
};
const lockOf = (dir: string, name: string) => join(dir, 'allocations', `${name}.lock`);
const heldBy = (dir: string, name: string) => (JSON.parse(readFileSync(lockOf(dir, name), 'utf8')) as { run: string }).run;
/** The run's process has ended (the CLI exits after the error): its lock now names a process that no longer runs. */
const ended = (dir: string, name: string): string => {
  const holder = JSON.parse(readFileSync(lockOf(dir, name), 'utf8')) as { run: string };
  writeFileSync(lockOf(dir, name), JSON.stringify({ ...holder, pid: 999_999_999 }));
  return holder.run;
};

describe('the run books (round 5)', () => {
  it('balance only when every paid operation is recorded and nothing failed', () => {
    const b = new RunBooks();
    expect(b.balanced).toBe(true);
    b.begin();
    b.begin();
    expect(b).toMatchObject({ balanced: false, open: 2, failure: null });
    b.recorded();
    b.cancelled();
    expect(b.balanced).toBe(true);
    expect(() => b.recorded()).toThrow(/no paid operation is open/);
    b.begin();
    b.fail('the ledger connection did not close');
    expect(b.describe()).toBe("1 paid operation(s) without a charge in the allocation's log; the ledger connection did not close");
    b.recorded();
    expect(b).toMatchObject({ balanced: false, open: 0, failure: 'the ledger connection did not close' });
  });

  it('release the lock when they balance, error or not; otherwise keep it and name the recovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'narrative-books-'));
    const a = openAllocation(dir, 'books', 1);
    expect(await holdingAllocation(a, 'run-ok', async () => 7)).toBe(7);
    expect(existsSync(lockOf(dir, 'books'))).toBe(false);
    // A failure that paid nothing: the original error, and the lock released.
    await expect(holdingAllocation(a, 'run-refused', async () => Promise.reject(new BudgetStop('over the limit')))).rejects.toBeInstanceOf(BudgetStop);
    expect(existsSync(lockOf(dir, 'books'))).toBe(false);
    // A paid operation never recorded: the lock stays, and the error says how to recover.
    const open = await failure(holdingAllocation(a, 'run-open', async (books) => books.begin()));
    expect(open).toBeInstanceOf(UnrecordedSpendError);
    expect((open as Error).message).toMatch(/allocation books keeps its lock: 1 paid operation\(s\) without a charge in the allocation's log.*recover --allocation books --run run-open --confirm/);
    expect(heldBy(dir, 'books')).toBe('run-open');
    writeFileSync(lockOf(dir, 'books'), JSON.stringify({ run: 'gone', pid: 999_999_999, host: hostname(), at: 'x' }));
    await recoverAllocation(a, 'gone', { runReservations: async () => [] }, { confirm: true });
    // The CLI prints the whole message, the recovery command included (a wrapped error's cause would replace it).
    expect(describeWorkerError(open)).toMatch(/keeps its lock.*recover --allocation books --run run-open --confirm/);
    const timeout = await failure(holdingAllocation(a, 'run-timeout', async (books) => {
      books.begin();
      throw new Error('timeout exceeded when trying to connect');
    }));
    expect(describeWorkerError(timeout)).toMatch(/^timeout exceeded when trying to connect; allocation books keeps its lock: 1 paid operation\(s\) without a charge.*recover --allocation books --run run-timeout --confirm/);
    writeFileSync(lockOf(dir, 'books'), JSON.stringify({ run: 'gone', pid: 999_999_999, host: hostname(), at: 'x' }));
    await recoverAllocation(a, 'gone', { runReservations: async () => [] }, { confirm: true });
    // A cleanup that fails (the ledger connection) keeps the lock even when the body succeeded.
    const close = await failure(holdingAllocation(a, 'run-close', async () => 1, { cleanup: async () => Promise.reject(new Error('connection reset')) }));
    expect((close as Error).message).toMatch(/^allocation books keeps its lock: the run's ledger connection did not close: connection reset/);
    expect(heldBy(dir, 'books')).toBe('run-close');
  });
});

describe('accounting failures keep the lock until recover reconciles, never counting twice (round 5)', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'narrative-accounting-'));

  // ---- Pools: the scope calls, then the embedding calls.
  const ITEMS = [{ id: 'q-one', question: 'Which accidents involved a loss of engine power?' }];
  const scopeCaller = () =>
    providerScopeCaller(createFakeProvider({ scope: { output: { intent: 'case_search', mechanicalCause: false, filters: {}, keywordText: 'engine power loss' }, usage: { inputTokens: 1_500, outputTokens: 80 } } }));
  const embedOn = (gate: SpendGate, run: string, after?: () => void) => async () => {
    const r = await gate.reserve({ category: 'evaluation', usd: 0.0002, purpose: run });
    await gate.settle(r, { usd: 0.00003 });
    after?.();
    return { vectors: new Map([['input', Float32Array.from([1, 0])]]), usd: 0.00003, requests: 1 };
  };
  const pay = (dir: string, gate: MemorySpendGate, run: string, over: { writer?: ChargeWriter; close?: () => Promise<void>; embedAfter?: () => void } = {}) => {
    const a = openAllocation(dir, 'pools', 1);
    const spendLog = join(dir, 'spend', `${run}.jsonl`);
    const result = holdingAllocation(a, run, (books) =>
      payForPoolInputs({
        allocation: a,
        run,
        spendLog,
        books,
        ...(over.writer ? { writer: over.writer } : {}),
        scope: { model: 'claude-haiku-5-5', take: () => runScopeSamples(scopeCaller(), gate, ITEMS, { samples: 1, retries: 0, maxUsd: 1, purpose: run }), close: over.close ?? (async () => undefined) },
        embed: { model: 'text-embedding-3-small', reserveUsd: 0.0002, take: embedOn(gate, run, over.embedAfter) },
      }),
    );
    return { a, spendLog, result };
  };
  /** Recover the run, then check each log holds exactly the ledger's charges and the allocation is free again. */
  const recoverAndCheck = async (dir: string, gate: MemorySpendGate, run: string, a: ReturnType<typeof openAllocation>, spendLog: string) => {
    expect(ended(dir, a.name)).toBe(run);
    const before = loggedRunUsd(a.log, run);
    const r = await recoverAllocation(a, run, ledgerFromGate(gate), { confirm: true, spendLog });
    const total = ledgerTotal(gate, run);
    expect(r.appendedUsd).toBeCloseTo(total - before, 9);
    expect(loggedRunUsd(a.log, run)).toBeCloseTo(total, 9);
    expect(loggedRunUsd(spendLog, run)).toBeCloseTo(total, 9);
    expect(existsSync(lockOf(dir, a.name))).toBe(false);
    await expect(recoverAllocation(a, run, ledgerFromGate(gate), { confirm: true, spendLog })).rejects.toThrow(/not locked/);
    return { r, before, total };
  };

  it('pools: a scope ledger connection that fails to close after the scope calls keeps the lock and pays nothing more', async () => {
    const dir = tmp();
    const gate = createMemorySpendGate(20);
    const run = 'eval-10c2-pools-close';
    const { a, spendLog, result } = pay(dir, gate, run, { close: async () => Promise.reject(new Error('connection reset while closing')) });
    const err = await failure(result);
    expect(err).toBeInstanceOf(UnrecordedSpendError);
    expect((err as Error).message).toMatch(/connection reset while closing.*keeps its lock.*recover --allocation pools --run eval-10c2-pools-close --confirm/);
    expect(heldBy(dir, 'pools')).toBe(run);
    // The scope calls were paid and their charge written; no embedding was paid after the failure.
    expect(gate.records.map((r) => r.purpose)).toEqual([`${run}-q-one-s1-a1`]);
    const { r, before, total } = await recoverAndCheck(dir, gate, run, a, spendLog);
    // Only the ledger's rounding to the micro-dollar is added: the logged scope charge is not counted twice.
    expect(before).toBeGreaterThan(0);
    expect(r.appendedUsd).toBeLessThan(1e-6);
    expect(total).toBeCloseTo(before, 5);
  });

  it('pools: a scope charge that cannot be written to the allocation\'s log keeps the lock; recover adds it once', async () => {
    const dir = tmp();
    const gate = createMemorySpendGate(20);
    const run = 'eval-10c2-pools-scope-write';
    const { a, spendLog, result } = pay(dir, gate, run, { writer: failingWriter((p) => p.endsWith(join('allocations', 'pools.jsonl'))) });
    const err = await failure(result);
    expect((err as Error).message).toMatch(/ENOSPC.*keeps its lock: 1 paid operation\(s\) without a charge in the allocation's log; a charge could not be written to the allocation's log/);
    expect(gate.records).toHaveLength(1);
    const { r, before, total } = await recoverAndCheck(dir, gate, run, a, spendLog);
    expect(before).toBe(0);
    expect(r.appendedUsd).toBeCloseTo(total, 9);
  });

  it('pools: an embedding charge that cannot be written keeps the lock; recover adds the embedding only, the logged scope charge once', async () => {
    const dir = tmp();
    const gate = createMemorySpendGate(20);
    const run = 'eval-10c2-pools-embed-write';
    const { a, spendLog, result } = pay(dir, gate, run, { writer: failingWriter((p) => p.endsWith(join('allocations', 'pools.jsonl')), 2) });
    const err = await failure(result);
    expect(err).toBeInstanceOf(UnrecordedSpendError);
    const scopeLogged = loggedRunUsd(a.log, run);
    expect(scopeLogged).toBeGreaterThan(0);
    const { r } = await recoverAndCheck(dir, gate, run, a, spendLog);
    // The embedding's ledger charge (and the scope's rounding to the micro-dollar), never the scope charge again.
    expect(r.appendedUsd).toBeCloseTo(0.00003, 5);
    expect(r.appendedUsd).toBeLessThan(scopeLogged);
  });

  it('pools: an embedding step that paid and then failed (its own connection) keeps the lock; recover adds its charge', async () => {
    const dir = tmp();
    const gate = createMemorySpendGate(20);
    const run = 'eval-10c2-pools-embed-close';
    const { a, spendLog, result } = pay(dir, gate, run, {
      embedAfter: () => {
        throw new Error('the embedding ledger connection did not close');
      },
    });
    const err = await failure(result);
    expect((err as Error).message).toMatch(/did not close.*1 paid operation\(s\) without a charge/);
    const { r } = await recoverAndCheck(dir, gate, run, a, spendLog);
    expect(r.appendedUsd).toBeCloseTo(0.00003, 5);
  });

  it('pools: a payment that records every charge releases the lock with each charge logged once', async () => {
    const dir = tmp();
    const gate = createMemorySpendGate(20);
    const run = 'eval-10c2-pools-ok';
    const { a, spendLog, result } = pay(dir, gate, run);
    const paid = await result;
    expect(paid.embedded).toEqual({ usd: 0.00003, requests: 1 });
    expect(existsSync(lockOf(dir, 'pools'))).toBe(false);
    expect(loggedRunUsd(a.log, run)).toBeCloseTo(paid.run.chargedUsd + 0.00003, 12);
    expect(loggedRunUsd(spendLog, run)).toBeCloseTo(loggedRunUsd(a.log, run), 12);
  });

  // ---- Judging attempts (calibration, relevance and answerability share runJudging).
  const items = (): PairPlanItem[] => [{ subject: subject(), priority: 0 }];
  const fakes = () => ({ judges: [createFakeJudge(HAIKU, reply([VERDICT.relevant])), createFakeJudge(LUNA, reply([VERDICT.relevant]))] as const, adjudicator: createFakeJudge(SONNET, reply([VERDICT.relevant])) });
  const opts = (outDir: string): Parameters<typeof runJudging>[1] => ({
    set: 'relevance' as const,
    confirm: true,
    limitUsd: 1,
    allocation: { name: 'judging', capUsd: 1 },
    maxEscalationShare: 1,
    concurrency: 1,
    outDir,
    reference: 'model-judged',
    schedule: scheduleInfo(items(), 1),
    log: () => undefined,
  });
  const judging = async (dir: string, gate: SpendGate, over: { writer?: ChargeWriter; close?: () => Promise<void> } = {}) =>
    runJudging(items(), opts(dir), { callers: fakes, ledger: () => ({ gate, close: over.close ?? (async () => undefined) }), ...(over.writer ? { writer: over.writer } : {}) });
  const runLog = (dir: string, run: string) => join(dir, 'spend', `${run}.jsonl`);

  it('judging: an attempt whose charge cannot be written to the allocation\'s log keeps the lock; recover adds exactly what is missing', async () => {
    const dir = tmp();
    const gate = createMemorySpendGate(20);
    const err = await failure(judging(dir, gate, { writer: failingWriter((p) => p.endsWith(join('allocations', 'judging.jsonl'))) }));
    expect(err).toBeInstanceOf(UnrecordedSpendError);
    expect((err as Error).message).toMatch(/ENOSPC.*allocation judging keeps its lock.*recover --allocation judging --run eval-10c2-relevance-/);
    // A later run is refused until the recovery.
    await expect(judging(dir, gate)).rejects.toThrow(/held by run eval-10c2-relevance-/);
    const run = ended(dir, 'judging');
    const a = openAllocation(dir, 'judging', undefined);
    const before = loggedRunUsd(a.log, run);
    const r = await recoverAllocation(a, run, ledgerFromGate(gate), { confirm: true, spendLog: runLog(dir, run) });
    const total = ledgerTotal(gate, run);
    // The unwritten attempt was never settled: the ledger charges its reservation in full, and the allocation now counts it once.
    expect(gate.records.some((x) => x.purpose.startsWith(run) && x.status === 'open')).toBe(true);
    expect(r.appendedUsd).toBeCloseTo(total - before, 9);
    expect(loggedRunUsd(a.log, run)).toBeCloseTo(total, 9);
    expect(loggedRunUsd(runLog(dir, run), run)).toBeCloseTo(total, 9);
    expect(existsSync(lockOf(dir, 'judging'))).toBe(false);
    await expect(recoverAllocation(a, run, ledgerFromGate(gate), { confirm: true })).rejects.toThrow(/not locked/);
    // The allocation is free again, and its count already includes the recovered run.
    expect(await judging(dir, createMemorySpendGate(20))).toBe(0);
  });

  it('judging: a spend-log write that fails after the allocation\'s keeps the lock; recover tops the allocation up to the ledger and fills the spend log, nothing twice', async () => {
    const dir = tmp();
    const gate = createMemorySpendGate(20);
    const err = await failure(judging(dir, gate, { writer: failingWriter((p) => p.includes(`${join('spend', 'eval-10c2-relevance-')}`)) }));
    expect((err as Error).message).toMatch(/ENOSPC.*keeps its lock: the run's spend log could not be written/);
    const run = ended(dir, 'judging');
    const a = openAllocation(dir, 'judging', undefined);
    const allocated = loggedRunUsd(a.log, run);
    expect(allocated).toBeGreaterThan(0);
    const r = await recoverAllocation(a, run, ledgerFromGate(gate), { confirm: true, spendLog: runLog(dir, run) });
    const total = ledgerTotal(gate, run);
    // The allocation already held the attempt's cost: only the rest of the unsettled reservation is added.
    expect(r.appendedUsd).toBeCloseTo(total - allocated, 9);
    expect(loggedRunUsd(a.log, run)).toBeCloseTo(total, 9);
    expect(loggedRunUsd(runLog(dir, run), run)).toBeCloseTo(total, 9);
  });

  it('judging: a ledger connection that fails to close keeps the lock although every charge was written; recover adds only rounding', async () => {
    const dir = tmp();
    const gate = createMemorySpendGate(20);
    const err = await failure(judging(dir, gate, { close: async () => Promise.reject(new Error('connection reset while closing')) }));
    expect((err as Error).message).toMatch(/^allocation judging keeps its lock: the run's ledger connection did not close: connection reset while closing/);
    // The run finished: its records are written.
    expect(readdirSync(dir).some((f) => f.startsWith('narrative-judgments-relevance-'))).toBe(true);
    const run = ended(dir, 'judging');
    const a = openAllocation(dir, 'judging', undefined);
    const before = loggedRunUsd(a.log, run);
    const r = await recoverAllocation(a, run, ledgerFromGate(gate), { confirm: true, spendLog: runLog(dir, run) });
    expect(r.appendedUsd).toBeLessThan(2e-6);
    expect(loggedRunUsd(a.log, run)).toBeCloseTo(ledgerTotal(gate, run), 9);
    expect(before).toBeCloseTo(ledgerTotal(gate, run), 5);
  });

  it('judging: a settlement the ledger refused keeps the lock; recover adds the rest of the reservation the ledger charges in full', async () => {
    const dir = tmp();
    const base = createMemorySpendGate(20);
    let settles = 0;
    const gate: MemorySpendGate = {
      ...base,
      records: base.records,
      settle: async (res, outcome) => {
        settles += 1;
        if (settles === 1) throw new Error('settle failed: connection reset');
        return base.settle(res, outcome);
      },
    };
    const err = await failure(judging(dir, gate));
    expect((err as Error).message).toMatch(/keeps its lock: the evaluation ledger could not settle an attempt: settle failed/);
    const run = ended(dir, 'judging');
    const a = openAllocation(dir, 'judging', undefined);
    const allocated = loggedRunUsd(a.log, run);
    const r = await recoverAllocation(a, run, ledgerFromGate(gate), { confirm: true, spendLog: runLog(dir, run) });
    const total = ledgerTotal(gate, run);
    expect(total).toBeGreaterThan(allocated);
    expect(r.appendedUsd).toBeCloseTo(total - allocated, 9);
    expect(loggedRunUsd(a.log, run)).toBeCloseTo(total, 9);
    expect(loggedRunUsd(runLog(dir, run), run)).toBeCloseTo(total, 9);
  });
});
