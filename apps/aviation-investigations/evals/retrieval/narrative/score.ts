/**
 * Track N metrics and diagnostics (task 10c protocol v4, section 5). Every score here is
 * **model-judged**; none is expert-adjudicated.
 *
 * **References.** A family's judged labels (`relevanceLabels`) become a `Reference` of the
 * protocol metric module (`metrics.ts`): a bounded cohort lists every cohort case (a
 * case without a judgment is `unknown`), cases outside it are outside the filters (0),
 * and it is exhaustive, so Recall@20 is a gate metric exactly when the cohort holds no
 * unknown and 1 to 20 fully relevant cases; a broad question lists its pool and leaves
 * every other case `unknown` (not exhaustive). Unknown cases keep their ranks and stay in
 * every denominator.
 *
 * **Per run** (member, method, scope sample): Recall@20 on the ranking, strict P@6 and
 * nDCG@6 (gains 0/1/3, ideal from the versioned judgments, bounds over the unknowns by
 * enumeration or the sound relaxation) on the delivered bundle, and **supported P@6**:
 * bundle cases that are fully relevant on the complete record *and* whose delivered
 * passages establish it (bundle answerability 2), over 6, with exact bounds (a case with
 * an unknown in either judgment counts in the upper bound only). Per question the value
 * is the mean over the scope samples, as in phase A.
 *
 * **Comparisons.** Paired group bootstrap by connected case group (`stats.ts`), on the
 * lower and the upper bounds separately.
 *
 * **Diagnostics.** Discovery as depth grows; method-exclusive relevant cases; the tail
 * samples' relevant share with Wilson intervals scaled to their strata (coverage, never a
 * bound); judge-judge Cohen's kappa (unweighted and linear-weighted) with group-bootstrap
 * intervals, agreement with Wilson intervals and confusion matrices, per tag and per
 * grade; judge-adjudicator agreement; calibration accuracy against the frozen labels;
 * and candidate code-narrative discrepancies (logged, never applied to any label).
 */
import { makeReference, scoreQuestion, uniqueTop, type Bounds, type Label, type ProtocolScore, type Reference } from '../metrics.js';
import { mulberry32, pairedGroupBootstrap, percentile, type BootstrapResult } from '../experiments/stats.js';
import type { CalibrationItem } from './calibration.js';
import type { NarrativeDataset } from './dataset.js';
import type { PairRecord } from './judging.js';
import { bundleKeyOf } from './judging.js';
import type { FamilyPool, PoolRun } from './pool.js';
import { GRADES, REFERENCE, type Grade } from './spec.js';

export { REFERENCE };

// ---------------------------------------------------------------------------
// Labels and references

/** The relevance label of every judged case, per family. */
export function relevanceLabels(records: readonly PairRecord[]): Map<string, Map<string, Label>> {
  const out = new Map<string, Map<string, Label>>();
  for (const r of records) {
    if (r.kind !== 'relevance') continue;
    const m = out.get(r.family) ?? new Map<string, Label>();
    m.set(r.ntsbNo, r.label);
    out.set(r.family, m);
  }
  return out;
}

/** The answerability label of every judged delivered case, per family, by `ntsbNo|bundleKey`. */
export function answerabilityLabels(records: readonly PairRecord[]): Map<string, Map<string, Label>> {
  const out = new Map<string, Map<string, Label>>();
  for (const r of records) {
    if (r.kind !== 'answerability' || r.bundleKey === null) continue;
    const m = out.get(r.family) ?? new Map<string, Label>();
    m.set(`${r.ntsbNo}|${r.bundleKey}`, r.label);
    out.set(r.family, m);
  }
  return out;
}

/** A family's reference (module comment). */
export function familyReference(pool: Pick<FamilyPool, 'type' | 'cases'> & { cohort?: readonly string[] | null }, labels: ReadonlyMap<string, Label>): Reference {
  if (pool.type === 'bounded-cohort') {
    const cohort = pool.cohort ?? pool.cases.map((c) => c.ntsbNo);
    return makeReference(
      cohort.map((n) => [n, labels.get(n) ?? 'unknown'] as const),
      { unlisted: 0, exhaustive: true },
    );
  }
  return makeReference(
    pool.cases.map((c) => [c.ntsbNo, labels.get(c.ntsbNo) ?? 'unknown'] as const),
    { unlisted: 'unknown', exhaustive: false },
  );
}

// ---------------------------------------------------------------------------
// Runs

export interface RunScore {
  member: string;
  method: string;
  sample: number;
  protocol: ProtocolScore;
  /** Supported P@6 (module comment). */
  supported: Bounds;
}

/** Strict supported P@6 of one bundle with exact bounds. */
export function supportedAt6(bundle: PoolRun['bundle'], relevance: (n: string) => Label, answerable: (n: string, key: string) => Label): Bounds {
  let lower = 0;
  let upper = 0;
  for (const b of bundle.slice(0, 6)) {
    const r = relevance(b.ntsbNo);
    const a = answerable(b.ntsbNo, bundleKeyOf(b.passages));
    if (r === 2 && a === 2) lower += 1;
    if ((r === 2 || r === 'unknown') && (a === 2 || a === 'unknown')) upper += 1;
  }
  return { lower: lower / 6, upper: upper / 6 };
}

export function scoreRuns(pool: FamilyPool, ref: Reference, answerability: ReadonlyMap<string, Label>): RunScore[] {
  const label = (n: string): Label => ref.labels.get(n) ?? ref.unlisted;
  return pool.runs.map((run) => ({
    member: run.member,
    method: run.method,
    sample: run.sample,
    protocol: scoreQuestion(run.ranking, run.bundle.map((b) => b.ntsbNo), ref),
    supported: supportedAt6(run.bundle, label, (n, key) => answerability.get(`${n}|${key}`) ?? 'unknown'),
  }));
}

export interface QuestionValue {
  member: string;
  family: string;
  method: string;
  /** Mean over samples; null unless the question is eligible for the recall gate. */
  recallGate: number | null;
  recallDiagnostic: number | null;
  p6: Bounds;
  /** Null when the question abstains under every assignment. */
  ndcg6: Bounds | null;
  supported: Bounds;
}

const meanOf = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const meanBounds = (bs: readonly Bounds[]): Bounds => ({ lower: meanOf(bs.map((b) => b.lower)), upper: meanOf(bs.map((b) => b.upper)) });

/** Each member's value per method: the mean of its scope samples. */
export function questionValues(pool: FamilyPool, runs: readonly RunScore[]): QuestionValue[] {
  const out: QuestionValue[] = [];
  for (const member of pool.members) {
    for (const method of [...new Set(runs.map((r) => r.method))]) {
      const mine = runs.filter((r) => r.member === member && r.method === method);
      if (mine.length === 0) continue;
      const recalls = mine.map((r) => r.protocol.recall);
      const eligible = recalls.every((r) => r.gate === 'eligible' && r.value !== null);
      const ndcgs = mine.map((r) => r.protocol.ndcg.bounds);
      out.push({
        member,
        family: pool.family,
        method,
        recallGate: eligible ? meanOf(recalls.map((r) => r.value as number)) : null,
        recallDiagnostic: recalls.every((r) => r.value !== null) ? meanOf(recalls.map((r) => r.value as number)) : null,
        p6: meanBounds(mine.map((r) => r.protocol.precision.strict)),
        ndcg6: ndcgs.every((b): b is Bounds => b !== null) ? meanBounds(ndcgs as Bounds[]) : null,
        supported: meanBounds(mine.map((r) => r.supported)),
      });
    }
  }
  return out;
}

/** Paired group bootstrap of method `b` minus method `a`, on the lower and the upper bounds. */
export function compareMethods(
  values: readonly QuestionValue[],
  groupOf: (member: string) => string,
  a: string,
  b: string,
  metric: 'p6' | 'ndcg6' | 'supported' | 'recallGate',
  boot: { resamples: number; seed: number },
): { lower: BootstrapResult | null; upper: BootstrapResult | null } {
  const pairs: { id: string; group: string; base: Bounds; variant: Bounds }[] = [];
  for (const va of values.filter((v) => v.method === a)) {
    const vb = values.find((v) => v.method === b && v.member === va.member);
    if (!vb) continue;
    const pick = (v: QuestionValue): Bounds | null => (metric === 'recallGate' ? (v.recallGate === null ? null : { lower: v.recallGate, upper: v.recallGate }) : v[metric]);
    const x = pick(va);
    const y = pick(vb);
    if (x && y) pairs.push({ id: va.member, group: groupOf(va.member), base: x, variant: y });
  }
  if (pairs.length === 0) return { lower: null, upper: null };
  const run = (side: 'lower' | 'upper') => pairedGroupBootstrap(pairs.map((p) => ({ id: p.id, group: p.group, base: p.base[side], variant: p.variant[side] })), boot.resamples, boot.seed);
  return { lower: run('lower'), upper: run('upper') };
}

/** Connected groups of questions: a family with its paraphrases, joined with any family sharing a fully relevant case. */
export function questionGroups(d: NarrativeDataset, labels: ReadonlyMap<string, ReadonlyMap<string, Label>>): Map<string, string> {
  const parent = new Map(d.questions.map((q) => [q.family, q.family]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    return r;
  };
  const owner = new Map<string, string>();
  for (const [family, m] of [...labels.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const [n, l] of m) {
      if (l !== 2) continue;
      const o = owner.get(n);
      if (o === undefined) owner.set(n, family);
      else if (find(o) !== find(family)) parent.set(find(family), find(o));
    }
  }
  return new Map(d.questions.map((q) => [q.id, find(q.family)]));
}

// ---------------------------------------------------------------------------
// Pool diagnostics

/** Fully relevant cases found by the union of the methods' first `d` cases, and how many each depth adds. */
export function discoveryByDepth(pool: FamilyPool, labels: ReadonlyMap<string, Label>, depths: readonly number[] = [10, 20, 30, 50, 75, 100]): { depth: number; relevant: number; added: number }[] {
  let previous = 0;
  return depths.map((depth) => {
    const found = new Set<string>();
    for (const run of pool.runs) for (const n of uniqueTop(run.ranking, depth)) if (labels.get(n) === 2) found.add(n);
    const added = found.size - previous;
    previous = found.size;
    return { depth, relevant: found.size, added };
  });
}

/** Fully relevant cases only one method retrieved within `depth` (any member and sample). */
export function methodExclusive(pool: FamilyPool, labels: ReadonlyMap<string, Label>, depth = 100): Record<string, string[]> {
  const by = new Map<string, Set<string>>();
  for (const run of pool.runs) for (const n of uniqueTop(run.ranking, depth)) if (labels.get(n) === 2) by.set(n, (by.get(n) ?? new Set()).add(run.method));
  const out: Record<string, string[]> = {};
  for (const [n, methods] of by) {
    if (methods.size !== 1) continue;
    const m = [...methods][0] as string;
    out[m] = [...(out[m] ?? []), n].sort();
  }
  return out;
}

export interface Rate {
  k: number;
  n: number;
  rate: number | null;
  lower: number | null;
  upper: number | null;
}

/** Wilson 95% interval of `k` of `n`. */
export function wilson(k: number, n: number, z = 1.96): Rate {
  if (n === 0) return { k, n, rate: null, lower: null, upper: null };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { k, n, rate: p, lower: Math.max(0, c - h), upper: Math.min(1, c + h) };
}

/** The tail samples' relevant share, scaled to their strata (a coverage diagnostic; unknown samples are reported, not guessed). */
export function tailEstimate(pool: FamilyPool, labels: ReadonlyMap<string, Label>): { stratum: 'near' | 'far'; size: number; sampled: number; unknown: number; relevant: Rate; estimatedMissed: [number, number] | null }[] {
  return (['near', 'far'] as const).map((stratum) => {
    const sample = pool.tail[stratum];
    const size = stratum === 'near' ? pool.tail.nearSize : pool.tail.farSize;
    const known = sample.filter((n) => labels.get(n) !== undefined && labels.get(n) !== 'unknown');
    const relevant = wilson(known.filter((n) => labels.get(n) === 2).length, known.length);
    return {
      stratum,
      size,
      sampled: sample.length,
      unknown: sample.length - known.length,
      relevant,
      estimatedMissed: relevant.lower === null || relevant.upper === null ? null : [Math.round(relevant.lower * size), Math.round(relevant.upper * size)],
    };
  });
}

// ---------------------------------------------------------------------------
// Agreement

export type Confusion = number[][];

const emptyConfusion = (): Confusion => GRADES.map(() => GRADES.map(() => 0));

/** Cohen's kappa over grade pairs: unweighted and linear-weighted (ordinal 0/1/2). Null when undefined. */
export function cohenKappa(pairs: readonly (readonly [Grade, Grade])[]): { kappa: number | null; weighted: number | null } {
  const n = pairs.length;
  if (n === 0) return { kappa: null, weighted: null };
  const m = emptyConfusion();
  for (const [a, b] of pairs) (m[a] as number[])[b] = ((m[a] as number[])[b] as number) + 1;
  const row = m.map((r) => r.reduce((x, y) => x + y, 0) / n);
  const col = GRADES.map((_, j) => m.reduce((x, r) => x + (r[j] as number), 0) / n);
  let po = 0;
  let pe = 0;
  let wo = 0;
  let we = 0;
  for (const i of GRADES) {
    for (const j of GRADES) {
      const obs = ((m[i] as number[])[j] as number) / n;
      const exp = (row[i] as number) * (col[j] as number);
      const w = 1 - Math.abs(i - j) / 2;
      if (i === j) {
        po += obs;
        pe += exp;
      }
      wo += w * obs;
      we += w * exp;
    }
  }
  return { kappa: pe === 1 ? null : (po - pe) / (1 - pe), weighted: we === 1 ? null : (wo - we) / (1 - we) };
}

/** Investigation thresholds (protocol section 3): below either, the tag's judged scores are low-confidence and the cause is investigated. Never a validation claim above them. */
export const INVESTIGATION_THRESHOLDS = Object.freeze({ kappa: 0.7, agreement: 0.8 });

export interface AgreementCell {
  n: number;
  /** Kappa below 0.7 or agreement below 0.8 (or either undefined): the scores of this cell are low-confidence. */
  lowConfidence: boolean;
  agreement: Rate;
  kappa: number | null;
  weightedKappa: number | null;
  /** 95% group-bootstrap interval of the unweighted kappa (resampling question families). */
  kappaInterval: [number, number] | null;
  /** Rows: judge A's grade; columns: judge B's grade. */
  confusion: Confusion;
}

function agreementCell(pairs: readonly { group: string; a: Grade; b: Grade }[], boot: { resamples: number; seed: number }): AgreementCell {
  const m = emptyConfusion();
  for (const p of pairs) (m[p.a] as number[])[p.b] = ((m[p.a] as number[])[p.b] as number) + 1;
  const k = cohenKappa(pairs.map((p) => [p.a, p.b] as const));
  let interval: [number, number] | null = null;
  const groups = [...new Set(pairs.map((p) => p.group))].sort();
  if (groups.length >= 2 && k.kappa !== null) {
    const byGroup = new Map(groups.map((g) => [g, pairs.filter((p) => p.group === g)]));
    const rand = mulberry32(boot.seed);
    const stats: number[] = [];
    for (let i = 0; i < boot.resamples; i += 1) {
      const sample: (readonly [Grade, Grade])[] = [];
      for (let j = 0; j < groups.length; j += 1) for (const p of byGroup.get(groups[Math.floor(rand() * groups.length)] as string) as typeof pairs) sample.push([p.a, p.b]);
      const s = cohenKappa(sample).kappa;
      if (s !== null) stats.push(s);
    }
    stats.sort((x, y) => x - y);
    if (stats.length > 0) interval = [percentile(stats, 0.025), percentile(stats, 0.975)];
  }
  const agreement = wilson(pairs.filter((p) => p.a === p.b).length, pairs.length);
  const lowConfidence = k.kappa === null || agreement.rate === null || k.kappa < INVESTIGATION_THRESHOLDS.kappa || agreement.rate < INVESTIGATION_THRESHOLDS.agreement;
  return { n: pairs.length, lowConfidence, agreement, kappa: k.kappa, weightedKappa: k.weighted, kappaInterval: interval, confusion: m };
}

export interface AgreementReport {
  /** Pairs where both judges gave a valid grade. */
  judgeJudge: { all: AgreementCell; byTag: Record<string, AgreementCell>; byGrade: Record<string, AgreementCell> };
  /** Adjudicated pairs: the adjudicator's final grade against each judge, and against its own blind first grade; overall and per tag. */
  judgeAdjudicator: JudgeAdjudicator & { byTag: Record<string, JudgeAdjudicator> };
  statuses: Record<string, number>;
}

export interface JudgeAdjudicator {
  adjudicated: number;
  withA: Rate;
  withB: Rate;
  changedFromInitial: Rate;
  abstained: number;
}

function judgeAdjudicator(records: readonly PairRecord[]): JudgeAdjudicator {
  const adjudicated = records.filter((r) => r.adjudication !== null && (r.status === 'adjudicated' || r.status === 'abstained'));
  const final = adjudicated.filter((r) => r.status === 'adjudicated');
  const agreeWith = (i: 0 | 1) => {
    const usable = final.filter((r) => r.judges[i]?.grade !== null && r.judges[i]?.grade !== undefined);
    return wilson(usable.filter((r) => r.judges[i]?.grade === r.label).length, usable.length);
  };
  return {
    adjudicated: adjudicated.length,
    withA: agreeWith(0),
    withB: agreeWith(1),
    changedFromInitial: wilson(final.filter((r) => r.adjudication?.initial !== null && r.adjudication?.initial !== r.label).length, final.filter((r) => r.adjudication?.initial !== null).length),
    abstained: adjudicated.length - final.length,
  };
}

/** The agreement diagnostics of a set of pair records (protocol section 3: diagnostics, never validation). */
export function agreementReport(records: readonly PairRecord[], tagsOf: (family: string) => readonly string[], boot = { resamples: 2_000, seed: 20261023 }): AgreementReport {
  const pairs = records.flatMap((r) => {
    const [a, b] = r.judges;
    return a?.grade !== null && a?.grade !== undefined && b?.grade !== null && b?.grade !== undefined ? [{ r, group: r.family, a: a.grade, b: b.grade }] : [];
  });
  const byTag: Record<string, AgreementCell> = {};
  for (const tag of [...new Set(records.flatMap((r) => tagsOf(r.family)))].sort()) byTag[tag] = agreementCell(pairs.filter((p) => tagsOf(p.r.family).includes(tag)), boot);
  const byGrade: Record<string, AgreementCell> = {};
  for (const g of [...GRADES.map(String), 'unknown']) byGrade[g] = agreementCell(pairs.filter((p) => String(p.r.label) === g), boot);
  const statuses: Record<string, number> = {};
  for (const r of records) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  const adjByTag: Record<string, JudgeAdjudicator> = {};
  for (const tag of Object.keys(byTag)) adjByTag[tag] = judgeAdjudicator(records.filter((r) => tagsOf(r.family).includes(tag)));
  return { judgeJudge: { all: agreementCell(pairs, boot), byTag, byGrade }, judgeAdjudicator: { ...judgeAdjudicator(records), byTag: adjByTag }, statuses };
}

// ---------------------------------------------------------------------------
// Calibration and discrepancies

export interface CalibrationCell {
  /** Items whose final label is known. */
  n: number;
  /** Final labels equal to the constructed labels. */
  accuracy: Rate;
  /** Each judge's valid grades against the labels. */
  judgeA: Rate;
  judgeB: Rate;
  /** Rows: constructed label; columns: final label (unknown in column 3). */
  confusion: number[][];
  unknown: number;
}

function calibrationCell(rows: readonly { item: CalibrationItem; r: PairRecord }[]): CalibrationCell {
  const confusion = GRADES.map(() => [0, 0, 0, 0]);
  for (const { item, r } of rows) (confusion[item.label] as number[])[r.label === 'unknown' ? 3 : r.label] = ((confusion[item.label] as number[])[r.label === 'unknown' ? 3 : r.label] as number) + 1;
  const known = rows.filter(({ r }) => r.label !== 'unknown');
  const judge = (i: 0 | 1) => {
    const usable = rows.filter(({ r }) => r.judges[i]?.grade !== null && r.judges[i]?.grade !== undefined);
    return wilson(usable.filter(({ item, r }) => r.judges[i]?.grade === item.label).length, usable.length);
  };
  return { n: known.length, accuracy: wilson(known.filter(({ item, r }) => r.label === item.label).length, known.length), judgeA: judge(0), judgeB: judge(1), confusion, unknown: rows.length - known.length };
}

/** Calibration figures per set, tag and constructed grade (diagnostics; labels are constructed, never expert). */
export function calibrationReport(items: readonly CalibrationItem[], records: readonly PairRecord[]): { bySet: Record<string, CalibrationCell>; byTag: Record<string, CalibrationCell>; byGrade: Record<string, CalibrationCell>; missing: string[] } {
  const byCase = new Map(records.map((r) => [`${r.family}|${r.ntsbNo}`, r]));
  const rows: { item: CalibrationItem; r: PairRecord }[] = [];
  const missing: string[] = [];
  for (const item of items) {
    const r = byCase.get(`${item.question}|${item.case.ntsbNo}`);
    if (r) rows.push({ item, r });
    else missing.push(item.id);
  }
  const group = (key: (i: CalibrationItem) => string[]) => {
    const out: Record<string, CalibrationCell> = {};
    for (const k of [...new Set(rows.flatMap(({ item }) => key(item)))].sort()) out[k] = calibrationCell(rows.filter(({ item }) => key(item).includes(k)));
    return out;
  };
  return { bySet: group((i) => [`${i.set}/${i.split}`]), byTag: group((i) => i.tags), byGrade: group((i) => [String(i.label)]), missing };
}

export interface Discrepancy {
  family: string;
  ntsbNo: string;
  /** `coded-not-relevant`: a related-code positive judged 0; `relevant-not-coded`: judged 2 without the related code. */
  kind: 'coded-not-relevant' | 'relevant-not-coded';
  label: Grade;
}

/** Candidate code-narrative discrepancies of the families with related codes: logged, never applied. */
export function discrepancies(d: NarrativeDataset, records: readonly PairRecord[]): Discrepancy[] {
  const out: Discrepancy[] = [];
  const positives = new Map(d.questions.filter((q) => q.relatedCodes !== undefined && q.paraphrase_of === undefined).map((q) => [q.family, new Set(q.relatedPositives)]));
  for (const r of records) {
    if (r.kind !== 'relevance' || r.label === 'unknown') continue;
    const coded = positives.get(r.family);
    if (!coded) continue;
    if (coded.has(r.ntsbNo) && r.label === 0) out.push({ family: r.family, ntsbNo: r.ntsbNo, kind: 'coded-not-relevant', label: r.label });
    if (!coded.has(r.ntsbNo) && r.label === 2) out.push({ family: r.family, ntsbNo: r.ntsbNo, kind: 'relevant-not-coded', label: r.label });
  }
  return out.sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : a.ntsbNo < b.ntsbNo ? -1 : 1));
}
