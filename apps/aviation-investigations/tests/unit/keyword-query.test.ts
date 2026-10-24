import { describe, expect, it } from 'vitest';
import { SearchRequestSchema } from '../../shared/contracts/search.js';
import { contentSecurityPolicy, securityHeaders } from '../../server/http/security-headers.js';
import { FRAGMENT_SIZE, SECTION_EDGE, buildSearchBody, parseQuery, sectionEdges, snippetFromHighlights, textQuery, unmark } from '../../server/search/keyword.js';
import { SEARCH_TIMEOUT, SearchIncompleteError, SearchTimedOutError, assertComplete } from '../../server/search/timeout.js';
import { isUnavailable } from '../../server/app.js';
import { THEME_SCRIPT_HASH } from '../../web/src/csp-hashes.js';

const request = (q: Record<string, string>) => SearchRequestSchema.parse(q);

describe('query text', () => {
  it('splits quoted phrases from words and drops stray quotes', () => {
    expect(parseQuery('carb "loss of engine power" icing')).toEqual({ words: 'carb icing', phrases: ['loss of engine power'] });
    expect(parseQuery('"unbalanced quote')).toEqual({ words: 'unbalanced quote', phrases: [] });
    expect(parseQuery('"" "  " word')).toEqual({ words: 'word', phrases: [] });
  });

  it('keeps at most eight phrases; the rest are words', () => {
    const q = Array.from({ length: 10 }, (_, i) => `"p${i} x"`).join(' ');
    const parsed = parseQuery(q);
    expect(parsed.phrases).toHaveLength(8);
    expect(parsed.words).toBe('p8 x p9 x');
  });

  it('builds match clauses only: Lucene syntax stays text', () => {
    const query = textQuery('carb* AND (icing "stall spin" title:x /re.+/ ~2 \\', ['probable_cause', 'analysis']);
    const json = JSON.stringify(query);
    for (const forbidden of ['query_string', 'simple_query_string', 'wildcard', 'regexp', 'script', 'fuzzy', 'prefix']) {
      expect(json).not.toContain(forbidden);
    }
    expect(query).toEqual({
      bool: {
        must: [
          {
            multi_match: {
              query: 'carb* AND (icing title:x /re.+/ ~2 \\',
              fields: ['probable_cause', 'analysis'],
              type: 'cross_fields',
              operator: 'and',
              zero_terms_query: 'all',
            },
          },
          {
            bool: {
              should: [
                { match_phrase: { probable_cause: { query: 'stall spin', zero_terms_query: 'all' } } },
                { match_phrase: { analysis: { query: 'stall spin', zero_terms_query: 'all' } } },
              ],
              minimum_should_match: 1,
            },
          },
        ],
      },
    });
    expect(textQuery('   ', ['factual'])).toBeNull();
  });

  it('puts every filter in post_filter and facet aggregations, never in the scored query', () => {
    const { body } = buildSearchBody('ix', request({ q: 'carburetor icing', phase: 'landing', category: 'HELI', injury: 'FATL' }));
    expect(JSON.stringify(body.query)).not.toContain('landing');
    expect(JSON.stringify(body.post_filter)).toContain('landing');
    // Aircraft facets are one nested clause: one aircraft must be a helicopter in landing.
    expect(JSON.stringify(body.post_filter)).toContain(
      JSON.stringify({
        nested: {
          path: 'aircraft',
          query: { bool: { filter: [{ terms: { 'aircraft.defining_phase_group': ['landing'] } }, { terms: { 'aircraft.category': ['HELI'] } }] } },
        },
      }),
    );
    // The phase facet's own aggregation ignores the phase selection but keeps the category inside the nested filter.
    const phaseAgg = JSON.stringify(body.aggs?.facet_phase);
    expect(phaseAgg).not.toContain('"landing"');
    expect(phaseAgg).toContain('"HELI"');
    // The probable cause comes whole; long sections only as their best passage.
    expect(body.highlight?.fields).toEqual({
      probable_cause: { number_of_fragments: 0 },
      analysis: { number_of_fragments: 1, fragment_size: FRAGMENT_SIZE, boundary_scanner: 'sentence', order: 'score' },
      factual: { number_of_fragments: 1, fragment_size: FRAGMENT_SIZE, boundary_scanner: 'sentence', order: 'score' },
    });
    expect(body._source).toBe(false);
    // Every search has a time limit; partial (timed-out) results are never served.
    expect(body.timeout).toBe(SEARCH_TIMEOUT);
    expect(() => assertComplete({ timed_out: true })).toThrow(SearchTimedOutError);
    expect(() => assertComplete({ timed_out: false })).not.toThrow();
  });

  it('refuses partial results by construction: in the request, and a shard report that is not whole (task 22 S-M1)', () => {
    expect(buildSearchBody('ix', request({ q: 'icing' })).body.allow_partial_search_results).toBe(false);
    expect(buildSearchBody('ix', request({})).body.allow_partial_search_results).toBe(false);
    const whole = { total: 1, successful: 1, skipped: 0, failed: 0 };
    expect(() => assertComplete({ timed_out: false, _shards: whole })).not.toThrow();
    // A failed or missing shard: incomplete counts, never served (503 like a timeout).
    for (const shards of [
      { ...whole, failed: 1, successful: 0 },
      { total: 2, successful: 1, skipped: 0, failed: 0 },
      { ...whole, failures: [{ shard: 0 }] },
      { total: 3, successful: 1, skipped: 2, failed: 0 },
    ]) {
      expect(() => assertComplete({ timed_out: false, _shards: shards }), JSON.stringify(shards)).toThrow(SearchIncompleteError);
      expect(isUnavailable(new SearchIncompleteError('keyword', 'x')), JSON.stringify(shards)).toBe(true);
    }
  });

  it('asks for probable-cause previews and no highlights without a query', () => {
    const { body } = buildSearchBody('ix', request({}));
    expect(body.highlight).toBeUndefined();
    expect(body._source).toEqual(['probable_cause']);
    expect(body.sort).toEqual([{ ev_date: { order: 'desc', missing: '_last' } }, { ntsb_no: { order: 'asc' } }]);
  });
});

describe('snippets from highlights', () => {
  const S = '\uE000';
  const E = '\uE001';

  it('turns markers into offsets', () => {
    expect(unmark(`a ${S}carb${E} b`)).toEqual({ text: 'a carb b', spans: [{ start: 2, end: 6 }] });
    expect(unmark(`${S}open`)).toBeNull();
    expect(unmark(`close${E}`)).toBeNull();
  });

  it('prefers the probable cause, merges adjacent marks and keeps the whole short cause', () => {
    const snippet = snippetFromHighlights({
      analysis: [`${S}carburetor${E} ${S}icing${E} and ${S}carburetor${E} again`],
      probable_cause: [`A loss of power due to ${S}carburetor${E} ${S}icing${E}.`],
    });
    expect(snippet).toEqual({
      section: 'probable_cause',
      label: 'Probable cause',
      text: 'A loss of power due to carburetor icing.',
      highlights: [{ start: 23, end: 39 }],
      truncatedStart: false,
      truncatedEnd: false,
    });
  });

  it('otherwise takes the passage with the most marks (analysis first on a tie), as an excerpt', () => {
    const passage = `The pilot applied ${S}carb${E} heat after the ${S}carb${E} temperature fell.`;
    const snippet = snippetFromHighlights({ factual: [`${S}carb${E} once`, passage], analysis: [`one ${S}carb${E}`] });
    expect(snippet).toMatchObject({ section: 'factual', label: 'Factual', truncatedStart: true, truncatedEnd: true });
    expect(snippet?.text).toBe('The pilot applied carb heat after the carb temperature fell.');
    const text = snippet?.text ?? '';
    expect(snippet?.highlights.map((h) => text.slice(h.start, h.end))).toEqual(['carb', 'carb']);
    const tie = snippetFromHighlights({ factual: [`a ${S}carb${E}`], analysis: [`b ${S}carb${E}`] });
    expect(tie?.section).toBe('analysis');
    // A long passage (a sentence without breaks) is still cut to the contract's limits.
    const long = snippetFromHighlights({ factual: [`${'word '.repeat(300)}${S}carb${E}${' tail'.repeat(300)}`] });
    expect(long?.text.length).toBeLessThanOrEqual(1200);
    expect(long?.highlights).toHaveLength(1);
  });

  it('marks a passage truncated only on a side where its section goes on (task 22 S-M7)', () => {
    const section = 'The pilot applied carb heat. The engine recovered. Then it quit again over the lake.';
    const edges = (...sections: string[]) => sectionEdges(sections);
    // The section's first sentences: nothing before them, more after.
    const first = snippetFromHighlights({ analysis: [`The pilot applied ${S}carb${E} heat. The engine recovered.`] }, { analysis: edges(section) });
    expect(first).toMatchObject({ section: 'analysis', truncatedStart: false, truncatedEnd: true });
    // Its last sentence: more before, nothing after.
    const last = snippetFromHighlights({ analysis: [`Then it quit again over the ${S}lake${E}.`] }, { analysis: edges(section) });
    expect(last).toMatchObject({ truncatedStart: true, truncatedEnd: false });
    // The whole section, in one of several (an event's per-aircraft variants).
    const whole = snippetFromHighlights({ factual: [section.replace('carb', `${S}carb${E}`)] }, { factual: edges('Another aircraft.', section) });
    expect(whole).toMatchObject({ section: 'factual', truncatedStart: false, truncatedEnd: false });
    // The middle, or no edges reported: truncated on both sides, as before.
    expect(snippetFromHighlights({ analysis: [`The engine ${S}recovered${E}.`] }, { analysis: edges(section) })).toMatchObject({ truncatedStart: true, truncatedEnd: true });
    expect(snippetFromHighlights({ analysis: [`The pilot applied ${S}carb${E} heat.`] })).toMatchObject({ truncatedStart: true, truncatedEnd: true });
    // A long section: only its edges are known, and a passage that begins it is still found.
    const long = `Long opening sentence about the ${'approach '.repeat(40)}path. ${'More text. '.repeat(60)}End.`;
    const head = long.slice(0, long.indexOf('. ') + 1);
    expect(snippetFromHighlights({ analysis: [head.replace('opening', `${S}opening${E}`)] }, { analysis: edges(long) })).toMatchObject({
      truncatedStart: false,
      truncatedEnd: true,
    });
  });

  it('asks Elasticsearch for each long section’s edges only, never its text', () => {
    const { body } = buildSearchBody('ix', request({ q: 'icing' }));
    expect(body._source).toBe(false);
    expect(Object.keys(body.script_fields ?? {}).sort()).toEqual(['analysis_edges', 'factual_edges']);
    expect(JSON.stringify(body.script_fields)).toContain(`"edge":${SECTION_EDGE}`);
    expect(buildSearchBody('ix', request({ q: 'icing', mentionedIn: 'probable_cause' })).body.script_fields).toBeUndefined();
    expect(buildSearchBody('ix', request({})).body.script_fields).toBeUndefined();
  });

  it('is null when no narrative section matched', () => {
    expect(snippetFromHighlights(undefined)).toBeNull();
    expect(snippetFromHighlights({ findings_text: [`${S}carb${E}`] })).toBeNull();
  });
});

describe('security headers', () => {
  it('has a strict CSP with the theme script hash and no unsafe sources', () => {
    const csp = contentSecurityPolicy();
    expect(csp).toContain(`script-src 'self' '${THEME_SCRIPT_HASH}'`);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-(inline|eval|hashes)/);
  });

  it('allows page styles only by nonce, never for scripts', () => {
    const csp = contentSecurityPolicy({ styleNonce: 'AbCdEfGhIjKlMnOpQrStUvWx' });
    expect(csp).toContain("style-src 'self' 'nonce-AbCdEfGhIjKlMnOpQrStUvWx'");
    expect(csp).toContain(`script-src 'self' '${THEME_SCRIPT_HASH}';`);
    expect(() => contentSecurityPolicy({ styleNonce: "x' 'unsafe-inline" })).toThrow(/invalid CSP nonce/);
  });

  it('allows Cloudflare Turnstile’s script and frame only when it is configured', () => {
    const without = contentSecurityPolicy();
    expect(without).not.toContain('challenges.cloudflare.com');
    expect(without).not.toContain('frame-src');
    const csp = contentSecurityPolicy({ turnstile: true, styleNonce: 'AbCdEfGhIjKlMnOpQrStUvWx' });
    expect(csp).toContain(`script-src 'self' '${THEME_SCRIPT_HASH}' https://challenges.cloudflare.com;`);
    expect(csp).toContain('; frame-src https://challenges.cloudflare.com;');
    expect(csp).toContain("style-src 'self' 'nonce-AbCdEfGhIjKlMnOpQrStUvWx';");
    expect(csp).toContain("connect-src 'self';");
    // Otherwise the policy is the one without Turnstile.
    expect(csp.replace(' https://challenges.cloudflare.com', '').replace('; frame-src https://challenges.cloudflare.com', '')).toBe(
      contentSecurityPolicy({ styleNonce: 'AbCdEfGhIjKlMnOpQrStUvWx' }),
    );
    expect(securityHeaders({ hsts: false, turnstile: true })['content-security-policy']).toBe(contentSecurityPolicy({ turnstile: true }));
    expect(securityHeaders({ hsts: false })['content-security-policy']).toBe(without);
  });

  it('sends HSTS only for an HTTPS origin', () => {
    expect(securityHeaders({ hsts: false })).not.toHaveProperty('strict-transport-security');
    expect(securityHeaders({ hsts: true })['strict-transport-security']).toBe('max-age=31536000');
    expect(securityHeaders({ hsts: false })).toMatchObject({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
  });
});

describe('dashboard map', () => {
  it('allows a point for every US event in the corpus', async () => {
    const { DashboardResponseSchema, MAX_MAP_POINTS } = await import('../../shared/contracts/dashboard.js');
    // 25,407 US events in the 2026-10-16 snapshot; at most one point each.
    expect(MAX_MAP_POINTS).toBeGreaterThanOrEqual(60_000);
    const shape = DashboardResponseSchema.shape.map.shape.points;
    expect(shape.safeParse(Array.from({ length: MAX_MAP_POINTS }, () => [500, 300])).success).toBe(true);
    expect(shape.safeParse(Array.from({ length: MAX_MAP_POINTS + 1 }, () => [500, 300])).success).toBe(false);
  });
});
