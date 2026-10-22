/** Short passage aliases at the model boundary (server/briefs/aliases.ts). */
import { describe, expect, it } from 'vitest';
import type { ComposeOutput } from '../../shared/contracts/briefs.js';
import { checkForModel, composeForModel, compositionFromModel, passageAliases } from '../../server/briefs/aliases.js';

const hex = (n: number) => String(n).repeat(64).slice(0, 64);
const cases = [
  { ntsbNo: 'DFW08TA066', passages: [{ passageId: hex(1) }, { passageId: hex(2) }] },
  { ntsbNo: 'DEN08LA103', passages: [{ passageId: hex(3) }] },
];

describe('passage aliases', () => {
  it('numbers the bundle’s passages P1..Pn in bundle order, both ways', () => {
    const a = passageAliases(cases);
    expect([...a.toModel]).toEqual([
      [hex(1), 'P1'],
      [hex(2), 'P2'],
      [hex(3), 'P3'],
    ]);
    expect(a.fromModel.get('P3')).toBe(hex(3));
    // The same bundle gets the same aliases (a re-pack recomputes them from its own bundle).
    expect([...passageAliases(cases).toModel]).toEqual([...a.toModel]);
  });

  it('the compose and check inputs carry aliases only', () => {
    const a = passageAliases(cases);
    const compose = composeForModel(
      {
        question: 'q',
        mechanicalCause: true,
        interpretations: [],
        cases: cases.map((c) => ({ ntsbNo: c.ntsbNo, header: 'h', passages: c.passages.map((p) => ({ passageId: p.passageId, section: 'Analysis', scope: 'event' as const, text: 't' })) })),
      },
      a,
    );
    expect(compose.cases.flatMap((c) => c.passages.map((p) => p.passageId))).toEqual(['P1', 'P2', 'P3']);
    const check = checkForModel(
      {
        criteria: [],
        passages: [{ passageId: hex(3), ntsbNo: 'DEN08LA103', section: 'Analysis', scope: 'event', text: 't' }],
        claims: [{ kind: 'why', ntsbNo: 'DEN08LA103', text: 'w', passageIds: [hex(3), hex(1)] }],
      },
      a,
    );
    expect(check.passages[0]!.passageId).toBe('P3');
    expect(check.claims[0]!.passageIds).toEqual(['P3', 'P1']);
  });

  it('maps every passage id of a composition back; an unknown alias stays and validation refuses it', () => {
    const a = passageAliases(cases);
    const c: ComposeOutput = {
      outcome: 'answer',
      summary: 'A [[case:DFW08TA066]].',
      groups: [{ kind: 'causal', caseNumbers: ['DFW08TA066'] }],
      cases: [
        {
          ntsbNo: 'DFW08TA066',
          why: 'w',
          quotes: [{ passageId: 'P2', quote: 'q q q', speaker: 'investigators' }],
          evidencePassageIds: ['P1', 'P2'],
          maintenance: { relation: 'investigator_attributed', passageIds: ['P2'] },
          symptom: { value: 'total_power_loss', passageIds: ['P1'] },
          chronology: {
            flightHours: { value: 5.1, bound: 'exact', passageIds: ['P1'] },
            calendarDays: { value: 3, bound: 'at_most', passageIds: ['P2'] },
            flight: { value: 'first', passageIds: ['P1'] },
            qualitative: { passageIds: ['P2'] },
          },
        },
      ],
      gaps: [{ ntsbNo: 'DEN08LA103', note: 'n', passageIds: ['P3', 'P9'] }],
    };
    const back = compositionFromModel(c, a);
    const k = back.cases[0]!;
    expect(k.quotes[0]!.passageId).toBe(hex(2));
    expect(k.evidencePassageIds).toEqual([hex(1), hex(2)]);
    expect(k.maintenance!.passageIds).toEqual([hex(2)]);
    expect(k.symptom!.passageIds).toEqual([hex(1)]);
    expect(k.chronology).toEqual({
      flightHours: { value: 5.1, bound: 'exact', passageIds: [hex(1)] },
      calendarDays: { value: 3, bound: 'at_most', passageIds: [hex(2)] },
      flight: { value: 'first', passageIds: [hex(1)] },
      qualitative: { passageIds: [hex(2)] },
    });
    // P9 is no passage of the bundle: left as it is, so validation refuses it.
    expect(back.gaps[0]!.passageIds).toEqual([hex(3), 'P9']);
    // Everything else is untouched.
    expect({ ...back, cases: [], gaps: [] }).toEqual({ ...c, cases: [], gaps: [] });
    // A composition outside its schema is returned as it is (validation reports it).
    const broken = { ...c, extra: true } as unknown as ComposeOutput;
    expect(compositionFromModel(broken, a)).toBe(broken);
  });
});
