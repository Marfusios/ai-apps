/**
 * AI briefs end to end through the HTTP routes, with the fake language-model provider,
 * over the fixture corpus in aviation_test published with a cases index and a passages
 * index (fake vectors under the production model name, so the dataset resolver's
 * passages contract check is the real one).
 *
 * Most tests read evidence through a fake retriever (tests/support/fake-retriever.ts)
 * to script failures; they exercise the pipeline's provenance check, validation,
 * settlement and storage. "Hybrid retrieval behind the port" runs the real binding
 * (server/briefs/retriever.ts) over the fixture passages index with the fake embedder.
 */
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import { errors, type Client, type estypes } from '@elastic/elasticsearch';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../shared/config.js';
import { TURNSTILE_ACTION } from '../../shared/contracts/ai.js';
import {
  BriefStepResponseSchema,
  CaseContextResponseSchema,
  FAILURE_TYPE_LABELS,
  StartBriefResponseSchema,
  type BriefStepResponse,
  type ComposeChronology,
  type ComposeOutput,
  type StartBriefResponse,
} from '../../shared/contracts/briefs.js';
import { ErrorResponseSchema } from '../../shared/contracts/common.js';
import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createFakeProvider, type FakeProvider, type FakeResult, type FakeScript } from '../../server/ai/fake.js';
import { startTracing } from '../../server/observability/tracing.js';
import type { CheckInput, CheckOutput, CheckVerdict, ComposeInput, ScopeInput, ScopeOutput } from '../../server/ai/provider.js';
import { createAiRuntime, type AiRuntime, type AiRuntimeConfig } from '../../server/ai/runtime.js';
import { SHUTDOWN_GRACE_MS, buildApp } from '../../server/app.js';
import { clarificationTemplateLabels } from '../../server/briefs/clarify.js';
import { QueryEmbeddingError, createOpenAIQueryEmbedder, queryEmbeddingInput, type EmbedResult, type Embedder } from '../../server/ai/embeddings.js';
import { CACHED_PREFIX_MAX, RESERVATIONS, STAGE_CAPS } from '../../server/ai/pricing.js';
import { countTokens } from '../../server/ai/tokens.js';
import { createCaseCatalog } from '../../server/briefs/catalog.js';
import {
  RetrievalFailure,
  type CaseCatalog,
  type EmbeddingUsage,
  type EvidenceDataset,
  type EvidenceQuery,
  type EvidenceRetriever,
} from '../../server/briefs/evidence.js';
import { createHybridRetriever } from '../../server/briefs/retriever.js';
import { createBriefServices, type BriefServices } from '../../server/briefs/services.js';
import { NO_MATCH_LINES, OUT_OF_SCOPE_LINES, OPERATIONAL_LINES, OPERATIONAL_TITLE } from '../../server/briefs/static-replies.js';
import { failOrphanedSteps, moveBriefReadOwner, type StepDiagnostics } from '../../server/briefs/store.js';
import { SPAN_ATTR_KEYS } from '../../server/observability/attributes.js';
import { diagnoseBrief } from '../../worker/brief-diagnose.js';
import { closeDb, type Db } from '../../server/db/client.js';
import { publishManifest } from '../../server/db/generations.js';
import { admitPaidRequest, canonicalRequestHash, pruneControls, runControlMaintenance, setAiSwitch } from '../../server/quota/index.js';
import { SPEND_LOCK_KEY } from '../../server/quota/policy.js';
import { assertServablePassagesIndex } from '../../server/search/hybrid.js';
import { FIXTURE_EMBEDDING, deleteIndices, fixtureEmbedder, publishFixtureDataset, type FixtureDataset } from '../support/api-dataset.js';
import { FakeRetriever, type FakeRetrieverOptions } from '../support/fake-retriever.js';
import { FakeSiteverify, REAL_SECRET, REAL_SITE_KEY } from '../support/fake-siteverify.js';
import { sqlState } from './corpus-helpers.js';
import { TEST_INDEX_PREFIX, resetControls, resetCorpus, testDb, testEs, testEsReader } from './helpers.js';

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
let dataset: FixtureDataset & { passagesIndex: string };
const PREFIX = `${TEST_INDEX_PREFIX}briefs${RUN}`;
/** The API's client (read key) and the index builder's (write key). */
let es: Client;
let writer: Client;
const harnesses: Harness[] = [];

beforeAll(async () => {
  appDb = testDb('app');
  ingest = testDb('ingest');
  migrator = testDb('migrator');
  es = testEsReader();
  writer = testEs();
  const published = await publishFixtureDataset(ingest, writer, PREFIX, { passages: true });
  if (!published.passagesIndex) throw new Error('the fixture dataset has no passages index');
  dataset = { ...published, passagesIndex: published.passagesIndex };
  generationId = dataset.generationId;
}, 180_000);

afterAll(async () => {
  await deleteIndices(writer, PREFIX);
  await resetCorpus();
  await Promise.all([closeDb(appDb), closeDb(ingest), closeDb(migrator), es.close(), writer.close()]);
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
  /** The server's log lines (JSON). */
  logs: string[];
}

interface HarnessOptions {
  retriever?: Partial<FakeRetrieverOptions>;
  /** Evidence through this retriever instead of the fake one (the hybrid binding). */
  evidence?: EvidenceRetriever;
  /** The configured embedding the dataset resolver checks the passages index against (default `FIXTURE_EMBEDDING`; null: none). */
  embedding?: { model: string; dims: number } | null;
  timeouts?: Partial<{ scope: number; retrieve: number; compose: number; check: number; total: number }>;
  /** The display projection's mode (default: the services' default, `whole`). */
  displayMode?: 'claims' | 'whole';
  trialRequests?: number;
  /** Which evidence index a new brief pins (default: the dataset resolver's servable index). */
  aiEvidence?: () => Promise<{ generationId: number; passagesIndex: string } | null>;
  /** Wrap the PostgreSQL case catalog. */
  catalog?: (real: CaseCatalog) => CaseCatalog;
  /** The closing deadline (default `SHUTDOWN_GRACE_MS`). */
  shutdownGraceMs?: number;
  /** Serve a built web client from here. */
  webRoot?: string;
}

/** The served index's passages contract, from hybrid retrieval's own check. */
const servedContract = async (d: EvidenceDataset) => (await assertServablePassagesIndex(es, d, FIXTURE_EMBEDDING)).contract;

function harness(script: FakeScript, opts: HarnessOptions = {}): Harness {
  const sv = new FakeSiteverify(now, { hostname: HOST, action: TURNSTILE_ACTION });
  const llm = createFakeProvider(script);
  const ai = createAiRuntime(aiConfig(opts.trialRequests === undefined ? {} : { trialRequests: opts.trialRequests }), {
    db: appDb,
    turnstile: { fetch: sv.fetch, retryDelayMs: 0, attemptTimeoutMs: 200 },
    llm,
    now,
  });
  const retriever = new FakeRetriever(appDb, { cases: SEEDS, served: servedContract, ...opts.retriever });
  const svc = createBriefServices(appDb, {
    retriever: opts.evidence ?? retriever,
    ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
    ...(opts.displayMode ? { displayMode: opts.displayMode } : {}),
    ...(opts.catalog ? { catalog: opts.catalog(createCaseCatalog(appDb)) } : {}),
  });
  const embedding = opts.embedding === undefined ? FIXTURE_EMBEDDING : opts.embedding;
  const logs: string[] = [];
  const app = buildApp({
    config: { appUrl: `https://${HOST}`, trustedProxyCidrs: [] },
    db: appDb,
    es,
    ai,
    briefs: svc,
    ...(embedding ? { embedding } : {}),
    ...(opts.aiEvidence ? { aiEvidence: opts.aiEvidence } : {}),
    logger: { level: 'debug', stream: { write: (line: string) => void logs.push(line) } },
    rateLimit: { limit: 100_000, windowMs: 60_000 },
    ...(opts.shutdownGraceMs !== undefined ? { shutdownGraceMs: opts.shutdownGraceMs } : {}),
    ...(opts.webRoot ? { webRoot: opts.webRoot } : {}),
  });
  const h = { app, ai, sv, llm, retriever, svc, logs };
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

/** The interpretation chip of `scopeOut()`'s default reading (`30d_or_10h`, not pinned). */
const DEFAULT_TIMING_CHIP = {
  field: 'timing_window',
  value: { days: 30, flightHours: 10 },
  label: 'Within 30 days or 10 flight hours',
  pinned: false,
} as const;

/** `checklist.interpretation` of a step that ran with `scopeOut()` and no filters. */
const DEFAULT_INTERPRETATION = { interpretations: [DEFAULT_TIMING_CHIP], filters: {} };

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
    const cause = c.passages.find((x) => x.section === 'Probable cause') ?? p;
    return {
      ntsbNo: c.ntsbNo,
      why: 'The engine lost power after recent maintenance.',
      quotes: [{ passageId: p.passageId, quote: firstSentence(p.text), speaker: 'investigators' as const }],
      evidencePassageIds: [...new Set([p.passageId, cause.passageId])],
      maintenance: { relation: 'preceding_not_established' as const, passageIds: [p.passageId] },
      symptom: { value: 'total_power_loss' as const, passageIds: [p.passageId] },
    };
  });
  const kinds = [...new Set(cases.map((c) => GROUP[c.ntsbNo] ?? 'insufficient'))];
  const out: ComposeOutput = {
    outcome: 'answer',
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

type Claim = CheckInput['claims'][number];
type Judged = CheckVerdict | { verdict: CheckVerdict; passages?: string[]; quote?: { passage: string; text: string } };

/**
 * The checker's answer as check.v7 returns it: one verdict per claim id, from `judge`
 * (default `supported`). A supported claim names its first cited passages (an absence
 * claim none), a contradicted one its first cited passage unless `judge` names others.
 */
function verdicts(input: CheckInput, judge: (claim: Claim, i: number) => Judged = () => 'supported'): FakeResult<CheckOutput> {
  const out: CheckOutput = { verdicts: [], quotes: [] };
  input.claims.forEach((c, i) => {
    const j = judge(c, i);
    const verdict = typeof j === 'string' ? j : j.verdict;
    const named = typeof j === 'object' && j.passages ? j.passages : undefined;
    const passages = named ?? (verdict === 'supported' ? (c.absence ? [] : c.passageIds.slice(0, 4)) : verdict === 'contradicted' ? c.passageIds.slice(0, 1) : []);
    out.verdicts.push({ claim: c.id, verdict, passages });
    if (typeof j === 'object' && j.quote) out.quotes.push({ claim: c.id, ...j.quote });
  });
  return { output: out };
}

/** Every claim supported. */
const SUPPORTED = (input: CheckInput) => verdicts(input);

/** A compose count over the answer input cap (a re-pack follows). */
const OVER_ANSWER_CAP = STAGE_CAPS.answer.input + 4_000;

/** Tracing to a loopback address that never answers (the tests read an in-memory exporter). */
const tracingConfig = () =>
  loadConfig({
    env: { NODE_ENV: 'test', APP_ENV: 'dev', AVIATION_TRACING_ENABLED: 'true', LANGFUSE_BASE_URL: 'http://127.0.0.1:1', LANGFUSE_PUBLIC_KEY: 'pk-test', LANGFUSE_SECRET_KEY: 'sk-test' },
    files: [],
  });

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

async function ask(
  h: Harness,
  question: string,
  opts: { cookie?: string | null; filters?: object; idempotencyKey?: string; token?: string; from?: string } = {},
) {
  const r = await inject<StartBriefResponse>(h, 'POST', '/api/briefs', {
    body: { question, ...(opts.filters ? { filters: opts.filters } : {}), turnstileToken: opts.token ?? h.sv.issue(), idempotencyKey: opts.idempotencyKey ?? key() },
    cookie: opts.cookie ?? null,
    ...(opts.from ? { from: opts.from } : {}),
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

/** Wait (bounded) until `ready()` holds. */
async function until(ready: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** `until` for an asynchronous condition. */
async function untilAsync(ready: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// A listening server -------------------------------------------------------------

async function listen(h: Harness): Promise<number> {
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  return (h.app.server.address() as AddressInfo).port;
}

interface Sent {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  socket: Socket;
}

/** One request; `agent` keeps its connection (default: a connection of its own, closed after it). */
function send(port: number, method: 'GET' | 'POST', path: string, opts: { body?: object; agent?: http.Agent } = {}): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const payload = opts.body ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: opts.agent ?? false,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, socket: socket! }));
      },
    );
    // The connection, kept here: a keep-alive agent detaches it from the response at its end.
    let socket: Socket | undefined;
    req.on('socket', (s) => (socket = s));
    req.on('error', reject);
    req.end(payload);
  });
}

/** Resolves when `socket` closes. */
function closedOf(socket: Socket): Promise<void> {
  return socket.closed ? Promise.resolve() : new Promise((resolve) => socket.once('close', () => resolve()));
}

// Pausing a request in the database ------------------------------------------------

/** Hold `table` in EXCLUSIVE mode (reads pass, inserts wait) until `release`. */
async function holdTable(table: string): Promise<{ release: () => Promise<void> }> {
  return holding(sql.raw(`LOCK TABLE ${table} IN EXCLUSIVE MODE`));
}

/** Hold a transaction-level advisory lock until `release`. */
async function holdAdvisory(lockKey: number): Promise<{ release: () => Promise<void> }> {
  return holding(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
}

/** Run `statement` in a transaction kept open until `release` (idempotent). */
async function holding(statement: ReturnType<typeof sql>): Promise<{ release: () => Promise<void> }> {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const held = new Promise<void>((r) => (locked = r));
  const done = migrator.transaction(async (tx) => {
    await tx.execute(statement);
    locked();
    await released;
  });
  await Promise.race([held, done]);
  return {
    release: async () => {
      release();
      await done;
    },
  };
}

/** Lock requests waiting on `table`. */
async function waitingOnTable(table: string): Promise<number> {
  return (await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND relation = ${table}::regclass`))[0]!.n;
}

/** Advisory-lock requests waiting. */
async function waitingOnAdvisory(): Promise<number> {
  return (await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype = 'advisory'`))[0]!.n;
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

/** The ledger lines of one reservation. */
async function ledgerOf(reservationId: number): Promise<{ stage: string; usd: string }[]> {
  return rows(sql`SELECT stage, usd::text AS usd FROM cost_ledger WHERE reservation_id = ${reservationId} ORDER BY id`);
}

async function stepRow(briefId: string, n = 1) {
  return (
    await rows<{
      status: string;
      stage: string;
      cost_usd: string | null;
      meta: Record<string, unknown>;
      intent: Record<string, unknown> | null;
      result: Record<string, unknown> | null;
    }>(sql`SELECT status, stage, cost_usd::text AS cost_usd, meta, intent, result FROM brief_steps WHERE brief_id = ${briefId}::uuid AND n = ${n}`)
  )[0]!;
}

/** A step's server-side diagnostics (no route reads them; the migrator does here). */
async function diagnosticsOf(briefId: string, n = 1): Promise<StepDiagnostics | null> {
  return (await rows<{ diagnostics: StepDiagnostics | null }>(sql`SELECT diagnostics FROM brief_steps WHERE brief_id = ${briefId}::uuid AND n = ${n}`))[0]!
    .diagnostics;
}

/** The developer's report on a live brief's latest step (worker/brief-diagnose.ts), as text. */
async function reportOf(briefId: string): Promise<string> {
  const d = await diagnoseBrief(appDb, briefId, undefined, { now: now() });
  if (d.kind !== 'report') throw new Error(`expected a report, got ${d.kind}`);
  return d.lines.join('\n');
}

/** The step's `brief step finished` log line. */
/** The latest "brief step finished" log line. */
const finishedLine = (h: Harness) => h.logs.map((l) => JSON.parse(l) as Record<string, unknown>).findLast((l) => l.msg === 'brief step finished');

// ---------------------------------------------------------------------------

/** Astra's case (gate G6 #1): DFW08TA066 classified insufficient with no maintenance evidence, quoting only its analysis. */
function contradict(c: ComposeOutput, dfw: ComposeInput['cases'][number]): void {
  const kind = (n: string) => (n === 'DFW08TA066' ? 'insufficient' : (GROUP[n] ?? 'insufficient'));
  const k = c.cases.find((x) => x.ntsbNo === 'DFW08TA066')!;
  const analysis = dfw.passages.find((p) => p.section === 'Analysis') ?? dfw.passages[0]!;
  k.quotes = [{ passageId: analysis.passageId, quote: firstSentence(analysis.text), speaker: 'investigators' }];
  k.evidencePassageIds = [];
  k.maintenance = { relation: 'no_evidence', passageIds: [] };
  c.groups = [...new Set(c.cases.map((x) => kind(x.ntsbNo)))].map((g) => ({ kind: g, caseNumbers: c.cases.filter((x) => kind(x.ntsbNo) === g).map((x) => x.ntsbNo) }));
}

/** DFW08TA066 with a supported timing of 5.1 flight hours (its analysis states it). */
function timing51(c: ComposeOutput, dfw: ComposeInput['cases'][number]): void {
  const k = c.cases.find((x) => x.ntsbNo === 'DFW08TA066')!;
  const stating = dfw.passages.find((p) => p.text.includes('5.1 hours')) ?? dfw.passages[0]!;
  k.chronology = { maintenance: 'the engine replacement', facts: [{ anchor: 'relevant_maintenance', relation: 'flight_hours', value: 5.1, bound: 'exact', passageIds: [stating.passageId] }] };
}

/** A chronology from the relevant maintenance with one fact cited from `passageId`. */
const chronologyOf = (maintenance: string, passageId: string, fact: Omit<ComposeChronology['facts'][number], 'passageIds' | 'anchor'> & { anchor?: 'relevant_maintenance' | 'other' }) => ({
  maintenance,
  facts: [{ anchor: 'relevant_maintenance' as const, ...fact, passageIds: [passageId] }],
});

/** Passages that state a chronology fact ("5.1 hours prior", "12 hours since installation", "depart again"). */
const STATES_CHRONOLOGY = /\b\d+(?:\.\d+)?\s+hours\b|\bmonths? prior\b|\bdepart again\b|\bsecond flight\b/i;

/**
 * A checker that reads the whole case for criterion claims, as the check prompt asks:
 * "under the timing rules, the supplied passages of this case do not settle whether..."
 * is contradicted when any passage of the case states a time since the maintenance or
 * which flight it was.
 */
function judgeCriteria(input: CheckInput): FakeResult<CheckOutput> {
  return verdicts(input, (claim) => {
    if (claim.kind !== 'criterion' || !claim.text.startsWith('Under the timing rules, the supplied passages of this case do not settle')) return 'supported';
    const stating = input.passages.filter((p) => p.ntsbNo === claim.ntsbNo && STATES_CHRONOLOGY.test(p.text));
    return stating.length > 0 ? { verdict: 'contradicted', passages: [stating[0]!.passageId] } : 'supported';
  });
}

/**
 * A checker that reads the whole case, as the check prompt asks: a "no relevant
 * maintenance" claim is contradicted by a probable cause that blames a mechanic.
 */
function judge(input: CheckInput): FakeResult<CheckOutput> {
  return verdicts(input, (claim) => {
    if (claim.kind !== 'maintenance' || !claim.text.startsWith('None of the supplied passages')) return 'supported';
    const blaming = input.passages.filter((p) => p.ntsbNo === claim.ntsbNo && p.section === 'Probable cause' && /mechanic/i.test(p.text));
    return blaming.length > 0 ? { verdict: 'contradicted', passages: [blaming[0]!.passageId] } : 'supported';
  });
}

describe('POST /api/briefs: the pipeline', () => {
  it('answers with groups, validated quotes and itemized settlement', async () => {
    const h = harness(answering());
    const { started, briefId, cookie, step } = await askAndWait(h);
    expect(started.status).toBe(202);
    expect(started.json).toEqual({ kind: 'started', briefId, step: 1, stage: 'retrieve' });
    expect(step).toMatchObject({ step: 1, steps: 1, refinementsLeft: 3, stage: 'done', origin: { kind: 'question' } });
    // No blanket "passed" (Task 16d): each statement shown was checked, and the result says what was removed.
    expect(step.checklist).toEqual({
      question: 'in_scope',
      interpretation: DEFAULT_INTERPRETATION,
      searched: { cases: 4, passages: 8 },
      written: true,
      verified: 'partially_checked',
    });
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
    expect(result.interpretations).toEqual([DEFAULT_TIMING_CHIP]);
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
      dataset: { generationId, passagesIndex: dataset.passagesIndex },
      keywordText: 'engine power loss maintenance',
      text: 'Engine power loss shortly after maintenance',
      filters: {},
    });
    // The models read short passage aliases; everything stored keeps the canonical ids.
    const composeIn = h.llm.calls.find((c) => c.stage === 'compose')!.input as ComposeInput;
    expect(composeIn.cases.flatMap((c) => c.passages.map((p) => p.passageId))).toEqual(Array.from({ length: 8 }, (_, i) => `P${i + 1}`));
    const checkIn = h.llm.calls.find((c) => c.stage === 'check')!.input as CheckInput;
    expect(new Set([...checkIn.passages.map((p) => p.passageId), ...checkIn.claims.flatMap((c) => c.passageIds)])).toEqual(
      new Set(Array.from({ length: 8 }, (_, i) => `P${i + 1}`)),
    );
    expect(quote.passageId).toMatch(/^[0-9a-f]{64}$/);
    // The checker saw claims of every kind, never the question.
    const check = h.llm.calls.find((c) => c.stage === 'check')!.input as { claims: { kind: string }[] };
    expect(new Set(check.claims.map((c) => c.kind))).toEqual(new Set(['summary', 'why', 'classification', 'maintenance', 'symptom', 'criterion', 'attribution']));
    // No case states a time since its maintenance: each unconfirmed timing decision is a claim on all of its case's passages.
    expect(check.claims.filter((c) => c.kind === 'criterion')).toHaveLength(SEEDS.length);
    expect(JSON.stringify(check)).not.toContain('shortly after maintenance');

    expect(await ledgerStages()).toEqual([['scope', 'embed', 'compose', 'check']]);
    // One content-free request id per request, on every ledger line and in the step's record.
    const ids = await rows<{ request_id: string }>(sql`SELECT DISTINCT request_id FROM cost_ledger`);
    expect(ids).toEqual([{ request_id: expect.stringMatching(/^brief:[0-9a-f-]{36}$/) }]);
    expect((await stepRow(briefId)).meta).toMatchObject({ requestId: ids[0]!.request_id });
    const [res] = await reservations();
    expect(res).toMatchObject({ status: 'settled', uncertain: false, quota_counted: true });
    expect(Number(res!.charged)).toBeGreaterThan(0);
    expect(Number(res!.charged)).toBeLessThan(Number(res!.usd));
    expect(await trialUsed()).toEqual([1]);
    const row = await stepRow(briefId);
    expect(row).toMatchObject({ status: 'answered', stage: 'done', cost_usd: res!.charged });
    expect(row.meta).toMatchObject({
      promptVersions: { scope: 'scope.v2', compose: 'compose.v7', check: 'check.v7' },
      validation: { ruleVersion: 'quote-ws-v2', codes: [] },
      criteriaRules: 'chronology-rules-v2',
      check: { supported: true, claims: check.claims.length, counts: { supported: check.claims.length, contradicted: 0, not_established: 0 }, codes: [], problems: [], chronologyMissed: [] },
      display: { rules: 'display-deps-v1', mode: 'whole', shown: true, withheld: [], claimsShown: check.claims.length, removed: {}, removedKeys: [], suppressed: [] },
    });
    expect(result.check).toEqual({
      rules: 'display-deps-v1',
      status: 'partially_checked',
      shown: check.claims.length,
      removed: { summary: 0, why: 0, classification: 0, maintenance: 0, symptom: 0, timing: 0, attribution: 0, criterion: 0, gap: 0 },
      unclassified: [],
    });

    // The case context: the cited passage with its highlight, and template lines.
    const ctx = await inject<unknown>(h, 'GET', `/api/briefs/${briefId}/steps/1/cases/DFW08TA066`, { cookie });
    expect(ctx.status).toBe(200);
    const context = CaseContextResponseSchema.parse(ctx.json);
    const cited = context.passages.find((p) => p.passageId === quote.passageId)!;
    expect(cited.text.slice(cited.highlights[0]!.start, cited.highlights[0]!.end)).toBe(quote.text);
    // Each line links to the passages its own claim was checked on.
    expect(context.lines.map((l) => l.label)).toEqual(['EVIDENCE', 'MAINTENANCE', 'SYMPTOM', 'CRITERIA']);
    // Unconfirmed: labelled so, linking the passage set the claim was checked on (all of the case's).
    expect(context.lines[3]).toEqual({
      label: 'CRITERIA',
      text: 'Unconfirmed: this analysis could not establish your timing window from the supplied passages',
      passageIds: context.passages.map((p) => p.passageId),
    });
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
    expect(step.checklist).toEqual({ question: 'in_scope', interpretation: DEFAULT_INTERPRETATION, searched: { cases: 4, passages: 8 }, verified: 'withheld' });
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
    const h = harness(answering({ check: (input) => verdicts(input, (_, i) => (i === 0 ? 'not_established' : 'supported')) }));
    const { briefId, step } = await askAndWait(h);
    expect(step.result).toMatchObject({ kind: 'withheld', reason: 'evidence_check' });
    expect((await stepRow(briefId)).meta).toMatchObject({ check: { supported: false, codes: ['not_established'], problems: [{ claim: 'C1', claimIndex: 0, kind: 'summary', code: 'not_established' }] } });

    const failing = harness(answering({ check: { fail: 'truncated' } }));
    advance(MIN);
    const second = await askAndWait(failing, 'Rough running after an oil change', { cookie: null });
    expect(second.step.result).toMatchObject({ kind: 'withheld', reason: 'evidence_check' });
  });

  it('compose input over the answer input cap is re-packed with a smaller evidence budget', async () => {
    let counts = 0;
    const h = harness(answering({ counts: { compose: () => (++counts === 1 ? OVER_ANSWER_CAP : 9_000) } }));
    const { briefId, step } = await askAndWait(h);
    expect(step.result?.kind).toBe('answer');
    expect(h.retriever.repacks).toHaveLength(1);
    // The budget shrinks by the measured overshoot (the cap over the count, with a 10% margin).
    const first = (await stepRow(briefId)).meta as { repacks: number };
    expect(first).toMatchObject({ repacks: 1 });
    expect(h.retriever.repacks[0]).toBeGreaterThan(0);
    // The re-packed bundle kept whole cases only (each with its best passage and its causes).
    if (step.result?.kind === 'answer') expect(step.result.cases.length).toBeLessThan(4);
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
    expect(none.step.checklist).toEqual({ question: 'in_scope', interpretation: DEFAULT_INTERPRETATION, searched: { cases: 0, passages: 0 } });
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
        // The planner adds a number the reader never wrote: it is ignored, not listed as "not found".
        { output: scopeOut({ intent: 'case_comparison', caseNumbers: ['DFW08TA066', 'XYZ99ZZ999', 'NYC08LA106', 'ABC12CD345'], ambiguity: undefined }) },
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
  it('a text refinement’s comparison numbers come from the question and the refinement', async () => {
    const h = harness({
      scope: [
        { output: scopeOut() },
        // XYZ99ZZ999 is in neither text: the planner cannot add it.
        { output: scopeOut({ intent: 'case_comparison', caseNumbers: ['DFW08TA066', 'NYC08LA106', 'XYZ99ZZ999'], ambiguity: undefined }) },
      ],
      compose: (input) => composition(input),
      check: SUPPORTED,
    });
    const first = await askAndWait(h, 'What went wrong in DFW08TA066 after its engine change?');
    advance(MIN);
    const r = await refine(h, first.briefId, first.cookie, { kind: 'text', text: 'Compare it with NYC08LA106' });
    expect(r.json).toMatchObject({ kind: 'scope_reply', reply: { kind: 'case_comparison', found: ['DFW08TA066', 'NYC08LA106'], notFound: [] } });
  });

  it('a refinement over the query embedding cap is refused before any spend', async () => {
    const h = harness(answering());
    const first = await askAndWait(h);
    advance(MIN);
    const calls = h.sv.calls.length;
    const before = await count('reservations');
    const r = await refine(h, first.briefId, first.cookie, { kind: 'text', text: '発動機の出力が整備直後に失われた事例。'.repeat(75).slice(0, 1_500) });
    expect([r.status, (r.json as unknown as { message: string }).message]).toEqual([400, 'The question is too long to search. Shorten it and try again.']);
    expect(h.sv.calls.length).toBe(calls);
    expect(await count('reservations')).toBe(before);
  });

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
    // The first step waits in retrieval until its timeout (a failure that is not settled in
    // full, so the anonymous share keeps room for the requests below).
    const h = harness(answering(), { timeouts: { retrieve: 400 }, retriever: { hang: true } });
    const started = await ask(h, 'Engine power loss shortly after maintenance');
    const cookie = cookieOf(started.setCookie);
    const briefId = started.json.briefId;
    advance(MIN);
    const busy = await refine(h, briefId, cookie, { kind: 'text', text: 'Only airplanes' });
    expect([busy.status, busy.json && (busy.json as unknown as { error: string }).error]).toEqual([429, 'in_flight']);
    await h.svc.settled();
    h.retriever.options.hang = false;

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
    await publishManifest(ingest, generationId, dataset.casesIndex, null);
    try {
      const keywordOnly = harness(answering());
      expect((await inject<{ state: string; reason?: string }>(keywordOnly, 'GET', '/api/ai/status')).json).toMatchObject({ state: 'paused', reason: 'dependency' });
      expect((await ask(keywordOnly, 'Engine power loss')).status).toBe(503);
      expect(keywordOnly.retriever.queries).toHaveLength(0);
    } finally {
      await publishManifest(ingest, generationId, dataset.casesIndex, dataset.passagesIndex);
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

describe('hybrid retrieval behind the port', () => {
  /** The motivating question (DESIGN §3) as the scope stage reads it: 2008, keyword text for BM25. */
  const SEED_QUESTION = 'Find 2008 investigations involving engine power loss shortly after maintenance';
  const SEED_KEYWORDS = 'engine power loss maintenance overhaul replaced mechanic';
  const SEED_SCOPE = scopeOut({ filters: { yearFrom: 2008, yearTo: 2008 }, keywordText: SEED_KEYWORDS });
  const evidenceQuery = (over: Partial<EvidenceQuery> = {}): EvidenceQuery => ({
    dataset: { generationId, passagesIndex: dataset.passagesIndex },
    text: SEED_QUESTION,
    keywordText: SEED_KEYWORDS,
    filters: { yearFrom: 2008, yearTo: 2008 },
    ...over,
  });
  const live = () => new AbortController().signal;

  /**
   * The API's client with `search` observed: every request body is recorded, and
   * `tamper` may fail the n-th search (1-based) or change its response.
   */
  function searchSpy(tamper: (n: number, res: estypes.SearchResponse) => Error | void = () => undefined) {
    const bodies: estypes.SearchRequest[] = [];
    const client = new Proxy(es, {
      get(target, prop) {
        if (prop === 'search') {
          return async (body: estypes.SearchRequest, opts?: unknown) => {
            bodies.push(body);
            const n = bodies.length;
            const res = (await target.search(body, opts as never)) as estypes.SearchResponse;
            const err = tamper(n, res);
            if (err) throw err;
            return res;
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const keywordQueries = () =>
      bodies.flatMap((b) => {
        const must = (b.query?.bool?.must ?? []) as { multi_match?: { query: string } }[];
        return must.flatMap((m) => (m.multi_match ? [m.multi_match.query] : []));
      });
    return { client, bodies, keywordQueries };
  }

  /** The fixture embedder with its results changed (e.g. no usage report). */
  function embedderWith(change: (r: EmbedResult) => EmbedResult): Embedder & { calls: string[][] } {
    const base = fixtureEmbedder();
    return { ...base, calls: base.calls, embed: async (texts) => change(await base.embed(texts)) };
  }

  function failingEmbedder(err: () => Error): Embedder & { calls: number } {
    const e = { model: FIXTURE_EMBEDDING.model, dims: FIXTURE_EMBEDDING.dims, usdPerMillionTokens: 0.02, calls: 0, embed: async () => {
      e.calls += 1;
      throw err();
    } };
    return e;
  }

  async function failureOf(p: Promise<unknown>): Promise<RetrievalFailure> {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetrievalFailure);
    const f = err as RetrievalFailure;
    expect(f.message).not.toMatch(/SENTINEL|aviation-test|passages-v\d|chunk-v2/);
    return f;
  }

  it('seed question returns groups and four seed cases in fixture corpus', async () => {
    const embedder = fixtureEmbedder();
    const spy = searchSpy();
    const h = harness(answering({ scope: { output: SEED_SCOPE } }), { evidence: createHybridRetriever({ es: spy.client, embedder }) });
    expect((await inject<{ state: string }>(h, 'GET', '/api/ai/status')).json).toMatchObject({ state: 'available' });
    const { briefId, cookie, step } = await askAndWait(h, SEED_QUESTION);
    const result = step.result!;
    if (result.kind !== 'answer') throw new Error(`expected an answer, got ${result.kind}`);

    // Every US, answer-eligible 2008 case of the fixtures: the four seeds and the two-airplane SEA08LA057.
    const found = result.cases.map((c) => c.case.ntsbNo);
    expect(found).toEqual(expect.arrayContaining(SEEDS));
    expect(new Set(found)).toEqual(new Set([...SEEDS, 'SEA08LA057']));
    expect(found).not.toContain('ENG08WA029'); // 2008, but not a US event
    expect(result.grouping).toBe('mechanical');
    const groups = new Map(result.groups.map((g) => [g.kind, g.caseNumbers]));
    expect(new Set(groups.get('causal'))).toEqual(new Set(['DFW08TA066', 'NYC08LA106']));
    expect(groups.get('defect_not_causal')).toEqual(['MIA08LA156']);
    expect(groups.get('no_fault')).toEqual(['DEN08LA103']);
    expect(groups.get('insufficient')).toEqual(['SEA08LA057']);
    // Real passages passed the provenance chain and the quote rule: each quote sits at its span.
    for (const c of result.cases) {
      expect(c.reading?.quotes.length).toBeGreaterThan(0);
      for (const q of c.reading!.quotes) expect(q.span.end).toBeGreaterThan(q.span.start);
    }
    expect(step.checklist).toMatchObject({ verified: 'partially_checked', searched: { cases: 5 } });

    // The dense channel embedded the question once; BM25 searched the scope stage's keyword text.
    expect(embedder.calls).toEqual([[queryEmbeddingInput(SEED_QUESTION)]]);
    expect(spy.keywordQueries()).toEqual([SEED_KEYWORDS]);
    expect(await ledgerStages()).toEqual([['scope', 'embed', 'compose', 'check']]);
    const embed = await rows<{ model: string; tokens: unknown }>(sql`SELECT model, tokens FROM cost_ledger WHERE stage = 'embed'`);
    expect(embed).toEqual([{ model: FIXTURE_EMBEDDING.model, tokens: { input: countTokens(queryEmbeddingInput(SEED_QUESTION)) } }]);

    // The case context reads the stored passages, highlighted.
    const dfw = result.cases.find((c) => c.case.ntsbNo === 'DFW08TA066')!;
    const quote = dfw.reading!.quotes[0]!;
    const ctx = await inject<unknown>(h, 'GET', `/api/briefs/${briefId}/steps/1/cases/DFW08TA066`, { cookie });
    expect(ctx.status).toBe(200);
    const cited = CaseContextResponseSchema.parse(ctx.json).passages.find((p) => p.passageId === quote.passageId)!;
    expect(cited.text.slice(cited.highlights[0]!.start, cited.highlights[0]!.end)).toBe(quote.text);
  });

  it('settles the query embedding once, from the callback, whatever fails after it', async () => {
    const usages: EmbeddingUsage[] = [];
    const embedder = fixtureEmbedder();
    const retrieved = await createHybridRetriever({ es, embedder }).retrieve(evidenceQuery(), live(), (u) => usages.push(u));
    expect(usages).toEqual([{ provider: 'openai', model: FIXTURE_EMBEDDING.model, tokens: countTokens(queryEmbeddingInput(SEED_QUESTION)), usd: 0, billing: 'reported' }]);
    expect(retrieved.bundle.cases.map((c) => c.ntsbNo)).toEqual(expect.arrayContaining(SEEDS));
    expect(retrieved.bundle.cases.every((c) => c.passages.some((p) => p.role === 'probable_cause'))).toBe(true);
    // A re-pack reuses the candidates: a smaller bundle, no second embedding.
    const budget = Math.floor(retrieved.bundle.evidenceTokens / 2);
    const smaller = await retrieved.repack(budget, live());
    expect(smaller.evidenceTokens).toBeLessThanOrEqual(budget);
    expect(embedder.calls).toHaveLength(1);
    expect(usages).toHaveLength(1);

    // A channel, the evidence fetch or a completeness check failing after the embedding.
    const cases: [number, (res: estypes.SearchResponse) => Error | void, string][] = [
      [1, () => new errors.ConnectionError('SENTINEL_UPSTREAM'), 'search'],
      [3, () => new Error('SENTINEL_UPSTREAM'), 'other'],
      [3, (res) => void (res.timed_out = true), 'incomplete_search'],
    ];
    for (const [at, fail, reason] of cases) {
      const seen: EmbeddingUsage[] = [];
      const spy = searchSpy((n, res) => (n === at ? fail(res) : undefined));
      const f = await failureOf(createHybridRetriever({ es: spy.client, embedder: fixtureEmbedder() }).retrieve(evidenceQuery(), live(), (u) => seen.push(u)));
      expect(f).toMatchObject({ kind: 'failed', embedding: 'none', reason });
      expect(seen).toHaveLength(1);
    }

    // A usage report the provider did not give: handed on once, as uncertain.
    const seen: EmbeddingUsage[] = [];
    const unsure = embedderWith((r) => ({ ...r, usageUncertain: true }));
    await createHybridRetriever({ es, embedder: unsure }).retrieve(evidenceQuery(), live(), (u) => seen.push(u));
    expect(seen).toEqual([expect.objectContaining({ billing: 'uncertain' })]);
  });

  it('a failed embedding is settled by its own billing; refusals before it charge nothing', async () => {
    const run = async (embedder: Embedder, q: EvidenceQuery = evidenceQuery(), signal = live()) => {
      const seen: EmbeddingUsage[] = [];
      const f = await failureOf(createHybridRetriever({ es, embedder }).retrieve(q, signal, (u) => seen.push(u)));
      return { f, seen };
    };
    const provider = (billing: 'none' | 'usage' | 'uncertain', billed: number | null = null) =>
      failingEmbedder(() => new QueryEmbeddingError('SENTINEL_UPSTREAM', { kind: 'api', status: 500 }, billing, billed));

    expect(await run(provider('none'))).toMatchObject({ f: { kind: 'failed', embedding: 'none', reason: 'embedding' }, seen: [] });
    expect(await run(provider('uncertain'))).toMatchObject({ f: { kind: 'failed', embedding: 'uncertain', reason: 'embedding' }, seen: [] });
    // Processed and billed, but unusable: the provider's billed tokens, handed on once.
    const billed = await run(provider('usage', 9));
    expect(billed.f).toMatchObject({ kind: 'failed', embedding: 'none' });
    expect(billed.seen).toEqual([{ provider: 'openai', model: FIXTURE_EMBEDDING.model, tokens: 9, usd: (9 * 0.02) / 1_000_000, billing: 'reported' }]);
    // Any other failure of a called embedder may have been billed.
    expect(await run(failingEmbedder(() => new Error('SENTINEL_UPSTREAM')))).toMatchObject({ f: { embedding: 'uncertain' }, seen: [] });

    // Refused before the embedder is called: nothing sent, nothing charged, no index name passed on.
    for (const [passagesIndex, reason] of [
      [null, 'no_passages_index'],
      [dataset.casesIndex, 'index_mismatch'],
      [`${PREFIX}-missing-passages`, 'index_mismatch'],
    ] as const) {
      const embedder = failingEmbedder(() => new Error('never called'));
      const r = await run(embedder, evidenceQuery({ dataset: { generationId, passagesIndex: passagesIndex as string } }));
      expect(r).toMatchObject({ f: { kind: 'unavailable', embedding: 'none', reason }, seen: [] });
      expect(embedder.calls).toBe(0);
    }
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await run(fixtureEmbedder(), evidenceQuery(), cancelled.signal)).toMatchObject({ f: { kind: 'timeout', reason: 'aborted' } });
  });

  it('a retrieval failure after the embedding keeps one embed line; an uncertain embedding settles in full', async () => {
    const spy = searchSpy((n) => (n === 3 ? new Error('SENTINEL_UPSTREAM') : undefined));
    const h = harness(answering({ scope: { output: SEED_SCOPE } }), { evidence: createHybridRetriever({ es: spy.client, embedder: fixtureEmbedder() }) });
    const { briefId, step } = await askAndWait(h, SEED_QUESTION);
    expect(step.result).toEqual({ kind: 'failed', countedAsSearch: true });
    expect(await ledgerStages()).toEqual([['scope', 'embed']]);
    expect((await stepRow(briefId)).meta).toMatchObject({ failure: { stage: 'retrieve', category: 'failed', reason: 'other' } });
    expect(h.logs.join('\n')).not.toContain('SENTINEL');

    const unsure = harness(answering({ scope: { output: SEED_SCOPE } }), {
      evidence: createHybridRetriever({ es, embedder: embedderWith((r) => ({ ...r, usageUncertain: true })) }),
    });
    advance(MIN);
    const second = await askAndWait(unsure, SEED_QUESTION, { cookie: null });
    expect(second.step.result?.kind).toBe('answer');
    const settled = (await reservations())[1]!;
    expect(settled).toMatchObject({ status: 'settled', uncertain: true });
    expect(settled.charged).toBe(settled.usd);
    expect((await ledgerStages())[1]!.filter((s) => s === 'embed')).toHaveLength(1);
  });

  it('an embedding aborted mid-request is settled uncertain, with no usage callback', async () => {
    // The real query embedder with a provider that never answers (nothing leaves the process).
    let called = 0;
    const hanging = (async (_url: unknown, init?: RequestInit) => {
      called += 1;
      await new Promise<void>((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason as Error);
        signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
      });
      throw new Error('unreachable');
    }) as unknown as typeof fetch;
    const embedder = createOpenAIQueryEmbedder({ apiKey: 'sk-test-not-a-real-key', model: FIXTURE_EMBEDDING.model, dims: FIXTURE_EMBEDDING.dims, fetch: hanging });
    const usages: EmbeddingUsage[] = [];
    const controller = new AbortController();
    const pending = createHybridRetriever({ es, embedder }).retrieve(evidenceQuery(), controller.signal, (u) => usages.push(u));
    await until(() => called === 1);
    controller.abort();
    const failure = await failureOf(pending);
    expect(failure).toMatchObject({ kind: 'timeout', embedding: 'uncertain', reason: 'aborted' });
    expect(usages).toEqual([]);
  });

  it('offline end to end over the fixture passages index: complete evidence, criteria, citations and re-packing', async () => {
    const dfwFirst = (input: ComposeInput) => input.cases.find((c) => c.ntsbNo === 'DFW08TA066')!;
    let forceOver = false;
    const checks: CheckInput[] = [];
    const embedder = fixtureEmbedder();
    const h = harness(
      {
        scope: { output: SEED_SCOPE },
        counts: {
          compose: () => {
            if (forceOver) {
              forceOver = false;
              return OVER_ANSWER_CAP;
            }
            return 9_000;
          },
        },
        compose: [
          // 1. Astra's case: insufficient, no maintenance evidence, while the cause blames the mechanic.
          (input) => composition(input, (c) => contradict(c, dfwFirst(input))),
          // 2. An uncited summary sentence.
          (input) => composition(input, (c) => (c.summary = `Maintenance matters to every flight. ${c.summary}`)),
          // 3. After a re-pack: a clean answer.
          (input) => composition(input),
          // 4. The refinement pins one flight hour; the case is a supported 5.1 hours.
          (input) => composition(input, (c) => timing51(c, dfwFirst(input))),
        ],
        check: (input) => {
          checks.push(input);
          return judge(input);
        },
      },
      { evidence: createHybridRetriever({ es, embedder }), trialRequests: 10 },
    );

    const one = await askAndWait(h, SEED_QUESTION);
    expect(one.step.result).toMatchObject({ kind: 'withheld', reason: 'evidence_check' });
    // The checker had every passage of the case, the probable cause the composition did not quote included.
    expect(checks[0]!.passages.filter((p) => p.ntsbNo === 'DFW08TA066').map((p) => p.section)).toContain('Probable cause');
    expect((await stepRow(one.briefId)).meta).toMatchObject({ check: { problems: [{ kind: 'maintenance', code: 'contradicted' }] } });

    advance(MIN);
    const two = await askAndWait(h, SEED_QUESTION, { cookie: one.cookie });
    expect(two.step.result).toMatchObject({ kind: 'withheld', reason: 'citation_check' });
    expect((await stepRow(two.briefId)).meta).toMatchObject({ validation: { codes: ['uncited_summary'] } });
    expect(checks).toHaveLength(1);

    advance(MIN);
    forceOver = true;
    const three = await askAndWait(h, SEED_QUESTION, { cookie: one.cookie });
    expect(three.step.result?.kind).toBe('answer');
    // Re-packed by the real retriever (no second embedding), and the smaller bundle checked whole.
    expect((await stepRow(three.briefId)).meta).toMatchObject({ repacks: 1 });
    expect(embedder.calls).toHaveLength(3);
    if (three.step.result?.kind === 'answer') {
      for (const card of three.step.result.cases) expect(card.reading?.quotes.length).toBeGreaterThan(0);
    }

    advance(MIN);
    const pinned = await refine(h, three.briefId, three.cookie, { kind: 'interpretation', field: 'timing_window', value: { days: null, flightHours: 1 } });
    expect(pinned.status).toBe(202);
    await h.svc.settled();
    const four = await read(h, three.briefId, three.cookie, 2);
    expect(four.json.result).toMatchObject({ kind: 'withheld', reason: 'criteria_check' });
    expect((await stepRow(three.briefId, 2)).meta).toMatchObject({
      criteria: expect.arrayContaining([{ ntsbNo: 'DFW08TA066', criterion: 'timing_window', decision: 'does_not_match', rules: ['TW-N'] }]),
    });
    // Code refused it before the checker was asked.
    expect(checks).toHaveLength(2);
  });

  it('AI stays off unless the dataset reports the passages index servable, and never says why', async () => {
    const refused = async (h: Harness) => {
      expect((await inject<{ state: string; reason?: string }>(h, 'GET', '/api/ai/status')).json).toMatchObject({ state: 'paused', reason: 'dependency' });
      const r = await ask(h, SEED_QUESTION);
      expect(r.status).toBe(503);
      expect(r.json).toEqual({ error: 'unavailable', message: expect.any(String) });
      expect(JSON.stringify(r.json)).not.toMatch(/aviation-test|passages|index/i);
      expect(h.sv.calls).toHaveLength(0);
      expect(h.retriever.queries).toHaveLength(0);
    };
    // The index breaks the contract for the configured dimensions (incompatible), or no embedding is configured.
    const wrongDims = harness(answering(), { embedding: { model: FIXTURE_EMBEDDING.model, dims: 512 } });
    await refused(wrongDims);
    expect(wrongDims.logs.some((l) => l.includes('passages index not servable') && l.includes('"code":"incompatible"'))).toBe(true);
    await refused(harness(answering(), { embedding: null }));

    // No servable dataset at all (the cases index is gone): the same refusal, nothing logged about it.
    const missing = `${PREFIX}-missing-cases`;
    await publishManifest(ingest, generationId, missing, dataset.passagesIndex);
    try {
      const gone = harness(answering());
      await refused(gone);
      expect(gone.logs.join('\n')).not.toContain(missing);
    } finally {
      await publishManifest(ingest, generationId, dataset.casesIndex, dataset.passagesIndex);
    }
    const ok = harness(answering());
    expect((await inject<{ state: string }>(ok, 'GET', '/api/ai/status')).json).toMatchObject({ state: 'available' });
  });
});

describe('cancel and expiry', () => {
  it('cancel ends the running step and keeps the search; it is logged and traced as cancelled, not as a failure', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = startTracing(tracingConfig(), { exporter, scheduledDelayMillis: 10 });
    try {
      const h = harness(answering({ compose: { hang: true } }), { timeouts: { compose: 20_000 } });
      const started = await ask(h, 'Engine power loss shortly after maintenance');
      const cookie = cookieOf(started.setCookie);
      // Deterministic: cancel only once the provider has the compose call (it hangs there).
      await until(() => h.llm.calls.some((c) => c.stage === 'compose'));
      const running = await read(h, started.json.briefId, cookie);
      expect(running.json).toMatchObject({ stage: 'compose', finishedAt: null });
      expect(running.json.result).toBeUndefined();
      const c = await inject(h, 'POST', `/api/briefs/${started.json.briefId}/cancel`, { cookie });
      expect(c.status).toBe(204);
      await h.svc.settled();
      const step = await read(h, started.json.briefId, cookie);
      expect(step.json).toMatchObject({ stage: 'failed', result: { kind: 'cancelled' } });
      expect(await trialUsed()).toEqual([1]);
      // The aborted compose call may have been billed: settled in full.
      expect(await reservations()).toMatchObject([{ status: 'settled', uncertain: true }]);
      // A reader's cancel has no failure category: not in the meta, the log line or the spans.
      const row = await stepRow(started.json.briefId);
      expect(row.status).toBe('cancelled');
      expect(row.meta).not.toHaveProperty('failure');
      const finished = h.logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'brief step finished');
      expect(finished).toMatchObject({ status: 'cancelled' });
      expect(finished).not.toHaveProperty('failure');
      await new Promise((r) => setTimeout(r, 100));
      const spans = exporter.getFinishedSpans();
      const compose = spans.find((sp) => sp.name === 'brief.compose')!;
      expect(compose.attributes).toMatchObject({ outcome: 'cancelled' });
      expect(compose.attributes).not.toHaveProperty('failure');
      // Not an error either: the stopped span ends with its status unset.
      expect(compose.status.code).toBe(SpanStatusCode.UNSET);
      const root = spans.find((sp) => sp.name === 'brief.step')!;
      expect(root.attributes).toMatchObject({ outcome: 'cancelled' });
      expect(root.attributes).not.toHaveProperty('failure');
      expect(root.status.code).toBe(SpanStatusCode.UNSET);
    } finally {
      await tracing.shutdown();
    }
  });

  it('a cancel during the check is not a failure either', async () => {
    const h = harness(answering({ check: { hang: true } }), { timeouts: { check: 20_000 } });
    const started = await ask(h, 'Engine power loss shortly after maintenance');
    const cookie = cookieOf(started.setCookie);
    await until(() => h.llm.calls.some((c) => c.stage === 'check'));
    expect((await inject(h, 'POST', `/api/briefs/${started.json.briefId}/cancel`, { cookie })).status).toBe(204);
    await h.svc.settled();
    expect((await read(h, started.json.briefId, cookie)).json.result).toEqual({ kind: 'cancelled' });
    const row = await stepRow(started.json.briefId);
    expect(row.status).toBe('cancelled');
    expect(row.meta).not.toHaveProperty('failure');
  });

  it('an expired brief is gone for its owner too', async () => {
    const h = harness(answering());
    const { briefId, cookie } = await askAndWait(h);
    advance(24 * 60 * MIN + 1);
    expect((await read(h, briefId, cookie)).status).toBe(404);
  });
});

/** A promise the test opens: a scripted stage waits on it, so reads see the step mid-run. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describe('checklist interpretation: the chips stay on top while a step runs (UI_DESIGN §4.4)', () => {
  it('once the scope stage is done, a running step carries its readings and filters as server templates; done, they are the result’s', async () => {
    const writing = gate();
    const checking = gate();
    const h = harness(
      answering({
        scope: { output: scopeOut({ filters: { injury: ['FATL'] }, keywordText: 'planner-written keyword text' }) },
        compose: async (input) => {
          await writing.opened;
          return composition(input);
        },
        check: async (input) => {
          await checking.opened;
          return SUPPORTED(input);
        },
      }),
    );
    // The question's own filters win per facet over the planner's.
    const started = await ask(h, 'Engine power loss shortly after maintenance', { filters: { category: ['AIR'] } });
    expect(started.json).toMatchObject({ kind: 'started', step: 1, stage: 'retrieve' });
    const cookie = cookieOf(started.setCookie);
    const { briefId } = started.json;
    const interpretation = { interpretations: [DEFAULT_TIMING_CHIP], filters: { injury: ['FATL'], category: ['AIR'] } };

    await until(() => h.llm.calls.some((c) => c.stage === 'compose'));
    const composing = await read(h, briefId, cookie, 1);
    expect(composing.json).toMatchObject({ stage: 'compose', finishedAt: null });
    expect(composing.json.result).toBeUndefined();
    expect(composing.json.checklist).toEqual({ question: 'in_scope', interpretation, searched: { cases: 4, passages: 8 } });
    // Templates only: each label is a reading template, and nothing the planner wrote is sent.
    const templates = clarificationTemplateLabels();
    for (const { label } of composing.json.checklist.interpretation!.interpretations) {
      expect(templates.fixed.includes(label) || templates.patterns.some((p) => p.test(label)), label).toBe(true);
    }
    expect(JSON.stringify(composing.json)).not.toContain('planner-written');

    writing.open();
    await until(() => h.llm.calls.some((c) => c.stage === 'check'));
    const validating = await read(h, briefId, cookie);
    expect(validating.json).toMatchObject({ stage: 'validate', finishedAt: null });
    expect(validating.json.checklist).toEqual({ question: 'in_scope', interpretation, searched: { cases: 4, passages: 8 }, written: true });

    checking.open();
    await h.svc.settled();
    const done = (await read(h, briefId, cookie)).json;
    expect(done).toMatchObject({ stage: 'done', checklist: { verified: 'passed' }, result: { kind: 'answer' } });
    if (done.result?.kind !== 'answer') throw new Error(`expected an answer, got ${done.result?.kind}`);
    expect(done.checklist.interpretation).toEqual({ interpretations: done.result.interpretations, filters: done.result.filters });
    expect(done.checklist.interpretation).toEqual(interpretation);
  });

  it('before its scope stage is done a step has none; a refinement then carries its own', async () => {
    const scoping = gate();
    const writing = gate();
    const h = harness(
      answering({
        scope: [
          { output: scopeOut({ filters: { injury: ['FATL'] } }) },
          async () => {
            await scoping.opened;
            return { output: scopeOut() };
          },
        ],
        compose: [
          (input) => composition(input),
          async (input) => {
            await writing.opened;
            return composition(input);
          },
        ],
      }),
    );
    const first = await askAndWait(h);
    const firstInterpretation = { interpretations: [DEFAULT_TIMING_CHIP], filters: { injury: ['FATL'] } };
    expect(first.step.checklist.interpretation).toEqual(firstInterpretation);
    advance(MIN);

    // The refine request waits for its scope stage; the step is read meanwhile.
    const refining = refine(h, first.briefId, first.cookie, { kind: 'interpretation', field: 'failure_type', value: 'total_power_loss' });
    await until(() => h.llm.calls.filter((c) => c.stage === 'scope').length === 2);
    for (const n of [2, undefined]) {
      const scope = await read(h, first.briefId, first.cookie, n);
      expect(scope.json).toMatchObject({ step: 2, steps: 2, stage: 'scope', finishedAt: null });
      expect(scope.json.checklist).toEqual({});
    }

    scoping.open();
    expect((await refining).json).toMatchObject({ kind: 'started', step: 2, stage: 'retrieve' });
    await until(() => h.llm.calls.filter((c) => c.stage === 'compose').length === 2);
    // The refinement's own readings (the reader's pick, pinned) and the filters it kept.
    const interpretation = {
      interpretations: [DEFAULT_TIMING_CHIP, { field: 'failure_type', value: 'total_power_loss', label: FAILURE_TYPE_LABELS.total_power_loss, pinned: true }],
      filters: { injury: ['FATL'] },
    };
    const composing = await read(h, first.briefId, first.cookie, 2);
    expect(composing.json).toMatchObject({ stage: 'compose', finishedAt: null });
    expect(composing.json.checklist).toEqual({ question: 'in_scope', interpretation, searched: { cases: 4, passages: 8 } });
    // The earlier step keeps its own.
    expect((await read(h, first.briefId, first.cookie, 1)).json.checklist.interpretation).toEqual(firstInterpretation);

    writing.open();
    await h.svc.settled();
    const done = (await read(h, first.briefId, first.cookie, 2)).json;
    expect(done).toMatchObject({ stage: 'done', result: { kind: 'answer' } });
    if (done.result?.kind !== 'answer') throw new Error(`expected an answer, got ${done.result?.kind}`);
    expect(done.checklist.interpretation).toEqual({ interpretations: done.result.interpretations, filters: done.result.filters });
    expect(done.checklist.interpretation).toEqual(interpretation);
  });

  it('a step cancelled or failed after its scope stage keeps them (Try again asks with those filters)', async () => {
    const interpretation = { interpretations: [DEFAULT_TIMING_CHIP], filters: { injury: ['FATL'] } };
    const script = answering({ scope: { output: scopeOut({ filters: { injury: ['FATL'] } }) } });
    // Cancelled while searching.
    const h = harness(script, { retriever: { hang: true }, timeouts: { retrieve: 20_000 } });
    const started = await ask(h, 'Engine power loss shortly after maintenance');
    const cookie = cookieOf(started.setCookie);
    await until(() => h.retriever.queries.length === 1);
    const searching = await read(h, started.json.briefId, cookie);
    expect(searching.json).toMatchObject({ stage: 'retrieve', finishedAt: null });
    expect(searching.json.checklist).toEqual({ question: 'in_scope', interpretation });
    expect((await inject(h, 'POST', `/api/briefs/${started.json.briefId}/cancel`, { cookie })).status).toBe(204);
    await h.svc.settled();
    const cancelled = (await read(h, started.json.briefId, cookie)).json;
    expect(cancelled).toMatchObject({ stage: 'failed', result: { kind: 'cancelled' } });
    expect(cancelled.checklist).toEqual({ question: 'in_scope', interpretation });

    // Failed in retrieval.
    const failing = harness(script, { retriever: { fail: { failure: new RetrievalFailure('failed', 'none'), afterEmbedding: true } } });
    advance(MIN);
    const failed = await askAndWait(failing, 'Engine power loss shortly after maintenance', { cookie: null });
    expect(failed.step).toMatchObject({ stage: 'failed', result: { kind: 'failed' } });
    expect(failed.step.checklist).toEqual({ question: 'in_scope', interpretation });
  });

  it('a static reply or a failed scope stage has none', async () => {
    const h = harness({
      scope: [{ output: scopeOut({ intent: 'out_of_scope', mechanicalCause: false, keywordText: '', ambiguity: undefined }) }, { fail: 'refusal' }],
    });
    const reply = await ask(h, 'Write me a poem about the sea');
    expect(reply.json).toMatchObject({ kind: 'scope_reply' });
    const cookie = cookieOf(reply.setCookie);
    await h.svc.settled();
    const replied = (await read(h, reply.json.briefId, cookie)).json;
    expect(replied).toMatchObject({ stage: 'done', result: { kind: 'scope_reply' } });
    expect(replied.checklist).toEqual({});

    advance(MIN);
    const refused = await ask(h, 'Engine power loss shortly after maintenance', { cookie });
    expect(refused.json).toMatchObject({ kind: 'started', stage: 'failed' });
    await h.svc.settled();
    const failed = (await read(h, refused.json.briefId, cookie)).json;
    expect(failed).toMatchObject({ stage: 'failed', result: { kind: 'failed' } });
    expect(failed.checklist).toEqual({});
  });

  it('a stored reading that would not render to the contract is left out, and the read still answers', async () => {
    const h = harness(answering());
    const first = await askAndWait(h);
    const { reservation_id: reservation, billing_principal: billing } = (
      await rows<{ reservation_id: number; billing_principal: string }>(
        sql`SELECT reservation_id::int AS reservation_id, billing_principal FROM brief_steps WHERE brief_id = ${first.briefId}::uuid AND n = 1`,
      )
    )[0]!;
    // A running step past its scope stage whose stored reading is out of the contract's range.
    const request = JSON.stringify({ origin: 'text', question: 'q', refinement: 'r', readings: {} });
    const checklist = JSON.stringify({ question: 'in_scope', searched: { cases: 4, passages: 8 } });
    const intent = JSON.stringify({
      intent: 'case_search',
      mechanicalCause: true,
      filters: {},
      keywordText: 'k',
      readings: { timingWindow: { value: { days: 0, flightHours: null }, pinned: false } },
      caseNumbers: [],
    });
    await migrator.execute(sql`
      INSERT INTO brief_steps (brief_id, n, billing_principal, billing_kind, reservation_id, request, created_at, updated_at)
      VALUES (${first.briefId}::uuid, 2, ${billing}, 'trial', ${reservation}, ${request}::jsonb, ${clock}, ${clock})`);
    await appDb.execute(sql`
      UPDATE brief_steps SET stage = 'compose', checklist = ${checklist}::jsonb, intent = ${intent}::jsonb
      WHERE brief_id = ${first.briefId}::uuid AND n = 2`);
    const r = await read(h, first.briefId, first.cookie, 2);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ step: 2, stage: 'compose', finishedAt: null });
    expect(r.json.checklist).toEqual({ question: 'in_scope', searched: { cases: 4, passages: 8 } });
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
    expect(await sqlState(appDb.execute(sql`UPDATE brief_steps SET diagnostics = '{}'::jsonb`))).toBe('55000');
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
    // A step with diagnostics: they share its row, so they go with the brief.
    await migrator.execute(sql`
      INSERT INTO brief_steps (brief_id, n, billing_principal, billing_kind, reservation_id, request, diagnostics, created_at, updated_at)
      VALUES (${inserted[0]!.id}::uuid, 1, ${owner}, 'trial', 1, '{"origin":"question"}'::jsonb, '{"reason":"citation_check"}'::jsonb, ${past}, ${past})`);
    const report = await pruneControls(appDb);
    expect(report).toMatchObject({ briefs: 1, briefSteps: 1 });
    expect(await count('briefs')).toBe(0);
    expect(await count('brief_steps')).toBe(0);
  });
});

describe('gate G6: evidence semantics through the routes', () => {
  it('insufficient + no maintenance evidence against a maintenance-caused probable cause → withheld', async () => {
    const checks: CheckInput[] = [];
    const h = harness(
      answering({
        compose: (input) => composition(input, (c) => contradict(c, input.cases.find((x) => x.ntsbNo === 'DFW08TA066')!)),
        check: (input) => {
          checks.push(input);
          return judge(input);
        },
      }),
    );
    const { briefId, step } = await askAndWait(h);
    expect(step.result).toMatchObject({ kind: 'withheld', reason: 'evidence_check' });
    // The composition quoted only the analysis; the checker still had the cause, and the claim cites it.
    const dfw = checks[0]!.passages.filter((p) => p.ntsbNo === 'DFW08TA066');
    expect(dfw.map((p) => p.section)).toEqual(['Analysis', 'Probable cause']);
    const claim = checks[0]!.claims.find((c) => c.kind === 'maintenance' && c.ntsbNo === 'DFW08TA066')!;
    expect(claim.passageIds).toEqual(dfw.map((p) => p.passageId));
    expect((await stepRow(briefId)).meta).toMatchObject({ check: { supported: false, problems: [{ kind: 'maintenance', code: 'contradicted' }] } });
  });

  it('a supported 5.1 flight hours under a pinned within-one-flight-hour reading is not presented as a match', async () => {
    const h = harness(
      answering({
        compose: [(input) => composition(input), (input) => composition(input, (c) => timing51(c, input.cases.find((x) => x.ntsbNo === 'DFW08TA066')!))],
      }),
    );
    const first = await askAndWait(h);
    expect(first.step.result?.kind).toBe('answer');
    advance(MIN);
    const r = await refine(h, first.briefId, first.cookie, { kind: 'interpretation', field: 'timing_window', value: { days: null, flightHours: 1 } });
    expect(r.status).toBe(202);
    await h.svc.settled();
    const step = await read(h, first.briefId, first.cookie, 2);
    expect(step.json.result).toMatchObject({ kind: 'withheld', reason: 'criteria_check' });
    expect((await stepRow(first.briefId, 2)).meta).toMatchObject({
      criteria: expect.arrayContaining([{ ntsbNo: 'DFW08TA066', criterion: 'timing_window', decision: 'does_not_match', rules: ['TW-N'] }]),
    });
    // The pinned reading was enforced in code: the checker was never asked about step 2.
    expect(h.llm.calls.filter((c) => c.stage === 'check')).toHaveLength(1);
    // A case whose timing the passages do not settle is shown, labelled unconfirmed.
    if (first.step.result?.kind === 'answer') {
      expect(first.step.result.cases[0]!.reading?.criteria).toEqual([{ criterion: 'timing_window', decision: 'unconfirmed' }]);
    }
  });

  it('G6 regression (a): 5.1 hours stated, a one-hour reading and no stated fact: the unknown decision is checked on every passage and fails', async () => {
    const checks: CheckInput[] = [];
    const h = harness(
      answering({
        scope: { output: scopeOut({ ambiguity: { type: 'timing_window', values: ['1h'] } }) },
        check: (input) => {
          checks.push(input);
          return judgeCriteria(input);
        },
      }),
    );
    const { briefId, step } = await askAndWait(h);
    // The composition stated no chronology: that settles nothing, and the checker rejects "not established".
    expect(step.result).toMatchObject({ kind: 'withheld', reason: 'evidence_check' });
    const dfw = checks[0]!.passages.filter((p) => p.ntsbNo === 'DFW08TA066');
    expect(dfw.some((p) => p.text.includes('5.1 hours'))).toBe(true);
    const claim = checks[0]!.claims.find((c) => c.kind === 'criterion' && c.ntsbNo === 'DFW08TA066')!;
    expect(claim).toEqual({
      id: expect.stringMatching(/^C\d+$/),
      kind: 'criterion',
      ntsbNo: 'DFW08TA066',
      text: 'Under the timing rules, the supplied passages of this case do not settle whether the event happened within 1 flight hour after the relevant maintenance.',
      passageIds: dfw.map((p) => p.passageId),
      absence: true,
    });
    // No criteria lines in the check input (Task 16d): the criterion claim states its own; each case has its server header.
    expect(checks[0]!).not.toHaveProperty('criteria');
    expect(checks[0]!.cases.map((c) => c.ntsbNo)).toContain('DFW08TA066');
    const meta = (await stepRow(briefId)).meta;
    expect(meta).toMatchObject({
      criteria: expect.arrayContaining([{ ntsbNo: 'DFW08TA066', criterion: 'timing_window', decision: 'unknown', rules: [], reason: 'unstated' }]),
      check: {
        supported: false,
        codes: ['contradicted', 'chronology_missed'],
        problems: expect.arrayContaining([{ claim: claim.id, claimIndex: expect.any(Number), kind: 'criterion', code: 'chronology_missed' }]),
        // NYC08LA106's passages state 12 hours since its installation too: also contradicted.
        chronologyMissed: expect.arrayContaining([{ claim: claim.id, ntsbNo: 'DFW08TA066', criterion: 'timing_window' }]),
      },
    });
    // Diagnostic only: still withheld, and no repair call was made.
    expect(h.llm.calls.map((c) => c.stage)).toEqual(['scope', 'compose', 'check']);
    // In whole mode (the default until G6) anything removed withholds the summary.
    expect(finishedLine(h)).toMatchObject({ withheld: { reason: 'evidence_check', codes: expect.arrayContaining(['contradicted', 'chronology_missed', 'display_whole_brief']) } });
    expect(await reportOf(briefId)).toContain('chronology_missed: DFW08TA066 timing_window');
  });

  it('G6 regression (b): a stated later flight fails first-flight-only; left out, the unknown decision fails the check', async () => {
    const checks: CheckInput[] = [];
    /** NYC08LA106 after its fuel pump: 12 hours since installation, and it departed again. */
    const nycLater = (c: ComposeOutput, input: ComposeInput, withFlight: boolean) => {
      const nyc = input.cases.find((x) => x.ntsbNo === 'NYC08LA106')!;
      const stating = nyc.passages.find((p) => STATES_CHRONOLOGY.test(p.text)) ?? nyc.passages[0]!;
      c.cases.find((x) => x.ntsbNo === 'NYC08LA106')!.chronology = {
        maintenance: 'the fuel pump installation',
        facts: [
          { anchor: 'relevant_maintenance', relation: 'flight_hours', value: 12, bound: 'exact', passageIds: [stating.passageId] },
          ...(withFlight ? [{ anchor: 'relevant_maintenance' as const, relation: 'flight_ordinal' as const, value: 2, passageIds: [stating.passageId] }] : []),
        ],
      };
    };
    const h = harness(
      answering({
        scope: { output: scopeOut({ ambiguity: { type: 'timing_window', values: ['first_flight'] } }) },
        compose: [(input) => composition(input, (c) => nycLater(c, input, true)), (input) => composition(input, (c) => nycLater(c, input, false))],
        check: (input) => {
          checks.push(input);
          return judgeCriteria(input);
        },
      }),
    );
    const first = await askAndWait(h);
    expect(first.step.result).toMatchObject({ kind: 'withheld', reason: 'criteria_check' });
    expect((await stepRow(first.briefId)).meta).toMatchObject({
      criteria: expect.arrayContaining([{ ntsbNo: 'NYC08LA106', criterion: 'first_flight_only', decision: 'does_not_match', rules: ['FF-O'] }]),
    });
    expect(checks).toHaveLength(0);
    advance(MIN);
    const second = await askAndWait(h, 'Engine power loss shortly after maintenance', { cookie: null });
    expect(second.step.result).toMatchObject({ kind: 'withheld', reason: 'evidence_check' });
    const claim = checks[0]!.claims.find((c) => c.kind === 'criterion' && c.ntsbNo === 'NYC08LA106')!;
    expect(claim.text).toBe(
      'Under the timing rules, the supplied passages of this case do not settle whether the event happened on the first flight after the relevant maintenance (the fuel pump installation).',
    );
    expect(claim.passageIds).toEqual(checks[0]!.passages.filter((p) => p.ntsbNo === 'NYC08LA106').map((p) => p.passageId));
    expect((await stepRow(second.briefId)).meta).toMatchObject({
      check: { problems: expect.arrayContaining([{ claim: claim.id, claimIndex: expect.any(Number), kind: 'criterion', code: 'contradicted' }]) },
    });
  });

  it('G6 regression (c): 40 days and 20 flight hours against the default 30 days OR 10 hours do not match', async () => {
    const h = harness(
      answering({
        compose: (input) =>
          composition(input, (c) => {
            const p = input.cases.find((x) => x.ntsbNo === 'DFW08TA066')!.passages[0]!;
            c.cases.find((x) => x.ntsbNo === 'DFW08TA066')!.chronology = {
              maintenance: 'the engine replacement',
              facts: [
                { anchor: 'relevant_maintenance', relation: 'calendar_days', value: 40, bound: 'exact', passageIds: [p.passageId] },
                { anchor: 'relevant_maintenance', relation: 'flight_hours', value: 20, bound: 'exact', passageIds: [p.passageId] },
              ],
            };
          }),
      }),
    );
    const { briefId, step } = await askAndWait(h);
    expect(step.result).toMatchObject({ kind: 'withheld', reason: 'criteria_check' });
    expect((await stepRow(briefId)).meta).toMatchObject({
      criteria: expect.arrayContaining([{ ntsbNo: 'DFW08TA066', criterion: 'timing_window', decision: 'does_not_match', rules: ['TW-N'] }]),
    });
    expect(h.llm.calls.some((c) => c.stage === 'check')).toBe(false);
    // Diagnosable: the failed criterion is the withheld code; the developer's command shows the case's chronology.
    expect(finishedLine(h)).toMatchObject({ withheld: { reason: 'criteria_check', codes: ['timing_window'] } });
    expect(await diagnosticsOf(briefId)).toMatchObject({ reason: 'criteria_check' });
    const report = await reportOf(briefId);
    expect(report).toContain('DFW08TA066 timing_window: does_not_match');
    expect(report).toMatch(/chronology: .*"value":40,[^}]*"relation":"calendar_days"/);
    // The whole AI summary is withheld, not just that case: every retrieved case is a plain NTSB card.
    if (step.result?.kind !== 'withheld') throw new Error('expected a withheld summary');
    expect(step.result.cases.map((c) => [c.case.ntsbNo, c.reading])).toEqual(SEEDS.map((n) => [n, null]));
    expect(step.result).not.toHaveProperty('summary');
  });

  it('G6 #2: an approximate value is shown unconfirmed, never as within the window', async () => {
    const checks: CheckInput[] = [];
    const h = harness(
      answering({
        scope: { output: scopeOut({ ambiguity: { type: 'timing_window', values: ['9h'] } }) },
        compose: (input) =>
          composition(input, (c) => {
            const p = input.cases.find((x) => x.ntsbNo === 'DFW08TA066')!.passages[0]!;
            c.cases.find((x) => x.ntsbNo === 'DFW08TA066')!.chronology = chronologyOf('the engine replacement', p.passageId, { relation: 'flight_hours', value: 8, bound: 'about' });
          }),
        check: (input) => {
          checks.push(input);
          return SUPPORTED(input);
        },
      }),
    );
    const { briefId, cookie, step } = await askAndWait(h);
    const result = step.result!;
    if (result.kind !== 'answer') throw new Error(`expected an answer, got ${result.kind}`);
    const dfw = result.cases.find((c) => c.case.ntsbNo === 'DFW08TA066')!.reading!;
    expect(dfw.timing).toEqual([{ basis: 'flight_hours', value: 8, bound: 'about', label: '≈ 8 FH' }]);
    expect(dfw.criteria).toEqual([{ criterion: 'timing_window', decision: 'unconfirmed' }]);
    expect(result.summary).toContainEqual({ kind: 'case', ntsbNo: 'DFW08TA066', unconfirmed: true });
    expect(checks[0]!.claims.filter((c) => c.kind === 'criterion' && c.ntsbNo === 'DFW08TA066').map((c) => c.text)).toEqual([
      'Under the timing rules, the supplied passages of this case do not settle whether the event happened within 9 flight hours after the relevant maintenance (the engine replacement).',
    ]);
    const ctx = CaseContextResponseSchema.parse((await inject(h, 'GET', `/api/briefs/${briefId}/steps/1/cases/DFW08TA066`, { cookie })).json);
    expect(ctx.lines.filter((l) => l.label === 'TIMING' || l.label === 'CRITERIA').map((l) => l.text)).toEqual([
      'About 8 flight hours after the maintenance (the engine replacement)',
      'Unconfirmed: this analysis could not establish your timing window from the supplied passages',
    ]);
    expect(JSON.stringify(ctx.lines)).not.toContain('Within your timing window');
  });

  it('timing rules: "immediately before the flight" matches by rule TW-I, never as zero days; a time from another anchor decides nothing', async () => {
    const checks: CheckInput[] = [];
    const h = harness(
      answering({
        compose: (input) =>
          composition(input, (c) => {
            const p = (n: string) => input.cases.find((x) => x.ntsbNo === n)!.passages[0]!.passageId;
            c.cases.find((x) => x.ntsbNo === 'DFW08TA066')!.chronology = chronologyOf('the engine replacement', p('DFW08TA066'), { relation: 'immediately_before' });
            // "The accident flight was conducted 2 days later", after the earlier flights: its own antecedent.
            c.cases.find((x) => x.ntsbNo === 'NYC08LA106')!.chronology = chronologyOf('the fuel pump installation', p('NYC08LA106'), {
              anchor: 'other',
              other: 'the earlier test flights',
              relation: 'calendar_days',
              value: 2,
              bound: 'exact',
            });
          }),
        check: (input) => {
          checks.push(input);
          return SUPPORTED(input);
        },
      }),
    );
    const { briefId, cookie, step } = await askAndWait(h);
    const result = step.result!;
    if (result.kind !== 'answer') throw new Error(`expected an answer, got ${result.kind}`);
    const reading = (n: string) => result.cases.find((c) => c.case.ntsbNo === n)!.reading!;
    expect(reading('DFW08TA066').timing).toEqual([{ basis: 'immediately_before', value: null, bound: 'exact', label: 'IMMEDIATELY BEFORE' }]);
    expect(reading('DFW08TA066').criteria).toEqual([{ criterion: 'timing_window', decision: 'matches' }]);
    // The fact from another anchor is neither shown nor decisive.
    expect(reading('NYC08LA106').timing).toEqual([]);
    expect(reading('NYC08LA106').criteria).toEqual([{ criterion: 'timing_window', decision: 'unconfirmed' }]);
    expect((await stepRow(briefId)).meta).toMatchObject({
      criteriaRules: 'chronology-rules-v2',
      criteria: expect.arrayContaining([
        { ntsbNo: 'DFW08TA066', criterion: 'timing_window', decision: 'matches', rules: ['TW-I'] },
        { ntsbNo: 'NYC08LA106', criterion: 'timing_window', decision: 'unknown', rules: [], reason: 'other_anchor' },
      ]),
    });
    // Both decisions are claims the checker judged, under the timing rules and naming the maintenance.
    const texts = checks[0]!.claims.filter((c) => c.kind === 'criterion' || c.kind === 'timing').map((c) => [c.ntsbNo, c.text]);
    expect(texts).toEqual(
      expect.arrayContaining([
        ['DFW08TA066', 'The relevant maintenance (the engine replacement) was completed immediately before the flight on which the event happened.'],
        ['DFW08TA066', 'Under the timing rules, the event happened within 30 calendar days or 10 flight hours after the relevant maintenance (the engine replacement).'],
        [
          'NYC08LA106',
          'Under the timing rules, the supplied passages of this case do not settle whether the event happened within 30 calendar days or 10 flight hours after the relevant maintenance (the fuel pump installation).',
        ],
      ]),
    );
    expect(JSON.stringify(checks[0]!.claims)).not.toMatch(/\b0 calendar days|\b0 flight hours|\b2 calendar days/);
    const ctx = CaseContextResponseSchema.parse((await inject(h, 'GET', `/api/briefs/${briefId}/steps/1/cases/DFW08TA066`, { cookie })).json);
    expect(ctx.lines.filter((l) => l.label === 'TIMING' || l.label === 'CRITERIA').map((l) => l.text)).toEqual([
      'On the flight that began immediately after the maintenance (the engine replacement)',
      'Within your timing window',
    ]);
  });

  it('G6 #3: a semantic failure-type decision (no structured symptom) keeps and links its checked passages', async () => {
    const checks: CheckInput[] = [];
    const h = harness(
      answering({
        scope: { output: scopeOut({ ambiguity: { type: 'failure_type', values: ['total_power_loss'] } }) },
        compose: (input) =>
          composition(input, (c) => {
            for (const k of c.cases) delete k.symptom;
          }),
        check: (input) => {
          checks.push(input);
          return SUPPORTED(input);
        },
      }),
    );
    const { briefId, cookie, step } = await askAndWait(h);
    const result = step.result!;
    if (result.kind !== 'answer') throw new Error(`expected an answer, got ${result.kind}`);
    expect(result.cases.find((c) => c.case.ntsbNo === 'DFW08TA066')!.reading!.criteria).toEqual([{ criterion: 'failure_type', decision: 'matches' }]);
    const claim = checks[0]!.claims.find((c) => c.kind === 'criterion' && c.ntsbNo === 'DFW08TA066')!;
    expect(claim.text).toBe('This event involved a total loss of engine power.');
    // The claim cites every DFW passage (by the aliases the checker reads)...
    expect(claim.passageIds).toEqual(checks[0]!.passages.filter((p) => p.ntsbNo === 'DFW08TA066').map((p) => p.passageId));
    const ctx = CaseContextResponseSchema.parse((await inject(h, 'GET', `/api/briefs/${briefId}/steps/1/cases/DFW08TA066`, { cookie })).json);
    expect(ctx.lines.find((l) => l.label === 'SYMPTOM')).toBeUndefined();
    // ...and the line links the same passages, by their canonical ids.
    const line = ctx.lines.find((l) => l.label === 'CRITERIA')!;
    expect(line).toEqual({ label: 'CRITERIA', text: 'The failure you asked about', passageIds: ctx.passages.map((p) => p.passageId) });
  });

  it('the bundle is checked under the chunker of the served index’s contract', async () => {
    const h = harness(answering());
    const ok = await askAndWait(h);
    expect(ok.step.result?.kind).toBe('answer');
    expect((await stepRow(ok.briefId)).meta).toMatchObject({ chunkerVersion: (await servedContract(dataset)).chunkerVersion });
    // A port reporting another chunker: no canonical row under it holds these passages.
    const fake = new FakeRetriever(appDb, { cases: SEEDS, served: servedContract });
    const other: EvidenceRetriever = {
      available: (d) => fake.available(d),
      retrieve: async (q, signal, onUsage) => ({ ...(await fake.retrieve(q, signal, onUsage)), chunkerVersion: 'chunk-other' }),
    };
    const h2 = harness(answering(), { evidence: other });
    advance(MIN);
    const refused = await askAndWait(h2, 'Engine power loss shortly after maintenance', { cookie: null });
    expect(refused.step.result).toEqual({ kind: 'failed', countedAsSearch: true });
    expect((await stepRow(refused.briefId)).meta).toMatchObject({
      chunkerVersion: 'chunk-other',
      failure: { stage: 'retrieve', category: 'integrity', reason: 'no_passage' },
    });
  });

  it('a result outside its contract fails the step cleanly and still settles', async () => {
    const h = harness(answering(), {
      catalog: (real) => ({
        ...real,
        async summaries(g, numbers) {
          const m = await real.summaries(g, numbers);
          const dfw = m.get('DFW08TA066');
          // A card field the result contract refuses (an empty report label).
          if (dfw) m.set('DFW08TA066', { ...dfw, report: { ...dfw.report, label: '' } as typeof dfw.report });
          return m;
        },
      }),
    });
    const { briefId, step } = await askAndWait(h);
    expect(step.result).toEqual({ kind: 'failed', countedAsSearch: true });
    expect(await stepRow(briefId)).toMatchObject({ status: 'failed', stage: 'failed', meta: { failure: { stage: 'pipeline', category: 'result_contract' } } });
    expect(await reservations()).toMatchObject([{ status: 'settled', uncertain: false }]);
    expect(await ledgerStages()).toEqual([['scope', 'embed', 'compose', 'check']]);
  });

  it('passage aliases: an alias in model prose, or anything but an alias in an id field, withholds the summary', async () => {
    const h = harness(
      answering({
        compose: [
          // An alias written into a why line.
          (input) => composition(input, (c) => (c.cases[0]!.why = `The engine lost power (${input.cases[0]!.passages[0]!.passageId}).`)),
          // An id field holding something the model was never shown (a canonical-looking id).
          (input) => composition(input, (c) => (c.cases[0]!.evidencePassageIds = ['f'.repeat(64)])),
          // The reader's own alias-shaped token, repeated in prose: not an alias.
          (input) => composition(input, (c) => (c.cases[0]!.why = 'The engine lost power on taxiway P2 after maintenance.')),
        ],
      }),
      { trialRequests: 10 },
    );
    const first = await askAndWait(h);
    expect(first.step.result).toMatchObject({ kind: 'withheld', reason: 'citation_check' });
    expect((await stepRow(first.briefId)).meta).toMatchObject({ validation: { codes: ['alias_in_text'] } });
    advance(MIN);
    const second = await askAndWait(h, 'Engine power loss shortly after maintenance', { cookie: null });
    expect(second.step.result).toMatchObject({ kind: 'withheld', reason: 'citation_check' });
    expect((await stepRow(second.briefId)).meta).toMatchObject({ validation: { codes: ['unknown_passage'] } });
    advance(MIN);
    const third = await askAndWait(h, 'Engine power loss on taxiway P2 shortly after maintenance', { cookie: null });
    expect(third.step.result?.kind).toBe('answer');
  });

  it('an uncited summary sentence → withheld', async () => {
    const h = harness(answering({ compose: (input) => composition(input, (c) => (c.summary = `${c.summary} Maintenance is often to blame.`)) }));
    const { briefId, step } = await askAndWait(h);
    expect(step.result).toMatchObject({ kind: 'withheld', reason: 'citation_check' });
    expect((await stepRow(briefId)).meta).toMatchObject({ validation: { codes: ['uncited_summary'] } });
  });

  it('summary citations: an uncited sentence never borrows one, a mid-sentence marker withholds, markers after the last period count', async () => {
    const [a, b] = SEEDS;
    const h = harness(
      answering({
        compose: [
          (input) => composition(input, (c) => (c.summary = `The engine lost power. 3 people were injured [[case:${a}]].`)),
          (input) => composition(input, (c) => (c.summary = `The engine lost power [[case:${a}]] during climb. 3 people were injured.`)),
          (input) => composition(input, (c) => (c.summary = `Power was lost after maintenance [[case:${a}]]. The fuel was contaminated. [[case:${b}]]`)),
        ],
      }),
      { trialRequests: 10 },
    );
    const first = await askAndWait(h);
    expect(first.step.result).toMatchObject({ kind: 'withheld', reason: 'citation_check' });
    expect((await stepRow(first.briefId)).meta).toMatchObject({ validation: { reasons: [{ code: 'uncited_summary', path: 'summary.0' }] } });
    advance(MIN);
    const second = await askAndWait(h, 'Engine power loss shortly after maintenance', { cookie: null });
    expect(second.step.result).toMatchObject({ kind: 'withheld', reason: 'citation_check' });
    expect((await stepRow(second.briefId)).meta).toMatchObject({
      validation: {
        reasons: [
          { code: 'misplaced_citation', path: 'summary.0' },
          { code: 'uncited_summary', path: 'summary.1' },
        ],
      },
    });
    advance(MIN);
    const third = await askAndWait(h, 'Engine power loss shortly after maintenance', { cookie: null });
    expect(third.step.result?.kind).toBe('answer');
    expect((await stepRow(third.briefId)).meta).toMatchObject({ validation: { codes: [], summarySentences: 2 } });
  });

  it('structured lines link to their own passages; gap notes keep theirs and their case context', async () => {
    const h = harness(
      answering({
        compose: (input) =>
          composition(input, (c) => {
            const dfwIn = input.cases.find((x) => x.ntsbNo === 'DFW08TA066')!;
            const analysis = dfwIn.passages.find((p) => p.section === 'Analysis')!;
            const cause = dfwIn.passages.find((p) => p.section === 'Probable cause')!;
            const dfw = c.cases.find((x) => x.ntsbNo === 'DFW08TA066')!;
            dfw.evidencePassageIds = [cause.passageId];
            dfw.maintenance = { relation: 'investigator_attributed', passageIds: [cause.passageId] };
            dfw.chronology = chronologyOf('the engine replacement', analysis.passageId, { relation: 'flight_hours', value: 5.1, bound: 'exact' });
            // NYC08LA106 is left out of the answer and noted as a gap.
            c.cases = c.cases.filter((x) => x.ntsbNo !== 'NYC08LA106');
            c.groups = c.groups.map((g) => ({ ...g, caseNumbers: g.caseNumbers.filter((n) => n !== 'NYC08LA106') })).filter((g) => g.caseNumbers.length > 0);
            c.summary = c.summary.replace(/ ?Power was lost after maintenance \[\[case:NYC08LA106\]\]\./, '');
            const nyc = input.cases.find((x) => x.ntsbNo === 'NYC08LA106')!.passages.find((p) => p.section === 'Analysis')!;
            c.gaps = [{ ntsbNo: 'NYC08LA106', note: 'The supplied passages put the fuel pump installation about two months earlier.', passageIds: [nyc.passageId] }];
          }),
      }),
    );
    const { briefId, cookie, step } = await askAndWait(h);
    const result = step.result!;
    if (result.kind !== 'answer') throw new Error(`expected an answer, got ${result.kind}`);
    expect(result.gaps).toEqual([{ ntsbNo: 'NYC08LA106', text: expect.any(String), passageIds: [expect.stringMatching(/^[0-9a-f]{64}$/)] }]);
    const dfwQuote = result.cases.find((c) => c.case.ntsbNo === 'DFW08TA066')!.reading!.quotes[0]!;
    const ctx = CaseContextResponseSchema.parse((await inject(h, 'GET', `/api/briefs/${briefId}/steps/1/cases/DFW08TA066`, { cookie })).json);
    const cause = ctx.passages.find((p) => p.section === 'probable_cause')!.passageId;
    const line = (label: string) => ctx.lines.find((l) => l.label === label)!;
    expect(line('EVIDENCE').passageIds).toEqual([cause]);
    expect(line('MAINTENANCE').passageIds).toEqual([cause]);
    expect(line('TIMING')).toEqual({ label: 'TIMING', text: '5.1 flight hours after the maintenance (the engine replacement)', passageIds: [dfwQuote.passageId] });
    // The criterion's own checked passages: the fact that decided it (G6 #3).
    expect(line('CRITERIA')).toEqual({ label: 'CRITERIA', text: 'Within your timing window', passageIds: [dfwQuote.passageId] });
    // A case whose passages state no time is shown, labelled unconfirmed, on its card and its summary citation.
    const den = result.cases.find((c) => c.case.ntsbNo === 'DEN08LA103')!.reading!;
    expect(den.criteria).toEqual([{ criterion: 'timing_window', decision: 'unconfirmed' }]);
    expect(result.summary.filter((x) => x.kind === 'case')).toEqual(
      expect.arrayContaining([
        { kind: 'case', ntsbNo: 'DFW08TA066', unconfirmed: false },
        { kind: 'case', ntsbNo: 'DEN08LA103', unconfirmed: true },
      ]),
    );
    const denCtx = CaseContextResponseSchema.parse((await inject(h, 'GET', `/api/briefs/${briefId}/steps/1/cases/DEN08LA103`, { cookie })).json);
    expect(denCtx.lines.find((l) => l.label === 'CRITERIA')).toEqual({
      label: 'CRITERIA',
      text: 'Unconfirmed: this analysis could not establish your timing window from the supplied passages',
      passageIds: denCtx.passages.map((p) => p.passageId),
    });
    // A gap-only case opens in the drawer with its gap and its passages.
    const gap = await inject(h, 'GET', `/api/briefs/${briefId}/steps/1/cases/NYC08LA106`, { cookie });
    expect(gap.status).toBe(200);
    expect(CaseContextResponseSchema.parse(gap.json)).toMatchObject({ reading: null, gaps: [{ ntsbNo: 'NYC08LA106' }] });
  });

  it('the explicit abstention: no supported match shows the cards and checked gap notes, and counts', async () => {
    const checks: CheckInput[] = [];
    const h = harness(
      answering({
        compose: (input) => {
          const nyc = input.cases.find((x) => x.ntsbNo === 'NYC08LA106')!.passages.find((p) => p.section === 'Analysis')!;
          return {
            output: {
              outcome: 'no_supported_match',
              summary: '',
              groups: [],
              cases: [],
              gaps: [{ ntsbNo: 'NYC08LA106', note: 'The supplied passages put the fuel pump installation about two months earlier.', passageIds: [nyc.passageId] }],
            },
          };
        },
        check: (input) => {
          checks.push(input);
          return SUPPORTED(input);
        },
      }),
    );
    const { briefId, step } = await askAndWait(h);
    expect(step.result).toMatchObject({ kind: 'no_match', lines: [...NO_MATCH_LINES], gaps: [{ ntsbNo: 'NYC08LA106' }] });
    // About the retrieved cases only, never "no such investigation exists".
    expect(NO_MATCH_LINES[0]).toContain('cases this search retrieved');
    expect(NO_MATCH_LINES[1]).toContain('not proof that no such investigation exists');
    if (step.result?.kind === 'no_match') expect(step.result.cases.map((c) => c.case.ntsbNo)).toEqual(SEEDS);
    expect(checks[0]!.claims.map((c) => [c.kind, c.absence])).toEqual([['gap', true]]);
    // A gap note is judged on every supplied passage of its case.
    expect(checks[0]!.claims[0]!.passageIds).toEqual(checks[0]!.passages.map((p) => p.passageId));
    expect(new Set(checks[0]!.passages.map((p) => p.ntsbNo))).toEqual(new Set(['NYC08LA106']));
    expect((await stepRow(briefId)).status).toBe('no_match');
    expect(await trialUsed()).toEqual([1]);
  });

  it('a bundle that breaks provenance or completeness fails the step; nothing is dropped or cut', async () => {
    type Tamper = NonNullable<FakeRetrieverOptions['tamper']>;
    const first = (b: Parameters<Tamper>[0]) => b.cases[0]!;
    const variants: [string, Tamper][] = [
      ['kind_mismatch', (b) => (first(b).passages[0]!.sectionKind = 'probable_cause', b)],
      ['no_passage', (b) => (first(b).passages[0]!.passageId = 'f'.repeat(64), b)],
      ['missing_cause', (b) => ((first(b).passages = first(b).passages.filter((p) => p.sectionKind !== 'probable_cause')), b)],
      ['missing_best_passage', (b) => ((first(b).passages[0]!.reserved = false), b)],
      ['too_many_cases', (b) => ({ ...b, cases: [...b.cases, ...b.cases.slice(0, 3)] })],
    ];
    const h = harness(answering(), { trialRequests: 10 });
    for (const [reason, tamper] of variants) {
      h.retriever.options.tamper = (b) => tamper(structuredClone(b), false);
      advance(MIN);
      const { briefId, step } = await askAndWait(h, 'Engine power loss shortly after maintenance', { cookie: null });
      expect(step.result, reason).toEqual({ kind: 'failed', countedAsSearch: true });
      expect((await stepRow(briefId)).meta, reason).toMatchObject({ failure: { stage: 'retrieve', category: 'integrity', reason } });
    }
    expect(h.llm.calls.some((c) => c.stage === 'compose')).toBe(false);
  });

  it('a re-packed bundle must keep every case whole', async () => {
    let counts = 0;
    const h = harness(answering({ counts: { compose: () => (++counts === 1 ? OVER_ANSWER_CAP : 9_000) } }), {
      retriever: {
        tamper: (b, repack) => {
          if (!repack) return b;
          const c = structuredClone(b);
          c.cases[0]!.passages = c.cases[0]!.passages.filter((p) => p.sectionKind !== 'probable_cause');
          return c;
        },
      },
    });
    const { briefId, step } = await askAndWait(h);
    expect(step.result).toEqual({ kind: 'failed', countedAsSearch: true });
    expect((await stepRow(briefId)).meta).toMatchObject({ repacks: 1, failure: { stage: 'compose', category: 'integrity', reason: 'missing_cause' } });
    expect(h.llm.calls.some((c) => c.stage === 'compose')).toBe(false);
  });

  it('the provider’s reported thinking tokens are kept per stage in the meta and on the stage span', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = startTracing(tracingConfig(), { exporter, scheduledDelayMillis: 10 });
    try {
      const h = harness(answering({ compose: (input) => ({ ...composition(input), usage: { outputTokens: 2_600, thinkingTokens: 812 } }) }));
      const { briefId, step } = await askAndWait(h);
      expect(step.result?.kind).toBe('answer');
      const meta = (await stepRow(briefId)).meta;
      // Only the stage that reported them; the billed output stays the whole 2,600.
      expect(meta.thinkingTokens).toEqual({ compose: 812 });
      const lines = await rows<{ stage: string; tokens: Record<string, number> }>(sql`SELECT stage, tokens FROM cost_ledger WHERE stage = 'compose'`);
      expect(lines).toEqual([{ stage: 'compose', tokens: expect.objectContaining({ output: 2_600 }) }]);
      await new Promise((r) => setTimeout(r, 100));
      const compose = exporter.getFinishedSpans().find((sp) => sp.name === 'brief.compose')!;
      expect(compose.attributes).toMatchObject({ outputTokens: 2_600, thinkingTokens: 812 });
      expect(exporter.getFinishedSpans().find((sp) => sp.name === 'brief.scope')!.attributes).not.toHaveProperty('thinkingTokens');
    } finally {
      await tracing.shutdown();
    }
  });

  it('a stage over its cap: its category on the stage span, the request span and the step log line, with no paid call', async () => {
    // The first paid end-to-end test stopped this way at scope; the reason was only in the step's meta.
    const exporter = new InMemorySpanExporter();
    const tracing = startTracing(tracingConfig(), { exporter, scheduledDelayMillis: 10 });
    try {
      const h = harness(answering({ counts: { scope: STAGE_CAPS.scope.input + 1 } }));
      const { briefId, step } = await askAndWait(h);
      expect(step.result).toEqual({ kind: 'failed', countedAsSearch: false });
      expect((await stepRow(briefId)).meta).toMatchObject({ failure: { stage: 'scope', category: 'cap_exceeded', inputTokens: STAGE_CAPS.scope.input + 1 } });
      const finished = h.logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'brief step finished');
      expect(finished).toMatchObject({ status: 'failed', charged: 0, released: true, failure: { stage: 'scope', category: 'cap_exceeded' } });
      await new Promise((r) => setTimeout(r, 100));
      const spans = exporter.getFinishedSpans();
      expect(spans.find((sp) => sp.name === 'brief.scope')!.attributes).toMatchObject({ stage: 'scope', failure: 'cap_exceeded', promptVersion: 'scope.v2' });
      const root = spans.find((sp) => sp.name === 'brief.step')!;
      expect(root.attributes).toMatchObject({ outcome: 'failed', failure: 'cap_exceeded', failureStage: 'scope' });
      expect(root.resource.attributes).toEqual({ 'service.name': 'aviation-casebook', 'deployment.environment': 'dev', 'deployment.environment.name': 'dev' });
      // The count refused it before any generation call.
      expect(h.llm.calls).toHaveLength(0);
    } finally {
      await tracing.shutdown();
    }
  });

  it('a check input over its cap is inconclusive: withheld with the cap failure recorded, the evidence kept whole', async () => {
    const h = harness(answering({ counts: { check: STAGE_CAPS.check.input + 1 } }));
    const { briefId, cookie, step } = await askAndWait(h);
    expect(step.result).toMatchObject({ kind: 'withheld', reason: 'evidence_check' });
    expect((await stepRow(briefId)).meta).toMatchObject({ failure: { stage: 'check', category: 'cap_exceeded', inputTokens: STAGE_CAPS.check.input + 1 } });
    expect(await ledgerStages()).toEqual([['scope', 'embed', 'compose']]);
    // Nothing was pruned to fit: every case keeps every passage it was retrieved with.
    for (const n of SEEDS) {
      const ctx = CaseContextResponseSchema.parse((await inject(h, 'GET', `/api/briefs/${briefId}/steps/1/cases/${n}`, { cookie })).json);
      expect(ctx.passages.map((p) => p.section).sort(), n).toEqual(['analysis', 'probable_cause']);
    }
  });
});

describe('diagnosable withholding and model-call telemetry', () => {
  it('a withheld composition is kept server-side with the split the validator used; meta, span and log name the reasons without text', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = startTracing(tracingConfig(), { exporter, scheduledDelayMillis: 10 });
    try {
      const UNCITED = 'Maintenance is often to blame.';
      const h = harness(answering({ compose: (input) => composition(input, (c) => (c.summary = `${c.summary} ${UNCITED}`)) }));
      const { briefId, cookie, step } = await askAndWait(h);
      expect(step.result).toMatchObject({ kind: 'withheld', reason: 'citation_check' });
      // The meta: each reason with its path, and the sentence count; never the text.
      const row = await stepRow(briefId);
      expect(row.meta.validation).toEqual({
        ruleVersion: 'quote-ws-v2',
        codes: ['uncited_summary'],
        reasons: [{ code: 'uncited_summary', path: 'summary.4' }],
        summarySentences: 5,
      });
      expect(JSON.stringify(row.meta)).not.toContain('blame');
      // The diagnostics: the composition as the model wrote it (passage aliases), the alias map and the split.
      const d = (await diagnosticsOf(briefId))!;
      expect(d.reason).toBe('citation_check');
      expect(d.summarySentences).toHaveLength(5);
      expect(d.summarySentences[4]).toBe(UNCITED);
      const written = d.composition as ComposeOutput;
      expect(written.summary).toContain(UNCITED);
      expect(written.cases[0]!.quotes[0]!.passageId).toMatch(/^P\d+$/);
      expect(d.aliases[written.cases[0]!.quotes[0]!.passageId]).toMatch(/^[0-9a-f]{64}$/);
      expect(d).not.toHaveProperty('claims');
      // No route returns them: the step read and the case context.
      for (const r of [await read(h, briefId, cookie), await inject(h, 'GET', `/api/briefs/${briefId}/steps/1/cases/${SEEDS[0]}`, { cookie })]) {
        expect(r.status).toBe(200);
        expect(JSON.stringify(r.json)).not.toContain('blame');
        expect(JSON.stringify(r.json)).not.toContain('diagnostics');
      }
      // The log line and the request span carry the reason and its codes, fixed values only.
      expect(finishedLine(h)).toMatchObject({ status: 'withheld', withheld: { reason: 'citation_check', codes: ['uncited_summary'] } });
      expect(h.logs.join('\n')).not.toContain('blame');
      await new Promise((r) => setTimeout(r, 100));
      const spans = exporter.getFinishedSpans();
      expect(spans.find((sp) => sp.name === 'brief.step')!.attributes).toMatchObject({
        outcome: 'withheld',
        withheld: 'citation_check',
        withheldCodes: 'uncited_summary',
      });
      expect(JSON.stringify(spans.map((sp) => sp.attributes))).not.toContain('blame');
      // The developer's command prints the reason with the offending sentence.
      const report = await reportOf(briefId);
      expect(report).toContain(`brief ${briefId}, step 1: withheld (citation_check)`);
      expect(report).toContain('uncited_summary at summary.4');
      expect(report).toContain(`sentence 4: ${JSON.stringify(UNCITED)}`);
      // Once the brief has expired (its rows wait for the maintenance pass), only on request.
      advance(24 * 60 * MIN + 1);
      expect(await diagnoseBrief(appDb, briefId, undefined, { now: now() })).toMatchObject({ kind: 'expired' });
      expect(await diagnoseBrief(appDb, briefId, undefined, { now: now(), includeExpired: true })).toMatchObject({ kind: 'report' });
    } finally {
      await tracing.shutdown();
    }
  });

  it('a withheld check keeps the claims the checker read and its verdicts, by id; its problems name them', async () => {
    let quoted = '';
    const h = harness(
      answering({
        check: (input) =>
          verdicts(input, (claim, i) => {
            if (i !== 1) return 'supported';
            const p = input.passages.find((x) => x.passageId === claim.passageIds[0])!;
            quoted = firstSentence(p.text);
            return { verdict: 'contradicted', passages: [p.passageId], quote: { passage: p.passageId, text: quoted } };
          }),
      }),
    );
    const { briefId, step } = await askAndWait(h);
    expect(step.result).toMatchObject({ kind: 'withheld', reason: 'evidence_check' });
    const input = h.llm.calls.find((c) => c.stage === 'check')!.input as CheckInput;
    expect((await stepRow(briefId)).meta.check).toEqual({
      supported: false,
      claims: input.claims.length,
      counts: { supported: input.claims.length - 1, contradicted: 1, not_established: 0 },
      codes: ['contradicted'],
      problems: [{ claim: 'C2', claimIndex: 1, kind: 'summary', code: 'contradicted' }],
      chronologyMissed: [],
    });
    const d = (await diagnosticsOf(briefId))!;
    expect(d.reason).toBe('evidence_check');
    // Exactly the claims the checker was given, passage aliases included, and its verdicts as returned.
    expect(d.claims).toEqual(input.claims);
    expect(d.claims![1]).toMatchObject({ id: 'C2', kind: 'summary', text: expect.stringContaining('Power was lost after maintenance') });
    expect(d.verdicts!.verdicts).toHaveLength(input.claims.length);
    expect(d.verdicts!.quotes).toEqual([{ claim: 'C2', passage: input.claims[1]!.passageIds[0], text: quoted }]);
    expect(finishedLine(h)).toMatchObject({ withheld: { reason: 'evidence_check', codes: expect.arrayContaining(['contradicted', 'display_whole_brief']) } });
    const report = await reportOf(briefId);
    expect(report).toContain('contradicted at C2 (summary');
    expect(report).toContain(`claim: ${JSON.stringify(d.claims![1]!.text)}`);
    expect(report).toContain(`: ${JSON.stringify(quoted)}`);
  });

  it('deterministic completeness: a missing, repeated or unknown verdict, or support from an uncited passage, withholds', async () => {
    const outcomes: [string, (input: CheckInput) => FakeResult<CheckOutput>][] = [
      ['check_missing_verdict', (input) => {
        const r = verdicts(input) as { output: CheckOutput };
        r.output.verdicts.pop();
        return r;
      }],
      ['check_duplicate_verdict', (input) => {
        const r = verdicts(input) as { output: CheckOutput };
        r.output.verdicts.push({ ...r.output.verdicts[0]! });
        return r;
      }],
      ['check_unknown_claim', (input) => {
        const r = verdicts(input) as { output: CheckOutput };
        r.output.verdicts.push({ claim: `C${input.claims.length + 1}`, verdict: 'supported', passages: [] });
        return r;
      }],
      // A correct statement whose citation does not establish it: support from another passage is not support.
      ['check_invalid_evidence', (input) =>
        verdicts(input, (claim) => {
          const uncited = input.passages.find((p) => p.ntsbNo === claim.ntsbNo && !claim.passageIds.includes(p.passageId));
          return claim.kind === 'why' && uncited ? { verdict: 'supported', passages: [uncited.passageId] } : 'supported';
        })],
      // "No relevant maintenance" needs supported: not_established never authorizes it.
      ['not_established', (input) => verdicts(input, (claim) => (claim.absence ? 'not_established' : 'supported'))],
    ];
    const h = harness(answering({ check: outcomes.map(([, step]) => step) }), { trialRequests: 10 });
    for (const [code] of outcomes) {
      const { briefId, step } = await askAndWait(h, 'Engine power loss shortly after maintenance', { cookie: null });
      expect(step.result, code).toMatchObject({ kind: 'withheld', reason: 'evidence_check' });
      expect((await stepRow(briefId)).meta.check, code).toMatchObject({ supported: false, codes: [code] });
      // A structurally unusable output withholds everything (`check_structural`); a rejected claim, in whole mode, the summary.
      expect(finishedLine(h), code).toMatchObject({ withheld: { reason: 'evidence_check', codes: expect.arrayContaining([code, code.startsWith('check_') ? 'check_structural' : 'display_whole_brief']) } });
      advance(MIN);
    }
    // Each was one check call; nothing was retried or repaired.
    expect(h.llm.calls.filter((c) => c.stage === 'check')).toHaveLength(outcomes.length);
    expect(h.llm.calls.filter((c) => c.stage === 'compose')).toHaveLength(outcomes.length);
  });

  it('each model call’s stop reason, warnings, usage and cost: in the meta and on its span, with the GenAI keys; an answer keeps no diagnostics', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = startTracing(tracingConfig(), { exporter, scheduledDelayMillis: 10 });
    try {
      const big = { inputTokens: 9_000, cacheWriteTokens: CACHED_PREFIX_MAX + 1, cacheReadTokens: 300, outputTokens: 2_600 };
      const h = harness(answering({ compose: (input) => ({ ...composition(input), usage: big }) }));
      const { briefId, step } = await askAndWait(h);
      expect(step.result?.kind).toBe('answer');
      const meta = (await stepRow(briefId)).meta;
      expect(meta.stopReasons).toEqual({ scope: 'end_turn', compose: 'end_turn', check: 'end_turn' });
      expect(meta.warnings).toEqual({ compose: ['cache_write_over_prefix_max'] });
      expect(meta.validation).toMatchObject({ codes: [], reasons: [], summarySentences: 4 });
      expect(await diagnosticsOf(briefId)).toBeNull();
      expect(finishedLine(h)).not.toHaveProperty('withheld');
      await new Promise((r) => setTimeout(r, 100));
      const spans = exporter.getFinishedSpans();
      const ledger = await rows<{ stage: string; usd: string }>(sql`SELECT stage, usd::text AS usd FROM cost_ledger`);
      for (const stage of ['scope', 'compose', 'check'] as const) {
        const a = spans.find((sp) => sp.name === `brief.${stage}`)!.attributes;
        const usage = stage === 'compose' ? big : { inputTokens: 1_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 100 };
        expect(a, stage).toMatchObject({
          stopReason: 'end_turn',
          'gen_ai.request.model': h.llm.models[stage === 'compose' ? 'answer' : stage],
          'gen_ai.usage.input_tokens': usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens,
          'gen_ai.usage.output_tokens': usage.outputTokens,
        });
        // The stage's cost: its ledger line, and Langfuse's cost key.
        expect(a['gen_ai.usage.cost'], stage).toBe(a.usd);
        expect(Number(ledger.find((l) => l.stage === stage)!.usd)).toBeCloseTo(a.usd as number, 5);
      }
      expect(spans.find((sp) => sp.name === 'brief.compose')!.attributes).toMatchObject({ warnings: 'cache_write_over_prefix_max' });
      const root = spans.find((sp) => sp.name === 'brief.step')!.attributes;
      expect(Object.keys(root).filter((k) => k.startsWith('gen_ai.'))).toEqual([]);
      expect(root).not.toHaveProperty('withheld');
      for (const k of new Set(spans.flatMap((sp) => Object.keys(sp.attributes)))) expect(SPAN_ATTR_KEYS).toContain(k);
    } finally {
      await tracing.shutdown();
    }
  });

  it('a billed failure keeps its stop reason, usage and cost on its span; no composition, so no diagnostics', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = startTracing(tracingConfig(), { exporter, scheduledDelayMillis: 10 });
    try {
      const h = harness(answering({ compose: { fail: 'truncated' } }));
      const { briefId, step } = await askAndWait(h);
      expect(step.result).toMatchObject({ kind: 'withheld', reason: 'compose_failed' });
      expect((await stepRow(briefId)).meta).toMatchObject({
        stopReasons: { scope: 'end_turn', compose: 'max_tokens' },
        failure: { stage: 'compose', category: 'truncated' },
      });
      expect(await diagnosticsOf(briefId)).toBeNull();
      expect(finishedLine(h)).toMatchObject({ withheld: { reason: 'compose_failed', codes: [] } });
      await new Promise((r) => setTimeout(r, 100));
      const spans = exporter.getFinishedSpans();
      const compose = spans.find((sp) => sp.name === 'brief.compose')!;
      expect(compose.attributes).toMatchObject({
        failure: 'truncated',
        stopReason: 'max_tokens',
        'gen_ai.usage.input_tokens': 1_000,
        'gen_ai.usage.output_tokens': 100,
      });
      expect(compose.attributes['gen_ai.usage.cost']).toBe(compose.attributes.usd);
      expect(compose.status.code).toBe(SpanStatusCode.ERROR);
      const root = spans.find((sp) => sp.name === 'brief.step')!.attributes;
      expect(root).toMatchObject({ withheld: 'compose_failed', failure: 'truncated', failureStage: 'compose' });
      expect(root).not.toHaveProperty('withheldCodes');
    } finally {
      await tracing.shutdown();
    }
  });
});

describe('orphaned and interrupted steps', () => {
  it('a stale running step neither blocks a refinement nor stays running', async () => {
    const h = harness(answering(), { trialRequests: 10 });
    const first = await askAndWait(h);
    // A step whose process died: still running, its reservation already closed.
    const reservation = (
      await rows<{ reservation_id: number }>(sql`SELECT reservation_id::int AS reservation_id FROM brief_steps WHERE brief_id = ${first.briefId}::uuid AND n = 1`)
    )[0]!.reservation_id;
    const owner = (await rows<{ read_owner: string }>(sql`SELECT read_owner FROM briefs WHERE id = ${first.briefId}::uuid`))[0]!.read_owner;
    await migrator.execute(sql`
      INSERT INTO brief_steps (brief_id, n, billing_principal, billing_kind, reservation_id, request, created_at, updated_at)
      VALUES (${first.briefId}::uuid, 2, ${owner}, 'trial', ${reservation}, ${JSON.stringify({ origin: 'text', question: 'q', refinement: 'r', readings: {} })}::jsonb, ${clock}, ${clock})`);
    expect((await read(h, first.briefId, first.cookie)).json).toMatchObject({ step: 2, stage: 'scope' });
    advance(3 * MIN);
    // Stale: reported failed, and the brief can be refined again.
    expect((await read(h, first.briefId, first.cookie)).json).toMatchObject({ step: 2, stage: 'failed', result: { kind: 'failed', countedAsSearch: true } });
    const r = await refine(h, first.briefId, first.cookie, { kind: 'text', text: 'Only airplanes' });
    expect([r.status, r.json]).toMatchObject([202, { step: 3 }]);
    await h.svc.settled();
    // Maintenance marks it failed once its reservation is closed.
    const pass = await runControlMaintenance(appDb, { info() {}, warn() {} }, clock);
    expect(pass).toMatchObject({ ran: true, orphanedSteps: 1, failed: [] });
    expect(await stepRow(first.briefId, 2)).toMatchObject({ status: 'failed', stage: 'failed', meta: { failure: { category: 'orphaned' } } });
    expect((await stepRow(first.briefId, 3)).status).toBe('answered');
  });

  it('the maintenance pass leaves a fresh step with a closed reservation and an old step with an open one alone', async () => {
    const h = harness(answering());
    const first = await askAndWait(h);
    const closed = (
      await rows<{ reservation_id: number }>(sql`SELECT reservation_id::int AS reservation_id FROM brief_steps WHERE brief_id = ${first.briefId}::uuid AND n = 1`)
    )[0]!.reservation_id;
    const open = (
      await rows<{ id: number }>(sql`
        INSERT INTO reservations (category, principal_kind, principal_hash, usd, status, lease_expires_at, accounting_day, quota_counted, created_at)
        VALUES ('interactive', 'trial', ${'f'.repeat(64)}, 0.14, 'open', ${new Date(clock.getTime() + 90_000)}, '2026-11-01', true, ${clock})
        RETURNING id::int AS id`)
    )[0]!.id;
    const owner = (await rows<{ read_owner: string }>(sql`SELECT read_owner FROM briefs WHERE id = ${first.briefId}::uuid`))[0]!.read_owner;
    const request = JSON.stringify({ origin: 'text', question: 'q', refinement: 'r', readings: {} });
    const old = new Date(clock.getTime() - 3 * MIN);
    await migrator.execute(sql`
      INSERT INTO brief_steps (brief_id, n, billing_principal, billing_kind, reservation_id, request, created_at, updated_at)
      VALUES (${first.briefId}::uuid, 2, ${owner}, 'trial', ${closed}, ${request}::jsonb, ${clock}, ${clock}),
             (${first.briefId}::uuid, 3, ${owner}, 'trial', ${open}, ${request}::jsonb, ${old}, ${old})`);
    // Fresh with a closed reservation: still live. Old with an open reservation: its run may still settle.
    expect(await failOrphanedSteps(appDb, clock)).toBe(0);
    expect((await stepRow(first.briefId, 2)).status).toBe('running');
    expect((await stepRow(first.briefId, 3)).status).toBe('running');
    // Once the first is old too, only it is failed.
    expect(await failOrphanedSteps(appDb, new Date(clock.getTime() + 3 * MIN))).toBe(1);
    expect((await stepRow(first.briefId, 2)).status).toBe('failed');
    expect((await stepRow(first.briefId, 3)).status).toBe('running');
  });

  it('closing a listening server under live traffic aborts the running step, settles it and drains within the grace', async () => {
    const h = harness(answering({ scope: { hang: true } }), { timeouts: { scope: 30_000 } });
    harnesses.splice(harnesses.indexOf(h), 1);
    const port = await listen(h);
    // Two keep-alive agents: one connection left idle, another with a request in flight
    // (one agent would reuse the idle connection for the POST).
    const idle = new http.Agent({ keepAlive: true });
    const busy = new http.Agent({ keepAlive: true });
    try {
      const health = await send(port, 'GET', '/api/health', { agent: idle });
      expect(health.headers.connection).toBe('keep-alive');
      const idleClosed = closedOf(health.socket);
      // The POST waits for the scope stage, which hangs until the step is aborted.
      const posted = send(port, 'POST', '/api/briefs', {
        agent: busy,
        body: { question: 'Engine power loss shortly after maintenance', turnstileToken: h.sv.issue(), idempotencyKey: key() },
      });
      await until(() => h.llm.calls.some((c) => c.stage === 'scope'));
      expect(h.svc.runs.size).toBe(1);
      const t0 = Date.now();
      await h.app.close();
      expect(Date.now() - t0).toBeLessThan(SHUTDOWN_GRACE_MS);
      // The request in flight got its answer, and its connection was closed with it; Node's
      // own server.close() closed the idle one.
      const res = await posted;
      expect([res.status, res.headers.connection]).toEqual([202, 'close']);
      expect(JSON.parse(res.body)).toMatchObject({ kind: 'started', step: 1, stage: 'failed' });
      await idleClosed;
      expect(h.svc.runs.size).toBe(0);
      const briefId = (JSON.parse(res.body) as { briefId: string }).briefId;
      expect(await stepRow(briefId)).toMatchObject({ status: 'failed', stage: 'failed', meta: { failure: { stage: 'pipeline', category: 'shutdown' } } });
      // The aborted scope call may have been billed: settled in full, the search kept.
      expect(await reservations()).toMatchObject([{ status: 'settled', uncertain: true }]);
    } finally {
      idle.destroy();
      busy.destroy();
    }
  });

  it.each(['create', 'refine'] as const)(
    'shutdown stops a %s request paused just before its step starts: no provider call, quota given back, settled at zero',
    async (kind) => {
      const h = harness(answering(), { trialRequests: 10 });
      harnesses.splice(harnesses.indexOf(h), 1);
      const first = kind === 'refine' ? await askAndWait(h) : null;
      const calls = h.llm.calls.length;
      advance(MIN);
      // The request passes the gate and admission, then waits to insert its step.
      const lock = await holdTable('brief_steps');
      let t0: number;
      let started: ReturnType<typeof ask>;
      try {
        started = first ? refine(h, first.briefId, first.cookie, { kind: 'text', text: 'Only airplanes' }) : ask(h, 'Engine power loss shortly after maintenance');
        await untilAsync(async () => (await waitingOnTable('brief_steps')) === 1);
        t0 = Date.now();
        const closing = h.app.close();
        await until(() => h.svc.shutdown.aborted);
        await lock.release();
        await closing;
      } finally {
        await lock.release();
      }
      expect(Date.now() - t0).toBeLessThan(SHUTDOWN_GRACE_MS);
      // The step was made, then stopped before its first provider call.
      const r = await started;
      const n = first ? 2 : 1;
      expect([r.status, r.json]).toMatchObject([202, { kind: 'started', step: n, stage: 'failed' }]);
      expect(h.llm.calls).toHaveLength(calls);
      expect(await stepRow(r.json.briefId, n)).toMatchObject({
        status: 'failed',
        stage: 'failed',
        cost_usd: '0.000000',
        result: { kind: 'failed', countedAsSearch: false },
        meta: { failure: { stage: 'pipeline', category: 'shutdown' } },
      });
      // The quota is given back and the reservation settles at zero (one zero ledger line).
      const settled = await reservations();
      expect(settled.at(-1)).toMatchObject({ status: 'settled', charged: '0.000000', uncertain: false, quota_counted: false });
      expect(await ledgerOf(settled.length)).toEqual([{ stage: 'request', usd: '0.000000' }]);
      expect(await trialUsed()).toEqual([first ? 1 : 0]);
    },
  );

  it('a request in admission when shutdown begins is refused, its admission given back and settled at zero', async () => {
    const h = harness(answering());
    harnesses.splice(harnesses.indexOf(h), 1);
    // Admission waits for the spend lock (well within its 2 s lock timeout).
    const lock = await holdAdvisory(SPEND_LOCK_KEY);
    let t0: number;
    let asked: ReturnType<typeof ask>;
    try {
      asked = ask(h, 'Engine power loss shortly after maintenance');
      await untilAsync(async () => (await waitingOnAdvisory()) === 1);
      t0 = Date.now();
      const closing = h.app.close();
      await until(() => h.svc.shutdown.aborted);
      await lock.release();
      await closing;
    } finally {
      await lock.release();
    }
    expect(Date.now() - t0).toBeLessThan(SHUTDOWN_GRACE_MS);
    const r = await asked;
    expect([r.status, (r.json as unknown as { error: string }).error]).toEqual([503, 'unavailable']);
    expect(await reservations()).toMatchObject([{ status: 'settled', charged: '0.000000', uncertain: false, quota_counted: false }]);
    expect(await ledgerOf(1)).toEqual([{ stage: 'request', usd: '0.000000' }]);
    expect(await count('brief_steps')).toBe(0);
    expect(await trialUsed()).toEqual([0]);
    expect(h.llm.calls).toHaveLength(0);
  });

  it('while closing, a new request gets 503 unavailable, and one still in the gate is refused before admission', async () => {
    const h = harness(answering());
    harnesses.splice(harnesses.indexOf(h), 1);
    const port = await listen(h);
    const release = h.sv.hold();
    const body = () => ({ question: 'Engine power loss shortly after maintenance', turnstileToken: h.sv.issue(), idempotencyKey: key() });
    const paused = send(port, 'POST', '/api/briefs', { body: body() });
    await until(() => h.sv.calls.length === 1);
    const t0 = Date.now();
    const closing = h.app.close();
    await until(() => h.svc.shutdown.aborted);
    // A request that arrives now: refused before any work, as an ErrorResponse with the security headers.
    const late = await send(port, 'POST', '/api/briefs', { body: body() });
    expect([late.status, ErrorResponseSchema.parse(JSON.parse(late.body)).error]).toEqual([503, 'unavailable']);
    expect(late.headers['content-security-policy']).toContain("default-src 'self'");
    expect(late.headers.connection).toBe('close');
    expect(h.sv.calls).toHaveLength(1);
    // The request in the gate resumes and is refused before admission.
    release();
    const res = await paused;
    expect([res.status, ErrorResponseSchema.parse(JSON.parse(res.body)).error]).toEqual([503, 'unavailable']);
    await closing;
    expect(Date.now() - t0).toBeLessThan(SHUTDOWN_GRACE_MS);
    expect(await count('reservations')).toBe(0);
    expect(h.llm.calls).toHaveLength(0);
  });

  it('closing closes a connection still open at the deadline (a request body that never arrives)', async () => {
    const grace = 1_500;
    const h = harness(answering(), { shutdownGraceMs: grace });
    harnesses.splice(harnesses.indexOf(h), 1);
    const port = await listen(h);
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    // Headers complete, body short of its Content-Length: the request stays active, so
    // Node's server.close() would wait for it indefinitely.
    socket.write('POST /api/briefs HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"question":');
    await new Promise((r) => setTimeout(r, 100));
    const closed = closedOf(socket);
    const t0 = Date.now();
    const outcome = await Promise.race([h.app.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), grace + 3_000))]);
    expect(outcome).toBe('closed');
    const took = Date.now() - t0;
    // The drain waited until the deadline for the straggler, then closed it.
    expect(took).toBeGreaterThanOrEqual(grace - 100);
    expect(took).toBeLessThan(grace + 1_000);
    await closed;
  });

  it('closing the server aborts running steps, which fail and settle within the grace', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = startTracing(tracingConfig(), { exporter, scheduledDelayMillis: 10 });
    try {
      const h = harness(answering({ compose: { hang: true } }), { timeouts: { compose: 30_000 } });
      const started = await ask(h, 'Engine power loss shortly after maintenance');
      await until(() => h.llm.calls.some((c) => c.stage === 'compose'));
      const t0 = Date.now();
      harnesses.splice(harnesses.indexOf(h), 1);
      await h.app.close();
      expect(Date.now() - t0).toBeLessThan(8_000);
      expect(h.svc.runs.size).toBe(0);
      const row = await stepRow(started.json.briefId);
      expect(row).toMatchObject({ status: 'failed', stage: 'failed', meta: { failure: { stage: 'pipeline', category: 'shutdown' } } });
      // The aborted compose call may have been billed: settled in full, the search kept.
      expect(await reservations()).toMatchObject([{ status: 'settled', uncertain: true }]);
      expect(await trialUsed()).toEqual([1]);
      // The stopped stage span: `failure: shutdown` with `outcome: shutdown`, and no error status.
      await new Promise((r) => setTimeout(r, 100));
      const spans = exporter.getFinishedSpans();
      const compose = spans.find((sp) => sp.name === 'brief.compose')!;
      expect(compose.attributes).toMatchObject({ outcome: 'shutdown', failure: 'shutdown' });
      expect(compose.status.code).toBe(SpanStatusCode.UNSET);
      expect(spans.find((sp) => sp.name === 'brief.step')!.attributes).toMatchObject({ outcome: 'failed', failure: 'shutdown', failureStage: 'pipeline' });
    } finally {
      await tracing.shutdown();
    }
  });
});

describe('admission: the paced daily budget and other checks before spend', () => {
  /** An open interactive reservation of another principal, made today. */
  async function openReservation(usd: number): Promise<void> {
    await migrator.execute(sql`
      INSERT INTO reservations (category, principal_kind, principal_hash, usd, status, lease_expires_at, accounting_day, quota_counted, created_at)
      VALUES ('interactive', 'account', ${'e'.repeat(64)}, ${usd}, 'open', ${new Date(clock.getTime() + 90_000)}, '2026-11-01', true, ${clock})`);
  }

  it('the brief route admits through the $3/day paced allowance and counts open reservations', async () => {
    // A fresh 30-day month: today's allowance is min($3, $80 / 30) = $2.666666; a brief
    // reserves its worst case (RESERVATIONS). Leave room for one and a half briefs.
    const reserve = RESERVATIONS['claude-opus-5-5']!;
    await openReservation(Number((2.666666 - 1.5 * reserve).toFixed(6)));
    const h = harness(answering({ compose: { hang: true } }), { timeouts: { compose: 2_000 } });
    const a = await ask(h, 'Engine power loss shortly after maintenance');
    expect(a.status).toBe(202);
    // While A's reservation is open, B does not fit: refused before any token work.
    const calls = h.sv.calls.length;
    const b = await ask(h, 'Engine power loss shortly after maintenance', { cookie: null });
    const untilMidnight = Math.ceil((Date.parse('2026-11-02T00:00:00Z') - clock.getTime()) / 1000);
    expect([b.status, (b.json as unknown as { error: string }).error, (b.json as unknown as { retryAfter: number }).retryAfter]).toEqual([503, 'ai_paused', untilMidnight]);
    expect(h.sv.calls.length).toBe(calls);
    // Admission itself applies the same pacing with the same open reservations.
    const direct = await admitPaidRequest(appDb, {
      policy: h.ai.policy!,
      principal: { kind: 'account', issuer: 'https://accounts.google.com', subject: 'pacing-test', createdAt: new Date('2026-01-01T00:00:00Z') },
      networkId: '198.51.100.40',
      idempotencyKey: `pacing-${RUN}`,
      requestHash: canonicalRequestHash({ q: 'pacing' }),
      reservationUsd: h.ai.startup.reservationUsd!,
      now: clock,
    });
    expect(direct).toMatchObject({ ok: false, reason: 'global_paused', pause: 'daily_budget' });
    await h.svc.settled();
    expect(await rows<{ usd: string }>(sql`SELECT usd::text AS usd FROM reservations WHERE principal_kind = 'trial'`)).toEqual([{ usd: reserve.toFixed(6) }]);
  });

  it('a question over the query embedding cap is refused before any spend', async () => {
    const h = harness(answering());
    const question = '発動機の出力が整備直後に失われた事例。'.repeat(75).slice(0, 1_500);
    const r = await ask(h, question);
    expect([r.status, (r.json as unknown as { error: string; message: string }).message]).toEqual([
      400,
      'The question is too long to search. Shorten it and try again.',
    ]);
    expect(h.sv.calls).toHaveLength(0);
    expect(await count('reservations')).toBe(0);
  });

  it('a refinement stays on the evidence index its brief is pinned to', async () => {
    const pinnedIndex = `aviation-test-briefs${RUN}-pinned`;
    const h = harness(answering(), {
      aiEvidence: async () => ({ generationId, passagesIndex: pinnedIndex }),
      // The pinned name is not a real index; its evidence comes from the fixture index.
      retriever: { available: (d) => d.passagesIndex !== pinnedIndex, served: () => servedContract(dataset) },
    });
    const first = await askAndWait(h);
    expect(first.step.result?.kind).toBe('answer');
    advance(MIN);
    const calls = h.sv.calls.length;
    const r = await refine(h, first.briefId, first.cookie, { kind: 'text', text: 'Only airplanes' });
    expect([r.status, (r.json as unknown as { error: string }).error]).toEqual([503, 'unavailable']);
    expect(h.sv.calls.length).toBe(calls);
  });
});

describe('claim-level display (Task 16d, display-deps-v1): one projection for every surface', () => {
  /** Distinctive texts the checker will reject, so their absence can be searched for. */
  const REJECTED = {
    sentence: 'Rejected sentence about the defect case',
    why: 'Rejected why line about the defect case',
    gap: 'Rejected gap note about the defect case',
  };
  /** MIA08LA156's summary sentence and why line, rejected by the checker; DEN08LA103 gets a gap note it rejects too. */
  const partial = (input: ComposeInput) =>
    composition(input, (c) => {
      c.summary = c.cases
        .map((k) => (k.ntsbNo === 'MIA08LA156' ? `${REJECTED.sentence} [[case:MIA08LA156]].` : `Power was lost after maintenance [[case:${k.ntsbNo}]].`))
        .join(' ');
      const mia = c.cases.find((k) => k.ntsbNo === 'MIA08LA156')!;
      mia.why = `${REJECTED.why}.`;
      const den = input.cases.find((k) => k.ntsbNo === 'DEN08LA103')!;
      c.gaps = [{ ntsbNo: 'DEN08LA103', note: `${REJECTED.gap}.`, passageIds: [den.passages[0]!.passageId] }];
    });
  const rejecting = (input: CheckInput) =>
    verdicts(input, (claim) => (Object.values(REJECTED).some((t) => claim.text.includes(t)) ? 'not_established' : 'supported'));
  const absent = (json: unknown) => {
    const text = JSON.stringify(json);
    for (const t of Object.values(REJECTED)) expect(text).not.toContain(t);
  };

  it('removed statements are absent from the step response, the case contexts, the stored step and any later prompt; the raw stays in the diagnostics', async () => {
    const h = harness(answering({ compose: (input) => partial(input), check: rejecting }), { displayMode: 'claims' });
    const { briefId, cookie, step } = await askAndWait(h);
    const result = step.result!;
    if (result.kind !== 'answer') throw new Error(`expected an answer, got ${result.kind}`);
    // GET /api/briefs/:id: the removed sentence is a marker, the defect case a plain card that says what was not verified.
    absent(step);
    expect(step.checklist.verified).toBe('partially_checked');
    expect(result.summary.filter((s) => s.kind === 'removed')).toEqual([{ kind: 'removed', count: 1 }]);
    const mia = result.cases.find((c) => c.case.ntsbNo === 'MIA08LA156')!;
    expect(mia.reading).toBeNull();
    expect(mia.notVerified).toEqual(expect.arrayContaining(['why']));
    expect(result.groups.flatMap((g) => g.caseNumbers)).not.toContain('MIA08LA156');
    expect(result.gaps).toEqual([]);
    expect(result.check).toMatchObject({ status: 'partially_checked', removed: { summary: 1, why: 1, gap: 1 } });
    expect(result.cases.filter((c) => c.reading !== null).map((c) => c.case.ntsbNo)).toEqual(['DFW08TA066', 'DEN08LA103', 'NYC08LA106']);
    // Every step read (the latest and by number), every case context: nothing rejected.
    absent((await read(h, briefId, cookie, 1)).json);
    for (const n of SEEDS) {
      const ctx = await inject<unknown>(h, 'GET', `/api/briefs/${briefId}/steps/1/cases/${n}`, { cookie });
      expect(ctx.status, n).toBe(200);
      absent(ctx.json);
      const parsed = CaseContextResponseSchema.parse(ctx.json);
      if (n === 'MIA08LA156') expect(parsed).toMatchObject({ reading: null, lines: [] });
    }
    // The stored step (result, evidence, meta) holds none of it; the diagnostics column keeps the raw for developers.
    const row = await rows<{ result: unknown; evidence: unknown; meta: Record<string, unknown>; diagnostics: StepDiagnostics | null }>(
      sql`SELECT result, evidence, meta, diagnostics FROM brief_steps WHERE brief_id = ${briefId}::uuid`,
    );
    absent({ result: row[0]!.result, evidence: row[0]!.evidence, meta: row[0]!.meta });
    expect(row[0]!.meta).toMatchObject({
      display: { rules: 'display-deps-v1', mode: 'claims', shown: true, removedKeys: expect.arrayContaining([{ key: 'summary.2', cause: 'not_established' }, { key: 'case.MIA08LA156.why', cause: 'not_established' }]) },
    });
    expect(row[0]!.diagnostics).toMatchObject({ reason: 'partial_display' });
    expect(JSON.stringify(row[0]!.diagnostics)).toContain(REJECTED.why);
    expect(await reportOf(briefId)).toContain('removed case.MIA08LA156.why: not_established');
    // A refinement reads the brief's request and intent, never an answer: the scope and compose inputs it builds from the
    // earlier step hold nothing rejected (its own new composition is checked and projected again).
    const before = h.llm.calls.length;
    const refined = await refine(h, briefId, cookie, { kind: 'text', text: 'Only the defect cases' });
    expect(refined.status).toBeLessThan(300);
    await h.svc.settled();
    const later = h.llm.calls.slice(before).filter((c) => c.stage === 'scope' || c.stage === 'compose');
    expect(later.map((c) => c.stage)).toEqual(['scope', 'compose']);
    for (const call of later) absent(call.input);
  });

  it('decisions never promote: 2 days and 40 days against 30 days stays unconfirmed when the 40-day fact is removed; a removed fact downgrades a match', async () => {
    const probe = (input: ComposeInput) =>
      composition(input, (c) => {
        const dfw = input.cases.find((k) => k.ntsbNo === 'DFW08TA066')!;
        const nyc = input.cases.find((k) => k.ntsbNo === 'NYC08LA106')!;
        c.cases.find((k) => k.ntsbNo === 'DFW08TA066')!.chronology = {
          maintenance: 'the engine replacement',
          facts: [
            { anchor: 'relevant_maintenance', relation: 'calendar_days', value: 2, bound: 'exact', passageIds: [dfw.passages[0]!.passageId] },
            { anchor: 'relevant_maintenance', relation: 'calendar_days', value: 40, bound: 'exact', passageIds: [dfw.passages[0]!.passageId] },
          ],
        };
        c.cases.find((k) => k.ntsbNo === 'NYC08LA106')!.chronology = chronologyOf('the fuel pump installation', nyc.passages[0]!.passageId, { relation: 'previous_day' });
      });
    const check = (input: CheckInput) =>
      verdicts(input, (claim) => (claim.kind === 'timing' && (claim.text.includes('40 calendar days') || claim.text.includes('the fuel pump installation')) ? 'not_established' : 'supported'));
    const h = harness(answering({ compose: (input) => probe(input), check }), { displayMode: 'claims' });
    const { briefId, cookie, step } = await askAndWait(h);
    const result = step.result!;
    if (result.kind !== 'answer') throw new Error(`expected an answer, got ${result.kind}`);
    // Decided once, before the check: DFW's conflict is unknown, NYC's previous day matches.
    expect((await stepRow(briefId)).meta).toMatchObject({
      criteria: expect.arrayContaining([
        { ntsbNo: 'DFW08TA066', criterion: 'timing_window', decision: 'unknown', rules: [], reason: 'conflict' },
        { ntsbNo: 'NYC08LA106', criterion: 'timing_window', decision: 'matches', rules: ['TW-C'] },
      ]),
    });
    const reading = (n: string) => result.cases.find((c) => c.case.ntsbNo === n)!.reading!;
    // Neither becomes a match once its fact is gone: both are shown unconfirmed and not verified.
    expect(reading('DFW08TA066').criteria).toEqual([{ criterion: 'timing_window', decision: 'unconfirmed', notVerified: true }]);
    expect(reading('NYC08LA106').criteria).toEqual([{ criterion: 'timing_window', decision: 'unconfirmed', notVerified: true }]);
    expect(reading('DFW08TA066').timing.map((t) => t.label)).toEqual(['2 DAYS']);
    // The summary flags them UNCONFIRMED from the projection.
    for (const s of result.summary) if (s.kind === 'case' && (s.ntsbNo === 'DFW08TA066' || s.ntsbNo === 'NYC08LA106')) expect(s.unconfirmed).toBe(true);
    const ctx = CaseContextResponseSchema.parse((await inject<unknown>(h, 'GET', `/api/briefs/${briefId}/steps/1/cases/NYC08LA106`, { cookie })).json);
    expect(ctx.lines.filter((l) => l.label === 'CRITERIA')).toEqual([{ label: 'CRITERIA', text: 'Not verified: the check could not confirm this against the cited passages', passageIds: [] }]);
    expect(ctx.lines).toContainEqual({ label: 'TIMING', text: 'Not verified: the check could not confirm this against the cited passages', passageIds: [] });
    expect(JSON.stringify(step)).not.toContain('PREVIOUS DAY');
  });

  it('whole mode (the default until G6) withholds the same brief, and two contradictions withhold it in claims mode too', async () => {
    const whole = harness(answering({ compose: (input) => partial(input), check: rejecting }));
    const w = await askAndWait(whole);
    expect(w.step.result).toMatchObject({ kind: 'withheld', reason: 'evidence_check' });
    expect(w.step.checklist.verified).toBe('withheld');
    absent(w.step);
    expect(finishedLine(whole)).toMatchObject({ withheld: { codes: expect.arrayContaining(['not_established', 'display_whole_brief']) } });
    const twice = harness(
      answering({
        check: (input) => verdicts(input, (claim) => (claim.kind === 'symptom' && (claim.ntsbNo === 'DFW08TA066' || claim.ntsbNo === 'DEN08LA103') ? 'contradicted' : 'supported')),
      }),
      { displayMode: 'claims' },
    );
    const t = await askAndWait(twice);
    expect(t.step.result).toMatchObject({ kind: 'withheld', reason: 'evidence_check' });
    expect(finishedLine(twice)).toMatchObject({ withheld: { codes: expect.arrayContaining(['contradicted', 'display_contradictions']) } });
    expect((await stepRow(t.briefId)).meta).toMatchObject({ display: { mode: 'claims', shown: false, withheld: ['display_contradictions'], contradictions: 2 } });
  });
});

describe('content security policy with anonymous AI', () => {
  it('allows Cloudflare Turnstile’s script and frame, and nothing broader, on API responses and pages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aviation-briefs-web-'));
    try {
      writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><title>Aviation Casebook</title></head><body><div id="root"></div></body></html>');
      const h = harness(answering(), { webRoot: root });
      for (const url of ['/api/config', '/api/ai/status', '/']) {
        const r = await h.app.inject({ method: 'GET', url, remoteAddress: VISITOR, headers: { accept: 'text/html' } });
        const csp = String(r.headers['content-security-policy']);
        expect(csp, url).toMatch(/; script-src 'self' 'sha256-[A-Za-z0-9+/=]+' https:\/\/challenges\.cloudflare\.com; /);
        expect(csp, url).toContain('; frame-src https://challenges.cloudflare.com; ');
        expect(csp, url).toContain("connect-src 'self';");
        expect(csp.match(/challenges\.cloudflare\.com/g), url).toHaveLength(2);
        expect(csp, url).not.toMatch(/unsafe-|\*|https:(?!\/\/challenges\.cloudflare\.com)/);
      }
      // The page keeps its per-response style nonce; scripts never take it.
      const page = await h.app.inject({ method: 'GET', url: '/', remoteAddress: VISITOR, headers: { accept: 'text/html' } });
      expect(String(page.headers['content-security-policy'])).toMatch(/style-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
      expect(String(page.headers['content-security-policy'])).not.toMatch(/script-src[^;]*nonce/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
