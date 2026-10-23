/**
 * Track N judging: the evaluation-only judge clients (the Anthropic one classifies
 * failures exactly as the production adapter does; the OpenAI one mirrors it, with
 * strict structured outputs, explicit caching, reasoning tokens and billing), and the
 * pair procedure: independent judges, one retry of an invalid output, adjudication with
 * a recorded blind first decision, abstentions and unresolved pairs as `unknown`, the
 * escalation bound, per-attempt ledger reservations, budget stops and the cache.
 * No request leaves the process.
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../../server/ai/anthropic.js';
import { StageError, stageCtx } from '../../server/ai/provider.js';
import { createMemorySpendGate } from '../../worker/index/spend-gate.js';
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
  FatalJudgeError,
  JudgmentCache,
  adjudicationOrder,
  judgePairs,
  relevanceSubject,
  type FamilyRef,
  type PairPlanItem,
  type PairRecord,
} from '../../evals/retrieval/narrative/judging.js';
import { runJudging, scheduleInfo } from '../../evals/retrieval/narrative/commands.js';
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
