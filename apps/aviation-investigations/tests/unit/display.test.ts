import { describe, expect, it } from 'vitest';
import type { ChronologyFact, ComposeOutput } from '../../shared/contracts/briefs.js';
import { BriefCheckSchema, CaseReadingSchema, SummarySegmentSchema } from '../../shared/contracts/briefs.js';
import type { CheckVerdict } from '../../server/ai/provider.js';
import type { ReadingState } from '../../server/briefs/clarify.js';
import { NOT_VERIFIED_LINE, readingLines } from '../../server/briefs/context.js';
import { evaluateCase, type CriterionCheck } from '../../server/briefs/criteria.js';
import {
  countsCases,
  dependencyGraph,
  dependencyViolations,
  oracleDisplay,
  projectDisplay,
  refersOutside,
  resolveGraph,
  type DisplayMode,
  type DisplayPlan,
} from '../../server/briefs/display.js';
import { EXCERPT_CONTEXT_VERSION, type ExcerptProblem } from '../../server/briefs/excerpts.js';
import {
  answerResult,
  caseEvidence,
  checkInput,
  displayPlan,
  noMatchResult,
  staticAbstentions,
  storedDimensions,
  summarySentences,
  type ClaimMeta,
  type VerifiedCase,
} from '../../server/briefs/render.js';
import type { ResolvedCitation } from '../../server/briefs/validate.js';

// ---------------------------------------------------------------------------
// A two-case brief: A (CEN15FA269) with two quotes, B (WPR18LA021) with one.

const A = 'CEN15FA269';
const B = 'WPR18LA021';
const hex = (n: number) => n.toString(16).padStart(64, '0');

function verified(ntsbNo: string, ids: string[]): VerifiedCase {
  return {
    ntsbNo,
    rank: 1,
    summary: {
      row: { ntsbNo, aircraft: [{ aircraftKey: 1, make: 'Piper', model: 'PA-28' }] },
      report: {},
      aircraftNumbers: [],
    },
    header: `Piper PA-28, total loss of engine power near Somewhere, Texas · 2015-06-14`,
    checkHeader: `Piper PA-28, near Somewhere, Texas · 2015-06-14`,
    passages: ids.map((id, i) => ({
      passageId: id,
      role: i === 0 ? 'retrieved' : 'probable_cause',
      reserved: true,
      rank: i === 0 ? 1 : null,
      sectionKind: i === 0 ? 'analysis' : 'probable_cause',
      allowed: {
        ntsbNo,
        text: `Passage ${id} text about the case, with enough words to quote.`,
        sha: 'a'.repeat(64),
        sectionId: `${ntsbNo}:analysis`,
        revisionId: 'b'.repeat(64),
        sectionKind: i === 0 ? 'analysis' : 'probable_cause',
        sectionStart: 0,
        scope: 'aircraft',
        aircraftKey: 1,
      },
    })),
  } as unknown as VerifiedCase;
}

const cases = new Map([
  [A, verified(A, [hex(1), hex(2)])],
  [B, verified(B, [hex(3), hex(4)])],
]);
const fact = (relation: ChronologyFact['relation'], over: Partial<ChronologyFact> & { passageIds: string[] }): ChronologyFact => ({
  anchor: 'relevant_maintenance',
  relation,
  ...over,
});

const SENTENCES = {
  a: 'In the Grumman case, fuel contamination caused a partial loss of engine power [[case:CEN15FA269]].',
  b: 'In the Vans case, an unsecured cable swage caused a total loss of engine power [[case:WPR18LA021]].',
  both: 'In the Grumman and Vans cases, investigators blamed maintenance [[case:CEN15FA269]] [[case:WPR18LA021]].',
};

function composition(over: Partial<ComposeOutput> = {}): ComposeOutput {
  return {
    outcome: 'answer',
    summary: [SENTENCES.a, SENTENCES.b, SENTENCES.both].join(' '),
    groups: [{ kind: 'causal', caseNumbers: [A, B] }],
    cases: [
      {
        ntsbNo: A,
        why: 'Fuel contamination in the Grumman caused a partial loss of engine power.',
        quotes: [
          { passageId: hex(1), quote: 'Passage one quote', speaker: 'investigators' },
          { passageId: hex(2), quote: 'Passage two quote', speaker: 'investigators' },
        ],
        evidencePassageIds: [hex(1)],
        maintenance: { relation: 'investigator_attributed', passageIds: [hex(2)] },
        symptom: { value: 'partial_power_loss', passageIds: [hex(2)] },
        // The gate's probe: 2 days and 40 days, both exact, against a 30-day window.
        chronology: {
          maintenance: 'the annual inspection',
          facts: [fact('calendar_days', { value: 2, bound: 'exact', passageIds: [hex(1)] }), fact('calendar_days', { value: 40, bound: 'exact', passageIds: [hex(2)] })],
        },
      },
      {
        ntsbNo: B,
        why: 'An unsecured cable swage in the Vans caused a total loss of engine power.',
        quotes: [{ passageId: hex(3), quote: 'Passage three quote', speaker: 'investigators' }],
        evidencePassageIds: [hex(3)],
        symptom: { value: 'total_power_loss', passageIds: [hex(4)] },
        chronology: { maintenance: 'the installation', facts: [fact('previous_day', { passageIds: [hex(3)] })] },
      },
    ],
    gaps: [{ ntsbNo: B, note: 'The supplied passages give no inspection date.', passageIds: [hex(4)] }],
    ...over,
  };
}

/** The citations of a composition; `omit` (by `case.<n>.quote.<q>` key): the excerpt rule's problems for that quote. */
const citationsOf = (c: ComposeOutput, omit: Readonly<Record<string, ExcerptProblem[]>> = {}): ResolvedCitation[] =>
  c.cases.flatMap((k, ci) =>
    k.quotes.map((q, qi) => ({
      ntsbNo: k.ntsbNo,
      caseIndex: ci,
      quoteIndex: qi,
      passageId: q.passageId,
      sectionId: `${k.ntsbNo}:analysis`,
      revisionId: 'b'.repeat(64),
      sectionSha: 'a'.repeat(64),
      text: q.quote,
      passageSpan: { start: 0, end: q.quote.length },
      sectionSpan: { start: 0, end: q.quote.length },
      matches: 1,
      occurrence: 'first' as const,
      excerpt: { rules: EXCERPT_CONTEXT_VERSION, problems: omit[`case.${k.ntsbNo}.quote.${qi}`] ?? [] },
    })),
  );

const READINGS: ReadingState = { timingWindow: { value: { days: 30, flightHours: null }, pinned: false }, failureType: { value: 'partial_power_loss', pinned: false } };

function built(c: ComposeOutput = composition(), readings: ReadingState = READINGS, mechanical = true, omit: Readonly<Record<string, ExcerptProblem[]>> = {}) {
  const criterionChecks = new Map<string, CriterionCheck[]>(c.cases.map((k) => [k.ntsbNo, evaluateCase(readings, k, mechanical, caseEvidence(cases.get(k.ntsbNo)))]));
  const citations = citationsOf(c, omit);
  const { input, claims } = checkInput(c, citations, cases, { mechanicalCause: mechanical, criterionChecks });
  const abstain = staticAbstentions(c, citations, cases, input, claims);
  return { c, citations, criterionChecks, input, claims, abstain, plan: displayPlan(c, claims, mechanical, { abstain, cases }) };
}

type Verdicts = Partial<Record<string, CheckVerdict>>;
/** A judgement: every claim supported unless `by` (stable key → verdict) says otherwise. */
const judged = (claims: readonly ClaimMeta[], by: Verdicts = {}) => ({
  kind: 'judged' as const,
  judgement: {
    structural: [],
    claims: claims.map((m) => {
      const verdict = by[m.key] ?? 'supported';
      return { verdict, confirmed: verdict === 'supported' };
    }),
  },
});
const project = (b: ReturnType<typeof built>, by: Verdicts = {}, mode: DisplayMode = 'claims') => projectDisplay(b.plan, judged(b.claims, by), mode);
const shownKeys = (b: ReturnType<typeof built>, d: ReturnType<typeof project>) => b.claims.filter((_, i) => d.displayed[i]).map((m) => m.key);
const removedKeys = (b: ReturnType<typeof built>, d: ReturnType<typeof project>) => b.claims.filter((_, i) => !d.displayed[i]).map((m) => m.key);

function render(b: ReturnType<typeof built>, d: ReturnType<typeof project>) {
  return answerResult({
    composition: b.c,
    citations: b.citations,
    cases,
    mechanicalCause: true,
    interpretations: [],
    filters: {},
    claims: b.claims,
    display: d,
  });
}

describe('display projection (display-deps-v2)', () => {
  it('the probe brief: the criteria are decided once, before the check, from every fact', () => {
    const b = built();
    const decisions = Object.fromEntries([...b.criterionChecks].map(([n, cs]) => [n, cs.map((c) => `${c.criterion}:${c.decision}`)]));
    // A: 2 days and 40 days conflict (C-1); B: the previous day (TW-C); B lost all power, not partial power.
    expect(decisions).toEqual({ [A]: ['timing_window:unknown', 'failure_type:matches'], [B]: ['timing_window:matches', 'failure_type:does_not_match'] });
  });
});

/** The same brief read only with a timing window (B's total loss is not a partial loss). */
const WINDOW: ReadingState = { timingWindow: { value: { days: 30, flightHours: null }, pinned: false } };

describe('display projection (display-deps-v2): claims, dependencies and whole-output rules', () => {
  it('every claim confirmed: everything is shown, partially checked with nothing removed', () => {
    const b = built(composition(), WINDOW);
    const d = project(b);
    expect(d.shown).toBe(true);
    expect(d.displayed.every(Boolean)).toBe(true);
    expect(d.counts.shown).toBe(b.claims.length);
    expect(Object.values(d.counts.removed).every((n) => n === 0)).toBe(true);
    const r = render(b, d);
    expect(r.check).toMatchObject({ status: 'partially_checked', shown: b.claims.length, unclassified: [] });
    expect(BriefCheckSchema.safeParse(r.check).success).toBe(true);
    expect(r.summary.some((s) => s.kind === 'removed')).toBe(false);
    expect(r.groups.find((g) => g.kind === 'causal')!.caseNumbers).toEqual([A, B]);
  });

  it('a failed call or a structurally unusable verdict set withholds the whole output', () => {
    const b = built(composition(), WINDOW);
    expect(projectDisplay(b.plan, { kind: 'failed' }, 'claims')).toMatchObject({ shown: false, withheld: ['check_failed'] });
    const j = judged(b.claims);
    expect(projectDisplay(b.plan, { kind: 'judged', judgement: { ...j.judgement, structural: ['check_missing_verdict'] } }, 'claims')).toMatchObject({
      shown: false,
      withheld: ['check_structural'],
    });
  });

  it('a removed claim takes only what depends on it: a non-essential symptom', () => {
    const b = built(composition(), WINDOW);
    const d = project(b, { [`case.${B}.symptom`]: 'not_established' });
    // The comparison rests on every statement of B, so it goes too; B keeps its own sentence (1 of 3 removed).
    expect(d.shown).toBe(true);
    expect(removedKeys(b, d)).toEqual(['summary.2', `case.${B}.symptom`]);
    expect(d.cases.find((c) => c.ntsbNo === B)).toMatchObject({ reading: true, grouped: true, suppressed: false, removed: ['symptom'] });
    const r = render(b, d);
    expect(r.cases.find((c) => c.case.ntsbNo === B)!.notVerified).toEqual(['symptom']);
  });

  it('decisions never promote: the gate\'s probe (2 days and 40 days against 30 days) stays unconfirmed when the 40-day fact is removed', () => {
    const b = built(composition(), WINDOW);
    const a = (d: ReturnType<typeof project>) => d.cases.find((c) => c.ntsbNo === A)!.decisions;
    // Conflicting facts: unknown, shown unconfirmed.
    expect(a(project(b))).toEqual([{ criterion: 'timing_window', decision: 'unconfirmed', notVerified: false }]);
    // The 40-day fact removed: never re-derived to "matches"; not verified.
    const d = project(b, { [`case.${A}.timing.1`]: 'not_established' });
    expect(a(d)).toEqual([{ criterion: 'timing_window', decision: 'unconfirmed', notVerified: true }]);
    expect(render(b, d).cases.find((c) => c.case.ntsbNo === A)!.reading!.criteria).toEqual([{ criterion: 'timing_window', decision: 'unconfirmed', notVerified: true }]);
    // A matching decision whose fact is removed goes down to not verified, never stays a match.
    const bd = project(b, { [`case.${B}.timing.0`]: 'not_established' });
    expect(bd.cases.find((c) => c.ntsbNo === B)!.decisions).toEqual([{ criterion: 'timing_window', decision: 'unconfirmed', notVerified: true }]);
    expect(project(b).cases.find((c) => c.ntsbNo === B)!.decisions).toEqual([{ criterion: 'timing_window', decision: 'matches', notVerified: false }]);
    // Its summary citations carry UNCONFIRMED from the projection, not from the pre-check decision.
    const segments = render(b, bd).summary.filter((s) => s.kind === 'case' && s.ntsbNo === B);
    expect(segments.every((s) => s.kind === 'case' && s.unconfirmed)).toBe(true);
    // Every outcome: a removal never turns any decision into a match it was not.
    for (const key of b.claims.map((m) => m.key)) {
      const p = project(b, { [key]: 'not_established' });
      for (const c of p.cases) {
        for (const x of c.decisions) {
          const before = b.criterionChecks.get(c.ntsbNo)!.find((y) => y.criterion === x.criterion)!.decision;
          if (x.decision === 'matches') expect(before).toBe('matches');
        }
      }
    }
  });

  it('a case without a confirmed why line or quote loses its reading, and with it its statements, group and summary sentences', () => {
    const b = built(composition(), WINDOW);
    const d = project(b, { [`case.${A}.why`]: 'not_established' });
    expect(d.cases.find((c) => c.ntsbNo === A)).toMatchObject({ reading: false, grouped: false, decisions: [] });
    // A's own sentence and the comparison go; B's sentence stays; 2 of 3 removed is more than a third.
    expect(d).toMatchObject({ shown: false, withheld: ['display_removed_share'] });
    // Both quotes rejected: the same.
    const q = project(b, { [`case.${A}.quote.0`]: 'not_established', [`case.${A}.quote.1`]: 'not_established' });
    expect(q.cases.find((c) => c.ntsbNo === A)!.reading).toBe(false);
    // One quote of two rejected: the reading stays with the other; only the comparison, which rests on every statement of A, goes.
    const one = project(b, { [`case.${A}.quote.1`]: 'not_established' });
    expect(one.cases.find((c) => c.ntsbNo === A)!.reading).toBe(true);
    expect(one).toMatchObject({ shown: true, sentences: [true, true, false] });
    expect(render(b, one).cases.find((c) => c.case.ntsbNo === A)!.reading!.quotes.map((q) => q.text)).toEqual(['Passage one quote']);
  });

  it('a comparison depends on every statement and the group of each case it cites', () => {
    const b = built(composition(), WINDOW);
    const d = project(b, { [`case.${A}.symptom`]: 'not_established' });
    // The symptom is not essential: A keeps its own sentence and group; the comparison goes.
    expect(d.sentences).toEqual([true, true, false]);
    expect(d.shown).toBe(true);
    const r = render(b, d);
    expect(r.summary.at(-1)).toEqual({ kind: 'removed', count: 1 });
    for (const s of r.summary) expect(SummarySegmentSchema.safeParse(s).success).toBe(true);
  });

  it('one contradiction of an essential claim suppresses the case\'s summary sentences and group, whatever the thresholds', () => {
    const b = built(composition({ summary: [SENTENCES.a, SENTENCES.b, 'In the Vans case, the airplane landed in a field [[case:WPR18LA021]].'].join(' ') }), WINDOW);
    // A's attribution of its second quote contradicted: A keeps its reading (first quote) but loses its summary sentence and group.
    const d = project(b, { [`case.${A}.quote.1`]: 'contradicted' });
    expect(d.cases.find((c) => c.ntsbNo === A)).toMatchObject({ reading: true, grouped: false, suppressed: true });
    expect(d.sentences).toEqual([false, true, true]);
    expect(d.shown).toBe(true);
    const r = render(b, d);
    expect(r.check!.unclassified).toEqual([A]);
    expect(r.groups.find((g) => g.kind === 'causal')!.caseNumbers).toEqual([B]);
    expect(r.cases.find((c) => c.case.ntsbNo === A)!.reading!.glyph).toBeNull();
    // A symptom contradiction is not essential: only the symptom goes.
    const s = project(b, { [`case.${B}.symptom`]: 'contradicted' });
    expect(s.cases.find((c) => c.ntsbNo === B)).toMatchObject({ suppressed: false, grouped: true });
  });

  it('a contradicted criterion (a "do not settle" claim the checker disputes) never presents the case: its reading goes', () => {
    const b = built(composition(), WINDOW);
    const d = project(b, { [`case.${A}.criterion.timing_window`]: 'contradicted' });
    expect(d.cases.find((c) => c.ntsbNo === A)).toMatchObject({ reading: false, decisions: [] });
    expect(removedKeys(b, d)).toContain(`case.${A}.why`);
  });

  it('sentences about the same case stand or fall together, and a back-reference falls with any earlier sentence', () => {
    const summary = [
      'In the Grumman case, fuel contamination caused a partial loss of engine power [[case:CEN15FA269]].',
      'In the Grumman case, the mechanic missed it during the annual inspection [[case:CEN15FA269]].',
      'In the Vans case, an unsecured cable swage caused a total loss of engine power [[case:WPR18LA021]].',
      'In the Vans case, the engine quit in cruise [[case:WPR18LA021]].',
      'The Vans airplane also landed off airport [[case:WPR18LA021]].',
    ].join(' ');
    const b = built(composition({ summary }), WINDOW);
    expect(b.plan.sentences.map((s) => s.reference)).toEqual([false, false, false, false, true]);
    // 0 goes, 1 with it (A's own sentences stand together), 4 refers back to it, and B's own sentences 2 and 3 go with 4.
    const d = project(b, { 'summary.0': 'not_established' });
    expect(d).toMatchObject({ shown: false, removedSentences: 5 });
    expect(d.withheld).toEqual(['display_removed_share', 'display_minimum_content']);
    // 3 goes with B's other sentences: 3 of 5; A's stay.
    const e = project(b, { 'summary.3': 'not_established' });
    expect(e).toMatchObject({ shown: false, removedSentences: 3, sentences: [false, false, false, false, false] });
    // Without the back-reference, removing B's sentence leaves A's: 3 of 5 still more than a third.
    const plain = built(composition({ summary: summary.replace('The Vans airplane also landed off airport', 'In the Vans case, the airplane landed off airport') }), WINDOW);
    expect(plain.plan.sentences.every((x) => !x.reference)).toBe(true);
    expect(project(plain, { 'summary.0': 'not_established' })).toMatchObject({ removedSentences: 2, shown: false, withheld: ['display_removed_share'] });
    expect(project(plain, { 'summary.4': 'not_established' })).toMatchObject({ removedSentences: 3, shown: false });
  });

  it('thresholds: more than a third removed, or two contradictions, withhold; a third removed does not', () => {
    const summary = [SENTENCES.a, SENTENCES.b, 'In the Grumman case, the engine was examined after the accident [[case:CEN15FA269]].'].join(' ');
    const three = built(composition({ summary: [SENTENCES.a, SENTENCES.b, 'In the Vans case, the pilot landed in a field [[case:WPR18LA021]].'].join(' ') }), WINDOW);
    // One of three (a third): shown, with a marker where it was.
    const third = project(three, { 'summary.0': 'not_established' });
    expect(third).toMatchObject({ shown: true, removedSentences: 1 });
    expect(render(three, third).summary[0]).toEqual({ kind: 'removed', count: 1 });
    const sep = built(composition({ summary }), WINDOW);
    expect(sep.plan.sentences.map((s) => s.cases)).toEqual([[A], [B], [A]]);
    // Two contradictions anywhere, even of non-essential claims, withhold.
    expect(project(three, { [`case.${A}.symptom`]: 'contradicted', 'gap.0': 'contradicted' })).toMatchObject({ shown: false, withheld: ['display_contradictions'] });
    const four = built(
      composition({
        summary: [SENTENCES.a, 'In the Grumman case, the pilot was not hurt [[case:CEN15FA269]].', SENTENCES.b, 'In the Vans case, the pilot landed in a field [[case:WPR18LA021]].'].join(' '),
      }),
      WINDOW,
    );
    // B's two sentences go together: 2 of 4 is more than a third.
    expect(project(four, { 'summary.2': 'not_established' })).toMatchObject({ shown: false, withheld: ['display_removed_share'] });
    const six = built(
      composition({
        summary: [
          SENTENCES.a,
          'In the Grumman case, the pilot was not hurt [[case:CEN15FA269]].',
          'In the Grumman case, the engine was examined [[case:CEN15FA269]].',
          'In the Grumman case, fuel was found in the tanks [[case:CEN15FA269]].',
          SENTENCES.b,
          'In the Vans case, the pilot landed in a field [[case:WPR18LA021]].',
        ].join(' '),
      }),
      WINDOW,
    );
    // B's two of six: a third, shown with a marker of 2.
    const shown = project(six, { 'summary.4': 'not_established' });
    expect(shown).toMatchObject({ shown: true, removedSentences: 2 });
    expect(render(six, shown).summary.at(-1)).toEqual({ kind: 'removed', count: 2 });
  });

  it('minimum useful content: a marker-only summary is never shown', () => {
    const b = built(composition({ summary: SENTENCES.a, gaps: [] }), WINDOW);
    expect(project(b, { 'summary.0': 'not_established' })).toMatchObject({ shown: false });
    expect(project(b, { 'summary.0': 'not_established' }).withheld).toContain('display_minimum_content');
  });

  it('whole mode (the default until G6) shows the output only when nothing at all was removed', () => {
    const b = built(composition(), WINDOW);
    expect(project(b, {}, 'whole').shown).toBe(true);
    expect(project(b, { [`case.${B}.symptom`]: 'not_established' }, 'whole')).toMatchObject({ shown: false, withheld: ['display_whole_brief'] });
  });

  it('M5: no shown claim ever depends on a removed one, whatever the verdicts', () => {
    const b = built(composition(), WINDOW);
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let t = 0; t < 2_000; t += 1) {
      const by: Verdicts = {};
      for (const m of b.claims) {
        const r = random();
        if (r < 0.12) by[m.key] = 'not_established';
        else if (r < 0.16) by[m.key] = 'contradicted';
      }
      const j = judged(b.claims, by).judgement;
      const nodes = dependencyGraph(
        b.plan,
        j.claims.map((c) => c.confirmed),
        j.claims.map((c) => c.verdict === 'contradicted'),
      );
      const shown = resolveGraph(nodes);
      expect(dependencyViolations(nodes, shown)).toEqual([]);
      const d = projectDisplay(b.plan, { kind: 'judged', judgement: j }, 'claims');
      if (!d.shown) continue;
      // What is rendered is exactly what was shown: no rejected text in the result.
      const text = JSON.stringify(render(b, d));
      const sentences = summarySentences(b.c.summary).map((x) => x.replace(/\s*\[\[case:[A-Z0-9]+\]\]/g, '').replace(/\.$/, ''));
      b.claims.forEach((m, i) => {
        if (d.displayed[i]) return;
        const k = b.c.cases.find((x) => m.key.startsWith(`case.${x.ntsbNo}.`));
        if (m.kind === 'why') expect(text).not.toContain(k!.why);
        if (m.kind === 'summary') expect(text).not.toContain(sentences[Number(m.key.split('.')[1])]!);
        if (m.kind === 'gap') expect(text).not.toContain(b.c.gaps[0]!.note);
        if (m.kind === 'attribution') expect(text).not.toContain(`"text":"${k!.quotes[Number(m.key.split('.').at(-1))]!.quote}"`);
      });
    }
  });

  it('stored dimensions keep only what is shown, aligned with the reading\'s chips; context lines say "not verified"', () => {
    const b = built(composition(), WINDOW);
    const d = project(b, { [`case.${A}.timing.1`]: 'not_established', [`case.${A}.maintenance`]: 'not_established' });
    const dims = storedDimensions(b.c, true, b.criterionChecks, { claims: b.claims, display: d });
    const a = dims.find((x) => x.ntsbNo === A)!;
    // The 40-day fact goes, and the 2-day fact it conflicts with goes with it (display-deps-v2).
    expect(a.timing).toEqual([]);
    expect(a.maintenance).toBeUndefined();
    expect(a.criteria).toEqual([{ criterion: 'timing_window', decision: 'unconfirmed', passageIds: [hex(1), hex(2)] }]);
    const card = render(b, d).cases.find((c) => c.case.ntsbNo === A)!;
    expect(CaseReadingSchema.safeParse(card.reading).success).toBe(true);
    expect(card.reading!.timing).toEqual([]);
    expect(card.notVerified).toEqual(['maintenance', 'timing', 'criterion']);
    const lines = readingLines(card.reading!, a, card.notVerified);
    expect(lines.filter((l) => l.text === NOT_VERIFIED_LINE).map((l) => l.label)).toEqual(['CRITERIA', 'MAINTENANCE', 'TIMING']);
    for (const l of lines.filter((x) => x.text === NOT_VERIFIED_LINE)) expect(l.passageIds).toEqual([]);
    expect(NOT_VERIFIED_LINE).not.toMatch(/no evidence|not in the|investigation/i);
  });

  it('an abstention checks its gap notes: a rejected one is absent', () => {
    const c: ComposeOutput = { outcome: 'no_supported_match', summary: '', groups: [], cases: [], gaps: [{ ntsbNo: B, note: 'The supplied passages give no inspection date.', passageIds: [hex(4)] }] };
    const b = built(c, WINDOW);
    expect(b.plan.shape).toBe('abstention');
    const d = project(b, { 'gap.0': 'not_established' });
    expect(d.shown).toBe(true);
    const r = noMatchResult(c, [...cases.values()], { interpretations: [], filters: {} }, { claims: b.claims, display: d });
    expect(r.gaps).toEqual([]);
    expect(r.check).toMatchObject({ removed: { gap: 1 } });
  });
});

describe('references (display-deps-v2 lexicon, 16d review I1)', () => {
  it('flags sentences that point outside themselves anywhere, by word or by their opening', () => {
    for (const s of [
      // display-deps-v1's lexicon
      'This failure caused the loss of power [[case:A1B2C3]].',
      'In the other three cases, both pilots failed to see and avoid [[case:A1B2C3]].',
      'Similarly, the Cessna lost power [[case:A1B2C3]].',
      'However, the cause was not found [[case:A1B2C3]].',
      'It lost power on takeoff [[case:A1B2C3]].',
      'The Piper also lost power [[case:A1B2C3]].',
      'Unlike the Grumman, the Piper had an annual [[case:A1B2C3]].',
      // the 16d review's misses (refersBack was false for each)
      'In the Vans case, a similar contamination caused a total loss of power [[case:WPR18LA021]].',
      'In the Vans case, the engine failed again [[case:WPR18LA021]].',
      'In the Piper case, a comparable error led to a fuel leak [[case:A1B2C3]].',
      'In the Piper case, the engine lost power too [[case:A1B2C3]].',
      'In the second case, the mechanic missed the crack [[case:A1B2C3]].',
      'In the Piper case, a different cause was found [[case:A1B2C3]].',
      'In the Piper case, the earlier inspection missed the crack [[case:A1B2C3]].',
      'In the remaining case, the cause was not determined [[case:A1B2C3]].',
      'In the Piper case, another loose fitting was found [[case:A1B2C3]].',
    ]) {
      expect(refersOutside(s), s).toBe(true);
    }
    for (const s of [
      'In the Grumman AA-5 case, the mechanic did not inspect the fuel system [[case:CEN15FA269]].',
      'In the Piper case, the engine lost all power after takeoff [[case:A1B2C3]].',
    ]) {
      expect(refersOutside(s), s).toBe(false);
    }
  });

  it('flags sentences that count or range over cases, which may cover cases they do not cite', () => {
    for (const s of [
      'In three of the four cases, maintenance came first [[case:A1B2C3]] [[case:D4E5F6]].',
      'In all cases, the engine lost power [[case:A1B2C3]].',
      'The other cases involved fuel lines [[case:A1B2C3]].',
      'Both cases followed an annual inspection [[case:A1B2C3]] [[case:D4E5F6]].',
      'In each of the six investigations, the fitting was loose [[case:A1B2C3]].',
    ]) {
      expect(countsCases(s), s).toBe(true);
    }
    expect(countsCases('In the Piper case, the engine lost all power after takeoff [[case:A1B2C3]].')).toBe(false);
  });
});

describe('display projection (display-deps-v2): the 16d review\'s probes and fixes', () => {
  /** The review's probe: two Grumman sentences, two Vans sentences, one of which compares with the Grumman's contamination. */
  const PROBE = [
    'In the Grumman case, water and debris contaminated the fuel system [[case:CEN15FA269]].',
    'In the Grumman case, the contamination caused a partial loss of engine power [[case:CEN15FA269]].',
    'In the Vans case, an unsecured alternator ground cable swage caused a total loss of engine power [[case:WPR18LA021]].',
    'In the Vans case, a similar contamination caused a total loss of power [[case:WPR18LA021]].',
    'In the Grumman case, the mechanic had completed the annual inspection [[case:CEN15FA269]].',
    'In the Vans case, the pilot had installed new engine systems [[case:WPR18LA021]].',
  ].join(' ');

  it('the Vans/Grumman probe: rejecting a Grumman sentence also removes the Vans sentence that compares with it', () => {
    const b = built(composition({ summary: PROBE }), WINDOW);
    expect(b.plan.sentences.map((x) => x.reference)).toEqual([false, false, false, true, false, false]);
    // v1 kept sentence 3 ("a similar contamination") after the Grumman sentences went; v2 removes it, and the Vans case's own sentences with it.
    const d = project(b, { 'summary.0': 'not_established' });
    expect(d.sentences).toEqual([false, false, false, false, false, false]);
    expect(d).toMatchObject({ shown: false, removedSentences: 6, withheld: ['display_removed_share', 'display_minimum_content'] });
    // Any sentence it could refer to is enough: a later one too.
    expect(project(b, { 'summary.4': 'not_established' }).removedSentences).toBe(6);
  });

  it('a count sentence depends on every presented case, cited or not', () => {
    const summary = [SENTENCES.a, SENTENCES.b, 'In three of the four cases, maintenance came first [[case:CEN15FA269]].'].join(' ');
    const b = built(composition({ summary }), WINDOW);
    expect(b.plan.sentences.map((x) => [x.reference, x.set])).toEqual([
      [false, false],
      [false, false],
      [true, true],
    ]);
    // B's reading goes (its why line): the count sentence, which cites only A, goes too.
    const d = project(b, { [`case.${B}.why`]: 'not_established' });
    expect(d.sentences[2]).toBe(false);
  });

  it('conflicting timing facts are shown together or not at all (16d review m3)', () => {
    const b = built(composition(), WINDOW);
    // A's 2 days and 40 days conflict: one group of two chips.
    expect(b.plan.together).toEqual([[`case.${A}.timing.0`, `case.${A}.timing.1`]]);
    const d = project(b, { [`case.${A}.timing.1`]: 'not_established' });
    expect(removedKeys(b, d)).toEqual(expect.arrayContaining([`case.${A}.timing.0`, `case.${A}.timing.1`]));
    expect(render(b, d).cases.find((c) => c.case.ntsbNo === A)!.reading!.timing).toEqual([]);
    // Without the conflict, removing one fact leaves the other.
    const one = built(
      composition({
        cases: composition().cases.map((k) =>
          k.ntsbNo === A ? { ...k, chronology: { maintenance: 'the annual inspection', facts: [fact('calendar_days', { value: 2, bound: 'exact', passageIds: [hex(1)] }), fact('flight_hours', { value: 1.5, bound: 'exact', passageIds: [hex(2)] })] } } : k,
        ),
      }),
      WINDOW,
    );
    expect(one.plan.together).toEqual([]);
  });

  it('a suppressed case\'s classification is removed with its group placement and counted (16d review m4)', () => {
    const b = built(composition({ summary: [SENTENCES.a, SENTENCES.b, 'In the Vans case, the airplane landed in a field [[case:WPR18LA021]].'].join(' ') }), WINDOW);
    const d = project(b, { [`case.${A}.quote.1`]: 'contradicted' });
    expect(d.cases.find((c) => c.ntsbNo === A)).toMatchObject({ reading: true, grouped: false, suppressed: true });
    expect(removedKeys(b, d)).toContain(`case.${A}.classification`);
    expect(d.counts.removed.classification).toBe(1);
    expect(render(b, d).cases.find((c) => c.case.ntsbNo === A)!.notVerified).toContain('classification');
  });
});

describe('display projection (display-deps-v2): static abstentions (Task 16e)', () => {
  it('an excerpt that needs its context is never shown, even when the checker confirms it; the case keeps its other quote', () => {
    const b = built(composition(), WINDOW, true, { [`case.${A}.quote.1`]: ['demonstrative'] });
    expect(b.plan.claims.find((c) => c.key === `case.${A}.quote.1`)!.abstain).toBe('excerpt_context');
    const d = project(b);
    expect(d.shown).toBe(true);
    expect(d.removal[b.claims.findIndex((m) => m.key === `case.${A}.quote.1`)]).toBe('static');
    expect(d.counts.abstained).toEqual({ excerpt_context: 1, ordinal_evidence: 0 });
    expect(d.cases.find((c) => c.ntsbNo === A)).toMatchObject({ reading: true, excerptsOmitted: 1, removed: [] });
    const r = render(b, d);
    const card = r.cases.find((c) => c.case.ntsbNo === A)!;
    expect(card.reading!.quotes.map((q) => q.text)).toEqual(['Passage one quote']);
    expect(card.quotesOmitted).toBe(1);
    expect(card.notVerified).toBeUndefined();
    expect(r.check).toMatchObject({ rules: 'display-deps-v2', omitted: { excerpts: 1, ordinals: 0 }, removed: { attribution: 1 } });
    expect(JSON.stringify(r)).not.toContain('Passage two quote');
  });

  it('a case whose every excerpt needs its context has no reading; in whole mode any abstention withholds', () => {
    const summary = [SENTENCES.b, 'In the Vans case, the pilot landed in a field [[case:WPR18LA021]].', SENTENCES.a].join(' ');
    const b = built(composition({ summary }), WINDOW, true, { [`case.${A}.quote.0`]: ['leading_reference'], [`case.${A}.quote.1`]: ['relative_time'] });
    const d = project(b);
    expect(d).toMatchObject({ shown: true, sentences: [true, true, false] });
    expect(d.cases.find((c) => c.ntsbNo === A)).toMatchObject({ reading: false, excerptsOmitted: 2 });
    expect(render(b, d).cases.find((c) => c.case.ntsbNo === A)).toMatchObject({ reading: null, quotesOmitted: 2 });
    expect(project(b, {}, 'whole')).toMatchObject({ shown: false, withheld: ['display_whole_brief'] });
    // The oracle (every claim confirmed) keeps the abstention: it is the static floor of what can be shown.
    expect(oracleDisplay(b.plan, 'claims').cases.find((c) => c.ntsbNo === A)!.reading).toBe(false);
  });

  it('a summary sentence stating a flight ordinal without explicit evidence in its passages is never shown (ordinal-evidence-v2)', () => {
    const summary = [SENTENCES.a, SENTENCES.b, 'In the Vans case, the engine quit on the third flight after the installation [[case:WPR18LA021]].'].join(' ');
    const b = built(composition({ summary }), WINDOW);
    expect(b.plan.claims.find((c) => c.key === 'summary.2')!.abstain).toBe('ordinal_evidence');
    const d = project(b);
    // B's own sentences stand together: sentence 1 goes with it; 2 of 3 removed withholds.
    expect(d).toMatchObject({ shown: false, removedSentences: 2 });
    expect(oracleDisplay(b.plan, 'claims').shown).toBe(false);
  });
});

export type { DisplayPlan };
