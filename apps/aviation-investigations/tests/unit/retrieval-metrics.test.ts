/**
 * The protocol metrics (task 10c protocol v4, section 5): Recall@20 gate eligibility,
 * strict P@6 and precision among returned cases, nDCG@6 with gains 0/1/3, and the
 * unknown-grade bounds with their zero-IDCG flags. The enumeration is checked against
 * a brute force over every assignment.
 */
import { describe, expect, it } from 'vitest';
import {
  GAIN,
  NDCG_ENUMERATION_LIMIT,
  aggregateProtocol,
  boundedVerdict,
  codedReference,
  makeReference,
  ndcgAt,
  ndcgAt6,
  ndcgVerdict,
  precisionAt6,
  recallAt20,
  recallVerdict,
  scoreQuestion,
  type Grade,
  type Label,
  type Reference,
} from '../../evals/retrieval/metrics.js';

const ref = (labels: Record<string, Label>, unlisted: 0 | 'unknown' = 0, exhaustive = false): Reference =>
  makeReference(Object.entries(labels), { unlisted, exhaustive });
const d = (i: number) => 1 / Math.log2(i + 2);
const cases = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/** Every assignment of grades to the unknowns, literally: min and max nDCG over those with a positive ideal DCG. */
function bruteForce(returned: readonly string[], r: Reference): { lower: number; upper: number } | null {
  const top = returned.slice(0, 6);
  const unknowns = [...new Set([...[...r.labels].filter(([, l]) => l === 'unknown').map(([n]) => n), ...top.filter((n) => (r.labels.get(n) ?? r.unlisted) === 'unknown')])];
  let lower = Infinity;
  let upper = -Infinity;
  for (let a = 0; a < 3 ** unknowns.length; a += 1) {
    const grade = new Map<string, Grade>();
    let rest = a;
    for (const n of unknowns) {
      grade.set(n, (rest % 3) as Grade);
      rest = Math.floor(rest / 3);
    }
    const g = (n: string): number => {
      const l = r.labels.get(n) ?? r.unlisted;
      return GAIN[l === 'unknown' ? (grade.get(n) as Grade) : l];
    };
    const dcg = top.reduce((s, n, i) => s + g(n) * d(i), 0);
    const judged = [...new Set([...r.labels.keys(), ...unknowns])];
    const ideal = judged.map(g).sort((x, y) => y - x).slice(0, 6).reduce((s, x, i) => s + x * d(i), 0);
    if (ideal <= 0) continue;
    lower = Math.min(lower, dcg / ideal);
    upper = Math.max(upper, dcg / ideal);
  }
  return lower === Infinity ? null : { lower, upper };
}

describe('nDCG@6 bounds with unknown grades', () => {
  it('passes the review regression: a known relevant case at rank 2, an unknown at rank 1 and one outside the top 6 give [0.387, 1.000]', () => {
    const r = ref({ K: 2, U1: 'unknown', U2: 'unknown', N1: 0, N2: 0, N3: 0, N4: 0 });
    const s = ndcgAt6(['U1', 'K', 'N1', 'N2', 'N3', 'N4', 'U2'], r);
    expect(s.method).toBe('enumeration');
    expect(s.affectingUnknowns).toBe(2);
    expect(s.bounds?.lower).toBeCloseTo(0.387, 3);
    expect(s.bounds?.upper).toBeCloseTo(1, 12);
    // Not the uniform assignments: every unknown 0 gives 0.631, every unknown 2 gives 0.765.
    expect(s.bounds?.lower).not.toBeCloseTo(0.631, 3);
    expect(s.bounds?.upper).not.toBeCloseTo(0.765, 3);
    expect(s.noPositivePossible).toBe(false);
    expect(s.abstention).toBe(false);
    expect(bruteForce(['U1', 'K', 'N1', 'N2', 'N3', 'N4', 'U2'], r)).toEqual(s.bounds);
  });

  it('enumerates exactly as a brute force over every assignment', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pick = (): Label => {
      const x = rand();
      return x < 0.3 ? 'unknown' : x < 0.55 ? 0 : x < 0.75 ? 1 : 2;
    };
    let enumerated = 0;
    for (let trial = 0; trial < 300; trial += 1) {
      const pool = cases('C', 4 + Math.floor(rand() * 8));
      const labels: Record<string, Label> = {};
      for (const n of pool) if (rand() < 0.85) labels[n] = pick();
      const unlisted = rand() < 0.3 ? 'unknown' : 0;
      const r = ref(labels, unlisted);
      const returned = pool.filter(() => rand() < 0.6).slice(0, 6 + Math.floor(rand() * 3));
      const s = ndcgAt6(returned, r);
      if (s.method === 'relaxation') continue;
      const brute = bruteForce(returned, r);
      if (brute === null) {
        expect(s.abstention, `trial ${trial}`).toBe(true);
        continue;
      }
      expect(s.bounds?.lower, `trial ${trial}`).toBeCloseTo(brute.lower, 12);
      expect(s.bounds?.upper, `trial ${trial}`).toBeCloseTo(brute.upper, 12);
      if (s.method === 'enumeration') enumerated += 1;
    }
    expect(enumerated).toBeGreaterThan(100);
  });

  it('falls back to the sound relaxation beyond 12 affecting unknowns', () => {
    // The regression's shape with 13 unknowns outside the list.
    const labels: Record<string, Label> = { K: 2, U1: 'unknown', N1: 0 };
    for (const n of cases('O', NDCG_ENUMERATION_LIMIT)) labels[n] = 'unknown';
    const s = ndcgAt6(['U1', 'K', 'N1'], ref(labels));
    expect(s.affectingUnknowns).toBe(13);
    expect(s.method).toBe('relaxation');
    // Lower: min DCG / max ideal DCG (every unknown 2); upper: max DCG / min ideal DCG, clamped.
    const maxIdeal = 3 * [0, 1, 2, 3, 4, 5].reduce((sum, i) => sum + d(i), 0);
    expect(s.bounds?.lower).toBeCloseTo((3 * d(1)) / maxIdeal, 12);
    expect(s.bounds?.upper).toBe(1);
    // Sound: it contains the exact bounds of the 12-unknown version.
    delete labels.O0;
    const exact = ndcgAt6(['U1', 'K', 'N1'], ref(labels));
    expect(exact.method).toBe('enumeration');
    expect(s.bounds?.lower).toBeLessThanOrEqual(exact.bounds?.lower as number);
    expect(s.bounds?.upper).toBeGreaterThanOrEqual(exact.bounds?.upper as number);
  });

  it('relaxes the upper bound to 0 when no relevant case can be returned and to 1 when the ideal DCG can be 0', () => {
    const many = Object.fromEntries(cases('O', 13).map((n) => [n, 'unknown' as Label]));
    // Nothing returned can be relevant: maximum DCG 0.
    expect(ndcgAt6(['N1'], ref({ N1: 0, K: 2, ...many })).bounds).toEqual({ lower: 0, upper: 0 });
    // No known relevant case: the minimum ideal DCG is 0.
    const s = ndcgAt6(['O0', 'N1'], ref({ N1: 0, ...many }));
    expect(s.method).toBe('relaxation');
    expect(s.noPositivePossible).toBe(true);
    expect(s.bounds).toEqual({ lower: 0, upper: 1 });
  });

  it('flags a question where some assignment leaves no relevant case, and abstains where none can exist', () => {
    const s = ndcgAt6(['U1', 'N1'], ref({ U1: 'unknown', N1: 0 }));
    expect(s).toMatchObject({ method: 'enumeration', noPositivePossible: true, abstention: false });
    // Conditional on a positive ideal DCG, U1 must be relevant: it is at rank 1, so nDCG is 1.
    expect(s.bounds).toEqual({ lower: 1, upper: 1 });
    expect(ndcgVerdict(s, 0.5)).toBe('inconclusive');
    expect(ndcgVerdict(s, 0.5, true)).toBe('pass');
    const none = ndcgAt6(['N1'], ref({ N1: 0 }));
    expect(none).toMatchObject({ bounds: null, abstention: true, noPositivePossible: true });
    expect(ndcgVerdict(none, 0.5)).toBeNull();
    // An unknown that is returned but unlisted counts as an unknown when unlisted cases are unknown.
    expect(ndcgAt6(['X'], ref({}, 'unknown'))).toMatchObject({ abstention: false, noPositivePossible: true, bounds: { lower: 1, upper: 1 } });
    expect(ndcgAt6(['X'], ref({}, 0)).abstention).toBe(true);
  });

  it('ignores unknowns outside the list once six known fully relevant cases fix the ideal DCG', () => {
    const labels: Record<string, Label> = Object.fromEntries(cases('K', 6).map((n) => [n, 2 as Label]));
    for (const n of cases('O', 30)) labels[n] = 'unknown';
    const s = ndcgAt6(['K0', 'X', 'K1'], ref(labels));
    expect(s.method).toBe('exact');
    expect(s.affectingUnknowns).toBe(0);
    const ideal = 3 * [0, 1, 2, 3, 4, 5].reduce((sum, i) => sum + d(i), 0);
    expect(s.bounds?.lower).toBeCloseTo((3 * d(0) + 3 * d(2)) / ideal, 12);
  });
});

describe('graded nDCG@6, strict P@6 and Recall@20', () => {
  it('uses gains 0/1/3 with the ideal ranking from the labels, and scores an empty list 0', () => {
    const r = ref({ A: 2, B: 1, C: 0, D: 2 });
    const s = ndcgAt6(['B', 'A', 'C'], r);
    const dcg = 1 * d(0) + 3 * d(1);
    const ideal = 3 * d(0) + 3 * d(1) + 1 * d(2);
    expect(s.method).toBe('exact');
    expect(s.bounds?.lower).toBeCloseTo(dcg / ideal, 12);
    expect(s.bounds?.upper).toBe(s.bounds?.lower);
    expect(ndcgAt6([], r).bounds).toEqual({ lower: 0, upper: 0 });
    // Binary silver nDCG is the protocol nDCG with every expected case fully relevant.
    expect(ndcgAt(['A', 'B'], ['X', 'A', 'B'])).toBeCloseTo((d(1) + d(2)) / (d(0) + d(1)), 12);
  });

  it('counts unfilled positions as zero in strict P@6 and reports precision among returned cases separately', () => {
    const r = ref({ A: 2, B: 1, U: 'unknown' });
    const p = precisionAt6(['A', 'B', 'U'], r);
    expect(p.strict).toEqual({ lower: 1 / 6, upper: 2 / 6 });
    expect(p.amongReturned).toEqual({ lower: 1 / 3, upper: 2 / 3 });
    expect(p).toMatchObject({ returned: 3, unknown: 1 });
    expect(precisionAt6([], r)).toMatchObject({ strict: { lower: 0, upper: 0 }, amongReturned: null, returned: 0 });
    // Only the first six count, once each.
    expect(precisionAt6(['A', 'A', 'X1', 'X2', 'X3', 'X4', 'X5', 'B'], ref({ A: 2, B: 2 })).strict.lower).toBe(1 / 6);
  });

  it('gates Recall@20 only on exhaustive questions with 1 to 20 relevant cases, never capping the positives', () => {
    const narrow = codedReference(cases('R', 5));
    const ranking = ['R0', 'X', 'R1', ...cases('Y', 30), 'R2'];
    expect(recallAt20(ranking, narrow)).toEqual({ value: 2 / 5, found: 2, relevant: 5, ceiling: 1, gate: 'eligible', reason: null });
    expect(recallVerdict(recallAt20(ranking, narrow))).toBe('fail');
    expect(recallVerdict(recallAt20(['R0', 'R1', 'R2', 'R3', 'R4'], narrow))).toBe('pass');
    // 25 relevant cases: a diagnostic with its ceiling 20/25, the value over all 25.
    const broad = codedReference(cases('R', 25));
    const all = recallAt20(cases('R', 25), broad);
    expect(all).toMatchObject({ value: 20 / 25, ceiling: 20 / 25, gate: 'diagnostic', reason: 'more-than-20' });
    expect(recallVerdict(all)).toBeNull();
    // Unknown labels or a non-exhaustive cohort: a diagnostic, never bounded.
    expect(recallAt20(['A'], ref({ A: 2, U: 'unknown' }, 0, true))).toMatchObject({ value: 1, gate: 'diagnostic', reason: 'unknown-labels' });
    expect(recallAt20(['A'], ref({ A: 2 }, 0, false))).toMatchObject({ gate: 'diagnostic', reason: 'not-exhaustive' });
    expect(recallAt20(['A'], ref({ A: 1 }, 0, true))).toMatchObject({ value: null, ceiling: null, reason: 'no-relevant' });
    expect(() => makeReference([], { unlisted: 'unknown', exhaustive: true })).toThrow(/exhaustive/);
    expect(() => makeReference([['A', 2], ['A', 0]], { unlisted: 0, exhaustive: false })).toThrow(/twice/);
  });

  it('scores a coded reference without unknowns: uncoded returned cases are "not coded" (0), bounds collapse', () => {
    const r = codedReference(['A', 'B']);
    const s = scoreQuestion(['X', 'A', 'B'], ['X', 'A'], r);
    expect(s.recall).toMatchObject({ value: 1, gate: 'eligible' });
    expect(s.precision.strict).toEqual({ lower: 1 / 6, upper: 1 / 6 });
    expect(s.precision.amongReturned).toEqual({ lower: 0.5, upper: 0.5 });
    expect(s.ndcg.method).toBe('exact');
    expect(s.ndcg.bounds?.lower).toBeCloseTo(d(1) / (d(0) + d(1)), 12);
  });

  it('verdicts: pass on the lower bound, fail on the upper bound, inconclusive when they straddle the threshold', () => {
    expect(boundedVerdict({ lower: 0.5, upper: 0.9 }, 0.5)).toBe('pass');
    expect(boundedVerdict({ lower: 0.1, upper: 0.4 }, 0.5)).toBe('fail');
    expect(boundedVerdict({ lower: 0.4, upper: 0.6 }, 0.5)).toBe('inconclusive');
    const regression = ndcgAt6(['U1', 'K'], ref({ K: 2, U1: 'unknown', U2: 'unknown' }));
    expect(ndcgVerdict(regression, 0.6)).toBe('inconclusive');
    expect(ndcgVerdict(regression, 0.3)).toBe('pass');
  });

  it('averages questions, keeping empty results and leaving abstentions out of nDCG', () => {
    const coded = codedReference(['A']);
    const s1 = scoreQuestion(['A'], ['A'], coded);
    const s2 = scoreQuestion(['X'], [], coded);
    const s3 = scoreQuestion(['N'], ['N'], ref({ N: 0 }, 0, true));
    const s4 = scoreQuestion(cases('R', 20), cases('R', 6), codedReference(cases('R', 40)));
    const a = aggregateProtocol([s1, s2, s3, s4]);
    expect(a).toMatchObject({
      questions: 4,
      recallGate: { questions: 2, mean: 0.5, atTarget: 0.5 },
      recallDiagnostic: { questions: 1, mean: 0.5, ceiling: 0.5 },
      abstentions: 1,
      noPositivePossible: 1,
      emptyResults: 1,
    });
    // nDCG over s1 (1), s2 (empty: 0) and s4 (1); s3 abstains.
    expect(a.ndcg6).toEqual({ lower: 0.6667, upper: 0.6667, questions: 3 });
    expect(a.strictP6).toEqual({ lower: Math.round(((1 / 6 + 0 + 0 + 1) / 4) * 10_000) / 10_000, upper: Math.round(((1 / 6 + 1) / 4) * 10_000) / 10_000 });
    expect(a.precisionReturned).toEqual({ lower: 0.6667, upper: 0.6667, questions: 3 });
    expect(aggregateProtocol([])).toMatchObject({ questions: 0, strictP6: null, ndcg6: null, recallGate: { mean: null } });
  });
});
