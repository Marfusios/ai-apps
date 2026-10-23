/**
 * The Track N judge calibration sets (task 10c protocol v4, section 3), built and
 * label-frozen before any judge output exists. They are diagnostics, not validation:
 * judge-judge and judge-adjudicator agreement, and agreement with the labels, per set,
 * tag and grade. Two separate sets:
 *
 * - **Code-reading** (`code-reading`): Track C questions with the answer-bearing codes
 *   visible. The judged case is a real case (its complete record from the canonical
 *   database, fingerprinted), the rubric asks about the coded rows only, and the label
 *   is derived from them by rule (**constructed**): 2 when one aircraft carries every
 *   clause of the question's code set as required (exactly the Track C label), 1 when a
 *   listed code appears but its clause is not met (not cited in the probable cause when
 *   required, or one aircraft carries only some clauses), 0 when no listed code appears.
 *   Per question: positives, partials and zeros drawn with a seeded sample, the zeros
 *   preferring cases with another modifier of a listed finding (hard negatives).
 * - **Narrative controls** (`narrative-control`): synthetic records written for the
 *   purpose (`calibration/controls*.ts`), minimal variants for negation, chronology,
 *   pilot statement against investigator finding, cross-aircraft attribution (with
 *   aircraft-scoped sections) and causal uncertainty; answerability items whose
 *   delivered bundle supports less or more than the complete record (judged with the
 *   answerability prompt); and long records judged in parts. Each is labelled
 *   **constructed** under a development question's rubric and tagged with its family
 *   and with `reading:edge-case` or `reading:novel`.
 *
 * **Splits.** Each set is split into `dev` and `holdout` by question (code-reading) or
 * by base record (controls), so variants of one record never straddle the split; every
 * family has at least `CALIBRATION_CRITERIA.perFamily.minItems` holdout items and every
 * grade in each split. Configurations are selected on `dev` only; the holdout runs once
 * for a frozen configuration and is judged against the frozen criteria (criteria.ts).
 *
 * **Freezing.** `labels.sha256` hashes every item's identity, label and provenance; the
 * builder's `--check` rebuilds in memory and refuses any difference.
 */
import { z } from 'zod';
import { mulberry32 } from '../experiments/stats.js';
import type { CodedCorpus, CodedDataset, CodedItem } from '../coded/coded.js';
import { GENERATION_IDENTITY_FIELDS, type GenerationSource } from '../generation.js';
import { deriveCohort, type CohortCase } from './dataset.js';
import { bundleFingerprint, fingerprint, planChunks, type CaseEvidence, type DeliveredPassage } from './evidence.js';
import { CALIBRATION_CRITERIA } from './criteria.js';
import { bundleKeyOf } from './judging.js';
import { ATTRIBUTION_CONTROLS, CHRONOLOGY_CONTROLS, CONTROL_FAMILIES, CROSS_AIRCRAFT_CONTROLS, NEGATION_CONTROLS, type Control, type ControlRecord } from './calibration/controls.js';
import { ANSWERABILITY_CONTROLS } from './calibration/controls-bundles.js';
import { LONG_CONTROLS, LONG_FILLERS } from './calibration/controls-long.js';
import { ATTRIBUTION_READING, CAUSAL_READING, CHRONOLOGY_READING, CROSS_AIRCRAFT_READING, NEGATION_READING } from './calibration/controls-reading.js';
import { CaseNoSchema, RubricSchema, canonicalJson, questionVersion, rubricVersion, sha256, type Grade, type NarrativeQuestionSpec, type Rubric } from './spec.js';

/**
 * v3 (fix round 2): the hour-window rubrics and their boundary controls, neutral and
 * aircraft-appropriate filler, coherent records and coded rows, the N6 edge cases;
 * v2 (fix round 1): new rubrics, realistic case numbers, reading controls, answerability
 * items and long records; at least 8 holdout items per family.
 */
export const CALIBRATION_VERSION = 'track-n-calibration-v3';

/** Every narrative control, in family order. */
export const NARRATIVE_CONTROLS: readonly Control[] = [
  ...NEGATION_CONTROLS,
  ...NEGATION_READING,
  ...CHRONOLOGY_CONTROLS,
  ...CHRONOLOGY_READING,
  ...ATTRIBUTION_CONTROLS,
  ...ATTRIBUTION_READING,
  ...CROSS_AIRCRAFT_CONTROLS,
  ...CROSS_AIRCRAFT_READING,
  ...CAUSAL_READING,
  ...ANSWERABILITY_CONTROLS,
  ...LONG_CONTROLS,
];

/** The Track C questions of the code-reading set, their split and how many items of each grade to draw. */
export const CODE_READING_SPECS: readonly { question: string; split: 'dev' | 'holdout'; positives: number; partials: number; zeros: number }[] = [
  { question: 'env-carb-icing-cause-michigan', split: 'dev', positives: 4, partials: 2, zeros: 4 },
  { question: 'sys-fuel-selector-misuse-2023-2026', split: 'dev', positives: 4, partials: 2, zeros: 4 },
  { question: 'occ-midair-nevada', split: 'dev', positives: 4, partials: 2, zeros: 4 },
  { question: 'occ-fuel-exhaustion-fuel-planning-cause-oklahoma', split: 'dev', positives: 4, partials: 2, zeros: 4 },
  { question: 'sys-magneto-failure-2014-2016', split: 'holdout', positives: 4, partials: 2, zeros: 4 },
  { question: 'occ-fuel-starvation-minnesota', split: 'holdout', positives: 4, partials: 2, zeros: 4 },
  { question: 'env-tailwind-cause-landing-utah', split: 'holdout', positives: 4, partials: 2, zeros: 4 },
];

/**
 * Base records (groups) of the narrative controls in the holdout split; the rest are dev.
 * Every family has at least `CALIBRATION_CRITERIA.perFamily.minItems` holdout items, and
 * no holdout record is a variant of a dev record.
 */
export const CONTROL_HOLDOUT_GROUPS: readonly string[] = [
  'neg-gear',
  'neg-jump',
  'chr-heli',
  'chr-thrush',
  'chr-cub',
  'chr-rotor',
  'att-data',
  'att-engine',
  'att-yaw',
  'mx-pattern',
  'mx-scoped',
  'mx-ramp',
  'cu-fire',
  'cu-show2',
  'ans-taxi',
  'ans-pv',
  'ans-late2',
  'long-pv',
  'long-mx',
];
/** A control's base record group: its id up to the second hyphen (`neg-skyd-...` → `neg-skyd`). */
export const controlGroup = (id: string): string => id.split('-').slice(0, 2).join('-');

/** A delivered bundle of a control (answerability): passages cut from the record's sections, in delivered order. */
export const ControlBundleSchema = z.strictObject({
  /** `bundleKeyOf` of the passages: how a judgment record finds its item. */
  key: z.string().min(1),
  passages: z
    .array(
      z.strictObject({
        passageId: z.string().min(1),
        /** The record's section alias (S1 the factual section, then any aircraft sections, the analysis, the probable cause). */
        section: z.string().regex(/^S[1-9]$/),
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
        textSha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1),
});
export type ControlBundle = z.infer<typeof ControlBundleSchema>;

export const CalibrationItemSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/),
  set: z.enum(['code-reading', 'narrative-control']),
  /** What is judged: case relevance on the complete record, or answerability of a delivered bundle. */
  kind: z.enum(['relevance', 'answerability']).default('relevance'),
  /** Answerability: the delivered passages; null for relevance. */
  bundle: ControlBundleSchema.nullable().default(null),
  split: z.enum(['dev', 'holdout']),
  /** Reporting tags: the control family, or `code-reading` with the code kinds. */
  tags: z.array(z.string().min(1)).min(1),
  /** The judged question (a key of the dataset's `questions`) and its versions. */
  question: z.string().min(1),
  questionVersion: z.string().regex(/^q-[0-9a-f]{16}$/),
  rubricVersion: z.string().regex(/^r-[0-9a-f]{16}$/),
  case: z.strictObject({
    ntsbNo: CaseNoSchema,
    source: z.enum(['canonical', 'synthetic']),
    /** The complete-input fingerprint the label was made against. */
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  label: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  provenance: z.enum(['constructed', 'model-reviewed']),
  mutation: z.string().nullable(),
  /** Exact record text the label rests on (controls). */
  anchors: z.array(z.string()),
  why: z.string().min(5),
});
export type CalibrationItem = z.infer<typeof CalibrationItemSchema>;

const ControlRecordSchema = z.strictObject({
  ntsbNo: CaseNoSchema,
  date: z.string(),
  city: z.string(),
  state: z.string(),
  aircraft: z.array(z.strictObject({ make: z.string(), model: z.string(), category: z.string(), farPart: z.string(), purpose: z.string(), phase: z.string(), engine: z.string(), damage: z.string().optional() })).min(1),
  factual: z.string(),
  analysis: z.string(),
  probableCause: z.string(),
  aircraftSections: z.array(z.strictObject({ aircraft: z.number().int().positive(), text: z.string() })).optional(),
  event: z.strictObject({ highestInjury: z.string().optional(), light: z.string().optional(), weather: z.string().optional() }).optional(),
  findings: z.array(z.strictObject({ aircraft: z.number().int(), code: z.string(), description: z.string(), inProbableCause: z.boolean() })),
  occurrences: z.array(z.strictObject({ aircraft: z.number().int(), code: z.string(), phase: z.string(), description: z.string(), defining: z.boolean() })),
});

export const CalibrationDatasetSchema = z.strictObject({
  version: z.literal(CALIBRATION_VERSION),
  note: z.string(),
  /** The generation the code-reading cases and labels come from. */
  source: z.strictObject({ generationId: z.number().int().positive(), ...GENERATION_IDENTITY_FIELDS }),
  labels: z.strictObject({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    items: z.number().int(),
    byGrade: z.strictObject({ '0': z.number().int(), '1': z.number().int(), '2': z.number().int() }),
  }),
  /** The judged questions and rubrics, by id. */
  questions: z.record(z.string(), z.strictObject({ question: z.string().min(10), rubric: RubricSchema, questionVersion: z.string(), rubricVersion: z.string() })),
  items: z.array(CalibrationItemSchema).min(1),
  /** The synthetic records of the narrative controls, by case number (long texts as `{{fill:<key>}}`). */
  records: z.record(z.string(), ControlRecordSchema),
  /** The long texts of the long-record controls, stored once per group. */
  fillers: z.record(z.string(), z.string()).default({}),
});
export type CalibrationDataset = z.infer<typeof CalibrationDatasetSchema>;

export const CALIBRATION_NOTE =
  'Track N judge calibration (task 10c protocol v4, section 3): code-reading items (Track C questions, answer-bearing ' +
  'codes visible, labels derived from the coded rows) and narrative controls (synthetic minimal-variant records for ' +
  'negation, chronology, pilot versus investigator, cross-aircraft attribution and causal uncertainty; answerability ' +
  'items whose delivered bundle supports less or more than the complete record; long records judged in parts). Every ' +
  'label is constructed; none is an expert\'s. Pass criteria are frozen in criteria.ts and apply to the holdout, which ' +
  'runs once per configuration. Rebuild with pnpm eval:retrieval:narrative calibration.';

// ---------------------------------------------------------------------------
// Synthetic records as judge evidence

/** A control record with its long texts filled in (`{{fill:<key>}}` from the file's `fillers`). */
export function resolveRecord(r: ControlRecord, fillers: Readonly<Record<string, string>>): ControlRecord {
  const fill = (text: string) =>
    text.replace(/\{\{fill:([a-z0-9-]+)\}\}/g, (_m, key: string) => {
      const t = fillers[key];
      if (t === undefined) throw new Error(`${r.ntsbNo}: no filler ${key}`);
      return t;
    });
  return {
    ...r,
    factual: fill(r.factual),
    analysis: fill(r.analysis),
    probableCause: fill(r.probableCause),
    ...(r.aircraftSections ? { aircraftSections: r.aircraftSections.map((x) => ({ ...x, text: fill(x.text) })) } : {}),
  };
}

/**
 * A (resolved) control record as the judge reads it, through the same renderer as a real
 * case: the factual section (event-scoped with several aircraft), then any aircraft-scoped
 * factual sections, the analysis and the probable cause.
 */
export function controlEvidence(r: ControlRecord): CaseEvidence {
  const multi = r.aircraft.length > 1;
  const scopeOf = (aircraft: number | null) => (aircraft === null ? (multi ? { scope: 'event' as const, key: 'event-1', aircraftKey: null } : { scope: 'aircraft' as const, key: 'aircraft-1', aircraftKey: 1 }) : { scope: 'aircraft' as const, key: `aircraft-${aircraft}`, aircraftKey: aircraft });
  const parts: { kind: 'factual' | 'analysis' | 'probable_cause'; text: string; aircraft: number | null }[] = [
    { kind: 'factual', text: r.factual, aircraft: null },
    ...(r.aircraftSections ?? []).map((x) => ({ kind: 'factual' as const, text: x.text, aircraft: x.aircraft })),
    { kind: 'analysis', text: r.analysis, aircraft: null },
    { kind: 'probable_cause', text: r.probableCause, aircraft: null },
  ];
  const sections = parts.map((p, i) => {
    const sc = scopeOf(p.aircraft);
    const sectionKey = `${p.kind}/${sc.key}`;
    const sha = sha256(p.text);
    return {
      alias: `S${i + 1}`,
      sectionId: `${r.ntsbNo}:${sectionKey}`,
      sectionKey,
      kind: p.kind,
      scope: sc.scope,
      aircraftKey: sc.aircraftKey,
      revisionId: sha256(JSON.stringify([r.ntsbNo, sectionKey, sha, 'synthetic'])),
      sha256: sha,
      text: p.text,
    };
  });
  return {
    ntsbNo: r.ntsbNo,
    event: { date: r.date, city: r.city, state: r.state, highestInjury: r.event?.highestInjury ?? 'MINR', light: r.event?.light ?? 'DAYL', weather: r.event?.weather ?? 'VMC' },
    aircraft: r.aircraft.map((a, i) => ({
      aircraftKey: i + 1,
      aircraftNtsbNo: multi ? `${r.ntsbNo}${String.fromCharCode(65 + i)}` : null,
      make: a.make,
      model: a.model,
      category: a.category,
      farPart: a.farPart,
      purpose: a.purpose,
      damage: a.damage ?? 'SUBS',
      definingPhaseGroup: a.phase,
      engines: [a.engine],
    })),
    sections,
    findings: r.findings.map((f, i) => ({
      alias: `F${i + 1}`,
      rowId: `${r.ntsbNo}/${f.aircraft}/finding/${i + 1}`,
      aircraftKey: f.aircraft,
      findingNo: i + 1,
      code: f.code,
      description: f.description,
      inProbableCause: f.inProbableCause,
    })),
    occurrences: r.occurrences.map((o, i) => ({
      alias: `O${i + 1}`,
      rowId: `${r.ntsbNo}/${o.aircraft}/occurrence/${i + 1}`,
      aircraftKey: o.aircraft,
      occurrenceNo: i + 1,
      phaseGroup: o.phase,
      eventCode: o.code,
      description: o.description,
      isDefining: o.defining,
    })),
  };
}

/** The delivered passages of a control's bundle: each text located (once) in its section of the evidence. */
export function bundlePassages(e: CaseEvidence, bundle: readonly { section: string; text: string }[]): DeliveredPassage[] {
  return bundle.map((b) => {
    const s = e.sections.find((x) => x.alias === b.section);
    if (!s) throw new Error(`${e.ntsbNo}: no section ${b.section}`);
    const start = s.text.indexOf(b.text);
    if (start < 0 || s.text.indexOf(b.text, start + 1) >= 0) throw new Error(`${e.ntsbNo}: a bundle passage must occur exactly once in ${b.section}`);
    return { passageId: `${e.ntsbNo}:${b.section}:${start}-${start + b.text.length}`, sectionId: s.sectionId, revisionId: s.revisionId, kind: s.kind, scope: s.scope, aircraftKey: s.aircraftKey, start, end: start + b.text.length, text: b.text };
  });
}

/** An item's frozen bundle as delivered passages, read back from the (resolved) record and checked against the frozen text hashes. */
export function itemPassages(e: CaseEvidence, bundle: ControlBundle): DeliveredPassage[] {
  return bundle.passages.map((p) => {
    const s = e.sections.find((x) => x.alias === p.section);
    const text = s?.text.slice(p.start, p.end);
    if (!s || text === undefined || sha256(text) !== p.textSha256) throw new Error(`${e.ntsbNo}: bundle passage ${p.passageId} does not match its record`);
    return { passageId: p.passageId, sectionId: s.sectionId, revisionId: s.revisionId, kind: s.kind, scope: s.scope, aircraftKey: s.aircraftKey, start: p.start, end: p.end, text };
  });
}

// ---------------------------------------------------------------------------
// Code-reading

/** The code-reading rubric of a Track C question: the listed codes and their clauses, judged from the coded rows only. */
export function codeReadingRubric(q: Pick<CodedItem, 'codeSet' | 'codes' | 'filters'>): Rubric {
  const descriptionOf = (kind: 'finding' | 'event', code: string) =>
    (q.codes.find((c) => c.kind === kind && c.code === code)?.descriptions[0] ?? 'description not recorded').replace(/\s+/g, ' ');
  /** Finding codes grouped by their first eight digits: the subsection once, then the listed modifiers. */
  const findings = (codes: readonly string[]) => {
    const groups = new Map<string, string[]>();
    for (const c of codes) groups.set(c.slice(0, 8), [...(groups.get(c.slice(0, 8)) ?? []), c.slice(8)]);
    return [...groups.entries()]
      .map(([prefix, modifiers]) => {
        const subsection = descriptionOf('finding', `${prefix}${modifiers[0]}`).replace(/-[^-]*$/, '');
        return modifiers.length === 1 ? `${prefix}${modifiers[0]} (${descriptionOf('finding', `${prefix}${modifiers[0]}`)})` : `${prefix} followed by modifier ${modifiers.join(', ')} (${subsection})`;
      })
      .join(' or ');
  };
  const clauses = q.codeSet.clauses.map((c) =>
    c.kind === 'finding'
      ? `a finding coded ${findings(c.codes)}${c.inProbableCause ? ', cited in the probable cause' : ', whether or not it is cited in the probable cause'}`
      : `an occurrence coded ${c.codes.map((x) => `${x} (${descriptionOf('event', x)})`).join(' or ')}, in any phase`,
  );
  const facets = [
    ...((q.filters.category ?? []).length > 0 ? [`of category ${(q.filters.category ?? []).join(' or ')}`] : []),
    ...((q.filters.phase ?? []).length > 0 ? [`with its defining event in phase ${(q.filters.phase ?? []).join(' or ')}`] : []),
  ];
  const carrier = `${clauses.length > 1 ? 'one aircraft' : 'an aircraft'}${facets.length > 0 ? ` ${facets.join(' and ')}` : ''} carries ${clauses.length > 1 ? 'all of: ' : ''}`;
  const pc = q.codeSet.clauses.some((c) => c.kind === 'finding' && c.inProbableCause);
  const unmet = [...(pc ? ['a listed finding is not cited in the probable cause although that is required'] : []), ...(clauses.length > 1 ? ['one aircraft carries only some of the requirements'] : [])];
  return {
    relevant: `Judge only from the coded findings and occurrences shown (codes are listed with each row); the narrative does not change the grade. Grade 2: ${carrier}${clauses.join('; and ')}.`,
    partial:
      unmet.length > 0
        ? `A listed code appears but a requirement is not met: ${unmet.join(', or ')}.`
        : 'Does not occur for this question: any listed code meets the requirement, so a case is either 2 or 0.',
    notRelevant: 'None of the listed codes appears in the coded findings or occurrences. Other modifiers of the same finding (the last two digits differ) and descriptions that merely resemble a listed one do not count.',
    edgeCases: [
      { situation: 'A coded row with one of the listed codes meeting every requirement.', grade: 2, why: 'The coded data hold the listed code as required.' },
      ...(q.codeSet.clauses.some((c) => c.kind === 'finding')
        ? [{ situation: 'A finding with the same first eight digits as a listed code but another modifier (the last two digits).', grade: 0 as const, why: 'Another code, not a listed one.' }]
        : []),
      ...(q.codeSet.clauses.some((c) => c.kind === 'event')
        ? [{ situation: 'An occurrence with another code whose description resembles the listed one.', grade: 0 as const, why: 'Another code, not a listed one.' }]
        : []),
      ...(pc ? [{ situation: 'A listed finding code on a row whose "cited in the probable cause" is no.', grade: 1 as const, why: 'The code appears but is not cited as required.' }] : []),
      { situation: 'The narrative describes the condition, but no listed code appears in the coded rows.', grade: 0, why: 'This rubric asks about the codes only.' },
    ],
  };
}

interface CaseCodes {
  /** Per aircraft meeting the facets: finding code → cited in the probable cause anywhere on that aircraft; event codes. */
  aircraft: { findings: Map<string, boolean>; events: Set<string> }[];
}

/** The code-reading grade of a case by rule (module comment). */
export function codeReadingGrade(c: CaseCodes, q: Pick<CodedItem, 'codeSet'>): Grade {
  const meets = (a: CaseCodes['aircraft'][number]) =>
    q.codeSet.clauses.map((cl) =>
      cl.kind === 'event' ? cl.codes.some((x) => a.events.has(x)) : cl.codes.some((x) => a.findings.has(x) && (!cl.inProbableCause || a.findings.get(x) === true)),
    );
  const anyListed = (a: CaseCodes['aircraft'][number]) =>
    q.codeSet.clauses.some((cl) => (cl.kind === 'event' ? cl.codes.some((x) => a.events.has(x)) : cl.codes.some((x) => a.findings.has(x))));
  if (q.codeSet.attribution === 'same-aircraft') {
    if (c.aircraft.some((a) => meets(a).every(Boolean))) return 2;
  } else if (q.codeSet.clauses.every((_, j) => c.aircraft.some((a) => meets(a)[j] === true))) return 2;
  return c.aircraft.some(anyListed) ? 1 : 0;
}

/** Each cohort case's codes on the aircraft that meet the question's aircraft facets. */
function casesCodes(coded: CodedCorpus, cohort: readonly string[], facets: { category?: readonly string[]; phase?: readonly string[] }): Map<string, CaseCodes> {
  const wanted = new Set(cohort);
  const aircraft = new Map<string, { key: number; findings: Map<string, boolean>; events: Set<string> }[]>();
  const meets = (a: { category: string | null; definingPhaseGroup: string | null }) =>
    ((facets.category ?? []).length === 0 || (a.category !== null && (facets.category ?? []).includes(a.category))) &&
    ((facets.phase ?? []).length === 0 || (a.definingPhaseGroup !== null && (facets.phase ?? []).includes(a.definingPhaseGroup)));
  for (const a of coded.aircraft) {
    if (!wanted.has(a.ntsbNo) || !meets(a)) continue;
    aircraft.set(a.ntsbNo, [...(aircraft.get(a.ntsbNo) ?? []), { key: a.aircraftKey, findings: new Map(), events: new Set() }]);
  }
  const of = (ntsbNo: string, key: number) => aircraft.get(ntsbNo)?.find((x) => x.key === key);
  for (const f of coded.findings) {
    const a = f.code === null ? undefined : of(f.ntsbNo, f.aircraftKey);
    if (a && f.code !== null) a.findings.set(f.code, (a.findings.get(f.code) ?? false) || f.inProbableCause === true);
  }
  for (const s of coded.sequence) {
    const a = s.eventCode === null ? undefined : of(s.ntsbNo, s.aircraftKey);
    if (a && s.eventCode !== null) a.events.add(s.eventCode);
  }
  return new Map(cohort.map((n) => [n, { aircraft: (aircraft.get(n) ?? []).map((a) => ({ findings: a.findings, events: a.events })) }]));
}

/** `n` items of `xs` in a seeded order (deterministic). */
export function seededSample<T>(xs: readonly T[], n: number, seed: string): T[] {
  const rand = mulberry32(parseInt(sha256(seed).slice(0, 8), 16));
  const copy = [...xs];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy.slice(0, n);
}

export interface CodeReadingDraw {
  question: CodedItem;
  split: 'dev' | 'holdout';
  picks: { ntsbNo: string; label: Grade; why: string }[];
  problems: string[];
}

/** The seeded draw of one code-reading question over the cohort (pure). */
export function drawCodeReading(spec: (typeof CODE_READING_SPECS)[number], q: CodedItem, cohortCases: readonly CohortCase[], coded: CodedCorpus): CodeReadingDraw {
  const problems: string[] = [];
  const cohort = deriveCohort(cohortCases, q.filters);
  const codes = casesCodes(coded, cohort, q.filters);
  const graded = cohort.map((n) => ({ n, grade: codeReadingGrade(codes.get(n) as CaseCodes, q) }));
  const twos = graded.filter((g) => g.grade === 2).map((g) => g.n);
  if (JSON.stringify(twos) !== JSON.stringify([...q.relevant].sort())) problems.push(`${q.id}: the code-reading positives differ from the Track C labels (${twos.length} against ${q.relevant.length})`);
  const listedPrefixes = new Set(q.codeSet.clauses.flatMap((c) => (c.kind === 'finding' ? c.codes.map((x) => x.slice(0, 8)) : [])));
  const listed = new Set(q.codeSet.clauses.flatMap((c) => c.codes));
  const sibling = (n: string) => (codes.get(n) as CaseCodes).aircraft.some((a) => [...a.findings.keys()].some((x) => listedPrefixes.has(x.slice(0, 8)) && !listed.has(x)));
  const zeros = graded.filter((g) => g.grade === 0).map((g) => g.n);
  const siblings = zeros.filter(sibling);
  const pickedZeros = seededSample(siblings, Math.min(siblings.length, Math.ceil(spec.zeros / 2)), `${q.id}|zero-sibling`);
  const rest = seededSample(zeros.filter((n) => !pickedZeros.includes(n)), spec.zeros - pickedZeros.length, `${q.id}|zero`);
  const picks = [
    ...seededSample(twos, spec.positives, `${q.id}|two`).map((n) => ({ ntsbNo: n, label: 2 as Grade, why: 'Track C coded positive: the coded rows meet every clause.' })),
    ...seededSample(graded.filter((g) => g.grade === 1).map((g) => g.n), spec.partials, `${q.id}|one`).map((n) => ({ ntsbNo: n, label: 1 as Grade, why: 'A listed code appears but its clause is not met.' })),
    ...pickedZeros.map((n) => ({ ntsbNo: n, label: 0 as Grade, why: 'No listed code; another modifier of a listed finding appears (a hard negative).' })),
    ...rest.map((n) => ({ ntsbNo: n, label: 0 as Grade, why: 'No listed code appears in the coded rows.' })),
  ];
  return { question: q, split: spec.split, picks, problems };
}

// ---------------------------------------------------------------------------
// Assembly

const tagsOfCodeSet = (q: CodedItem): string[] => [
  'code-reading',
  ...new Set(q.codeSet.clauses.map((c) => (c.kind === 'event' ? 'occurrence-code' : 'finding-code'))),
  ...(q.codeSet.clauses.some((c) => c.kind === 'finding' && c.inProbableCause) ? ['probable-cause'] : []),
  ...(q.codeSet.clauses.length > 1 ? ['multi-clause'] : []),
];

/** Pure: the calibration dataset from the code-reading draws (with each drawn case's evidence) and the controls. */
export function assembleCalibration(
  source: GenerationSource,
  draws: readonly CodeReadingDraw[],
  evidence: ReadonlyMap<string, CaseEvidence>,
  questions: ReadonlyMap<string, NarrativeQuestionSpec>,
  controls: readonly Control[] = NARRATIVE_CONTROLS,
): { dataset: CalibrationDataset; problems: string[] } {
  const problems: string[] = draws.flatMap((d) => d.problems);
  const items: CalibrationItem[] = [];
  const judged: CalibrationDataset['questions'] = {};
  for (const d of draws) {
    const rubric = codeReadingRubric(d.question);
    const q = { question: d.question.question, rubric, questionVersion: questionVersion({ question: d.question.question, filters: d.question.filters }), rubricVersion: rubricVersion(rubric) };
    judged[`code-reading:${d.question.id}`] = q;
    for (const p of d.picks) {
      const e = evidence.get(p.ntsbNo);
      if (!e) {
        problems.push(`${d.question.id}: no evidence for ${p.ntsbNo}`);
        continue;
      }
      items.push({
        id: `cr-${d.question.id}-${p.ntsbNo.toLowerCase()}`.slice(0, 81),
        set: 'code-reading',
        kind: 'relevance',
        bundle: null,
        split: d.split,
        tags: tagsOfCodeSet(d.question),
        question: `code-reading:${d.question.id}`,
        questionVersion: q.questionVersion,
        rubricVersion: q.rubricVersion,
        case: { ntsbNo: p.ntsbNo, source: 'canonical', fingerprint: fingerprint(e) },
        label: p.label,
        provenance: 'constructed',
        mutation: null,
        anchors: [],
        why: p.why,
      });
    }
  }
  const records: CalibrationDataset['records'] = {};
  const fillers: Record<string, string> = {};
  for (const c of controls) {
    const spec = questions.get(c.question);
    if (!spec) {
      problems.push(`${c.id}: unknown development question ${c.question}`);
      continue;
    }
    for (const key of [...JSON.stringify(c.record).matchAll(/\{\{fill:([a-z0-9-]+)\}\}/g)].map((m) => m[1] as string)) {
      const text = LONG_FILLERS[key];
      if (text === undefined) problems.push(`${c.id}: no filler ${key}`);
      else fillers[key] = text;
    }
    let resolved: ControlRecord;
    try {
      resolved = resolveRecord(c.record, fillers);
    } catch (err) {
      problems.push(`${c.id}: ${(err as Error).message}`);
      continue;
    }
    const e = controlEvidence(resolved);
    const all = e.sections.map((x) => x.text).join('\n');
    for (const a of c.anchors) if (!all.includes(a)) problems.push(`${c.id}: the anchor "${a.slice(0, 40)}" is not in the record`);
    if (c.anchorParts) {
      const plan = planChunks(e);
      if (plan.chunks.length < 2) problems.push(`${c.id}: a long record must be judged in parts (${plan.tokens} tokens make ${plan.chunks.length} part)`);
      c.anchors.forEach((a, k) => {
        const part = plan.chunks.findIndex((pieces) => pieces.some((p) => (e.sections.find((x) => x.alias === p.alias)?.text.slice(p.start, p.end) ?? '').includes(a)));
        if (part + 1 !== c.anchorParts?.[k]) problems.push(`${c.id}: the anchor "${a.slice(0, 40)}" is in part ${part + 1}, not ${c.anchorParts?.[k]}`);
      });
    }
    const existing = records[c.record.ntsbNo];
    if (existing && JSON.stringify(existing) !== JSON.stringify(c.record)) problems.push(`${c.id}: case number ${c.record.ntsbNo} names two different records`);
    records[c.record.ntsbNo] = c.record;
    judged[spec.id] = { question: spec.question, rubric: spec.rubric, questionVersion: questionVersion(spec), rubricVersion: rubricVersion(spec.rubric) };
    const kind = c.kind ?? 'relevance';
    let bundle: ControlBundle | null = null;
    let fp = fingerprint(e);
    if (kind === 'answerability') {
      if (!c.bundle || c.bundle.length === 0) {
        problems.push(`${c.id}: an answerability control needs a bundle`);
        continue;
      }
      let passages: DeliveredPassage[];
      try {
        passages = bundlePassages(e, c.bundle);
      } catch (err) {
        problems.push(`${c.id}: ${(err as Error).message}`);
        continue;
      }
      const frozen = passages.map((p) => ({ passageId: p.passageId, section: e.sections.find((x) => x.sectionId === p.sectionId)?.alias as string, start: p.start, end: p.end, textSha256: sha256(p.text) }));
      bundle = { key: bundleKeyOf(frozen), passages: frozen };
      fp = bundleFingerprint(e.ntsbNo, e.event, e.aircraft, passages);
    }
    items.push({
      id: `nc-${c.id}`,
      set: 'narrative-control',
      kind,
      bundle,
      split: CONTROL_HOLDOUT_GROUPS.includes(controlGroup(c.id)) ? 'holdout' : 'dev',
      tags: [c.family, `reading:${c.reading}`],
      question: spec.id,
      questionVersion: questionVersion(spec),
      rubricVersion: rubricVersion(spec.rubric),
      case: { ntsbNo: c.record.ntsbNo, source: 'synthetic', fingerprint: fp },
      label: c.label,
      provenance: 'constructed',
      mutation: c.mutation,
      anchors: c.anchors,
      why: c.note,
    });
  }
  const ids = new Set<string>();
  for (const i of items) {
    if (ids.has(i.id)) problems.push(`duplicate item ${i.id}`);
    ids.add(i.id);
  }
  const min = CALIBRATION_CRITERIA.perFamily.minItems;
  for (const family of CONTROL_FAMILIES) {
    for (const split of ['dev', 'holdout'] as const) {
      const mine = items.filter((i) => i.set === 'narrative-control' && i.tags.includes(family) && i.split === split);
      if (mine.length === 0) problems.push(`no ${split} control of family ${family}`);
      if (new Set(mine.map((i) => i.label)).size < 3) problems.push(`the ${split} controls of family ${family} do not cover every grade`);
      if (split === 'holdout' && mine.length < min) problems.push(`family ${family} has ${mine.length} holdout controls (at least ${min})`);
    }
  }
  const crHoldout = items.filter((i) => i.set === 'code-reading' && i.split === 'holdout').length;
  if (draws.length > 0 && crHoldout < min) problems.push(`the code-reading set has ${crHoldout} holdout items (at least ${min})`);
  const byGrade = { '0': 0, '1': 0, '2': 0 };
  for (const i of items) byGrade[String(i.label) as '0' | '1' | '2'] += 1;
  const dataset: CalibrationDataset = {
    version: CALIBRATION_VERSION,
    note: CALIBRATION_NOTE,
    source: {
      generationId: source.generationId,
      archiveSha256: source.archiveSha256,
      mappingVersion: source.mappingVersion,
      fieldNormalizationVersion: source.fieldNormalizationVersion,
      citationTextVersion: source.citationTextVersion,
    },
    labels: { sha256: labelsSha256(items), items: items.length, byGrade },
    questions: Object.fromEntries(Object.entries(judged).sort(([a], [b]) => (a < b ? -1 : 1))),
    items,
    records,
    fillers: Object.fromEntries(Object.entries(fillers).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  const parsed = CalibrationDatasetSchema.safeParse(dataset);
  if (!parsed.success) problems.push(...parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`));
  return { dataset, problems: [...new Set(problems)] };
}

/** The frozen label hash: every item's identity (with its bundle when it is an answerability item), label and provenance. */
export const labelsSha256 = (items: readonly CalibrationItem[]): string =>
  sha256(
    canonicalJson(
      items.map((i) => ({
        id: i.id,
        set: i.set,
        split: i.split,
        question: i.questionVersion,
        rubric: i.rubricVersion,
        case: i.case,
        ...(i.kind === 'answerability' ? { kind: i.kind, bundle: i.bundle?.key ?? null } : {}),
        label: i.label,
        provenance: i.provenance,
      })),
    ),
  );

/** The reporting family of an item: its control family, or `code-reading`. */
export const itemFamily = (i: Pick<CalibrationItem, 'set' | 'tags'>): string => (i.set === 'code-reading' ? 'code-reading' : (i.tags[0] as string));

/** The key that joins an item with its judgment record: kind, question, case and bundle. */
export const itemKey = (i: Pick<CalibrationItem, 'kind' | 'question' | 'case' | 'bundle'>): string => `${i.kind}|${i.question}|${i.case.ntsbNo}|${i.bundle?.key ?? ''}`;

/** Problems with a committed calibration file: its label hash and counts. */
export function calibrationProblems(d: CalibrationDataset): string[] {
  const problems: string[] = [];
  if (d.labels.sha256 !== labelsSha256(d.items)) problems.push('labels: the label hash does not match the items (labels changed after freezing)');
  if (d.labels.items !== d.items.length) problems.push('labels: the item count does not match');
  for (const i of d.items) {
    if (i.case.source === 'synthetic' && !d.records[i.case.ntsbNo]) problems.push(`${i.id}: its synthetic record is missing`);
    const q = d.questions[i.question];
    if (!q) problems.push(`${i.id}: unknown question ${i.question}`);
    else if (q.questionVersion !== i.questionVersion || q.rubricVersion !== i.rubricVersion || q.rubricVersion !== rubricVersion(q.rubric)) problems.push(`${i.id}: question or rubric version differs`);
  }
  return problems;
}

/** Track C questions by id, from the coded dataset. */
export const codedQuestions = (d: CodedDataset): Map<string, CodedItem> => new Map(d.questions.map((q) => [q.id, q]));
