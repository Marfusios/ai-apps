/**
 * An Elasticsearch stand-in for the case-level retrieval unit tests (`retrieval.v2`). It
 * answers each request by its kind, the way the real indexes would for synthetic data:
 *
 * - `getMapping`: the `_meta` of the passages and the cases index;
 * - `keyword` / `vector` (passage channels) and `cases` (the cases index): canned ranked
 *   hits with descending scores, cut to the request's size;
 * - `count` (mapping): a case's passages under the filter, from `corpus` and `underFilter`;
 * - `mapping` (per-case kNN): that case's passages under the filter by `similarity`,
 *   at most `k`, honouring `num_candidates` the way an exact search does;
 * - `fetch`: the passages asked for by id and every probable cause of the cases asked for.
 *
 * Every call is recorded with its kind and transport signal; a kind can be failed, made
 * incomplete or held back until released (to order concurrent requests in a test).
 */
import type { Client, estypes } from '@elastic/elasticsearch';
import type { Query } from '../../server/search/filters.js';

export type Kind = 'keyword' | 'vector' | 'cases' | 'count' | 'mapping' | 'fetch';
export type SectionKind = 'factual' | 'analysis' | 'probable_cause';

export interface FakePassage {
  passage_id: string;
  ntsb_no: string;
  section_id: string;
  revision_id: string;
  section_kind: SectionKind;
  scope: 'aircraft' | 'event';
  aircraft_specific: boolean;
  aircraft_key: number | null;
  start: number;
  end: number;
  part: number;
  parts: number;
  continuation: boolean;
  text: string;
}

export function passage(ntsbNo: string, kind: SectionKind, part = 1, opts: { section?: string; words?: number; event?: boolean } = {}): FakePassage {
  const section = opts.section ?? kind;
  return {
    passage_id: `${ntsbNo}:${section}:${part}`,
    ntsb_no: ntsbNo,
    section_id: `${ntsbNo}:${section}`,
    revision_id: `r-${ntsbNo}-${section}`,
    section_kind: kind,
    scope: opts.event ? 'event' : 'aircraft',
    aircraft_specific: !opts.event,
    aircraft_key: opts.event ? null : 1,
    start: 0,
    end: 10,
    part,
    parts: 1,
    continuation: part > 1,
    text: Array.from({ length: opts.words ?? 20 }, (_, i) => `word${i}`).join(' '),
  };
}

/** A case with `analysis` parts 1..n, one factual passage and one probable cause. */
export function casePassages(ntsbNo: string, analysisParts = 3): FakePassage[] {
  return [
    ...Array.from({ length: analysisParts }, (_, i) => passage(ntsbNo, 'analysis', i + 1)),
    passage(ntsbNo, 'factual', 1),
    passage(ntsbNo, 'probable_cause', 1),
  ];
}

export interface Call {
  kind: Kind;
  body: estypes.SearchRequest;
  signal: AbortSignal | undefined;
}

export interface FakeEsOptions {
  passagesIndex: string;
  casesIndex: string;
  /** `_meta` of each index (merged over valid defaults by the caller). */
  meta: Record<string, Record<string, unknown>>;
  /** Every passage of the passages index. */
  corpus: FakePassage[];
  /** Canned channel results, best first (passage ids, or case numbers for `cases`). */
  keyword: string[];
  vector: string[];
  cases: string[];
  /** Whether a passage satisfies the request's passages filter (default: every passage). */
  underFilter?: (p: FakePassage, filter: Query[]) => boolean;
  /** Cosine order within a case (higher first; default: corpus order). */
  similarity?: (p: FakePassage) => number;
  /** Requests that fail outright, by kind. */
  fail?: Partial<Record<Kind, () => Error>>;
  /** Response changes (incompleteness), by kind. */
  tamper?: Partial<Record<Kind, (res: estypes.SearchResponse<Record<string, unknown>>) => void>>;
  /** Kinds whose answer waits until `release(kind)`. */
  hold?: Kind[];
}

export interface FakeEs {
  es: Client;
  calls: Call[];
  mappingCalls: number;
  kinds(): Kind[];
  release(kind: Kind): void;
  /** Resolves once a request of `kind` arrived. */
  arrived(kind: Kind): Promise<void>;
}

const CASE_TERM = (body: estypes.SearchRequest): string | null => {
  const filters = ((body.knn as estypes.KnnSearch | undefined)?.filter as { bool?: { filter?: Query[] } } | undefined)?.bool?.filter ?? (body.query?.bool?.filter as Query[] | undefined) ?? [];
  for (const f of filters) {
    const t = (f as { term?: { ntsb_no?: string } }).term;
    if (t?.ntsb_no) return t.ntsb_no;
  }
  return null;
};

export function kindOf(body: estypes.SearchRequest, casesIndex: string): Kind {
  if (body.index === casesIndex) return 'cases';
  if (body.knn) return CASE_TERM(body) ? 'mapping' : 'vector';
  if (body.size === 0) return 'count';
  return body.query?.bool?.must ? 'keyword' : 'fetch';
}

export function createFakeEs(o: FakeEsOptions): FakeEs {
  const calls: Call[] = [];
  const held = new Map<Kind, { promise: Promise<void>; resolve: () => void }>();
  for (const k of o.hold ?? []) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    held.set(k, { promise, resolve });
  }
  const waiters: { kind: Kind; resolve: () => void }[] = [];
  const byId = new Map(o.corpus.map((p) => [p.passage_id, p]));
  const under = (p: FakePassage, filter: Query[]) => (o.underFilter ? o.underFilter(p, filter) : true);
  const meta = (p: FakePassage) => {
    const { text: _text, ...m } = p;
    return m;
  };
  const reply = (hits: estypes.SearchHit<Record<string, unknown>>[], total?: number): estypes.SearchResponse<Record<string, unknown>> => ({
    took: 1,
    timed_out: false,
    _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
    hits: { total: { value: total ?? hits.length, relation: 'eq' as const }, hits },
  });
  const ranked = (ids: string[], size: number, index: string) =>
    ids.slice(0, size).map((id, i) => {
      const p = byId.get(id);
      if (!p) throw new Error(`fake: unknown passage ${id}`);
      return { _index: index, _id: id, _score: 100 - i, _source: meta(p) as Record<string, unknown> };
    });

  const state: FakeEs = {
    es: undefined as unknown as Client,
    calls,
    mappingCalls: 0,
    kinds: () => calls.map((c) => c.kind),
    release: (k) => held.get(k)?.resolve(),
    arrived: (k) =>
      calls.some((c) => c.kind === k)
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ kind: k, resolve });
          }),
  };
  const client = {
    indices: {
      getMapping: async ({ index }: { index: string }) => {
        state.mappingCalls += 1;
        const m = o.meta[index];
        if (!m) {
          const err = Object.assign(new Error('index_not_found_exception'), { meta: { statusCode: 404 } });
          throw err;
        }
        return { [index]: { mappings: { _meta: m } } };
      },
    },
    search: async (body: estypes.SearchRequest, transport: { signal?: AbortSignal } = {}) => {
      const kind = kindOf(body, o.casesIndex);
      calls.push({ kind, body, signal: transport.signal });
      for (const w of waiters.filter((x) => x.kind === kind)) w.resolve();
      const h = held.get(kind);
      if (h) {
        await new Promise<void>((resolve, reject) => {
          const s = transport.signal;
          if (s?.aborted) return reject(Object.assign(new Error('Request aborted'), { name: 'RequestAbortedError' }));
          s?.addEventListener('abort', () => reject(Object.assign(new Error('Request aborted'), { name: 'RequestAbortedError' })), { once: true });
          void h.promise.then(resolve);
        });
      }
      if (transport.signal?.aborted) throw Object.assign(new Error('Request aborted'), { name: 'RequestAbortedError' });
      const fail = o.fail?.[kind];
      if (fail) throw fail();
      let res: estypes.SearchResponse<Record<string, unknown>>;
      const filter = (body.query?.bool?.filter ?? ((body.knn as estypes.KnnSearch | undefined)?.filter as { bool: { filter: Query[] } } | undefined)?.bool.filter ?? []) as Query[];
      switch (kind) {
        case 'keyword':
          res = reply(ranked(o.keyword, body.size ?? 10, o.passagesIndex));
          break;
        case 'vector':
          res = reply(ranked(o.vector, (body.knn as estypes.KnnSearch).k ?? 10, o.passagesIndex));
          break;
        case 'cases':
          res = reply(o.cases.slice(0, body.size ?? 10).map((n, i) => ({ _index: o.casesIndex, _id: n, _score: 50 - i * 0.5, _source: { ntsb_no: n } })));
          break;
        case 'count': {
          const n = CASE_TERM(body);
          res = reply([], o.corpus.filter((p) => p.ntsb_no === n && under(p, filter)).length);
          break;
        }
        case 'mapping': {
          const knn = body.knn as estypes.KnnSearch;
          const n = CASE_TERM(body);
          const own = o.corpus.filter((p) => p.ntsb_no === n && under(p, filter));
          // An exact search considers every candidate only when num_candidates covers them.
          const considered = own.slice(0, knn.num_candidates ?? 0);
          const sim = o.similarity ?? (() => 0);
          const best = [...considered].sort((a, b) => sim(b) - sim(a)).slice(0, knn.k ?? 0);
          res = reply(best.map((p) => ({ _index: o.passagesIndex, _id: p.passage_id, _score: 1 + sim(p), _source: meta(p) as Record<string, unknown> })));
          break;
        }
        case 'fetch': {
          const b = (body.query as { bool: { filter: Query[] } }).bool;
          const wanted = (b.filter.at(-1) as { bool: { should: Query[] } }).bool.should;
          const ids = new Set<string>();
          const causeCases = new Set<string>();
          for (const w of wanted as Record<string, unknown>[]) {
            if ('ids' in w) for (const id of (w.ids as { values: string[] }).values) ids.add(id);
            else for (const n of (w as { bool: { filter: { terms?: { ntsb_no: string[] } }[] } }).bool.filter[0]?.terms?.ntsb_no ?? []) causeCases.add(n);
          }
          const out = o.corpus.filter((p) => under(p, b.filter.slice(0, -1)) && (ids.has(p.passage_id) || (causeCases.has(p.ntsb_no) && p.section_kind === 'probable_cause')));
          res = reply(out.map((p) => ({ _index: o.passagesIndex, _id: p.passage_id, _score: 0, _source: { ...meta(p), text: p.text } as Record<string, unknown> })));
          break;
        }
      }
      o.tamper?.[kind]?.(res);
      return res;
    },
  };
  state.es = client as unknown as Client;
  return state;
}
