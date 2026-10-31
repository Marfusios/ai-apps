/**
 * The mock progress of AI evidence searches (web/mock/evidence-progress.ts) that the search
 * checklist's component and end-to-end tests read, the mock's ratings and its admin overview
 * (web/mock/admin.ts): every answer validates under its contract (`EvidenceProgressSchema`,
 * `AdminOverviewSchema`), the stages run in order and take live's times scaled by `timing`, each
 * stage ends as the search it belongs to did, and only the asker reads it.
 */
import { describe, expect, it } from 'vitest';
import { AdminOverviewSchema } from '../../shared/contracts/admin.js';
import { CreateEvidenceResponseSchema, EvidenceProgressSchema, type CreateEvidenceRequest, type EvidenceProgress } from '../../shared/contracts/evidence.js';
import type { EvidenceRankingVersion } from '../../shared/evidence-ranking.js';
import { MOCK_ADMIN_NEW_USERS, MOCK_ADMIN_USERS, mockAdminOverview } from '../../web/mock/admin.js';
import type { MockReader } from '../../web/mock/briefs.js';
import { MOCK_EVIDENCE_QUESTIONS, MOCK_EVIDENCE_RELEASE, MockEvidence, type MockEvidenceConfig } from '../../web/mock/evidence.js';
import { MOCK_PROGRESS_TTL_MS, MOCK_STAGE_MS, MockEvidenceProgress } from '../../web/mock/evidence-progress.js';

/** A request without its key and token (the rig adds them). */
type RequestBody = CreateEvidenceRequest extends infer R ? (R extends CreateEvidenceRequest ? Omit<R, 'idempotencyKey' | 'turnstileToken'> : never) : never;

/** A mock server and its progress on one clock, as the handlers pair them. */
function rig(config: MockEvidenceConfig, timing = 1) {
  let now = Date.parse('2026-10-31T12:00:00.000Z');
  let visitor: MockReader = 'trial';
  const evidence = new MockEvidence({ config, now: () => new Date(now), visitor: () => visitor });
  const progress = new MockEvidenceProgress({ ranking: config.ranking, timing, now: () => now, visitor: () => visitor });
  let n = 0;
  return {
    evidence,
    progress,
    /** Sends a request: the mock's reply, its key and how long its answer waits (ms). */
    send(body: RequestBody) {
      const idempotencyKey = `progress-key-${String(++n).padStart(4, '0')}`;
      const request = { ...body, idempotencyKey, turnstileToken: 'token' } as CreateEvidenceRequest;
      const reply = evidence.create(request);
      const ms = reply.progress ? progress.start(request, reply.progress) : 0;
      return { reply, key: idempotencyKey, ms };
    },
    /** The progress of `key` `ms` after the request arrived (the clock moves on from there). */
    at(key: string, startedAt: number, ms: number) {
      now = startedAt + ms;
      const reply = progress.read(key);
      return reply.status === 200 ? EvidenceProgressSchema.parse(reply.body) : reply.status;
    },
    get now() {
      return now;
    },
    set visitor(next: MockReader) {
      visitor = next;
    },
  };
}

const ask = (question: string) => ({ kind: 'question' as const, question });
const statuses = (p: EvidenceProgress | number) => (typeof p === 'number' ? p : [p.state, p.question.status, p.search.status, p.order.status].join(' '));

describe('the mock progress of an AI search', () => {
  it('what live runs: 404 until the key is known, then the question, the search and the AI order, each ending as the search did', () => {
    const r = rig(MOCK_EVIDENCE_RELEASE);
    const start = r.now;
    const { reply, key, ms } = r.send(ask(MOCK_EVIDENCE_QUESTIONS.carb));
    const page = CreateEvidenceResponseSchema.parse(reply.body).search;
    const { register, question, search } = MOCK_STAGE_MS;
    const rerank = MOCK_STAGE_MS.rerank.haiku50;
    expect(ms).toBe(register + question + search + rerank);
    expect(r.at(key, start, 0)).toBe(404);
    expect(r.at(key, start, register - 1)).toBe(404);
    expect(statuses(r.at(key, start, register))).toBe('running running pending pending');
    const scoped = r.at(key, start, register + question) as EvidenceProgress;
    expect(statuses(scoped)).toBe('running done running pending');
    expect(scoped.question.result).toBe('suggestions');
    expect(scoped.search.cases).toBeNull();
    const searched = r.at(key, start, register + question + search) as EvidenceProgress;
    expect(statuses(searched)).toBe('running done done running');
    expect(searched.search.cases).toBe(page.total);
    expect(searched.order.result).toBeNull();
    const done = r.at(key, start, ms) as EvidenceProgress;
    expect(statuses(done)).toBe('done done done done');
    expect(done.order.result).toBe('ai_relevance');
    expect(done.startedAt).toBe(new Date(start).toISOString());
  });

  it.each([
    ['er-q-v1', null],
    ['er-q-h100-v1', MOCK_STAGE_MS.rerank.haiku100],
    ['er-t-s50-v1', MOCK_STAGE_MS.rerank.sonnet50],
  ] as const)('%s: the order row is skipped without a reranker, and takes the reranker’s time with one', (ranking: EvidenceRankingVersion, rerank) => {
    const r = rig({ ranking, autoFilters: 'none' });
    const start = r.now;
    const { key, ms } = r.send(ask(MOCK_EVIDENCE_QUESTIONS.seed));
    const { register, question, search } = MOCK_STAGE_MS;
    expect(ms).toBe(register + question + search + (rerank ?? 0));
    const first = r.at(key, start, register) as EvidenceProgress;
    expect(first.order.status).toBe(rerank === null ? 'skipped' : 'pending');
    const done = r.at(key, start, ms) as EvidenceProgress;
    expect(done.state).toBe('done');
    expect(done.order).toEqual(rerank === null ? { status: 'skipped', result: null } : { status: 'done', result: 'ai_relevance' });
  });

  it('an edit skips the question stage from the start; nothing retrieved is no AI order, in match order at once', () => {
    const r = rig(MOCK_EVIDENCE_RELEASE);
    const { reply } = r.send(ask(MOCK_EVIDENCE_QUESTIONS.carb));
    const from = CreateEvidenceResponseSchema.parse(reply.body).search;
    const start = r.now;
    const edit = r.send({ kind: 'edited', from: from.id, filters: { phase: ['approach'] } });
    expect(edit.ms).toBe(MOCK_STAGE_MS.register + MOCK_STAGE_MS.search + MOCK_STAGE_MS.rerank.haiku50);
    const first = r.at(edit.key, start, MOCK_STAGE_MS.register) as EvidenceProgress;
    expect(first.question).toEqual({ status: 'skipped', result: null });
    expect(first.search.status).toBe('running');
    const nothing = r.send(ask('Nothing at all like this'));
    const empty = r.at(nothing.key, r.now, nothing.ms) as EvidenceProgress;
    expect(empty.search.cases).toBe(0);
    expect(empty.order).toEqual({ status: 'done', result: 'match' });
  });

  it('a note, nothing to suggest and a failed scope stage each end the question row their own way; the search goes on', () => {
    const r = rig(MOCK_EVIDENCE_RELEASE);
    const result = (question: string): EvidenceProgress => {
      const sent = r.send(ask(question));
      return r.at(sent.key, r.now, sent.ms) as EvidenceProgress;
    };
    expect(result(MOCK_EVIDENCE_QUESTIONS.outOfScope).question).toEqual({ status: 'done', result: 'note' });
    expect(result(MOCK_EVIDENCE_QUESTIONS.noSuggestion).question).toEqual({ status: 'failed', result: 'unavailable' });
    expect(result(MOCK_EVIDENCE_QUESTIONS.noSuggestion).state).toBe('done');
    // A state applied on its own, with nothing else left to suggest (the reviewed state policy): nothing to suggest.
    const s = rig({ ranking: 'er-qt-v1', autoFilters: 'state-explicit.v1.3' });
    const sent = s.send(ask('Engine power loss in California or Nevada'));
    const page = CreateEvidenceResponseSchema.parse(sent.reply.body).search;
    expect(page.suggestion).toBeNull();
    expect((s.at(sent.key, s.now, sent.ms) as EvidenceProgress).question).toEqual({ status: 'done', result: 'nothing_to_suggest' });
  });

  it('a search lost after admission fails at retrieval: the order is never reached', () => {
    const r = rig(MOCK_EVIDENCE_RELEASE);
    const start = r.now;
    const sent = r.send(ask('Carb icing unavailable'));
    expect(sent.reply.status).toBe(503);
    expect(sent.ms).toBe(MOCK_STAGE_MS.register + MOCK_STAGE_MS.question + MOCK_STAGE_MS.search);
    const failed = r.at(sent.key, start, sent.ms) as EvidenceProgress;
    expect(statuses(failed)).toBe('failed done failed pending');
    expect(failed.search.cases).toBeNull();
  });

  it('refusals, replays and a request that never started have no progress; only the asker reads it, for about five minutes', () => {
    const r = rig(MOCK_EVIDENCE_RELEASE);
    const sent = r.send(ask(MOCK_EVIDENCE_QUESTIONS.seed));
    expect(r.send({ kind: 'edited', from: '00000000-0000-4000-9000-999999999999', filters: {} }).reply.status).toBe(404);
    expect(r.send(ask('Lost before start, please')).reply.progress).toBeUndefined();
    const start = r.now;
    expect(typeof r.at(sent.key, start, sent.ms)).toBe('object');
    r.visitor = 'account';
    expect(r.progress.read(sent.key).status).toBe(404);
    r.visitor = 'trial';
    expect(r.at(sent.key, start, sent.ms + MOCK_PROGRESS_TTL_MS + 1)).toBe(404);
  });

  it('with no timing every stage is over at once', () => {
    const r = rig(MOCK_EVIDENCE_RELEASE, 0);
    const sent = r.send(ask(MOCK_EVIDENCE_QUESTIONS.seed));
    expect(sent.ms).toBe(0);
    expect(statuses(r.at(sent.key, r.now, 0))).toBe('done done done done');
  });
});

describe('the mock ratings', () => {
  it('the owner rates a search, the latest counting; another visitor gets a 404; “rating fails” fails once', () => {
    const r = rig(MOCK_EVIDENCE_RELEASE, 0);
    const page = CreateEvidenceResponseSchema.parse(r.send(ask(MOCK_EVIDENCE_QUESTIONS.seed)).reply.body).search;
    expect(r.evidence.rate(page.id, 'not_useful').status).toBe(204);
    expect(r.evidence.rate(page.id, 'useful').status).toBe(204);
    expect(r.evidence.ratingCounts()).toEqual({ useful: 1, notUseful: 0 });
    r.visitor = 'account';
    expect(r.evidence.rate(page.id, 'useful').status).toBe(404);
    r.visitor = 'trial';
    const flaky = CreateEvidenceResponseSchema.parse(r.send(ask('Carb icing, rating fails')).reply.body).search;
    expect(r.evidence.rate(flaky.id, 'useful').status).toBe(503);
    expect(r.evidence.rate(flaky.id, 'useful').status).toBe(204);
    expect(r.evidence.ratingCounts()).toEqual({ useful: 2, notUseful: 0 });
  });
});

describe('the mock admin overview', () => {
  const now = new Date('2026-10-31T17:05:00.000Z');
  const overview = (ratings = { useful: 0, notUseful: 0 }) =>
    AdminOverviewSchema.parse(mockAdminOverview({ now, evidence: MOCK_EVIDENCE_RELEASE, ratings, admin: { name: 'Alex Example', email: 'alex@example.com' } }));

  it('is a valid overview, the same on every read, of synthetic accounts, most recently active first', () => {
    const o = overview();
    expect(overview()).toEqual(o);
    expect(o.users.total).toBe(MOCK_ADMIN_USERS);
    expect(o.users.newLast7Days).toBe(MOCK_ADMIN_NEW_USERS);
    expect(o.users.list).toHaveLength(MOCK_ADMIN_USERS);
    expect(o.users.list.every((u) => /@example\.(com|org|net)$/.test(u.email))).toBe(true);
    expect(new Set(o.users.list.map((u) => u.name)).size).toBe(MOCK_ADMIN_USERS);
    expect(new Set(o.users.list.map((u) => u.email)).size).toBe(MOCK_ADMIN_USERS);
    expect(o.users.list.filter((u) => u.isAdmin).map((u) => u.email).sort()).toEqual(['alex@example.com', 'robin@example.com']);
    const active = o.users.list.map((u) => Math.max(...[u.createdAt, u.lastSignInAt, u.lastAiSearchAt].filter((t): t is string => t !== null).map(Date.parse)));
    expect(active).toEqual([...active].sort((a, b) => b - a));
    for (const u of o.users.list) {
      const s = u.aiSearches;
      expect(s.today <= s.last7Days && s.last7Days <= s.last30Days && s.last30Days <= s.last90Days).toBe(true);
    }
    expect(o.users.list.filter((u) => Date.parse(u.createdAt) > now.getTime() - 7 * 86_400_000)).toHaveLength(MOCK_ADMIN_NEW_USERS);
  });

  it('30 UTC days of use, oldest first, ending today; this month’s costs add up by category; the ratings add the mock’s own', () => {
    const o = overview({ useful: 2, notUseful: 1 });
    expect(o.usage.days).toHaveLength(30);
    expect(o.usage.days.at(-1)?.day).toBe('2026-10-31');
    expect(o.usage.days[0]?.day).toBe('2026-10-02');
    const { interactive, indexing, evaluation } = o.costs.byCategory;
    expect(interactive + indexing + evaluation).toBeCloseTo(o.costs.monthToDate, 5);
    expect(o.costs.today).toBe(o.usage.days.at(-1)?.usd);
    // Today's interactive spend: all of today's but an indexing run's.
    expect(o.costs.interactiveToday).toBeLessThanOrEqual(o.costs.today);
    const indexingDay = AdminOverviewSchema.parse(mockAdminOverview({ now: new Date('2026-10-17T09:00:00.000Z'), evidence: MOCK_EVIDENCE_RELEASE, ratings: { useful: 0, notUseful: 0 }, admin: { name: 'Alex Example', email: 'alex@example.com' } }));
    expect(indexingDay.costs.today - indexingDay.costs.interactiveToday).toBeCloseTo(0.92, 6);
    expect(o.costs.byStage.map((s) => s.usd)).toEqual([...o.costs.byStage.map((s) => s.usd)].sort((a, b) => b - a));
    expect(o.usage.feedback).toEqual({ useful: 43, notUseful: 14, usefulLast30Days: 19, notUsefulLast30Days: 7 });
    expect(o.system).toMatchObject({ ranking: 'er-q-h50-v1', automaticFilters: 'none', nextAutomaticImport: null, appEnv: 'dev' });
  });
});
