/** Short passage aliases at the model boundary (server/briefs/aliases.ts). */
import { describe, expect, it } from 'vitest';
import type { ComposeOutput } from '../../shared/contracts/briefs.js';
import {
  UnknownAliasError,
  checkForModel,
  citationsFromModel,
  composeForModel,
  compositionFromModel,
  passageAliases,
} from '../../server/briefs/aliases.js';
import { validateComposition, type AllowedPassage, type Allowlist, type ResolvedCitation } from '../../server/briefs/validate.js';

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

  it('maps every passage id of a validated composition back; anything but an alias of the bundle throws', () => {
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
      gaps: [{ ntsbNo: 'DEN08LA103', note: 'n', passageIds: ['P3'] }],
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
    expect(back.gaps[0]!.passageIds).toEqual([hex(3)]);
    // Everything else is untouched, free text included.
    expect({ ...back, cases: [], gaps: [] }).toEqual({ ...c, cases: [], gaps: [] });
    // Strict: an unknown alias or a canonical id in an id field throws (validation refuses it first).
    expect(() => compositionFromModel({ ...c, gaps: [{ ntsbNo: 'DEN08LA103', note: 'n', passageIds: ['P9'] }] }, a)).toThrow(UnknownAliasError);
    expect(() => compositionFromModel({ ...c, gaps: [{ ntsbNo: 'DEN08LA103', note: 'n', passageIds: [hex(3)] }] }, a)).toThrow(UnknownAliasError);
    const citation = { ntsbNo: 'DFW08TA066', caseIndex: 0, quoteIndex: 0, passageId: 'P2' } as ResolvedCitation;
    expect(citationsFromModel([citation], a)[0]!.passageId).toBe(hex(2));
    expect(() => citationsFromModel([{ ...citation, passageId: 'P13' }], a)).toThrow(UnknownAliasError);
  });

  it('validation against the aliases refuses any other id, and alias-shaped tokens in model prose', () => {
    const a = passageAliases(cases);
    const allowed = (ntsbNo: string, text: string): AllowedPassage => ({
      ntsbNo,
      text,
      sha: 'a'.repeat(64),
      sectionId: `${ntsbNo}:analysis/aircraft-1`,
      revisionId: 'b'.repeat(64),
      sectionKind: 'analysis',
      sectionStart: 0,
      scope: 'aircraft',
      aircraftKey: 1,
    });
    const allow: Allowlist = {
      passages: new Map([
        ['P1', allowed('DFW08TA066', 'The engine lost all power shortly after takeoff.')],
        ['P2', allowed('DFW08TA066', 'The nut was loose.')],
        ['P3', allowed('DEN08LA103', 'Nothing was found.')],
      ]),
      cases: new Set(['DFW08TA066', 'DEN08LA103']),
    };
    const ok: ComposeOutput = {
      outcome: 'answer',
      summary: 'The engine quit after an engine change [[case:DFW08TA066]].',
      groups: [{ kind: 'causal', caseNumbers: ['DFW08TA066'] }],
      cases: [
        {
          ntsbNo: 'DFW08TA066',
          why: 'The engine lost all power after maintenance.',
          quotes: [{ passageId: 'P1', quote: 'The engine lost all power', speaker: 'investigators' }],
          evidencePassageIds: ['P1'],
        },
      ],
      gaps: [],
    };
    const codes = (c: ComposeOutput) => {
      const r = validateComposition(c, allow, { mechanicalCause: true });
      return r.ok ? [] : r.reasons.map((x) => x.code);
    };
    expect(codes(ok)).toEqual([]);
    // A canonical id (never shown to the model) or an unknown alias in an id field.
    expect(codes({ ...ok, cases: [{ ...ok.cases[0]!, evidencePassageIds: [hex(1)] }] })).toEqual(['unknown_passage']);
    expect(codes({ ...ok, cases: [{ ...ok.cases[0]!, evidencePassageIds: ['P7'] }] })).toEqual(['unknown_passage']);
    // Aliases in prose, alone, in parentheses or in a list; not inside a longer token.
    for (const [field, text] of [
      ['why', 'The engine lost power (P1) after maintenance.'],
      ['why', 'See P2 for the loose nut.'],
      ['summary', 'The engine quit, per P1, P2 [[case:DFW08TA066]].'],
      ['note', 'The supplied passages [p3] give no date.'],
    ] as const) {
      const c: ComposeOutput =
        field === 'why'
          ? { ...ok, cases: [{ ...ok.cases[0]!, why: text }] }
          : field === 'summary'
            ? { ...ok, summary: text }
            : { ...ok, gaps: [{ ntsbNo: 'DEN08LA103', note: text, passageIds: ['P3'] }] };
      expect(codes(c), text).toEqual(['alias_in_text']);
    }
    expect(codes({ ...ok, cases: [{ ...ok.cases[0]!, why: 'A P-51 and an XP180 are not passage aliases.' }] })).toEqual([]);
    // Quotes are passage text: a literal "P1" there is the record's own words.
    expect(a.toModel.get(hex(1))).toBe('P1');
  });
});
