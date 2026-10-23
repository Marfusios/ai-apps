/**
 * The Track N calibration sets: code-reading labels derived from the coded rows by rule
 * (2 / 1 / 0, the probable-cause and same-aircraft requirements), the seeded draws with
 * hard negatives, the synthetic narrative controls (rendered like real cases, anchors
 * present, balanced per family, split by base record), and the frozen labels.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodedCorpus, CodedItem } from '../../evals/retrieval/coded/coded.js';
import {
  CALIBRATION_VERSION,
  CalibrationDatasetSchema,
  assembleCalibration,
  calibrationProblems,
  codeReadingGrade,
  codeReadingRubric,
  controlEvidence,
  controlGroup,
  drawCodeReading,
  labelsSha256,
  seededSample,
  type CalibrationDataset,
} from '../../evals/retrieval/narrative/calibration.js';
import { CONTROL_FAMILIES, NARRATIVE_CONTROLS } from '../../evals/retrieval/narrative/calibration/controls.js';
import type { CohortCase } from '../../evals/retrieval/narrative/dataset.js';
import { renderCase } from '../../evals/retrieval/narrative/evidence.js';
import { NARRATIVE_QUESTIONS } from '../../evals/retrieval/narrative/questions.js';
import { rubricVersion } from '../../evals/retrieval/narrative/spec.js';

const APP_DIR = resolve(import.meta.dirname, '../..');
const committed = (): CalibrationDataset =>
  CalibrationDatasetSchema.parse(JSON.parse(readFileSync(resolve(APP_DIR, 'evals/retrieval/narrative/calibration.json'), 'utf8')));

const finding = (codes: string[], inProbableCause: boolean) => ({ kind: 'finding' as const, codes, inProbableCause });
const aircraft = (findings: [string, boolean][] = [], events: string[] = []) => ({ findings: new Map(findings), events: new Set(events) });

describe('code-reading labels by rule', () => {
  const pc = { codeSet: { clauses: [finding(['0303103081'], true)], attribution: 'same-aircraft' as const } };
  const two = { codeSet: { clauses: [{ kind: 'event' as const, codes: ['192'] }, finding(['0206103044'], true)], attribution: 'same-aircraft' as const } };

  it('grades 2 when the clause is met, 1 when a listed code fails its citation, 0 without a listed code', () => {
    expect(codeReadingGrade({ aircraft: [aircraft([['0303103081', true]])] }, pc)).toBe(2);
    expect(codeReadingGrade({ aircraft: [aircraft([['0303103081', false]])] }, pc)).toBe(1);
    expect(codeReadingGrade({ aircraft: [aircraft([['0303103082', true]])] }, pc)).toBe(0);
  });

  it('needs one aircraft to carry every clause, and grades a split as 1', () => {
    expect(codeReadingGrade({ aircraft: [aircraft([['0206103044', true]], ['192'])] }, two)).toBe(2);
    expect(codeReadingGrade({ aircraft: [aircraft([], ['192']), aircraft([['0206103044', true]])] }, two)).toBe(1);
    expect(codeReadingGrade({ aircraft: [aircraft([], ['192']), aircraft([['0206103044', true]])] }, { codeSet: { ...two.codeSet, attribution: 'any-aircraft' } })).toBe(2);
  });

  it('writes the rubric from the code set, the codes visible and grouped by subsection', () => {
    const r = codeReadingRubric({
      codeSet: { clauses: [finding(['0303103081', '0303103082'], true)], attribution: 'same-aircraft' },
      codes: [
        { kind: 'finding', code: '0303103081', descriptions: ['Environmental issues-Conditions/weather/phenomena-Temp/humidity/pressure-Conducive to carburetor icing-Effect on equipment'], cohortCases: 1, relevantCases: 1 },
        { kind: 'finding', code: '0303103082', descriptions: ['Environmental issues-Conditions/weather/phenomena-Temp/humidity/pressure-Conducive to carburetor icing-Effect on operation'], cohortCases: 1, relevantCases: 1 },
      ],
      filters: { phase: ['landing'] },
    });
    expect(r.relevant).toContain('03031030 followed by modifier 81, 82 (Environmental issues-Conditions/weather/phenomena-Temp/humidity/pressure-Conducive to carburetor icing)');
    expect(r.relevant).toContain('an aircraft with its defining event in phase landing carries');
    expect(r.relevant).toContain('cited in the probable cause');
    expect(r.partial).toContain('not cited in the probable cause');
    expect(r.edgeCases.some((e) => e.grade === 1)).toBe(true);
  });
});

describe('the code-reading draw', () => {
  const cohort: CohortCase[] = ['FIX10MI001', 'FIX10MI002', 'FIX10MI003', 'FIX10MI004', 'FIX10MI005', 'FIX10MI006'].map((ntsbNo) => ({
    ntsbNo,
    evYear: 2010,
    state: 'MI',
    injury: null,
    conditions: null,
    light: null,
    aircraft: [{ aircraftKey: 1, category: 'AIR', phase: 'landing', farPart: '091', purpose: 'PERS', engines: [] }],
  }));
  const coded: CodedCorpus = {
    cases: cohort.map((c) => ({ ntsbNo: c.ntsbNo, evYear: 2010, state: 'MI' })),
    aircraft: cohort.map((c) => ({ ntsbNo: c.ntsbNo, aircraftKey: 1, category: 'AIR', definingPhaseGroup: 'landing' })),
    findings: [
      { ntsbNo: 'FIX10MI001', aircraftKey: 1, code: '0303103081', description: 'd', inProbableCause: true },
      { ntsbNo: 'FIX10MI002', aircraftKey: 1, code: '0303103081', description: 'd', inProbableCause: false },
      { ntsbNo: 'FIX10MI003', aircraftKey: 1, code: '0303103086', description: 'd', inProbableCause: true },
    ],
    sequence: [],
  };
  const q = { id: 'carb', question: 'Which?', filters: { state: ['MI'] }, codeSet: { clauses: [finding(['0303103081'], true)], attribution: 'same-aircraft' }, codes: [], relevant: ['FIX10MI001'] } as unknown as CodedItem;
  const spec = { question: 'carb', split: 'dev' as const, positives: 4, partials: 2, zeros: 2 };

  it('draws positives (the Track C labels), partials and hard zeros first, deterministically', () => {
    const d = drawCodeReading(spec, q, cohort, coded);
    expect(d.problems).toEqual([]);
    expect(d.picks.filter((p) => p.label === 2).map((p) => p.ntsbNo)).toEqual(['FIX10MI001']);
    expect(d.picks.filter((p) => p.label === 1).map((p) => p.ntsbNo)).toEqual(['FIX10MI002']);
    const zeros = d.picks.filter((p) => p.label === 0);
    expect(zeros).toHaveLength(2);
    expect(zeros[0]?.ntsbNo).toBe('FIX10MI003');
    expect(drawCodeReading(spec, q, cohort, coded)).toEqual(d);
  });

  it('reports positives that differ from the Track C labels', () => {
    expect(drawCodeReading(spec, { ...q, relevant: ['FIX10MI002'] } as CodedItem, cohort, coded).problems[0]).toMatch(/differ from the Track C labels/);
  });

  it('samples deterministically by seed', () => {
    expect(seededSample([1, 2, 3, 4, 5], 3, 's')).toEqual(seededSample([1, 2, 3, 4, 5], 3, 's'));
    expect(seededSample([1, 2, 3, 4, 5], 9, 's')).toHaveLength(5);
  });
});

describe('the narrative controls', () => {
  it('cover every family with every grade, under rubrics of the development questions', () => {
    const ids = new Set(NARRATIVE_QUESTIONS.map((q) => q.id));
    for (const family of CONTROL_FAMILIES) {
      const mine = NARRATIVE_CONTROLS.filter((c) => c.family === family);
      expect(new Set(mine.map((c) => c.label))).toEqual(new Set([0, 1, 2]));
    }
    for (const c of NARRATIVE_CONTROLS) {
      expect(ids.has(c.question)).toBe(true);
      expect(c.record.ntsbNo).toMatch(/^SYN\d{2}[A-Z]{2}\d{3}$/);
    }
  });

  it('render like real cases: aircraft scope with one aircraft, event scope with several', () => {
    const single = NARRATIVE_CONTROLS.find((c) => c.record.aircraft.length === 1);
    const multi = NARRATIVE_CONTROLS.find((c) => c.record.aircraft.length > 1);
    const s = controlEvidence(single?.record as never);
    const m = controlEvidence(multi?.record as never);
    expect(s.sections.every((x) => x.scope === 'aircraft' && x.aircraftKey === 1)).toBe(true);
    expect(m.sections.every((x) => x.scope === 'event' && x.aircraftKey === null)).toBe(true);
    expect(m.aircraft.map((a) => a.aircraftNtsbNo)).toEqual([`${multi?.record.ntsbNo}A`, `${multi?.record.ntsbNo}B`]);
    expect(renderCase(m)).toContain('<section id="S1" kind="factual information" scope="event">');
  });

  it('keep variants of one base record in one split', () => {
    const d = committed();
    const splitOf = new Map<string, Set<string>>();
    for (const i of d.items.filter((x) => x.set === 'narrative-control')) {
      const g = controlGroup(i.id.replace(/^nc-/, ''));
      splitOf.set(g, (splitOf.get(g) ?? new Set()).add(i.split));
    }
    for (const splits of splitOf.values()) expect(splits.size).toBe(1);
  });
});

describe('assembly and frozen labels', () => {
  const source = { generationId: 1, archiveSha256: 'a'.repeat(64), mappingVersion: 'v1-empirical', fieldNormalizationVersion: 'v1', citationTextVersion: 'v1' };
  const questions = new Map(NARRATIVE_QUESTIONS.map((q) => [q.id, q]));

  it('refuses a control whose anchor is not in its record', () => {
    const [first, ...rest] = NARRATIVE_CONTROLS;
    const broken = { ...(first as (typeof NARRATIVE_CONTROLS)[number]), anchors: ['a sentence the record does not contain'] };
    const built = assembleCalibration(source, [], new Map(), questions, [broken, ...rest]);
    expect(built.problems.some((p) => p.includes('is not in the record'))).toBe(true);
  });

  it('changes the label hash when any label changes', () => {
    const built = assembleCalibration(source, [], new Map(), questions);
    const items = built.dataset.items;
    const changed = items.map((i, n) => (n === 0 ? { ...i, label: ((i.label + 1) % 3) as 0 | 1 | 2 } : i));
    expect(labelsSha256(changed)).not.toBe(labelsSha256(items));
    expect(calibrationProblems({ ...built.dataset, items: changed })).toContain('labels: the label hash does not match the items (labels changed after freezing)');
  });

  it('is the committed, frozen set', () => {
    const d = committed();
    expect(d.version).toBe(CALIBRATION_VERSION);
    expect(calibrationProblems(d)).toEqual([]);
    expect(d.labels.sha256).toBe('98e78bdfc4be14459100ca30baf42a436d05d1d73ddb37d3eeca55c5725b8bca');
    expect(d.items.every((i) => i.provenance === 'constructed')).toBe(true);
    for (const q of Object.values(d.questions)) expect(q.rubricVersion).toBe(rubricVersion(q.rubric));
    const sets = new Set(d.items.map((i) => `${i.set}/${i.split}`));
    expect(sets).toEqual(new Set(['code-reading/dev', 'code-reading/holdout', 'narrative-control/dev', 'narrative-control/holdout']));
  });
});
