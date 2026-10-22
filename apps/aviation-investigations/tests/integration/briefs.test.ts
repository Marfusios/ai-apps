/**
 * AI briefs end to end through the HTTP routes, with the fake language-model provider
 * and a fake evidence retriever (tests/support/fake-retriever.ts) over the fixture
 * corpus in aviation_test. Retrieval itself (Task 10) is not exercised here; the
 * pipeline's provenance check, validation, settlement and storage are.
 *
 * The fixture generation is published with a placeholder passages-index name (no
 * Elasticsearch is read: the routes use the manifest row and the retriever port).
 */
import { randomBytes } from 'node:crypto';
import { Client } from '@elastic/elasticsearch';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../shared/config.js';
import { TURNSTILE_ACTION } from '../../shared/contracts/ai.js';
import {
  BriefStepResponseSchema,
  CaseContextResponseSchema,
  StartBriefResponseSchema,
  type BriefStepResponse,
  type ComposeOutput,
  type StartBriefResponse,
} from '../../shared/contracts/briefs.js';
import { ErrorResponseSchema } from '../../shared/contracts/common.js';
import { createFakeProvider, type FakeProvider, type FakeResult, type FakeScript } from '../../server/ai/fake.js';
import type { ComposeInput, ScopeInput, ScopeOutput } from '../../server/ai/provider.js';
import { createAiRuntime, type AiRuntime, type AiRuntimeConfig } from '../../server/ai/runtime.js';
import { buildApp } from '../../server/app.js';
import { clarificationTemplateLabels } from '../../server/briefs/clarify.js';
import { RetrievalFailure } from '../../server/briefs/evidence.js';
import { createBriefServices, type BriefServices } from '../../server/briefs/services.js';
import { OUT_OF_SCOPE_LINES, OPERATIONAL_LINES, OPERATIONAL_TITLE } from '../../server/briefs/static-replies.js';
import { moveBriefReadOwner } from '../../server/briefs/store.js';
import { closeDb, type Db } from '../../server/db/client.js';
import { publishManifest } from '../../server/db/generations.js';
import { pruneControls, setAiSwitch } from '../../server/quota/index.js';
import { loadFixtureGeneration } from '../support/api-dataset.js';
import { FakeRetriever, type FakeRetrieverOptions } from '../support/fake-retriever.js';
import { FakeSiteverify, REAL_SECRET, REAL_SITE_KEY } from '../support/fake-siteverify.js';
import { sqlState } from './corpus-helpers.js';
import { resetControls, resetCorpus, testDb } from './helpers.js';

const IDENTITY_SECRET = 'test-identity-hmac-secret-0123456789';
const NETWORK_SECRET = 'test-network-hmac-secret-0123456789';
const HOST = 'casebook.example';
const T0 = new Date('2026-11-01T10:00:00Z');
const MIN = 60_000;
const VISITOR = '203.0.113.9';
const RUN = randomBytes(4).toString('hex');
const SEEDS = ['DFW08TA066', 'DEN08LA103', 'MIA08LA156', 'NYC08LA106'];
const GROUP: Record<string, ComposeOutput['groups'][number]['kind']> = {
  DFW08TA066: 'causal',
  NYC08LA106: 'causal',
  MIA08LA156: 'defect_not_causal',
  DEN08LA103: 'no_fault',
};

let clock = T0;
/** Milliseconds the clock moves on every read (0: frozen). */
let tick = 0;
const now = () => {
  const t = clock;
  if (tick > 0) clock = new Date(clock.getTime() + tick);
  return t;
};
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

let appDb: Db;
let ingest: Db;
let migrator: Db;
let generationId: number;
const es = new Client({ node: 'http://localhost:9' }); // never used: briefs read no index here
const harnesses: Harness[] = [];

beforeAll(async () => {
  appDb = testDb('app');
  ingest = testDb('ingest');
  migrator = testDb('migrator');
  generationId = await loadFixtureGeneration(ingest);
  await publishManifest(ingest, generationId, `aviation-test-briefs${RUN}-cases`, `aviation-test-briefs${RUN}-passages`);
});

afterAll(async () => {
  await resetCorpus();
  await Promise.all([closeDb(appDb), closeDb(ingest), closeDb(migrator), es.close()]);
});

beforeEach(async () => {
  clock = T0;
  tick = 0;
  await resetControls();
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.svc.settled();
    await h.app.close();
  }
});

// ---------------------------------------------------------------------------
// Harness

function aiConfig(over: { trialRequests?: number } = {}): AiRuntimeConfig {
  const base = loadConfig({ env: {}, files: [] });
  return {
    nodeEnv: 'test',
    appEnv: 'dev',
    appUrl: `https://${HOST}`,
    ai: { ...base.ai, llmProvider: 'fake', limits: { ...base.ai.limits, anonymousTrialRequests: over.trialRequests ?? 3 } },
    auth: { identityHmacSecret: IDENTITY_SECRET, ipHmacSecret: NETWORK_SECRET },
    turnstile: { secretKey: REAL_SECRET, siteKey: REAL_SITE_KEY },
  };
}

interface Harness {
  app: FastifyInstance;
  ai: AiRuntime;
  sv: FakeSiteverify;
  llm: FakeProvider;
  retriever: FakeRetriever;
  svc: BriefServices;
}

function harness(
  script: FakeScript,
  opts: { retriever?: Partial<FakeRetrieverOptions>; timeouts?: Partial<{ scope: number; retrieve: number; compose: number; check: number; total: number }>; trialRequests?: number } = {},
): Harness {
  const sv = new FakeSiteverify(now, { hostname: HOST, action: TURNSTILE_ACTION });
  const llm = createFakeProvider(script);
  const ai = createAiRuntime(aiConfig(opts.trialRequests === undefined ? {} : { trialRequests: opts.trialRequests }), {
    db: appDb,
    turnstile: { fetch: sv.fetch, retryDelayMs: 0, attemptTimeoutMs: 200 },
    llm,
    now,
  });
  const retriever = new FakeRetriever(appDb, { cases: SEEDS, ...opts.retriever });
  const svc = createBriefServices(appDb, { retriever, ...(opts.timeouts ? { timeouts: opts.timeouts } : {}) });
  const app = buildApp({
    config: { appUrl: `https://${HOST}`, trustedProxyCidrs: [] },
    db: appDb,
    es,
    ai,
    briefs: svc,
    rateLimit: { limit: 100_000, windowMs: 60_000 },
  });
  const h = { app, ai, sv, llm, retriever, svc };
  harnesses.push(h);
  return h;
}

// Scripts ---------------------------------------------------------------------

const scopeOut = (over: Partial<ScopeOutput> = {}): ScopeOutput => ({
  intent: 'case_search',
  mechanicalCause: true,
  filters: {},
  keywordText: 'engine power loss maintenance',
  ambiguity: { type: 'timing_window', values: ['30d_or_10h'] },
  ...over,
});

/** The first sentence of a passage: an exact substring, as the prompt asks. */
function firstSentence(text: string): string {
  const t = text.trimStart();
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(t);
  return (m ? m[0] : t).slice(0, 500);
}

/** A composition that follows every rule, built from the compose input. */
function composition(input: ComposeInput, tweak?: (c: ComposeOutput) => void): FakeResult<ComposeOutput> {
  const cases = input.cases.map((c) => {
    const p = c.passages.find((x) => x.section === 'Analysis') ?? c.passages[0]!;
    return {
      ntsbNo: c.ntsbNo,
      why: 'The engine lost power after recent maintenance.',
      quotes: [{ passageId: p.passageId, quote: firstSentence(p.text), speaker: 'investigators' as const }],
      maintenance: 'preceding_not_established' as const,
      symptom: 'total_power_loss' as const,
    };
  });
  const kinds = [...new Set(cases.map((c) => GROUP[c.ntsbNo] ?? 'insufficient'))];
  const out: ComposeOutput = {
    summary: cases.map((c) => `Power was lost after maintenance [[case:${c.ntsbNo}]].`).join(' '),
    groups: input.mechanicalCause
      ? kinds.map((kind) => ({ kind, caseNumbers: cases.filter((c) => (GROUP[c.ntsbNo] ?? 'insufficient') === kind).map((c) => c.ntsbNo) }))
      : [{ kind: 'examples', caseNumbers: cases.map((c) => c.ntsbNo) }],
    cases,
    gaps: [],
  };
  tweak?.(out);
  return { output: out };
}

const SUPPORTED = { output: { supported: true, problems: [] } };

const answering = (over: Partial<FakeScript> = {}): FakeScript => ({
  scope: { output: scopeOut() },
  compose: (input) => composition(input),
  check: SUPPORTED,
  ...over,
});

// Requests --------------------------------------------------------------------

interface Got<T> {
  status: number;
  json: T;
  setCookie: string | null;
}

const cookieOf = (setCookie: string | null): string => {
  if (!setCookie) throw new Error('no Set-Cookie');
  return setCookie.split(';', 1)[0]!;
};

let keySeq = 0;
const key = () => `brief-test-${RUN}-${++keySeq}`;

async function inject<T>(h: Harness, method: 'GET' | 'POST', url: string, opts: { body?: unknown; cookie?: string | null; from?: string } = {}): Promise<Got<T>> {
  const r = await h.app.inject({
    method,
    url,
    remoteAddress: opts.from ?? VISITOR,
    headers: opts.cookie ? { cookie: opts.cookie } : {},
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  });
  expect(r.headers['cache-control'], url).toBe('private, no-store');
  const setCookie = r.headers['set-cookie'];
  return { status: r.statusCode, json: (r.body ? JSON.parse(r.body) : null) as T, setCookie: typeof setCookie === 'string' ? setCookie : null };
}

async function ask(h: Harness, question: string, opts: { cookie?: string | null; filters?: object; idempotencyKey?: string; token?: string } = {}) {
  const r = await inject<StartBriefResponse>(h, 'POST', '/api/briefs', {
    body: { question, ...(opts.filters ? { filters: opts.filters } : {}), turnstileToken: opts.token ?? h.sv.issue(), idempotencyKey: opts.idempotencyKey ?? key() },
    cookie: opts.cookie ?? null,
  });
  if (r.status < 300) StartBriefResponseSchema.parse(r.json);
  return r;
}

async function refine(h: Harness, briefId: string, cookie: string, change: object, opts: { idempotencyKey?: string } = {}) {
  const r = await inject<StartBriefResponse>(h, 'POST', `/api/briefs/${briefId}/refine`, {
    body: { ...change, turnstileToken: h.sv.issue(), idempotencyKey: opts.idempotencyKey ?? key() },
    cookie,
  });
  if (r.status < 300) StartBriefResponseSchema.parse(r.json);
  return r;
}

async function read(h: Harness, briefId: string, cookie: string | null, step?: number): Promise<Got<BriefStepResponse>> {
  const r = await inject<BriefStepResponse>(h, 'GET', `/api/briefs/${briefId}${step ? `?step=${step}` : ''}`, { cookie });
  if (r.status === 200) BriefStepResponseSchema.parse(r.json);
  return r;
}

/** Ask and wait for the step to finish; returns the brief, the cookie and the finished step. */
async function askAndWait(h: Harness, question = 'Engine power loss shortly after maintenance', opts: { cookie?: string | null } = {}) {
  const started = await ask(h, question, opts);
  expect(started.status, JSON.stringify(started.json)).toBeLessThan(300);
  const cookie = opts.cookie ?? cookieOf(started.setCookie);
  await h.svc.settled();
  const briefId = started.json.briefId;
  const step = await read(h, briefId, cookie);
  expect(step.status).toBe(200);
  return { started, briefId, cookie, step: step.json };
}

// Database ----------------------------------------------------------------------

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await migrator.execute(query)).rows as T[];
}

async function count(table: string): Promise<number> {
  return (await rows<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM ${table}`)))[0]!.n;
}

async function trialUsed(): Promise<number[]> {
  return (await rows<{ used: number }>(sql`SELECT requests_used AS used FROM trial_identities ORDER BY created_at`)).map((r) => r.used);
}

interface Settled {
  status: string;
  usd: string;
  charged: string;
  uncertain: boolean;
  quota_counted: boolean;
}

async function reservations(): Promise<Settled[]> {
  return rows<Settled>(sql`
    SELECT status, usd::text AS usd, charged_usd::text AS charged, uncertain, quota_counted FROM reservations ORDER BY id`);
}

async function ledgerStages(): Promise<string[][]> {
  const lines = await rows<{ reservation_id: number; stage: string }>(
    sql`SELECT reservation_id::int AS reservation_id, stage FROM cost_ledger ORDER BY reservation_id, id`,
  );
  const by = new Map<number, string[]>();
  for (const l of lines) by.set(l.reservation_id, [...(by.get(l.reservation_id) ?? []), l.stage]);
  return [...by.values()];
}

async function stepRow(briefId: string, n = 1) {
  return (
    await rows<{ status: string; stage: string; cost_usd: string | null; meta: Record<string, unknown>; intent: Record<string, unknown> | null }>(
      sql`SELECT status, stage, cost_usd::text AS cost_usd, meta, intent FROM brief_steps WHERE brief_id = ${briefId}::uuid AND n = ${n}`,
    )
  )[0]!;
}

// ---------------------------------------------------------------------------

describe('POST /api/briefs: the pipeline', () => {
  it('answers with groups, validated quotes and itemized settlement', async () => {
    const h = harness(answering());
    const { started, briefId, cookie, step } = await askAndWait(h);
    expect(started.status).toBe(202);
    expect(started.json).toEqual({ kind: 'started', briefId, step: 1, stage: 'retrieve' });
    expect(step).toMatchObject({ step: 1, steps: 1, refinementsLeft: 3, stage: 'done', origin: { kind: 'question' } });
    expect(step.checklist).toEqual({ question: 'in_scope', searched: { cases: 4, passages: 8 }, written: true, verified: 'passed' });
    const result = step.result!;
    if (result.kind !== 'answer') throw new Error(`expected an answer, got ${result.kind}`);
    expect(result.grouping).toBe('mechanical');
    expect(result.groups.map((g) => [g.kind, g.caseNumbers])).toEqual([
      ['causal', ['DFW08TA066', 'NYC08LA106']],
      ['defect_not_causal', ['MIA08LA156']],
      ['no_fault', ['DEN08LA103']],
      ['insufficient', []],
    ]);
    expect(result.cases.map((c) => c.case.ntsbNo)).toEqual(SEEDS);
    expect(result.interpretations).toEqual([
      { field: 'timing_window', value: { days: 30, flightHours: 10 }, label: 'Within 30 days or 10 flight hours', pinned: false },
    ]);
    const dfw = result.cases[0]!;
    expect(dfw.reading?.glyph).toBe('causal');
    expect(dfw.reading?.evidence).toEqual({ scope: 'aircraft', aircraftKey: expect.any(Number) });
    const quote = dfw.reading!.quotes[0]!;
    expect(quote.text.startsWith('The commercial pilot/air interdiction agent')).toBe(true);
    expect(quote.sectionSpan.start).toBe(quote.span.start);
    expect(result.summary.filter((s) => s.kind === 'case').map((s) => (s.kind === 'case' ? s.ntsbNo : ''))).toEqual(SEEDS);

    // The scope stage's keyword text and the question went to retrieval, pinned to the brief's generation.
    expect(h.retriever.queries).toHaveLength(1);
    expect(h.retriever.queries[0]).toMatchObject({
      dataset: { generationId, passagesIndex: `aviation-test-briefs${RUN}-passages` },
      keywordText: 'engine power loss maintenance',
      text: 'Engine power loss shortly after maintenance',
      filters: {},
    });
    // The checker saw claims of every kind, never the question.
    const check = h.llm.calls.find((c) => c.stage === 'check')!.input as { claims: { kind: string }[] };
    expect(new Set(check.claims.map((c) => c.kind))).toEqual(new Set(['summary', 'why', 'classification', 'maintenance', 'symptom', 'attribution']));
    expect(JSON.stringify(check)).not.toContain('shortly after maintenance');

    expect(await ledgerStages()).toEqual([['scope', 'embed', 'compose', 'check']]);
    const [res] = await reservations();
    expect(res).toMatchObject({ status: 'settled', uncertain: false, quota_counted: true });
    expect(Number(res!.charged)).toBeGreaterThan(0);
    expect(Number(res!.charged)).toBeLessThan(Number(res!.usd));
    expect(await trialUsed()).toEqual([1]);
    const row = await stepRow(briefId);
    expect(row).toMatchObject({ status: 'answered', stage: 'done', cost_usd: res!.charged });
    expect(row.meta).toMatchObject({
      promptVersions: { scope: 'scope.v2', compose: 'compose.v2', check: 'check.v2' },
      validation: { ruleVersion: 'quote-ws-v1', codes: [] },
      check: { supported: true, problems: [] },
    });

    // The case context: the cited passage with its highlight, and template lines.
    const ctx = await inject<unknown>(h, 'GET', `/api/briefs/${briefId}/steps/1/cases/DFW08TA066`, { cookie });
    expect(ctx.status).toBe(200);
    const context = CaseContextResponseSchema.parse(ctx.json);
    const cited = context.passages.find((p) => p.passageId === quote.passageId)!;
    expect(cited.text.slice(cited.highlights[0]!.start, cited.highlights[0]!.end)).toBe(quote.text);
    expect(context.lines.map((l) => l.label)).toEqual(['EVIDENCE', 'MAINTENANCE', 'SYMPTOM']);
    expect((await inject(h, 'GET', `/api/briefs/${briefId}/steps/1/cases/CEN19FA024`, { cookie })).status).toBe(404);
  });

  it('quote not in passage → summary withheld, cards returned, step charged', async () => {
    const h = harness(
      answering({
        compose: (input) =>
          composition(input, (c) => {
            c.cases[0]!.quotes[0]!.quote = 'The engine was replaced 5 hours before the accident.';
          }),
      }),
    );
    const { briefId, step } = await askAndWait(h);
    expect(step.stage).toBe('done');
    expect(step.checklist).toMatchObject({ written: true, verified: 'withheld' });
    const result = step.result!;
    if (result.kind !== 'withheld') throw new Error(`expected withheld, got ${result.kind}`);
    expect(result.reason).toBe('citation_check');
    expect(result.cases.map((c) => c.case.ntsbNo)).toEqual(SEEDS);
    expect(result.cases.every((c) => c.reading === null && c.excerpt.text.length > 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('5 hours before');
    // No check call: code validation failed first.
    expect(h.llm.calls.map((c) => c.stage)).toEqual(['scope', 'compose']);
    // Charged: the step keeps its search and its spend.
    expect(await ledgerStages()).toEqual([['scope', 'embed', 'compose']]);
    expect(await reservations()).toMatchObject([{ status: 'settled', uncertain: false, quota_counted: true }]);
    expect(await trialUsed()).toEqual([1]);
    const row = await stepRow(briefId);
    expect(row.status).toBe('withheld');
    expect(Number(row.cost_usd)).toBeGreaterThan(0);
    expect(row.meta).toMatchObject({ validation: { codes: ['quote_not_found'] } });
  });

  it('unallowlisted case number in why → withheld', async () => {
    const h = harness(
      answering({
        compose: (input) =>
          composition(input, (c) => {
            c.cases[1]!.why = 'Like CEN19FA024, the engine lost power after maintenance.';
          }),
      }),
    );
    const { briefId, step } = await askAndWait(h);
    expect(step.result).toMatchObject({ kind: 'withheld', reason: 'citation_check' });
    expect(JSON.stringify(step.result)).not.toContain('CEN19FA024');
    expect((await stepRow(briefId)).meta).toMatchObject({ validation: { codes: ['unallowlisted_case_number'] } });
    expect(h.llm.calls.some((c) => c.stage === 'check')).toBe(false);
  });

  it('compose refusal → withheld and settled', async () => {
    const h = harness(answering({ compose: { fail: 'refusal', refusalCategory: 'cyber' } }));
    const { briefId, step } = await askAndWait(h);
    expect(step.result).toMatchObject({ kind: 'withheld', reason: 'compose_failed' });
    if (step.result?.kind === 'withheld') expect(step.result.cases).toHaveLength(4);
    expect(step.checklist).toEqual({ question: 'in_scope', searched: { cases: 4, passages: 8 }, verified: 'withheld' });
    // The refusal was billed: its usage is a ledger line, and the settlement is certain.
    expect(await ledgerStages()).toEqual([['scope', 'embed', 'compose']]);
    const [res] = await reservations();
    expect(res).toMatchObject({ status: 'settled', uncertain: false });
    expect(Number(res!.charged)).toBeLessThan(Number(res!.usd));
    expect(await trialUsed()).toEqual([1]);
    expect((await stepRow(briefId)).meta).toMatchObject({ failure: { stage: 'compose', category: 'refusal' } });
  });

  it('timeout at compose → settled at reservation (uncertain)', async () => {
    const h = harness(answering({ compose: { hang: true } }), { timeouts: { compose: 300 } });
    const { briefId, step } = await askAndWait(h);
    expect(step.result).toMatchObject({ kind: 'withheld', reason: 'compose_failed' });
    const [res] = await reservations();
    expect(res).toMatchObject({ status: 'settled', uncertain: true });
    expect(res!.charged).toBe(res!.usd);
    expect((await ledgerStages())[0]).toEqual(['scope', 'embed', 'uncertain']);
    const row = await stepRow(briefId);
    expect(row.cost_usd).toBe(res!.usd);
    expect(row.meta).toMatchObject({ failure: { stage: 'compose', category: 'timeout' } });
    expect(await trialUsed()).toEqual([1]);
  });

  it('an inconclusive check withholds the summary', async () => {
    const h = harness(answering({ check: { output: { supported: true, problems: [{ claimIndex: 0, reason: 'overstated_certainty' }] } } }));
    const { briefId, step } = await askAndWait(h);
    expect(step.result).toMatchObject({ kind: 'withheld', reason: 'evidence_check' });
    expect((await stepRow(briefId)).meta).toMatchObject({ check: { supported: true, problems: [{ kind: 'summary', reason: 'overstated_certainty' }] } });

    const failing = harness(answering({ check: { fail: 'truncated' } }));
    advance(MIN);
    const second = await askAndWait(failing, 'Rough running after an oil change', { cookie: null });
    expect(second.step.result).toMatchObject({ kind: 'withheld', reason: 'evidence_check' });
  });

  it('compose input over the 16,000-token cap is re-packed with a smaller evidence budget', async () => {
    let counts = 0;
    const h = harness(answering({ counts: { compose: () => (++counts === 1 ? 20_000 : 9_000) } }));
    const { briefId, step } = await askAndWait(h);
    expect(step.result?.kind).toBe('answer');
    expect(h.retriever.repacks).toHaveLength(1);
    expect(h.retriever.repacks[0]).toBeLessThan(0.8 * 4_000);
    expect((await stepRow(briefId)).meta).toMatchObject({ repacks: 1 });
  });

  it('retrieval failure after the embedding settles the embedding; no results gives the search back', async () => {
    const h = harness(answering(), { retriever: { fail: { failure: new RetrievalFailure('failed', 'none'), afterEmbedding: true } } });
    const { step } = await askAndWait(h);
    expect(step.result).toEqual({ kind: 'failed', countedAsSearch: true });
    expect(await ledgerStages()).toEqual([['scope', 'embed']]);
    expect(await trialUsed()).toEqual([1]);

    const empty = harness(answering(), { retriever: { cases: [] } });
    advance(MIN);
    const none = await askAndWait(empty, 'Engine power loss shortly after maintenance', { cookie: null });
    expect(none.step.result).toMatchObject({ kind: 'no_results', filters: {} });
    expect(none.step.checklist).toEqual({ question: 'in_scope', searched: { cases: 0, passages: 0 } });
    expect((await trialUsed())[1]).toBe(0);
  });
});

describe('scope outcomes', () => {
  it('out_of_scope and operational do not consume trial', async () => {
    const h = harness({ scope: [{ output: scopeOut({ intent: 'out_of_scope', mechanicalCause: false, keywordText: '', ambiguity: undefined }) }, { output: scopeOut({ intent: 'operational_advice', mechanicalCause: false, keywordText: '', ambiguity: undefined }) }] });
    const off = await ask(h, 'Write me a poem about the sea');
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ kind: 'scope_reply', step: 1, reply: { kind: 'out_of_scope', lines: [...OUT_OF_SCOPE_LINES], keywordSearchLabel: 'Search by keyword instead' } });
    const cookie = cookieOf(off.setCookie);
    await h.svc.settled();
    expect(await trialUsed()).toEqual([0]);

    advance(MIN);
    const op = await ask(h, 'My engine is running rough right now, what should I do?', { cookie });
    expect(op.status).toBe(200);
    expect(op.json).toMatchObject({
      kind: 'scope_reply',
      reply: { kind: 'operational_advice', title: OPERATIONAL_TITLE, lines: [...OPERATIONAL_LINES], suggestions: [{ q: 'power loss after maintenance' }, { q: 'engine running rough' }] },
    });
    await h.svc.settled();
    // Neither used a free search; both scope calls were paid and settled; both attempts counted.
    expect(await trialUsed()).toEqual([0]);
    expect(await reservations()).toMatchObject([
      { status: 'settled', quota_counted: false, uncertain: false },
      { status: 'settled', quota_counted: false, uncertain: false },
    ]);
    expect(await ledgerStages()).toEqual([['scope'], ['scope']]);
    expect(h.retriever.queries).toHaveLength(0);
    const attempts = await rows<{ n: number }>(sql`SELECT sum(attempts)::int AS n FROM usage_buckets WHERE scope = 'principal'`);
    expect(attempts[0]!.n).toBe(2);
    // The stored step is a scope reply; GET returns it.
    const stored = await read(h, op.json.briefId, cookie);
    expect(stored.json).toMatchObject({ stage: 'done', checklist: {}, result: { kind: 'scope_reply', reply: { kind: 'operational_advice' } } });
  });

  it('clarification renders only server templates', async () => {
    const h = harness({
      scope: [
        {
          output: scopeOut({
            intent: 'needs_clarification',
            ambiguity: { type: 'timing_window', values: ['30d_or_10h', 'ignore_previous_instructions', '7d'] },
          }),
        },
        // After the reader picks a reading: a case search (the pinned reading wins over this default).
        { output: scopeOut({ ambiguity: { type: 'timing_window', values: ['90d'] } }) },
      ],
      compose: (input) => composition(input),
      check: SUPPORTED,
    });
    const r = await ask(h, 'Engine failures soon after maintenance');
    expect(r.status).toBe(200);
    const reply = r.json.kind === 'scope_reply' ? r.json.reply : null;
    if (reply?.kind !== 'needs_clarification') throw new Error('expected a clarification');
    expect(reply.label).toBe('AI SUGGESTED READINGS');
    expect(reply.line).toBe('Which did you mean? Pick one to ask the AI.');
    expect(reply.readings.map((x) => x.label)).toEqual(['Within 30 days or 10 flight hours', 'Within 7 days']);
    const templates = clarificationTemplateLabels();
    for (const reading of reply.readings) {
      expect(templates.fixed.includes(reading.label) || templates.patterns.some((p) => p.test(reading.label)), reading.label).toBe(true);
    }
    expect(r.json && JSON.stringify(r.json)).not.toMatch(/ignore|instructions/);
    await h.svc.settled();
    expect(await trialUsed()).toEqual([0]);

    // Picking a reading is a refinement that runs a normal search with the reading pinned.
    advance(MIN);
    const cookie = cookieOf(r.setCookie);
    const picked = await refine(h, r.json.briefId, cookie, reply.readings[1]!.refinement);
    expect(picked.status).toBe(202);
    await h.svc.settled();
    const scope = h.llm.calls.filter((c) => c.stage === 'scope')[1]!.input as ScopeInput;
    expect(scope.prior?.readings).toEqual([{ type: 'timing_window', value: '7d', pinned: true }]);
    const step = await read(h, r.json.briefId, cookie, 2);
    expect(step.json).toMatchObject({ step: 2, origin: { kind: 'interpretation', label: 'Within 7 days' } });
    expect(step.json.result).toMatchObject({
      kind: 'answer',
      interpretations: [{ field: 'timing_window', value: { days: 7, flightHours: null }, label: 'Within 7 days', pinned: true }],
    });
    const compose = h.llm.calls.find((c) => c.stage === 'compose')!.input as ComposeInput;
    expect(compose.interpretations).toEqual(['Read vague timing words about maintenance as: within 7 calendar days after the maintenance.']);
    expect(await trialUsed()).toEqual([1]);
  });

  it('a clarification with fewer than two usable readings runs the search', async () => {
    const h = harness(
      answering({ scope: { output: scopeOut({ intent: 'needs_clarification', ambiguity: { type: 'failure_type', values: ['total_power_loss', 'kaboom'] } }) } }),
    );
    const { briefId, step } = await askAndWait(h);
    expect(step.result?.kind).toBe('answer');
    expect((await stepRow(briefId)).meta).toMatchObject({ clarificationDropped: true });
  });

  it('statistics and comparisons get static replies with validated values only', async () => {
    const h = harness({
      scope: [
        { output: scopeOut({ intent: 'corpus_statistics', filters: { category: ['HELI', 'RCKT'], yearFrom: 2010 }, ambiguity: undefined }) },
        { output: scopeOut({ intent: 'case_comparison', caseNumbers: ['DFW08TA066', 'XYZ99ZZ999', 'NYC08LA106'], ambiguity: undefined }) },
      ],
    });
    const stats = await ask(h, 'How many helicopter accidents since 2010?');
    expect(stats.json).toMatchObject({
      kind: 'scope_reply',
      reply: { kind: 'corpus_statistics', lines: ['Counting questions are answered from the data directly, not by the AI.'], filters: { category: ['HELI', 'RCKT'], yearFrom: 2010 } },
    });
    await h.svc.settled();
    advance(MIN);
    const compare = await ask(h, 'Compare DFW08TA066, XYZ99ZZ999 and NYC08LA106', { cookie: cookieOf(stats.setCookie) });
    expect(compare.json).toMatchObject({ kind: 'scope_reply', reply: { kind: 'case_comparison', found: ['DFW08TA066', 'NYC08LA106'], notFound: ['XYZ99ZZ999'] } });
    await h.svc.settled();
    expect(await trialUsed()).toEqual([0]);
  });
});

describe('refinements', () => {
  it('fourth refinement rejected', async () => {
    const h = harness(answering(), { trialRequests: 10 });
    const first = await askAndWait(h);
    for (const [i, text] of ['Only airplanes', 'Only in IMC', 'Only fatal accidents'].entries()) {
      advance(MIN);
      const r = await refine(h, first.briefId, first.cookie, { kind: 'text', text });
      expect(r.status, `refinement ${i + 1}`).toBe(202);
      expect(r.json).toMatchObject({ kind: 'started', step: i + 2 });
      await h.svc.settled();
    }
    const step = await read(h, first.briefId, first.cookie);
    expect(step.json).toMatchObject({ step: 4, steps: 4, refinementsLeft: 0, origin: { kind: 'text', text: 'Only fatal accidents' } });

    advance(MIN);
    const reservationsBefore = await count('reservations');
    const callsBefore = h.sv.calls.length;
    const fourth = await refine(h, first.briefId, first.cookie, { kind: 'text', text: 'Only in Alaska' });
    expect(fourth.status).toBe(409);
    expect(ErrorResponseSchema.parse(fourth.json).error).toBe('refinement_limit');
    expect(await count('reservations')).toBe(reservationsBefore);
    expect(h.sv.calls.length).toBe(callsBefore);
    expect(await count('brief_steps')).toBe(4);
  });

  it('refinement filters variant re-runs scope', async () => {
    const h = harness({
      scope: [{ output: scopeOut({ filters: { injury: ['FATL'] } }) }, { output: scopeOut({ filters: { category: ['AIR'] } }) }],
      compose: (input) => composition(input),
      check: SUPPORTED,
    });
    const first = await askAndWait(h);
    expect(first.step.result).toMatchObject({ kind: 'answer', filters: { injury: ['FATL'] } });
    advance(MIN);
    const r = await refine(h, first.briefId, first.cookie, { kind: 'filters', filters: { category: ['HELI'], state: ['TX'] } });
    expect(r.status).toBe(202);
    await h.svc.settled();

    const scopes = h.llm.calls.filter((c) => c.stage === 'scope').map((c) => c.input as ScopeInput);
    expect(scopes).toHaveLength(2);
    expect(scopes[1]).toMatchObject({
      question: 'Engine power loss shortly after maintenance',
      prior: { question: 'Engine power loss shortly after maintenance', intent: 'case_search', filters: { category: ['HELI'], state: ['TX'] }, caseNumbers: SEEDS },
    });
    // The reader's filters are the step's filters exactly; the planner's are ignored.
    expect(h.retriever.queries[1]!.filters).toEqual({ category: ['HELI'], state: ['TX'] });
    const step = await read(h, first.briefId, first.cookie, 2);
    expect(step.json).toMatchObject({ step: 2, origin: { kind: 'filters', filters: { category: ['HELI'], state: ['TX'] } } });
    expect(step.json.result).toMatchObject({ kind: 'answer', filters: { category: ['HELI'], state: ['TX'] } });
    expect(await trialUsed()).toEqual([2]);
  });

  it('a text refinement keeps earlier filters unless the planner changes them', async () => {
    const h = harness({
      scope: [{ output: scopeOut({ filters: { injury: ['FATL'] } }) }, { output: scopeOut({ filters: { category: ['AIR'] } }) }],
      compose: (input) => composition(input),
      check: SUPPORTED,
    });
    const first = await askAndWait(h);
    advance(MIN);
    await refine(h, first.briefId, first.cookie, { kind: 'text', text: 'Only airplanes' });
    await h.svc.settled();
    const scope = h.llm.calls.filter((c) => c.stage === 'scope')[1]!.input as ScopeInput;
    expect(scope).toMatchObject({ question: 'Only airplanes', prior: { question: 'Engine power loss shortly after maintenance', filters: { injury: ['FATL'] } } });
    expect(h.retriever.queries[1]).toMatchObject({
      filters: { injury: ['FATL'], category: ['AIR'] },
      text: 'Engine power loss shortly after maintenance\nOnly airplanes',
    });
    const compose = h.llm.calls.filter((c) => c.stage === 'compose')[1]!.input as ComposeInput;
    expect(compose).toMatchObject({ question: 'Engine power loss shortly after maintenance', refinement: 'Only airplanes' });
  });

  it('one step at a time, the read owner only, and a retried refinement replays', async () => {
    const h = harness(answering({ compose: [{ hang: true }, (input: ComposeInput) => composition(input)] }), { timeouts: { compose: 400 } });
    const started = await ask(h, 'Engine power loss shortly after maintenance');
    const cookie = cookieOf(started.setCookie);
    const briefId = started.json.briefId;
    advance(MIN);
    const busy = await refine(h, briefId, cookie, { kind: 'text', text: 'Only airplanes' });
    expect([busy.status, busy.json && (busy.json as unknown as { error: string }).error]).toEqual([429, 'in_flight']);
    await h.svc.settled();

    // Someone else's cookie, or none: 404 for every read and write.
    const other = await ask(h, 'Another question', { cookie: null });
    const otherCookie = cookieOf(other.setCookie);
    await h.svc.settled();
    expect((await read(h, briefId, otherCookie)).status).toBe(404);
    expect((await read(h, briefId, null)).status).toBe(404);
    expect((await inject(h, 'POST', `/api/briefs/${briefId}/cancel`, { cookie: otherCookie })).status).toBe(404);
    advance(MIN);
    expect((await refine(h, briefId, otherCookie, { kind: 'text', text: 'Only airplanes' })).status).toBe(404);

    advance(MIN);
    const idempotencyKey = key();
    const r1 = await refine(h, briefId, cookie, { kind: 'text', text: 'Only airplanes' }, { idempotencyKey });
    expect(r1.status).toBe(202);
    await h.svc.settled();
    const reservationsBefore = await count('reservations');
    const r2 = await refine(h, briefId, cookie, { kind: 'text', text: 'Only airplanes' }, { idempotencyKey });
    expect(r2.json).toMatchObject({ kind: 'started', briefId, step: 2, stage: 'done' });
    expect(await count('reservations')).toBe(reservationsBefore);
    const conflict = await refine(h, briefId, cookie, { kind: 'text', text: 'Only helicopters' }, { idempotencyKey });
    expect([conflict.status, (conflict.json as unknown as { error: string }).error]).toEqual([409, 'conflict']);
  });
});

describe('admission order', () => {
  it('the gate checks the kill switch and budgets before claiming the token', async () => {
    const h = harness(answering());
    await setAiSwitch(ingest, false, 'test');
    try {
      const r = await ask(h, 'Engine power loss shortly after maintenance');
      expect([r.status, (r.json as unknown as { error: string }).error]).toEqual([503, 'ai_paused']);
      expect(h.sv.calls).toHaveLength(0);
      expect(await count('turnstile_redemptions')).toBe(0);
      expect(await count('trial_identities')).toBe(0);
      expect(await count('reservations')).toBe(0);
    } finally {
      await setAiSwitch(ingest, true);
    }
  });

  it('a trial that expires between the gate and admission asks for a new check', async () => {
    const h = harness(answering());
    const first = await askAndWait(h);
    const expires = (await rows<{ ms: string }>(sql`SELECT (extract(epoch FROM expires_at) * 1000)::bigint AS ms FROM trial_identities`))[0]!;
    // Every clock read moves 1 ms: the token is issued at expiry − 2 ms, the gate finds the
    // trial live at expiry − 1 ms, and admission reads the clock at expiry or later.
    clock = new Date(Number(expires.ms) - 2);
    tick = 1;
    const r = await ask(h, 'Engine power loss shortly after maintenance', { cookie: first.cookie });
    tick = 0;
    expect([r.status, (r.json as unknown as { error: string }).error]).toEqual([403, 'challenge_required']);
    expect(await count('reservations')).toBe(1);
  });

  it('AI is unavailable without a passages index: status and briefs', async () => {
    const h = harness(answering(), { retriever: { available: false } });
    const s = await inject<{ state: string; reason?: string }>(h, 'GET', '/api/ai/status');
    expect(s.json).toMatchObject({ state: 'paused', reason: 'dependency' });
    const r = await ask(h, 'Engine power loss shortly after maintenance');
    expect([r.status, (r.json as unknown as { error: string }).error]).toEqual([503, 'unavailable']);
    expect(h.sv.calls).toHaveLength(0);

    // A keyword-only manifest: no passages index at all.
    await publishManifest(ingest, generationId, `aviation-test-briefs${RUN}-cases`, null);
    try {
      const keywordOnly = harness(answering());
      expect((await inject<{ state: string; reason?: string }>(keywordOnly, 'GET', '/api/ai/status')).json).toMatchObject({ state: 'paused', reason: 'dependency' });
      expect((await ask(keywordOnly, 'Engine power loss')).status).toBe(503);
      expect(keywordOnly.retriever.queries).toHaveLength(0);
    } finally {
      await publishManifest(ingest, generationId, `aviation-test-briefs${RUN}-cases`, `aviation-test-briefs${RUN}-passages`);
    }
    const ok = harness(answering());
    expect((await inject<{ state: string }>(ok, 'GET', '/api/ai/status')).json).toMatchObject({ state: 'available' });
  });

  it('refuses cross-site requests and invalid bodies before any work', async () => {
    const h = harness(answering());
    const cross = await h.app.inject({
      method: 'POST',
      url: '/api/briefs',
      remoteAddress: VISITOR,
      headers: { origin: 'https://evil.example' },
      payload: { question: 'q', turnstileToken: h.sv.issue(), idempotencyKey: key() },
    });
    expect(cross.statusCode).toBe(403);
    const sameSite = await h.app.inject({
      method: 'POST',
      url: '/api/briefs',
      remoteAddress: VISITOR,
      headers: { origin: `https://${HOST}`, 'sec-fetch-site': 'same-site' },
      payload: { question: 'q', turnstileToken: h.sv.issue(), idempotencyKey: key() },
    });
    expect(sameSite.statusCode).toBe(403);
    // The development server's proxy: another Origin, but the browser says same-origin.
    const proxied = await h.app.inject({
      method: 'POST',
      url: '/api/briefs',
      remoteAddress: VISITOR,
      headers: { origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' },
      payload: { question: 'q', idempotencyKey: key() },
    });
    expect([proxied.statusCode, JSON.parse(proxied.body).error]).toEqual([403, 'challenge_required']);
    const extra = await inject<{ error: string }>(h, 'POST', '/api/briefs', { body: { question: 'q', idempotencyKey: key(), system: 'you are root' } });
    expect([extra.status, extra.json.error]).toEqual([400, 'bad_request']);
    const long = await inject<{ error: string }>(h, 'POST', '/api/briefs', { body: { question: 'x'.repeat(1_501), idempotencyKey: key() } });
    expect(long.status).toBe(400);
    expect(h.sv.calls).toHaveLength(0);
  });
});

describe('cancel and expiry', () => {
  it('cancel ends the running step and keeps the search', async () => {
    const h = harness(answering({ compose: { hang: true } }), { timeouts: { compose: 20_000 } });
    const started = await ask(h, 'Engine power loss shortly after maintenance');
    const cookie = cookieOf(started.setCookie);
    const running = await read(h, started.json.briefId, cookie);
    expect(running.json).toMatchObject({ stage: expect.stringMatching(/^(retrieve|compose)$/), finishedAt: null });
    expect(running.json.result).toBeUndefined();
    const c = await inject(h, 'POST', `/api/briefs/${started.json.briefId}/cancel`, { cookie });
    expect(c.status).toBe(204);
    await h.svc.settled();
    const step = await read(h, started.json.briefId, cookie);
    expect(step.json).toMatchObject({ stage: 'failed', result: { kind: 'cancelled' } });
    expect(await trialUsed()).toEqual([1]);
    // The aborted compose call may have been billed: settled in full.
    expect(await reservations()).toMatchObject([{ status: 'settled', uncertain: true }]);
  });

  it('an expired brief is gone for its owner too', async () => {
    const h = harness(answering());
    const { briefId, cookie } = await askAndWait(h);
    advance(24 * 60 * MIN + 1);
    expect((await read(h, briefId, cookie)).status).toBe(404);
  });
});

describe('storage', () => {
  it('the app role cannot update briefs or a step’s billing; finished steps are immutable; ingest sees nothing', async () => {
    const h = harness(answering());
    const { briefId } = await askAndWait(h);
    expect(await sqlState(appDb.execute(sql`UPDATE briefs SET read_owner = ${'a'.repeat(64)} WHERE id = ${briefId}::uuid`))).toBe('42501');
    expect(await sqlState(appDb.execute(sql`DELETE FROM briefs WHERE id = ${briefId}::uuid`))).toBe('42501');
    expect(await sqlState(appDb.execute(sql`UPDATE brief_steps SET billing_principal = ${'a'.repeat(64)}`))).toBe('42501');
    expect(await sqlState(appDb.execute(sql`UPDATE brief_steps SET request = '{}'::jsonb`))).toBe('42501');
    expect(await sqlState(appDb.execute(sql`UPDATE brief_steps SET result = '{"kind":"cancelled"}'::jsonb`))).toBe('55000');
    expect(await sqlState(migrator.execute(sql`UPDATE brief_steps SET billing_principal = ${'a'.repeat(64)}`))).toBe('55000');
    expect(await sqlState(migrator.execute(sql`DELETE FROM brief_steps`))).toBe('55000');
    expect(await sqlState(ingest.execute(sql`SELECT count(*) FROM briefs`))).toBe('42501');
    expect(await sqlState(ingest.execute(sql`SELECT count(*) FROM brief_steps`))).toBe('42501');
  });

  it('the read owner moves once, by compare-and-set, from the trial to an account', async () => {
    const h = harness(answering());
    const { briefId, cookie } = await askAndWait(h);
    const owner = (await rows<{ read_owner: string }>(sql`SELECT read_owner FROM briefs WHERE id = ${briefId}::uuid`))[0]!.read_owner;
    const account = 'b'.repeat(64);
    const [a, b] = await Promise.all([
      moveBriefReadOwner(appDb, briefId, owner, account),
      moveBriefReadOwner(appDb, briefId, owner, 'c'.repeat(64)),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await moveBriefReadOwner(appDb, briefId, owner, account)).toBe(false);
    // The trial can no longer read it; billing stays with the trial.
    expect((await read(h, briefId, cookie)).status).toBe(404);
    const steps = await rows<{ billing_principal: string; billing_kind: string }>(sql`SELECT billing_principal, billing_kind FROM brief_steps WHERE brief_id = ${briefId}::uuid`);
    expect(steps).toEqual([{ billing_principal: owner, billing_kind: 'trial' }]);
    expect(await sqlState(appDb.execute(sql`SELECT move_brief_read_owner(${briefId}::uuid, ${owner}, 'not-a-hash')`))).toBe('22023');
  });

  it('retention deletes expired briefs with their steps', async () => {
    const past = new Date(Date.now() - 2 * 24 * 60 * MIN);
    const owner = 'd'.repeat(64);
    const inserted = await rows<{ id: string }>(sql`
      INSERT INTO briefs (read_owner, read_owner_kind, generation_id, passages_index, created_at, expires_at)
      VALUES (${owner}, 'trial', ${generationId}, 'aviation-test-old', ${past}, ${new Date(past.getTime() + 24 * 60 * MIN)})
      RETURNING id::text AS id`);
    await migrator.execute(sql`
      INSERT INTO brief_steps (brief_id, n, billing_principal, billing_kind, reservation_id, request, created_at, updated_at)
      VALUES (${inserted[0]!.id}::uuid, 1, ${owner}, 'trial', 1, '{"origin":"question"}'::jsonb, ${past}, ${past})`);
    const report = await pruneControls(appDb);
    expect(report).toMatchObject({ briefs: 1, briefSteps: 1 });
    expect(await count('briefs')).toBe(0);
  });
});
