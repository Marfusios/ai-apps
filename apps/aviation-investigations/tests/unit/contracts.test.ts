import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CaseDetailSchema } from '../../shared/contracts/cases.js';
import { ConfigResponseSchema } from '../../shared/contracts/config.js';
import { DashboardResponseSchema } from '../../shared/contracts/dashboard.js';
import {
  DEFAULT_COMPLETION,
  SearchRequestSchema,
  SearchResponseSchema,
  paramsToQuery,
  searchRequestToParams,
} from '../../shared/contracts/search.js';

const appDir = join(import.meta.dirname, '..', '..');
const cases = JSON.parse(readFileSync(join(appDir, 'web/mock/cases.json'), 'utf8')) as Record<string, unknown>;
const sampleCase = cases.DFW08TA066 as Record<string, unknown>;

/** Every object key reachable in a Zod schema (through objects, arrays, unions, wrappers). */
function schemaKeys(schema: z.ZodType, seen = new Set<z.ZodType>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  const keys: string[] = [];
  const visit = (child: unknown): void => {
    if (child && typeof child === 'object' && '_zod' in child) keys.push(...schemaKeys(child as z.ZodType, seen));
  };
  if (def.type === 'object') {
    for (const [key, child] of Object.entries(def.shape as Record<string, unknown>)) {
      keys.push(key);
      visit(child);
    }
  }
  for (const field of ['element', 'innerType', 'in', 'out', 'schema', 'catchall']) visit(def[field]);
  for (const option of (def.options as unknown[] | undefined) ?? []) visit(option);
  for (const item of (def.items as unknown[] | undefined) ?? []) visit(item);
  return keys;
}

describe('CaseDetail contract', () => {
  it('case endpoint never contains AI fields: no AI key anywhere in the schema', () => {
    const keys = schemaKeys(CaseDetailSchema);
    expect(keys.length).toBeGreaterThan(80);
    const forbidden = new Set([
      'ai', 'brief', 'briefs', 'step', 'summary', 'why', 'matched', 'verdict', 'classification', 'classified',
      'glyph', 'evidence', 'timing', 'interpretation', 'interpretations', 'reading', 'generated', 'llm', 'prompt',
    ]);
    const words = (key: string): string[] => key.split(/(?=[A-Z])|_/).map((w) => w.toLowerCase());
    expect(keys.filter((k) => words(k).some((w) => forbidden.has(w)))).toEqual([]);
    expect(keys).not.toContain('evId');
    expect(keys).not.toContain('ev_id');
  });

  it('rejects unknown keys at every level, so AI output cannot ride along', () => {
    expect(CaseDetailSchema.safeParse(sampleCase).success).toBe(true);
    expect(CaseDetailSchema.safeParse({ ...sampleCase, aiSummary: 'text' }).success).toBe(false);
    expect(CaseDetailSchema.safeParse({ ...sampleCase, evId: '20080222X00229' }).success).toBe(false);
    const findings = sampleCase.findings as Record<string, unknown>[];
    const withVerdict = { ...sampleCase, findings: [{ ...findings[0], verdict: 'causal' }] };
    expect(CaseDetailSchema.safeParse(withVerdict).success).toBe(false);
  });

  it('allows aircraft-scoped sections only in single-aircraft cases (A3)', () => {
    type Detail = { aircraft: { aircraftKey: number }[]; sections: Record<string, unknown>[] };
    const single = sampleCase as unknown as Detail;
    expect(single.sections.every((s) => s.scope === 'aircraft' && s.aircraftKey === 1)).toBe(true);
    expect(CaseDetailSchema.safeParse(single).success).toBe(true);
    // The same section pointing at another aircraft, or carrying a key while event-scoped, fails.
    const wrongKey = { ...single, sections: single.sections.map((s) => ({ ...s, aircraftKey: 2 })) };
    expect(CaseDetailSchema.safeParse(wrongKey).success).toBe(false);
    const eventWithKey = { ...single, sections: single.sections.map((s) => ({ ...s, scope: 'event' })) };
    expect(CaseDetailSchema.safeParse(eventWithKey).success).toBe(false);

    const multi = cases.SEA08LA057 as unknown as Detail;
    expect(multi.aircraft).toHaveLength(2);
    expect(multi.sections.every((s) => s.scope === 'event' && s.aircraftKey === null)).toBe(true);
    expect(CaseDetailSchema.safeParse(multi).success).toBe(true);
    const attributed = { ...multi, sections: multi.sections.map((s, i) => (i === 0 ? { ...s, scope: 'aircraft', aircraftKey: 1 } : s)) };
    const result = CaseDetailSchema.safeParse(attributed);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('aircraft scope is valid only when the case has exactly one aircraft');
    // A case with no aircraft row cannot have aircraft-scoped text either.
    const none = { ...single, aircraft: [] };
    expect(CaseDetailSchema.safeParse(none).success).toBe(false);
  });

  it('labels findings only with the raw in-probable-cause flag, never cause or factor', () => {
    const keys = schemaKeys(CaseDetailSchema);
    expect(keys).toContain('inProbableCause');
    expect(keys.filter((k) => /cause_?factor|contributing/i.test(k))).toEqual([]);
  });

  it('accepts only the fixed report template or the labelled search fallback', () => {
    const report = (url: string) =>
      CaseDetailSchema.safeParse({ ...sampleCase, report: { kind: 'report', url, label: 'NTSB final report', capturedOn: '2026-10-01' } })
        .success;
    expect(report('https://data.ntsb.gov/carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/66123/pdf')).toBe(true);
    expect(report('https://evil.example/carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/66123/pdf')).toBe(false);
    expect(report('javascript:alert(1)')).toBe(false);
    const search = { kind: 'search', url: 'https://my.ntsb.gov/aviation', label: 'Search NTSB aviation investigations', note: 'Direct report link unavailable' };
    expect(CaseDetailSchema.safeParse({ ...sampleCase, report: search }).success).toBe(true);
    expect(CaseDetailSchema.safeParse({ ...sampleCase, report: { ...search, label: 'NTSB report' } }).success).toBe(false);
  });
});

describe('SearchRequest contract', () => {
  it('applies defaults: empty query over the default cohort, newest first', () => {
    const r = SearchRequestSchema.parse({});
    expect(r).toMatchObject({ q: '', mentionedIn: 'anywhere', sort: 'newest', page: 1, pageSize: 20 });
    expect(r.completion).toEqual(DEFAULT_COMPLETION);
    expect(r.phase).toEqual([]);
  });

  it('accepts repeated keys and comma lists, and completion=any turns the cohort filter off', () => {
    const r = SearchRequestSchema.parse({ phase: ['initial_climb', 'takeoff,initial_climb'], completion: 'any' });
    expect(r.phase).toEqual(['takeoff', 'initial_climb']); // vocabulary (flight) order
    expect(r.completion).toEqual([]);
  });

  it('rejects a 1,501-character query, unknown facet values and bad ranges', () => {
    expect(SearchRequestSchema.safeParse({ q: 'a'.repeat(1500) }).success).toBe(true);
    expect(SearchRequestSchema.safeParse({ q: 'a'.repeat(1501) }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ phase: 'cruise' }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ injury: 'fatal' }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ page: '51' }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ pageSize: '51' }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ yearFrom: '2020', yearTo: '2010' }).success).toBe(false);
  });

  it('keeps Lucene syntax as literal text', () => {
    expect(SearchRequestSchema.parse({ q: 'carb* AND (icing' }).q).toBe('carb* AND (icing');
  });

  it('round-trips through a canonical query string', () => {
    const r = SearchRequestSchema.parse({ q: 'carburetor icing', injury: 'NONE,FATL', completion: 'any', yearFrom: '2010', sort: 'oldest' });
    const params = searchRequestToParams(r);
    expect(params.toString()).toBe('q=carburetor+icing&completion=any&injury=FATL%2CNONE&yearFrom=2010&sort=oldest');
    expect(SearchRequestSchema.parse(paramsToQuery(params))).toEqual(r);
    expect(searchRequestToParams(SearchRequestSchema.parse({})).toString()).toBe('');
  });
});

describe('mock responses satisfy the contracts', () => {
  const read = (name: string): unknown => JSON.parse(readFileSync(join(appDir, 'web/mock', name), 'utf8'));

  it('config, dashboards and every case detail', () => {
    // Older cached configs may omit automatic-filter capability.
    expect(() => ConfigResponseSchema.parse(read('config.json'))).not.toThrow();
    expect(() => DashboardResponseSchema.parse(read('dashboard-default.json'))).not.toThrow();
    expect(() => DashboardResponseSchema.parse(read('dashboard-all.json'))).not.toThrow();
    for (const [ntsbNo, detail] of Object.entries(cases)) {
      const parsed = CaseDetailSchema.safeParse(detail);
      expect(parsed.success, `${ntsbNo}: ${parsed.error?.message ?? ''}`).toBe(true);
    }
  });

  it('every sample search response', () => {
    const samples = read('search-samples.json') as Record<string, { query: Record<string, string>; response: unknown }>;
    expect(Object.keys(samples).length).toBeGreaterThanOrEqual(5);
    for (const [name, sample] of Object.entries(samples)) {
      expect(SearchRequestSchema.safeParse(sample.query).success, name).toBe(true);
      const parsed = SearchResponseSchema.safeParse(sample.response);
      expect(parsed.success, `${name}: ${parsed.error?.message ?? ''}`).toBe(true);
    }
  });

  it('no internal ev_id appears in any mock file', () => {
    for (const name of ['config.json', 'dashboard-default.json', 'dashboard-all.json', 'cases.json', 'search-index.json', 'search-samples.json']) {
      const text = readFileSync(join(appDir, 'web/mock', name), 'utf8');
      expect(text, name).not.toMatch(/"ev_?[iI]d"/);
      // Fixture event ids look like 20080222X00229 or 20240516194273.
      expect(text, name).not.toMatch(/\b20\d{6}X\d{5}\b/);
      expect(text, name).not.toMatch(/\b20\d{12}\b/);
    }
  });
});
