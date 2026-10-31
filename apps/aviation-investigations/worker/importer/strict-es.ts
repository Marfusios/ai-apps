import type { Client } from '@elastic/elasticsearch';
import { ImportFailure } from './contracts.js';
import { passageId } from '../index/passages.js';
import { createHash } from 'node:crypto';
import type { CaseRecord } from '../../server/db/queries/case-records.js';
import { sectionIdOf, sectionRevisionId } from '../ingest/load.js';

/** Validate every source section before the plan/build consumes it, not merely sampled stored documents. */
export function validateRecord(r: CaseRecord): CaseRecord {
  if (!r.isUs || r.country !== 'USA' || !r.answerEligible) throw new ImportFailure('integrity');
  for (const s of r.sections) {
    if (
      createHash('sha256').update(s.text).digest('hex') !== s.sha256 ||
      s.sectionId !== sectionIdOf(r.ntsbNo, s.sectionKey) ||
      s.revisionId !== sectionRevisionId(r.ntsbNo, s.sectionKey, s.sha256, s.citationTextVersion)
    )
      throw new ImportFailure('integrity');
  }
  return r;
}

export function strictShards(value: unknown): void {
  const s = value as
    | { total?: unknown; successful?: unknown; failed?: unknown; skipped?: unknown }
    | undefined;
  const numbers = [s?.total, s?.successful, s?.failed, s?.skipped ?? 0];
  if (
    numbers.some((n) => !Number.isSafeInteger(n) || Number(n) < 0) ||
    !s ||
    Number(s.total) < 1 ||
    s.successful !== s.total ||
    s.failed !== 0 ||
    Number(s.skipped ?? 0) > Number(s.successful)
  )
    throw new ImportFailure('probe');
}
export function strictSearch(value: unknown): void {
  const r = value as {
    _shards?: unknown;
    timed_out?: boolean;
    terminated_early?: boolean;
    hits?: { total?: number | { value: number; relation: string }; hits?: unknown[] };
  };
  strictShards(r._shards);
  const total = r.hits?.total;
  const n = typeof total === 'number' ? total : total?.value;
  if (
    r.timed_out !== false ||
    r.terminated_early === true ||
    !Number.isSafeInteger(n) ||
    Number(n) < 0 ||
    (typeof total === 'object' && total.relation !== 'eq') ||
    !Array.isArray(r.hits?.hits)
  )
    throw new ImportFailure('probe');
}
function completeAggregations(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(completeAggregations);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  for (const name of ['sum_other_doc_count', 'doc_count_error_upper_bound']) {
    if (name in row && row[name] !== 0) throw new ImportFailure('probe');
  }
  Object.values(row).forEach(completeAggregations);
}
export function validateDocument(doc: Record<string, unknown>): void {
  if (typeof doc.ntsb_no !== 'string' || !doc.ntsb_no.trim() || doc.country !== 'USA')
    throw new ImportFailure('integrity');
  if ('passage_id' in doc) {
    if (
      typeof doc.passage_id !== 'string' ||
      !/^[0-9a-f]{64}$/.test(doc.passage_id) ||
      typeof doc.revision_id !== 'string' ||
      doc.passage_id !== passageId(doc.revision_id, Number(doc.start), Number(doc.end)) ||
      doc.answer_eligible !== true ||
      typeof doc.text !== 'string' ||
      !Number.isSafeInteger(doc.start) ||
      Number(doc.start) < 0 ||
      Number(doc.end) - Number(doc.start) !== doc.text.length ||
      !Array.isArray(doc.embedding) ||
      doc.embedding.length !== 1536 ||
      doc.embedding.some((v) => typeof v !== 'number' || !Number.isFinite(v))
    ) {
      throw new ImportFailure('integrity');
    }
    if (
      doc.aircraft_specific === false &&
      (doc.event_aircraft_complete !== true ||
        !Array.isArray(doc.event_aircraft) ||
        doc.event_aircraft.length !== doc.event_aircraft_count ||
        doc.event_aircraft.length < 2 ||
        !Array.isArray(doc.aircraft) ||
        doc.aircraft.length !== 0)
    )
      throw new ImportFailure('integrity');
    if (
      doc.aircraft_specific === true &&
      (doc.scope !== 'aircraft' ||
        !Number.isSafeInteger(doc.aircraft_key) ||
        !Array.isArray(doc.aircraft) ||
        doc.aircraft.length !== 1 ||
        (doc.aircraft[0] as { aircraft_key?: unknown })?.aircraft_key !== doc.aircraft_key ||
        doc.event_aircraft_complete !== false ||
        doc.event_aircraft_count !== null ||
        !Array.isArray(doc.event_aircraft) ||
        doc.event_aircraft.length !== 0)
    )
      throw new ImportFailure('integrity');
    if (doc.aircraft_specific === false && (doc.scope !== 'event' || doc.aircraft_key !== null))
      throw new ImportFailure('integrity');
  } else if (!Array.isArray(doc.aircraft) || doc.aircraft.length !== doc.aircraft_count)
    throw new ImportFailure('integrity');
}
/** Import-only strict transport wrapper; no changes to operational alias behavior. */
export function certificationClient(client: Client): Client {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'search')
        return async (
          request: Parameters<Client['search']>[0],
          options?: Parameters<Client['search']>[1],
        ) => {
          const r = await target.search(
            { ...request, track_total_hits: true, allow_partial_search_results: false },
            options,
          );
          strictSearch(r);
          const total = typeof r.hits.total === 'number' ? r.hits.total : r.hits.total!.value;
          if (
            r.hits.hits.length !==
            Math.min(request?.size ?? 10, Math.max(0, total - (request?.from ?? 0)))
          )
            throw new ImportFailure('probe');
          completeAggregations(r.aggregations);
          return r;
        };
      if (prop === 'count')
        return async (
          request: Parameters<Client['count']>[0],
          options?: Parameters<Client['count']>[1],
        ) => {
          const r = await target.count(request, options);
          strictShards(r._shards);
          if (!Number.isSafeInteger(r.count) || r.count < 0) throw new ImportFailure('probe');
          return r;
        };
      if (prop === 'bulk')
        return async (
          request: Parameters<Client['bulk']>[0],
          options?: Parameters<Client['bulk']>[1],
        ) => {
          const operations = request.operations as Record<string, unknown>[] | undefined;
          if (!operations || operations.length % 2) throw new ImportFailure('integrity');
          for (let i = 0; i < operations.length; i += 2) {
            const doc = operations[i + 1]!,
              action = operations[i]!.create as { _id?: string } | undefined;
            validateDocument(doc);
            if (action?._id !== (doc.passage_id ?? doc.ntsb_no))
              throw new ImportFailure('integrity');
          }
          const r = await target.bulk(request, options);
          if (r.items.length !== operations.length / 2) throw new ImportFailure('probe');
          r.items.forEach((item, i) => {
            const a = operations[i * 2]!.create as { _id: string; _index: string },
              got = item.create;
            if (
              !got ||
              got._id !== a._id ||
              got._index !== a._index ||
              !Number.isInteger(got.status) ||
              (!got.error && got.status !== 201) ||
              (got.error && got.status < 400)
            )
              throw new ImportFailure('probe');
          });
          if (r.errors !== r.items.some((i) => Boolean(i.create?.error)))
            throw new ImportFailure('probe');
          return r;
        };
      if (prop === 'indices')
        return new Proxy(target.indices, {
          get(indices, key) {
            if (key === 'refresh')
              return async (...args: Parameters<Client['indices']['refresh']>) => {
                const r = await indices.refresh(...args);
                strictShards(r._shards);
                return r;
              };
            const value: unknown = Reflect.get(indices, key, indices);
            return typeof value === 'function' ? value.bind(indices) : value;
          },
        });
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
