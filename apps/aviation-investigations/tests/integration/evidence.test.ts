/** Real canonical rows, production retrieval, fake embeddings/scope, no provider network. */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Client } from '@elastic/elasticsearch';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../server/app.js';
import { createAiRuntime } from '../../server/ai/runtime.js';
import { createFakeProvider, type FakeScript } from '../../server/ai/fake.js';
import { createEvidenceRetriever, createEvidenceServices, type EvidenceRetriever } from '../../server/evidence/retrieve.js';
import { pageOf, readOwnedSearch, takeOverSearch } from '../../server/evidence/store.js';
import { evidenceSnapshot } from '../../server/evidence/snapshot.js';
import { EvidencePageSchema, CreateEvidenceResponseSchema } from '../../shared/contracts/evidence.js';
import { loadConfig } from '../../shared/config.js';
import { closeDb, type Db } from '../../server/db/client.js';
import { authUsers, authSessions, evidenceSearches } from '../../server/db/schema/index.js';
import { completeHandover, handoverCandidate } from '../../server/auth/handover.js';
import { withLiveAccount } from '../../server/auth/lifecycle.js';
import { type AuthService, type SignedIn } from '../../server/auth/better-auth.js';
import { principalHash } from '../../server/quota/policy.js';
import { deleteAccount, issueDeletionConfirmation } from '../../server/auth/deletion.js';
import { runControlMaintenance } from '../../server/quota/maintenance.js';
import { restoreCheck } from '../../server/db/backup.js';
import { pruneControls } from '../../server/quota/retention.js';
import { publishManifest } from '../../server/db/generations.js';
import { rebuildCasesIndex } from '../../worker/index/cases-index.js';
import { testDb, testEs, testEsReader, resetControls, resetCorpus } from './helpers.js';
import { publishFixtureDataset, deleteIndices, fixtureEmbedder, FIXTURE_EMBEDDING, type FixtureDataset } from '../support/api-dataset.js';
import { FakeSiteverify, REAL_SECRET, REAL_SITE_KEY } from '../support/fake-siteverify.js';

const prefix = `aviation-test-evidence-${randomBytes(4).toString('hex')}`;
const host = 'aircase.example';
let db: Db, ingest: Db, migrator: Db, es: Client, writer: Client, dataset: FixtureDataset;
let clock: Date;
const now = () => clock;
const nextMinute = () => { clock = new Date(clock.getTime() + 61_000); };
const configs = () => loadConfig({ files: [], env: {
  NODE_ENV: 'test', APP_ENV: 'dev', APP_URL: `https://${host}`, AI_LLM_PROVIDER: 'fake',
  IDENTITY_HMAC_SECRET: 'evidence-test-identity-key-012345678901', IP_HMAC_SECRET: 'evidence-test-network-key-012345678901',
  TURNSTILE_SITE_KEY: REAL_SITE_KEY, TURNSTILE_SECRET_KEY: REAL_SECRET,
} });
const success = { intent: 'case_search' as const, filters: {}, terms: 'engine power loss maintenance', unchecked: [{ kind: 'timing' as const, quote: 'after maintenance' }] };
const harnesses: { app: ReturnType<typeof buildApp> }[] = [];
beforeAll(async () => {
  db = testDb(); ingest = testDb('ingest'); migrator = testDb('migrator'); es = testEsReader(); writer = testEs();
  dataset = await publishFixtureDataset(ingest, writer, prefix, { passages: true });
}, 180_000);
beforeEach(async () => { clock = new Date(); await resetControls(); });
afterEach(async () => { for (const h of harnesses.splice(0)) await h.app.close(); });
afterAll(async () => { await resetControls(); await deleteIndices(writer, prefix); await resetCorpus();
  await Promise.all([closeDb(db), closeDb(ingest), closeDb(migrator), es.close(), writer.close()]); });

function harness(script: FakeScript = { evidenceScope: { output: success } }, wrap?: (r: EvidenceRetriever) => EvidenceRetriever) {
  const config = configs();
  const verify = new FakeSiteverify(now, { hostname: host, action: 'ask-ai' });
  const llm = createFakeProvider(script);
  const ai = createAiRuntime(config, { db, llm, now, turnstile: { fetch: verify.fetch, retryDelayMs: 0 } });
  const embedder = fixtureEmbedder();
  const embed = vi.spyOn(embedder, 'embed');
  const actual = createEvidenceRetriever(db, es, embedder);
  const svc = createEvidenceServices(wrap ? wrap(actual) : actual);
  let signed: SignedIn | null = null;
  const auth: AuthService = { secure: true, async handle() { return new Response(null, { status: 404 }); },
    async signedIn(cookie) { return cookie?.includes('account=yes') ? signed : null; }, expiredSessionCookies: () => [],
    finishSignOut: async () => true, hasPendingSignOut: () => false, pendingSignOutCookie: () => '', donePendingSignOutCookie: () => '', checkSchema: async () => {} };
  const logs: string[] = [];
  const app = buildApp({ db, es, config, ai, auth, evidence: svc, embedding: FIXTURE_EMBEDDING, manifestTtlMs: 0,
    rateLimit: { limit: 1000, windowMs: 60_000 }, logger: { level: 'warn', stream: { write: (s: string) => logs.push(s) } } });
  let cookie = '';
  const request = async (body: Record<string, unknown> = {}, key = randomUUID()) => {
    const res = await app.inject({ method: 'POST', url: '/api/evidence', remoteAddress: '127.0.0.1',
      headers: { origin: config.appUrl, cookie }, payload: { kind: 'question', question: 'Find engine power loss after maintenance',
        idempotencyKey: key, turnstileToken: verify.issue(), ...body } });
    for (const c of res.cookies) if (c.name.includes('trial')) cookie = [cookie, `${c.name}=${c.value}`].filter(Boolean).join('; ');
    return res;
  };
  const get = (id: string, page = 1, withCookie = cookie) => app.inject({ url: `/api/evidence/${id}?page=${page}`, headers: { cookie: withCookie } });
  const h = { app, ai, llm, svc, embed, verify, logs, request, get, cookie: () => cookie,
    async account() {
      const principal = { kind: 'account' as const, issuer: 'https://accounts.google.com', subject: randomUUID(), createdAt: now() };
      const hash = principalHash(ai.policy!, principal);
      const [u] = await db.insert(authUsers).values({ name: 'Test', email: `${principal.subject}@example.com`, emailVerified: true, createdAt: now(), updatedAt: now() }).returning();
      const [s] = await db.insert(authSessions).values({ userId: u!.id, token: randomUUID(), createdAt: now(), updatedAt: now(), expiresAt: new Date(Date.now() + 7 * 86400_000) }).returning();
      signed = { principal, hash, userId: u!.id, sessionId: s!.id, name: 'Test', email: u!.email };
      cookie += '; account=yes';
      return signed;
    },
  };
  harnesses.push(h); return h;
}
const searchOf = (r: Awaited<ReturnType<ReturnType<typeof harness>['request']>>) => {
  expect(r.statusCode, r.body).toBe(201);
  const body = CreateEvidenceResponseSchema.parse(r.json());
  if (body.kind !== 'results') throw new Error('expected evidence results');
  return body.search;
};
const spent = async () => (await db.execute(sql`SELECT sum(usd)::float AS usd, count(*)::int AS lines FROM cost_ledger`)).rows[0] as { usd: number; lines: number };
const usage = async () => (await db.execute(sql`SELECT quota_counted, status FROM reservations ORDER BY id DESC LIMIT 1`)).rows[0] as { quota_counted: boolean; status: string };

describe('evidence search routes', () => {
  it('aborts a stalled canonical snapshot and frees its connection for the next read', async () => {
    const controller = new AbortController();
    let reached!: () => void;
    const started = new Promise<void>((resolve) => { reached = resolve; });
    const work = evidenceSnapshot(db, controller.signal, async (tx) => {
      reached();
      await tx.execute(sql`SELECT pg_sleep(30)`);
      throw new Error('should never finish');
    });
    const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    controller.abort();
    await rejected;
    expect(db.$client.waitingCount).toBe(0);
    expect(db.$client.totalCount).toBe(db.$client.idleCount);
    expect((await evidenceSnapshot(db, new AbortController().signal, (tx) => tx.execute(sql`SELECT 1 AS n`))).rows[0]?.n).toBe(1);
  });
  it('creates results from canonical rows; pages and context never pay, and ownership is checked', async () => {
    const h = harness(), page = searchOf(await h.request());
    expect(page.total).toBeGreaterThan(10);
    expect(page.cases).toHaveLength(10);
    expect(page.cases.every((c) => c.probableCauses.length > 0)).toBe(true);
    expect(h.embed).toHaveBeenCalledTimes(1);
    expect(h.llm.calls.map((c) => c.stage)).toEqual(['scope']);
    expect((await h.get(page.id, 1, '')).statusCode).toBe(404);
    const second = await h.get(page.id, 2);
    expect(second.headers['cache-control']).toBe('private, no-store');
    const p2 = EvidencePageSchema.parse(second.json());
    expect(new Set([...page.cases, ...p2.cases].map((c) => c.case.ntsbNo)).size).toBe(page.cases.length + p2.cases.length);
    expect((await h.get(page.id, 10)).statusCode).toBe(404);
    const before = await spent();
    const c = page.cases[0]!;
    const context = await h.app.inject({ url: `/api/evidence/${page.id}/cases/${c.case.ntsbNo}`, headers: { cookie: h.cookie() } });
    expect(context.statusCode).toBe(200);
    for (const excerpt of c.excerpts) {
      const section = context.json().sections.find((s: { key: string }) => s.key === excerpt.sectionKey);
      expect(section.text.slice(excerpt.paragraph.start, excerpt.paragraph.end)).toBe(excerpt.text);
      expect(section.revision).toBe(excerpt.revision);
    }
    expect(await spent()).toEqual(before);
    expect(h.embed).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(page)).not.toMatch(/"(summary|classification|why|diagnostics)":/);
  });
  it('replays once, rejects a reused key with different content, and edits preserve unchecked readings without scope', async () => {
    const h = harness(), key = randomUUID(), page = searchOf(await h.request({}, key));
    nextMinute();
    expect(searchOf(await h.request({}, key))).toEqual(page);
    expect((await h.request({ question: 'Find carb icing' }, key)).statusCode).toBe(409);
    expect(h.embed).toHaveBeenCalledTimes(1);
    nextMinute();
    const edited = searchOf(await h.request({ kind: 'edited', question: undefined, from: page.id, filters: {}, terms: 'carb icing' }));
    expect(edited.question).toBe(page.question);
    expect(edited.edited).toBe(true);
    expect(edited.interpretation.unchecked).toEqual(page.interpretation.unchecked);
    expect(edited.interpretation.filters).toEqual({});
    expect(h.llm.calls).toHaveLength(1);
    expect(h.embed).toHaveBeenCalledTimes(2);
  });
  it.each(['out_of_scope', 'operational_advice', 'corpus_statistics', 'case_comparison'] as const)('returns only the static %s reply and refunds quota', async (intent) => {
    const h = harness({ evidenceScope: { output: { intent, filters: {} } } });
    const res = await h.request();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'scope_reply', reply: { kind: intent } });
    expect((await usage()).quota_counted).toBe(false);
    expect((await spent()).usd).toBeGreaterThan(0);
    expect(h.embed).not.toHaveBeenCalled();
  });
  it('refunds failures after embedding, settles its usage exactly once and leaks no diagnostic text', async () => {
    const h = harness(undefined, (r) => ({ ...r, async search(p, i, s, cb) { await r.search(p, i, s, cb); throw new Error('SENTINEL_PRIVATE'); } }));
    const res = await h.request();
    expect(res.statusCode).toBe(503);
    expect((await usage()).quota_counted).toBe(false);
    expect((await spent()).lines).toBe(2);
    expect(res.body + h.logs.join('')).not.toContain('SENTINEL_PRIVATE');
    expect(h.llm.calls).toHaveLength(1);
  });
  it('rejects an invented unchecked quote after charging only scope and returns the search', async () => {
    const h = harness({ evidenceScope: { output: { ...success, unchecked: [{ kind: 'timing', quote: 'within 30 days' }] } } });
    expect((await h.request()).statusCode).toBe(503);
    expect((await usage()).quota_counted).toBe(false);
    expect(h.embed).not.toHaveBeenCalled();
  });
  it('charges an uncertain scope only at its own maximum and refunds the request', async () => {
    const h = harness({ evidenceScope: { fail: 'timeout' } });
    expect((await h.request()).statusCode).toBe(503);
    expect((await spent()).usd).toBeCloseTo(0.001113, 6);
    expect((await usage()).quota_counted).toBe(false);
  });
  it('reports new limits; the tenth anonymous search fits and UTC midnight resets it', async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) { searchOf(await h.request()); nextMinute(); }
    expect((await h.request()).statusCode).toBe(429);
    const exhausted = await h.app.inject({ url: '/api/ai/status', headers: { cookie: h.cookie() } });
    expect(exhausted.json()).toMatchObject({ reason: 'trial_used', remaining: { limit: 10, left: 0 }, retryAt: expect.any(String) });
    clock = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate() + 1, 1));
    searchOf(await h.request());
    const cfg = await h.app.inject('/api/config');
    expect(cfg.json().aiLimits).toMatchObject({ anonymousDaily: 10, accountDaily: 50, newAccountDaily: 20, accountMonthly: 600, reset: '00:00 UTC', briefsEnabled: false });
  });
  it('leaves generation and indices pinned across a same-generation publication change', async () => {
    const h = harness(), page = searchOf(await h.request()), before = (await h.get(page.id, 2)).json();
    const built = await rebuildCasesIndex(writer, ingest, { generationId: dataset.generationId, prefix });
    await publishManifest(ingest, dataset.generationId, built.index, dataset.passagesIndex);
    try {
      expect((await h.get(page.id, 2)).json()).toEqual(before);
      const pins = await ingest.execute(sql`SELECT indices_cited_by_live_briefs() AS name`);
      expect(pins.rows.map((r) => r.name)).toContain(dataset.casesIndex);
      const generations = await ingest.execute(sql`SELECT generations_cited_by_live_briefs() AS id`);
      expect(generations.rows.map((r) => Number(r.id))).toContain(dataset.generationId);
      expect(h.embed).toHaveBeenCalledTimes(1);
    } finally { await publishManifest(ingest, dataset.generationId, dataset.casesIndex, dataset.passagesIndex); }
  });
  it('expires at 24 hours, with the same 404 as another owner', async () => {
    const h = harness(), page = searchOf(await h.request());
    clock = new Date(clock.getTime() + 86400_000);
    expect((await h.get(page.id)).statusCode).toBe(404);
  });
  it('hands over at sign-in without rebilling, then deletes searches and idempotency with the account', async () => {
    const h = harness(), key = randomUUID(), page = searchOf(await h.request({}, key)), trialCookie = h.cookie();
    const account = await h.account();
    const deps = { db, policy: h.ai.policy!, trials: h.ai.trials!, now };
    const candidate = await handoverCandidate(deps, trialCookie, `/ai/${page.id}`);
    expect(candidate?.kind).toBe('evidence');
    expect(await completeHandover(deps, trialCookie, candidate!, account)).toBe('moved');
    expect((await h.get(page.id, 1, trialCookie)).statusCode).toBe(404);
    expect((await h.get(page.id)).statusCode).toBe(200);
    expect(searchOf(await h.request({}, key)).id).toBe(page.id);
    expect(h.embed).toHaveBeenCalledTimes(1);
    await issueDeletionConfirmation(db, account);
    expect(await deleteAccount({ db, now }, account)).not.toBe('not_confirmed');
    expect((await h.get(page.id)).statusCode).toBe(404);
    expect((await db.execute(sql`SELECT count(*)::int AS n FROM idempotency`)).rows[0]?.n).toBe(0);
    expect((await spent()).usd).toBeGreaterThan(0);
  });
  it('signed-in edited searches take over the parent and use the account quota', async () => {
    const h = harness(), page = searchOf(await h.request()), trialCookie = h.cookie();
    await h.account();
    const edited = searchOf(await h.request({ kind: 'edited', question: undefined, from: page.id, filters: {}, terms: 'carb icing' }));
    expect(edited.question).toBe(page.question);
    expect((await h.get(page.id, 1, trialCookie)).statusCode).toBe(404);
    const status = await h.app.inject({ url: '/api/ai/status', headers: { cookie: h.cookie() } });
    expect(status.json().remaining).toMatchObject({ kind: 'account', limitToday: 20, leftToday: 19, limitThisMonth: 600 });
  });
  it('brief create/refine are 404 with keys present; legacy reads still route to ownership checks', async () => {
    const h = harness();
    for (const url of ['/api/briefs', `/api/briefs/${randomUUID()}/refine`]) {
      expect((await h.app.inject({ method: 'POST', url, headers: { origin: `https://${host}` }, payload: {} })).statusCode).toBe(404);
    }
    expect((await h.app.inject(`/api/briefs/${randomUUID()}`)).statusCode).toBe(404);
    expect(h.llm.calls).toHaveLength(0);
  });
  it('stops before paid calls when paused, and rejects cross-site creation', async () => {
    const h = harness();
    await migrator.execute(sql`UPDATE ai_switch SET enabled = false WHERE id = 1`);
    expect((await h.request()).statusCode).toBe(503);
    expect(h.llm.calls).toHaveLength(0); expect(h.embed).not.toHaveBeenCalled();
    expect((await spent()).lines).toBe(0);
    const foreign = await h.app.inject({ method: 'POST', url: '/api/evidence', headers: { origin: 'https://elsewhere.example' }, payload: {} });
    expect(foreign.statusCode).toBe(403);
  });
  it('crash recovery charges the uncertain reservation but returns quota and refuses late work', async () => {
    let release!: () => void, started!: () => void;
    const reached = new Promise<void>((r) => { started = r; });
    const held = new Promise<void>((r) => { release = r; });
    const h = harness({ evidenceScope: async () => { started(); await held; return { output: success }; } });
    const request = h.request();
    await reached;
    try {
      clock = new Date(clock.getTime() + 121_000);
      const maintenance = await runControlMaintenance(db, { info() {}, warn() {} }, clock);
      expect(maintenance).toMatchObject({ ran: true, failed: [], orphanedSearches: 1 });
      expect((await usage())).toMatchObject({ quota_counted: false, status: 'expired_charged' });
      expect((await spent()).usd).toBe(0.0012);
    } finally { release(); }
    expect((await request).statusCode).toBe(503);
    expect(h.embed).not.toHaveBeenCalled();
    const status = await h.app.inject({ url: '/api/ai/status', headers: { cookie: h.cookie() } });
    expect(status.json().remaining.left).toBe(10);
    expect((await db.select({ status: evidenceSearches.status }).from(evidenceSearches))[0]?.status).toBe('failed');
  });
  it('shutdown aborts an admitted scope, settles its uncertain cost and releases its quota', async () => {
    let started!: () => void;
    const reached = new Promise<void>((r) => { started = r; });
    const h = harness({ evidenceScope: async (_input, ctx) => {
      started(); await new Promise<void>((r) => ctx.signal.addEventListener('abort', () => r(), { once: true }));
      return { fail: 'timeout' };
    } });
    const request = h.request(); await reached;
    h.svc.beginShutdown();
    expect((await request).statusCode).toBe(503);
    expect((await usage()).quota_counted).toBe(false);
    expect((await spent()).usd).toBeGreaterThan(0);
    expect(h.embed).not.toHaveBeenCalled();
    expect((await h.request()).statusCode).toBe(503);
    expect(h.llm.calls).toHaveLength(1);
  });
  it('account deletion during scope leaves no search or idempotent replay and makes no embedding', async () => {
    let release!: () => void, started!: () => void;
    const reached = new Promise<void>((r) => { started = r; });
    const held = new Promise<void>((r) => { release = r; });
    const h = harness({ evidenceScope: async () => { started(); await held; return { output: success }; } });
    const account = await h.account();
    await issueDeletionConfirmation(db, account);
    const request = h.request(); await reached;
    try { expect(await deleteAccount({ db, now }, account)).not.toBe('not_confirmed'); }
    finally { release(); }
    expect((await request).statusCode).toBe(503);
    expect(h.embed).not.toHaveBeenCalled();
    expect((await usage()).quota_counted).toBe(false);
    expect((await db.execute(sql`SELECT count(*)::int AS n FROM evidence_searches`)).rows[0]?.n).toBe(0);
    expect((await db.execute(sql`SELECT count(*)::int AS n FROM idempotency`)).rows[0]?.n).toBe(0);
  });
  it('maintenance removes expired searches and restore-check detects their excluded private rows', async () => {
    clock = new Date(clock.getTime() - 25 * 3600_000);
    const h = harness(); searchOf(await h.request());
    expect((await restoreCheck(migrator)).rows).toContainEqual({ table: 'evidence_searches', rows: 1 });
    expect((await pruneControls(db)).evidenceSearches).toBe(1);
    expect((await db.execute(sql`SELECT count(*)::int AS n FROM evidence_searches`)).rows[0]?.n).toBe(0);
  });
  it('does not grant ingest access to private searches or permit editing finished content', async () => {
    const h = harness(), page = searchOf(await h.request());
    await expect(ingest.execute(sql`SELECT * FROM evidence_searches`)).rejects.toThrow();
    await expect(db.update(evidenceSearches).set({ data: {} }).where(eq(evidenceSearches.id, page.id))).rejects.toThrow();
  });
});
