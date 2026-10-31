/**
 * Mock progress of AI evidence searches (`GET /api/evidence/progress/:key`, contract
 * `EvidenceProgressSchema` in shared/contracts/evidence.ts) for the MSW handlers: the stages a
 * `POST /api/evidence` goes through, timed like live's and kept per idempotency key for its owner.
 *
 * - **Timing** (`MOCK_STAGE_MS`): the server registers the key once the request's Turnstile check
 *   and admission are through, under a second after it arrives (before that, reads answer 404, as
 *   they do on the server), then the question stage takes about
 *   1.5 s (question searches only; an edit skips it), the embedding and retrieval about 1.7 s, and
 *   the configuration's reranker about 2.7 s for Haiku on the top 50 (longer for the top 100 or
 *   Sonnet; a configuration without one skips it), as live measured them. Every time is multiplied
 *   by `timing`: 1 is as live, 0 is no wait at all (the default of the handlers, so the component
 *   tests and the end-to-end tests do not wait).
 * - **Outcomes** come from the search the mock made (`MockStageOutcome`, web/mock/evidence.ts):
 *   what the question stage gave, the cases retrieval found and the order. A search admitted and
 *   then lost fails at retrieval (`failedAt`), and a refusal, a replay or a request that never
 *   started has no progress (404).
 * - **Lifetime**: about five minutes after the search ended, as the server keeps it in memory.
 *
 * Statuses and counts only, never any text.
 */
import type { CreateEvidenceRequest, EvidenceProgress } from '../../shared/contracts/evidence.js';
import type { ErrorResponse } from '../../shared/contracts/common.js';
import type { EvidenceRankingVersion } from '../../shared/evidence-ranking.js';
import type { MockReader, MockReply } from './briefs.js';
import { rerankerOf, type MockStageOutcome } from './evidence.js';

/** Live's stage times (Task 25 measurements), before `timing` scales them. */
export const MOCK_STAGE_MS = {
  /**
   * From the request's arrival until the server knows its key, once the Turnstile check and
   * admission are through (reads before then are a 404).
   */
  register: 800,
  question: 1_500,
  search: 1_700,
  rerank: { haiku50: 2_700, haiku100: 4_200, sonnet50: 4_600 },
} as const;

/** The server keeps a search's progress about this long after it ended. */
export const MOCK_PROGRESS_TTL_MS = 5 * 60_000;

type StageName = 'question' | 'search' | 'order';

interface Stage {
  name: StageName;
  /** When it starts running; `null`: skipped from the start. */
  from: number | null;
  /** When it ends. */
  to: number;
  status: 'done' | 'skipped' | 'failed';
  result: string | null;
  cases: number | null;
}

interface Run {
  owner: MockReader;
  startedAt: number;
  registeredAt: number;
  endsAt: number;
  stages: Stage[];
}

export interface MockEvidenceProgressOptions {
  /** Scale of the stage times: 1 as live, 0 no wait (default 0). */
  timing?: number;
  now?: () => number;
  visitor?: () => MockReader;
  /** The ranking configuration the mock stands in for: whether a reranker runs, and how long it takes. */
  ranking: EvidenceRankingVersion;
}

const NOT_FOUND = (): MockReply<never> => ({ status: 404, body: { error: 'not_found', message: 'Not found.' } satisfies ErrorResponse });

function rerankMs(ranking: EvidenceRankingVersion): number | null {
  const reranker = rerankerOf(ranking);
  if (!reranker) return null;
  if (reranker.model === 'sonnet') return MOCK_STAGE_MS.rerank.sonnet50;
  return reranker.depth === 100 ? MOCK_STAGE_MS.rerank.haiku100 : MOCK_STAGE_MS.rerank.haiku50;
}

export class MockEvidenceProgress {
  private readonly runs = new Map<string, Run>();
  private readonly timing: number;
  private readonly now: () => number;
  private readonly visitor: () => MockReader;
  private readonly ranking: EvidenceRankingVersion;

  constructor(opts: MockEvidenceProgressOptions) {
    this.timing = Math.max(0, opts.timing ?? 0);
    this.now = opts.now ?? (() => Date.now());
    this.visitor = opts.visitor ?? (() => 'trial');
    this.ranking = opts.ranking;
  }

  /**
   * A search's stages begin (`POST /api/evidence` with `body`, which ended as `outcome`): returns
   * how long until its answer is sent, in milliseconds (0 with no timing).
   */
  start(body: CreateEvidenceRequest, outcome: MockStageOutcome): number {
    const scale = (ms: number): number => Math.round(ms * this.timing);
    const startedAt = this.now();
    const registeredAt = startedAt + scale(MOCK_STAGE_MS.register);
    const stages: Stage[] = [];
    let at = registeredAt;
    // The question stage: skipped for an edit (and by the server when it skips scope).
    if (body.kind === 'edited' || outcome.question === 'skipped') {
      stages.push({ name: 'question', from: null, to: registeredAt, status: 'skipped', result: null, cases: null });
    } else {
      const to = at + scale(MOCK_STAGE_MS.question);
      const failed = outcome.question === 'unavailable';
      stages.push({ name: 'question', from: at, to, status: failed ? 'failed' : 'done', result: outcome.question, cases: null });
      at = to;
    }
    // Retrieval, the query embedding included.
    const searched = at + scale(MOCK_STAGE_MS.search);
    const lost = outcome.failedAt === 'search';
    stages.push({ name: 'search', from: at, to: searched, status: lost ? 'failed' : 'done', result: null, cases: lost ? null : outcome.cases });
    at = searched;
    // The reranker: only with a configuration that has one, and only once retrieval found something to order.
    const rerank = rerankMs(this.ranking);
    if (rerank === null || outcome.order === 'skipped') {
      stages.push({ name: 'order', from: null, to: registeredAt, status: 'skipped', result: null, cases: null });
    } else if (!lost) {
      const to = at + (outcome.cases === 0 ? 0 : scale(rerank));
      stages.push({ name: 'order', from: at, to, status: 'done', result: outcome.order, cases: null });
      at = to;
    } else {
      // Never reached: retrieval failed first.
      stages.push({ name: 'order', from: Number.POSITIVE_INFINITY, to: Number.POSITIVE_INFINITY, status: 'done', result: null, cases: null });
    }
    this.runs.set(body.idempotencyKey, { owner: this.visitor(), startedAt, registeredAt, endsAt: at, stages });
    return at - startedAt;
  }

  /** `GET /api/evidence/progress/:key`: how far the visitor's own search with that key has got; 404 otherwise. */
  read(key: string): MockReply<EvidenceProgress> {
    const run = this.runs.get(key);
    const now = this.now();
    if (!run || run.owner !== this.visitor() || now < run.registeredAt) return NOT_FOUND();
    if (now > run.endsAt + MOCK_PROGRESS_TTL_MS) {
      this.runs.delete(key);
      return NOT_FOUND();
    }
    const view = (name: StageName) => {
      const stage = run.stages.find((s) => s.name === name) as Stage;
      if (stage.from === null) return { status: 'skipped' as const, result: null, cases: null };
      if (now < stage.from) return { status: 'pending' as const, result: null, cases: null };
      if (now < stage.to) return { status: 'running' as const, result: null, cases: null };
      return { status: stage.status, result: stage.result, cases: stage.cases };
    };
    const question = view('question');
    const search = view('search');
    const order = view('order');
    const statuses = [question.status, search.status, order.status];
    const state = search.status === 'failed' ? 'failed' : statuses.every((s) => s === 'done' || s === 'skipped' || s === 'failed') ? 'done' : 'running';
    return {
      status: 200,
      body: {
        state,
        startedAt: new Date(run.startedAt).toISOString(),
        question: { status: question.status, result: question.result as EvidenceProgress['question']['result'] },
        search: { status: search.status, cases: search.cases },
        order: { status: order.status, result: order.result as EvidenceProgress['order']['result'] },
      },
    };
  }
}
