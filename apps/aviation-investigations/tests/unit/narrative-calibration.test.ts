/**
 * The Track N calibration sets: code-reading labels derived from the coded rows by rule
 * (2 / 1 / 0, the probable-cause and same-aircraft requirements), the seeded draws with
 * hard negatives, the synthetic narrative controls (rendered like real cases, anchors
 * present, every grade in each split of each family, at least 8 holdout items per
 * family, split by base record, neutral filler, long records judged in parts,
 * answerability bundles frozen by their passages), and the frozen labels.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CodedCorpus, CodedItem } from '../../evals/retrieval/coded/coded.js';
import {
  CALIBRATION_VERSION,
  CONTROL_HOLDOUT_GROUPS,
  CalibrationDatasetSchema,
  NARRATIVE_CONTROLS,
  assembleCalibration,
  bundlePassages,
  itemPassages,
  resolveRecord,
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
import { CONTROL_FAMILIES } from '../../evals/retrieval/narrative/calibration/controls.js';
import { FILLER_FORBIDDEN, fillerParagraphs, longFiller } from '../../evals/retrieval/narrative/calibration/filler.js';
import { CALIBRATION_CRITERIA } from '../../evals/retrieval/narrative/criteria.js';
import { bundleKeyOf } from '../../evals/retrieval/narrative/judging.js';
import type { CohortCase } from '../../evals/retrieval/narrative/dataset.js';
import { planChunks, renderCase } from '../../evals/retrieval/narrative/evidence.js';
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
  it('cover every family with every grade in each split, under rubrics of the development questions', () => {
    const ids = new Set(NARRATIVE_QUESTIONS.map((q) => q.id));
    const holdout = (id: string) => CONTROL_HOLDOUT_GROUPS.includes(controlGroup(id));
    for (const family of CONTROL_FAMILIES) {
      for (const split of [true, false]) {
        const mine = NARRATIVE_CONTROLS.filter((c) => c.family === family && holdout(c.id) === split);
        expect({ family, split, grades: new Set(mine.map((c) => c.label)) }).toEqual({ family, split, grades: new Set([0, 1, 2]) });
        if (split) expect(mine.length).toBeGreaterThanOrEqual(CALIBRATION_CRITERIA.perFamily.minItems);
      }
    }
    for (const c of NARRATIVE_CONTROLS) {
      expect(ids.has(c.question)).toBe(true);
      // The real format with a sequence of 900 or above (the builder also checks the database).
      expect(c.record.ntsbNo).toMatch(/^[A-Z]{3}\d{2}(LA|FA|MA)9\d{2}$/);
    }
    // Every family holds controls that need reading as well as edge-case lookups, and the holdout mostly needs reading.
    const novelHoldout = NARRATIVE_CONTROLS.filter((c) => holdout(c.id) && c.reading === 'novel').length;
    expect(novelHoldout / NARRATIVE_CONTROLS.filter((c) => holdout(c.id)).length).toBeGreaterThan(0.5);
  });

  it('render like real cases: aircraft scope with one aircraft, event scope with several, aircraft sections in their own scope', () => {
    const single = NARRATIVE_CONTROLS.find((c) => c.record.aircraft.length === 1);
    const multi = NARRATIVE_CONTROLS.find((c) => c.record.aircraft.length > 1 && !c.record.aircraftSections);
    const scoped = NARRATIVE_CONTROLS.find((c) => c.record.aircraftSections !== undefined && !c.record.factual.includes('{{fill:'));
    const s = controlEvidence(single?.record as never);
    const m = controlEvidence(multi?.record as never);
    expect(s.sections.every((x) => x.scope === 'aircraft' && x.aircraftKey === 1)).toBe(true);
    expect(m.sections.every((x) => x.scope === 'event' && x.aircraftKey === null)).toBe(true);
    expect(m.aircraft.map((a) => a.aircraftNtsbNo)).toEqual([`${multi?.record.ntsbNo}A`, `${multi?.record.ntsbNo}B`]);
    expect(renderCase(m)).toContain('<section id="S1" kind="factual information" scope="event">');
    const sc = controlEvidence(scoped?.record as never);
    expect(sc.sections.map((x) => [x.alias, x.kind, x.scope, x.aircraftKey])).toEqual([
      ['S1', 'factual', 'event', null],
      ['S2', 'factual', 'aircraft', 1],
      ['S3', 'factual', 'aircraft', 2],
      ['S4', 'analysis', 'event', null],
      ['S5', 'probable_cause', 'event', null],
    ]);
    expect(renderCase(sc)).toContain('<section id="S3" kind="factual information" scope="aircraft" aircraft="2">');
  });

  it('use neutral filler that never states anything a rubric turns on', () => {
    const place = { airport: 'Test Field', station: 'KTST', elevation: 500, temperature: 20 };
    for (const seed of ['a', 'b', 'c', 'd']) {
      for (const p of fillerParagraphs(seed, place, 9)) expect(FILLER_FORBIDDEN.test(p)).toBe(false);
      expect(FILLER_FORBIDDEN.test(longFiller(seed, place, 30))).toBe(false);
    }
    expect(fillerParagraphs('a', place, 3)).toEqual(fillerParagraphs('a', place, 3));
  });

  it('judge long records in parts, with the deciding sentences in the parts they were placed in', () => {
    const d = committed();
    const long = d.items.filter((i) => i.tags[0] === 'long_record');
    expect(long.length).toBeGreaterThanOrEqual(8);
    for (const i of long) {
      const e = controlEvidence(resolveRecord(d.records[i.case.ntsbNo] as never, d.fillers));
      const plan = planChunks(e);
      expect(plan.chunks.length).toBeGreaterThanOrEqual(2);
      expect(plan.uncovered).toBeNull();
      const parts = i.anchors.map((a) => plan.chunks.findIndex((pieces) => pieces.some((p) => (e.sections.find((x) => x.alias === p.alias)?.text.slice(p.start, p.end) ?? '').includes(a))));
      expect(new Set(parts).size).toBeGreaterThan(1);
    }
  });

  it('freeze each answerability bundle by its passages, and pair it with the complete record\'s relevance', () => {
    const d = committed();
    const ans = d.items.filter((i) => i.kind === 'answerability');
    expect(ans.length).toBeGreaterThanOrEqual(8);
    for (const i of ans) {
      const e = controlEvidence(resolveRecord(d.records[i.case.ntsbNo] as never, d.fillers));
      const passages = itemPassages(e, i.bundle as never);
      expect(bundleKeyOf(i.bundle?.passages ?? [])).toBe(i.bundle?.key);
      expect(passages.map((p) => p.text)).toEqual(i.anchors);
      // The same record's relevance item exists, and some bundle's label differs from it.
      expect(d.items.some((x) => x.kind === 'relevance' && x.case.ntsbNo === i.case.ntsbNo)).toBe(true);
    }
    const differs = ans.filter((i) => d.items.find((x) => x.kind === 'relevance' && x.case.ntsbNo === i.case.ntsbNo)?.label !== i.label);
    expect(differs.length).toBeGreaterThanOrEqual(6);
    expect(() => bundlePassages(controlEvidence(resolveRecord(d.records[ans[0]?.case.ntsbNo as string] as never, d.fillers)), [{ section: 'S1', text: 'not in the record' }])).toThrow(/exactly once/);
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
    expect(d.labels.sha256).toBe('9266af5a2923e847947b48eaeade3a8b1f086bb341eb28c048aeccc8ac4ae896');
    expect(d.items.every((i) => i.provenance === 'constructed')).toBe(true);
    for (const q of Object.values(d.questions)) expect(q.rubricVersion).toBe(rubricVersion(q.rubric));
    const sets = new Set(d.items.map((i) => `${i.set}/${i.split}`));
    expect(sets).toEqual(new Set(['code-reading/dev', 'code-reading/holdout', 'narrative-control/dev', 'narrative-control/holdout']));
  });
});
