import { describe, expect, it } from 'vitest';
import type { StepDiagnostics, StepRow } from '../../server/briefs/store.js';
import { formatDiagnosis, validDiagnoseArgs, valueAt } from '../../worker/brief-diagnose.js';

const BRIEF = '0b7e2a4c-1f3d-4e5a-9b6c-7d8e9f0a1b2c';
const ID = 'a'.repeat(64);

function step(meta: Record<string, unknown>, reason: string | null = 'citation_check'): StepRow {
  return {
    briefId: BRIEF,
    n: 2,
    status: reason ? 'withheld' : 'answered',
    result: reason ? { kind: 'withheld', reason } : { kind: 'answer' },
    meta,
  } as unknown as StepRow;
}

const composition = {
  outcome: 'answer',
  summary: 'The engine quit 2 hrs. after an overhaul [[case:DFW08TA066]]. Mechanics are often to blame.',
  groups: [{ kind: 'causal', caseNumbers: ['DFW08TA066'] }],
  cases: [
    {
      ntsbNo: 'DFW08TA066',
      why: 'The engine lost power after maintenance (P1).',
      quotes: [{ passageId: 'P1', quote: 'The engine had been replaced 5 hours prior', speaker: 'investigators' }],
      evidencePassageIds: ['P1', 'P9'],
    },
  ],
  gaps: [],
};

const diagnostics: StepDiagnostics = {
  reason: 'citation_check',
  composition,
  aliases: { P1: ID },
  summarySentences: ['The engine quit 2 hrs. after an overhaul [[case:DFW08TA066]].', 'Mechanics are often to blame.'],
};

describe('brief-diagnose', () => {
  it('prints each validation reason with the text its path points at', () => {
    const reasons = [
      { code: 'uncited_summary', path: 'summary.1' },
      { code: 'alias_in_text', path: 'cases.0.why' },
      { code: 'quote_not_found', path: 'cases.0.quotes.0.quote' },
      { code: 'unknown_passage', path: 'cases.0.evidencePassageIds.1' },
      { code: 'provenance', path: 'passages.P1' },
    ];
    const lines = formatDiagnosis(step({ validation: { ruleVersion: 'quote-ws-v2', reasons }, stopReasons: { compose: 'end_turn' } }), diagnostics);
    expect(lines).toEqual([
      `brief ${BRIEF}, step 2: withheld (citation_check)`,
      'stop reasons: compose=end_turn',
      'validation (quote-ws-v2): 5 reason(s), summary split into 2 sentence(s)',
      '  uncited_summary at summary.1',
      '    sentence 1: "Mechanics are often to blame."',
      '  alias_in_text at cases.0.why',
      '    "The engine lost power after maintenance (P1)."',
      '  quote_not_found at cases.0.quotes.0.quote',
      '    "The engine had been replaced 5 hours prior"',
      `    cites passage P1 = ${ID}`,
      '  unknown_passage at cases.0.evidencePassageIds.1',
      '    passage "P9" (not an alias of the bundle)',
      '  provenance at passages.P1',
      `    passage P1 = ${ID}`,
      'summary as the validator split it (2):',
      '  0: "The engine quit 2 hrs. after an overhaul [[case:DFW08TA066]]."',
      '  1: "Mechanics are often to blame."',
    ]);
  });

  it('prints each judged claim with its verdict, passages and quote, and says when nothing was kept', () => {
    const claims = [
      { id: 'C1', kind: 'summary', ntsbNo: 'DFW08TA066', text: 'The engine quit 2 hrs. after an overhaul (DFW08TA066).', passageIds: ['P1'], absence: false },
      { id: 'C2', kind: 'why', ntsbNo: 'DFW08TA066', text: 'The engine lost power after maintenance.', passageIds: ['P1'], absence: false },
      { id: 'C3', kind: 'criterion', ntsbNo: 'DFW08TA066', text: 'Under the timing rules, the supplied passages of this case do not settle it.', passageIds: ['P1'], absence: true },
    ];
    const meta = {
      check: {
        supported: false,
        claims: 3,
        counts: { supported: 1, contradicted: 1, not_established: 1 },
        codes: ['contradicted', 'not_established', 'chronology_missed'],
        problems: [
          { claim: 'C2', claimIndex: 1, kind: 'why', code: 'not_established' },
          { claim: 'C3', claimIndex: 2, kind: 'criterion', code: 'contradicted' },
          { claim: 'C3', claimIndex: 2, kind: 'criterion', code: 'chronology_missed' },
        ],
        chronologyMissed: [{ claim: 'C3', ntsbNo: 'DFW08TA066', criterion: 'timing_window' }],
      },
    };
    const verdicts = {
      verdicts: [
        { claim: 'C1', verdict: 'supported', passages: ['P1'] },
        { claim: 'C2', verdict: 'not_established', passages: [] },
        { claim: 'C3', verdict: 'contradicted', passages: ['P1'] },
      ],
      quotes: [{ claim: 'C3', passage: 'P1', text: 'replaced 5.1 hours prior to the accident' }],
    };
    const lines = formatDiagnosis(step(meta, 'evidence_check'), { ...diagnostics, reason: 'evidence_check', claims, verdicts });
    expect(lines.slice(1, 12)).toEqual([
      'check: supported=false, 3 claim(s); verdicts supported 1, contradicted 1, not_established 1; codes contradicted, not_established, chronology_missed',
      '  not_established at C2 (why, DFW08TA066)',
      '    claim: "The engine lost power after maintenance."',
      `    cites: P1 = ${ID}`,
      '    verdict: not_established; passages none',
      '  contradicted + chronology_missed at C3 (criterion, DFW08TA066)',
      '    claim: "Under the timing rules, the supplied passages of this case do not settle it."',
      `    cites: P1 = ${ID} (absence claim: every supplied passage of its case)`,
      '    verdict: contradicted; passages P1',
      `    quote from P1 = ${ID}: "replaced 5.1 hours prior to the accident"`,
      '  chronology_missed: DFW08TA066 timing_window (C3): the checker found timing the composition did not extract, or the checker erred; nothing was repaired',
    ]);
    const failed = formatDiagnosis(step({ failure: { stage: 'compose', category: 'truncated' } }, 'compose_failed'), null);
    expect(failed).toEqual([
      `brief ${BRIEF}, step 2: withheld (compose_failed)`,
      'failure: compose truncated',
      'no diagnostics: the summary was withheld before a composition existed (compose_failed), or the step predates them',
    ]);
    expect(formatDiagnosis(step({}, null), null).at(-1)).toBe('no diagnostics: only a withheld or partially shown summary keeps them');
  });

  it('reads only own properties along a path, and takes a UUID and a step from 1 to 4', () => {
    expect(valueAt(composition, 'cases.0.quotes.0.passageId')).toBe('P1');
    expect(valueAt(composition, 'cases.3.why')).toBeUndefined();
    expect(valueAt(composition, 'constructor.name')).toBeUndefined();
    expect(validDiagnoseArgs(BRIEF)).toBe(true);
    expect(validDiagnoseArgs(BRIEF, 4)).toBe(true);
    expect(validDiagnoseArgs(BRIEF, 5)).toBe(false);
    expect(validDiagnoseArgs('not-a-brief')).toBe(false);
  });
});
