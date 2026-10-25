/** Real Elasticsearch, synthetic 100-case worst fan-out; no provider or canonical DB writes. */
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { mapCasesToPassages, MAPPING_CONCURRENCY } from '../../server/search/case-mapping.js';
import { PASSAGES_MAPPING, PASSAGES_SETTINGS } from '../../worker/index/passages-index.js';
import { fakeVector } from '../../worker/index/embed.js';
import { casePassages } from '../support/fake-es.js';
import { testEs, testEsReader } from './helpers.js';

it('maps 100 candidates within the eight-second bound with eight requests in flight', async () => {
  const writer = testEs(), reader = testEsReader();
  const index = `aviation-test-evidence-fanout-${randomBytes(4).toString('hex')}`;
  const cases = Array.from({ length: 100 }, (_, i) => `TST24LA${String(i).padStart(3, '0')}`);
  const vector = [...fakeVector('evidence test query', 1536)];
  try {
    await writer.indices.create({ index, mappings: structuredClone(PASSAGES_MAPPING), settings: structuredClone(PASSAGES_SETTINGS) });
    const documents = cases.flatMap((c) => casePassages(c)).map((p) => ({ ...p, embedding: [...fakeVector(p.passage_id, 1536)] }));
    const bulk = await writer.bulk({ refresh: true, operations: documents.flatMap((p) => [{ index: { _index: index, _id: p.passage_id } }, p]) });
    expect(bulk.errors).toBe(false);
    const times: number[] = [];
    for (let i = 0; i < 21; i++) {
      const start = performance.now();
      const result = await mapCasesToPassages(reader, index, [], vector, cases, { timeoutMs: 8000 },
        { passagesPerCase: 2, maxMappablePassages: 1000, maxCases: 100 });
      if (i > 0) times.push(performance.now() - start);
      expect(result.cases).toHaveLength(100);
      expect(result.cases.every((c) => c.status === 'mapped' && c.returned === 5)).toBe(true);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(8000);
    console.info(JSON.stringify({ measurement: 'evidence-mapping-100', samples: times.length, concurrency: MAPPING_CONCURRENCY,
      cases: cases.length, requestsPerSearch: 200, p50Ms: Math.round(times[9]!), p95Ms: Math.round(p95), maxMs: Math.round(times.at(-1)!) }));
  } finally {
    await writer.indices.delete({ index }, { ignore: [404] });
    await Promise.all([writer.close(), reader.close()]);
  }
}, 120_000);
