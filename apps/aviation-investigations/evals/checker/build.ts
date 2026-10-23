/**
 * `pnpm eval:checker build [--check]`: the checker calibration sets, built
 * deterministically from the frozen evidence and the authored items (`items/`). Every
 * check input is rendered by the production code: claim batches through `checkCases`,
 * `checkPassages` and `checkForModel`; complete briefs through `validateComposition`,
 * `compositionFromModel`, the criteria (`evaluateCase`, the timing rules), `checkInput`,
 * `displayPlan` and `checkForModel`, exactly as the brief pipeline renders them. A brief's
 * error variant must change exactly one rendered claim, which becomes its known error; a
 * mixed-error variant applies several of them at once.
 *
 * Two datasets:
 * - `dataset.json` (`checker-cal-v1`, Task 16c): frozen. The 16c runs judged its inputs;
 *   `--check` verifies its label hash and keeps it byte-for-byte. `v1Plans` rebuilds the
 *   display plan of each of its briefs with the production code, after checking that the
 *   rebuilt claims are the frozen ones, so the offline simulation projects the 16c
 *   recordings exactly as production would.
 * - `dataset.v2.json` (`checker-cal-v2`, Task 16d): the 16c items (both 16c splits now
 *   development) rendered by the 16d code (case headers, no criteria, `chronology-rules-v2`),
 *   with labels v2 (`labels.v2.ts`), the 16d development additions and the 16d held-out
 *   set. Each brief batch carries its display plan, each batch its cluster (the source
 *   bundle). `labels.sha256` hashes every claim with its label, per split too, and
 *   `--check` refuses any difference from the committed file (exit 1).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CheckInputSchema, MAX_CHECK_CLAIMS, type CheckInput } from '../../server/ai/provider.js';
import { checkForModel, citationsFromModel, compositionFromModel, passageAliases, type PassageAliases } from '../../server/briefs/aliases.js';
import type { ReadingState } from '../../server/briefs/clarify.js';
import { CHRONOLOGY_RULES_VERSION, evaluateCase, type CriterionCheck } from '../../server/briefs/criteria.js';
import { DISPLAY_RULES_VERSION, type DisplayPlan } from '../../server/briefs/display.js';
import { caseEvidence, checkCases, checkInput, checkPassages, displayPlan, type ClaimMeta, type VerifiedCase } from '../../server/briefs/render.js';
import { validateComposition, type AllowedPassage, type Allowlist } from '../../server/briefs/validate.js';
import { APP_DIR } from '../../worker/config.js';
import type { ComposeOutput } from '../../shared/contracts/briefs.js';
import { EvidenceFileSchema, EvidenceV2FileSchema, evidenceProblems, sha256, verifiedCases, type EvidenceBundle, type EvidenceFile, type EvidenceV2File } from './evidence.js';
import { BRIEFS, CLAIM_BATCHES, V2_BRIEFS, V2_CLAIM_BATCHES, V2_MAX_SIZE } from './items/index.js';
import { BRIEF_LABELS_V2, CLAIM_LABELS_V2, LABELS_V2_VERSION } from './labels.v2.js';
import { QUESTIONS, QUESTIONS_16D } from './questions.js';
import type { BriefCategory, BriefClaimLabel, BriefSpec, ClaimBatch, Family, Label, Provenance } from './types.js';
import { FAMILIES, MUTATIONS } from './types.js';

export const DATASET_PATH = resolve(APP_DIR, 'evals/checker/dataset.json');
export const DATASET_V2_PATH = resolve(APP_DIR, 'evals/checker/dataset.v2.json');
export const EVIDENCE_PATH = resolve(APP_DIR, 'evals/checker/evidence.json');
export const EVIDENCE_V2_PATH = resolve(APP_DIR, 'evals/checker/evidence-16d.json');

/** One claim's label in the dataset, by its server-issued id. */
export interface LabelledClaim {
  claim: string;
  item: string;
  kind: string;
  case: string | null;
  label: Label;
  expect?: 'contradicted' | 'not_established';
  provenance: Provenance;
  family: Family;
  mutation?: string;
  critical?: boolean;
  source?: string;
  paidIndex?: number;
  /** A criterion claim's criterion and server decision (`judgeCheck` records a contradicted `unknown` as `chronology_missed`). */
  criterion?: 'timing_window' | 'first_flight_only' | 'failure_type';
  decision?: 'matches' | 'does_not_match' | 'unknown';
  /** The claim's stable key (`ClaimMeta.key`; v2 briefs). */
  key?: string;
  /** Why a label differs from the brief as authored, or was corrected (labels v2). */
  reason?: string;
}

/** One check call of the calibration: the input exactly as the checker reads it, and the labels. */
export interface CalibrationBatch {
  id: string;
  split: 'dev' | 'holdout';
  kind: 'claims' | 'brief';
  /** v1: `supported` or `one_error`; v2: `BriefCategory`. */
  brief?: BriefCategory;
  bundle: string;
  input: CheckInput;
  labels: LabelledClaim[];
  /** v2: the display plan the projection reads (`displayPlan`; a claim batch's claims are independent). */
  plan?: DisplayPlan;
  /** v2: the brief spec it comes from (its variants share it). */
  base?: string;
  /** v2: built to the maximum claim count (latency and caps at the largest inputs). */
  maxSize?: boolean;
}

export interface CalibrationDataset {
  version: 'checker-cal-v1' | 'checker-cal-v2';
  note: string;
  chronologyRules: string;
  displayRules?: string;
  evidenceSha256: string;
  /** v2: the 16d evidence file's sha256 (headers and held-out bundles). */
  evidenceV2Sha256?: string;
  labels: {
    sha256: string;
    claims: number;
    supported: number;
    notSupported: number;
    unknown: number;
    version?: string;
    /** v2: the hash and counts of each split's labels (the held-out split freezes on its own). */
    splits?: Record<'dev' | 'holdout', { sha256: string; claims: number; supported: number; notSupported: number; unknown: number }>;
  };
  batches: CalibrationBatch[];
}

/** The planner's default reading of "shortly" (30 calendar days or 10 flight hours). */
const DEFAULT_READINGS: ReadingState = { timingWindow: { value: { days: 30, flightHours: 10 }, pinned: false } };

export class BuildError extends Error {}

const mutationOf = (family: Family, mutation: string | undefined): boolean =>
  family !== 'control' && mutation !== undefined && (MUTATIONS[family] as readonly string[]).includes(mutation);

function aliasesOf(cases: readonly VerifiedCase[]): PassageAliases {
  return passageAliases(cases);
}

/** A claim batch's plan: independent claims (no summary, no case readings). */
function claimsPlan(input: CheckInput): DisplayPlan {
  return {
    rules: DISPLAY_RULES_VERSION,
    shape: 'claims',
    grouping: null,
    cases: [],
    sentences: [],
    claims: input.claims.map((c) => ({ key: `claims.${c.id}`, kind: c.kind, cases: c.ntsbNo ? [c.ntsbNo] : [] })),
  };
}

type Inputs = 'v1' | 'v2';
const applies = (inputs: BriefClaimLabel['inputs'], at: Inputs) => (inputs ?? 'both') === 'both' || inputs === at;

function claimBatch(batch: ClaimBatch, split: 'dev' | 'holdout', cases: readonly VerifiedCase[], at: Inputs): CalibrationBatch {
  const aliases = aliasesOf(cases);
  const about = new Set(batch.cases);
  for (const n of about) if (!cases.some((c) => c.ntsbNo === n)) throw new BuildError(`${batch.id}: case ${n} is not in bundle ${batch.bundle}`);
  const passages = checkPassages(cases, about);
  const caseOf = new Map(passages.map((p) => [p.passageId, p.ntsbNo]));
  const seen = new Set<string>();
  const claims: CheckInput['claims'] = batch.claims.map((item, i) => {
    if (seen.has(item.id)) throw new BuildError(`${batch.id}/${item.id}: duplicate item id`);
    seen.add(item.id);
    if (!about.has(item.case)) throw new BuildError(`${batch.id}/${item.id}: case ${item.case} is not one of the batch's cases`);
    const all = passages.filter((p) => p.ntsbNo === item.case).map((p) => p.passageId);
    const ids =
      item.cites === 'all'
        ? all
        : item.cites.map((a) => {
            const id = aliases.fromModel.get(a);
            if (!id) throw new BuildError(`${batch.id}/${item.id}: ${a} is not an alias of bundle ${batch.bundle}`);
            if (caseOf.get(id) !== item.case) throw new BuildError(`${batch.id}/${item.id}: ${a} is not a passage of ${item.case}`);
            return id;
          });
    if (item.absence && (all.length !== ids.length || all.some((id) => !ids.includes(id)))) {
      throw new BuildError(`${batch.id}/${item.id}: an absence claim cites every passage of its case`);
    }
    if (item.kind === 'criterion' && (!item.criterion || !item.decision) && item.source !== 'paid-run') {
      throw new BuildError(`${batch.id}/${item.id}: a criterion claim names its criterion and decision`);
    }
    if (item.label === 'not_supported' && (!item.expect || item.family === 'control' || !mutationOf(item.family, item.mutation))) {
      throw new BuildError(`${batch.id}/${item.id}: a not-supported claim needs its family, a mutation of that family and the expected verdict`);
    }
    if (item.label === 'supported' && item.family !== 'control') throw new BuildError(`${batch.id}/${item.id}: a supported claim is a control`);
    return { id: `C${i + 1}`, kind: item.kind, ntsbNo: item.case, text: item.text, passageIds: ids, absence: item.absence ?? false };
  });
  const input = CheckInputSchema.parse(checkForModel({ cases: checkCases(cases, about), passages, claims }, aliases));
  const corrections = CLAIM_LABELS_V2.filter((c) => c.batch === batch.id && applies(c.inputs, at));
  for (const c of corrections) if (!batch.claims.some((item) => item.id === c.item)) throw new BuildError(`labels v2: ${batch.id} has no item ${c.item}`);
  return {
    id: batch.id,
    split,
    kind: 'claims',
    bundle: batch.bundle,
    input,
    labels: batch.claims.map((item, i) => {
      const fix = corrections.find((c) => c.item === item.id);
      const base: LabelledClaim = {
        claim: `C${i + 1}`,
        item: item.id,
        kind: item.kind,
        case: item.case,
        label: item.label,
        ...(item.expect ? { expect: item.expect } : {}),
        provenance: item.provenance,
        family: item.family,
        ...(item.mutation ? { mutation: item.mutation } : {}),
        ...(item.critical ? { critical: true } : {}),
        ...(item.source ? { source: item.source } : {}),
        ...(item.paidIndex !== undefined ? { paidIndex: item.paidIndex } : {}),
        ...(item.criterion ? { criterion: item.criterion } : {}),
        ...(item.decision ? { decision: item.decision } : {}),
      };
      return fix ? relabel(base, fix) : base;
    }),
    plan: claimsPlan(input),
    base: batch.id,
  };
}

/** A label with a correction applied (labels v2), keeping the claim's identity. */
function relabel(l: LabelledClaim, fix: Omit<Pick<BriefClaimLabel, 'family' | 'mutation' | 'expect' | 'critical' | 'provenance' | 'reason'>, never> & { label: Label }): LabelledClaim {
  const { expect: _e, mutation: _m, critical: _c, ...rest } = l;
  if (fix.label === 'not_supported' && (!fix.family || !fix.expect || !mutationOf(fix.family, fix.mutation))) {
    throw new BuildError(`labels v2: ${l.item}: a not-supported label needs its family, a mutation of that family and the expected verdict`);
  }
  return {
    ...rest,
    label: fix.label,
    family: fix.label === 'not_supported' ? fix.family! : 'control',
    ...(fix.label === 'not_supported' ? { expect: fix.expect!, mutation: fix.mutation! } : {}),
    ...(fix.critical ? { critical: true } : {}),
    provenance: fix.provenance ?? 'model-reviewed',
    reason: fix.reason,
  };
}

/** A composition rendered as the pipeline renders it, or a build error naming why it would not reach the checker. */
function renderBrief(
  spec: BriefSpec,
  composition: ComposeOutput,
  cases: readonly VerifiedCase[],
  question: string,
): { input: CheckInput; meta: ClaimMeta[]; plan: DisplayPlan } {
  const aliases = aliasesOf(cases);
  const allow: Allowlist = {
    passages: new Map(cases.flatMap((c) => c.passages.map((p): [string, AllowedPassage] => [aliases.toModel.get(p.passageId)!, p.allowed]))),
    cases: new Set(cases.flatMap((c) => [c.ntsbNo, ...c.summary.aircraftNumbers])),
  };
  const checked = validateComposition(composition, allow, { mechanicalCause: spec.mechanicalCause, readerText: question });
  if (!checked.ok) throw new BuildError(`${spec.id}: the composition fails validation: ${checked.reasons.map((r) => `${r.code}@${r.path}`).join(', ')}`);
  const c = compositionFromModel(composition, aliases);
  const citations = citationsFromModel(checked.citations, aliases);
  const byCase = new Map(cases.map((vc) => [vc.ntsbNo, vc]));
  const criterionChecks = new Map<string, CriterionCheck[]>();
  for (const k of c.cases) {
    const checks = evaluateCase(spec.readings, k, spec.mechanicalCause, caseEvidence(byCase.get(k.ntsbNo)));
    const outside = checks.filter((d) => d.decision === 'does_not_match');
    if (outside.length > 0) throw new BuildError(`${spec.id}: ${k.ntsbNo} fails ${outside.map((d) => d.criterion).join(', ')} (withheld by the criteria, never checked)`);
    criterionChecks.set(k.ntsbNo, checks);
  }
  const built = checkInput(c, citations, byCase, { mechanicalCause: spec.mechanicalCause, criterionChecks });
  if (built.overflow) throw new BuildError(`${spec.id}: the claims overflow the check input`);
  if (built.input.claims.length === 0) throw new BuildError(`${spec.id}: no claims to check`);
  return { input: CheckInputSchema.parse(checkForModel(built.input, aliases)), meta: built.claims, plan: displayPlan(c, built.claims, spec.mechanicalCause) };
}

const sameClaim = (a: CheckInput['claims'][number], b: CheckInput['claims'][number]) =>
  a.kind === b.kind && a.ntsbNo === b.ntsbNo && a.text === b.text && a.absence === b.absence && a.passageIds.join(' ') === b.passageIds.join(' ');

const errorCount = (labels: readonly LabelledClaim[]) => labels.filter((l) => l.label === 'not_supported').length;

function categoryOf(labels: readonly LabelledClaim[]): BriefCategory {
  const errors = errorCount(labels);
  if (errors >= 2) return 'mixed_error';
  if (errors === 1) return 'one_error';
  return labels.some((l) => l.label === 'unknown') ? 'unresolved' : 'supported';
}

/** The labels of the brief as authored: supported, unless the spec or labels v2 says otherwise (by stable key). */
function authoredLabels(spec: BriefSpec, input: CheckInput, meta: readonly ClaimMeta[], at: Inputs): LabelledClaim[] {
  const fixes = [...(spec.labels ?? []), ...BRIEF_LABELS_V2.filter((c) => c.brief === spec.id)].filter((f) => applies(f.inputs, at));
  for (const f of fixes) if (!meta.some((m) => m.key === f.key)) throw new BuildError(`${spec.id}: no claim ${f.key} to label`);
  return input.claims.map((c, i) => {
    const m = meta[i]!;
    const base: LabelledClaim = {
      claim: c.id,
      item: `${spec.id}.${c.id}`,
      kind: c.kind,
      case: c.ntsbNo ?? null,
      label: 'supported',
      provenance: 'model-reviewed',
      family: 'control',
      key: m.key,
      ...(m.criterion ? { criterion: m.criterion } : {}),
      ...(m.decision ? { decision: m.decision } : {}),
    };
    const fix = fixes.find((f) => f.key === m.key);
    return fix ? relabel(base, fix) : base;
  });
}

function briefBatches(spec: BriefSpec, split: 'dev' | 'holdout', cases: readonly VerifiedCase[], question: string, at: Inputs): CalibrationBatch[] {
  const { input, meta, plan } = renderBrief(spec, spec.composition, cases, question);
  const labels = authoredLabels(spec, input, meta, at);
  const out: CalibrationBatch[] = [
    { id: spec.id, split, kind: 'brief', brief: categoryOf(labels), bundle: spec.bundle, input, labels, plan, base: spec.id, ...(spec.maxSize ? { maxSize: true } : {}) },
  ];
  // Each error edit, alone: exactly one rendered claim changes, and no criterion decision.
  const single = new Map<string, number>();
  const variant = (id: string, composition: ComposeOutput) => {
    const v = renderBrief(spec, composition, cases, question);
    if (v.meta.some((m, i) => m.criterion !== meta[i]?.criterion || m.decision !== meta[i]?.decision)) throw new BuildError(`${spec.id}/${id}: the edit changed a criterion decision`);
    if (v.input.claims.length !== input.claims.length) throw new BuildError(`${spec.id}/${id}: the edit changed the number of claims`);
    if (v.meta.some((m, i) => m.key !== meta[i]!.key)) throw new BuildError(`${spec.id}/${id}: the edit moved a claim`);
    return { ...v, changed: v.input.claims.map((c, i) => (sameClaim(c, input.claims[i]!) ? -1 : i)).filter((i) => i >= 0) };
  };
  const marked = (base: readonly LabelledClaim[], at: number, e: BriefSpec['errors'][number], id: string): LabelledClaim[] =>
    base.map((l, i) =>
      i === at
        ? {
            ...l,
            item: `${spec.id}.${id}.${l.claim}`,
            label: 'not_supported' as const,
            expect: e.expect,
            provenance: 'constructed' as const,
            family: e.family,
            mutation: e.mutation,
            ...(e.critical ? { critical: true } : {}),
          }
        : l,
    );
  for (const e of spec.errors) {
    if (!mutationOf(e.family, e.mutation)) throw new BuildError(`${spec.id}/${e.id}: ${e.mutation} is not a ${e.family} mutation`);
    const composition = structuredClone(spec.composition);
    e.edit(composition);
    const v = variant(e.id, composition);
    if (v.changed.length !== 1) throw new BuildError(`${spec.id}/${e.id}: the edit changed ${v.changed.length} claims, not exactly one`);
    // The edited claim is a new text: the variant's error, whatever the brief's label of the text it replaced.
    const at = v.changed[0]!;
    single.set(e.id, at);
    const varied = marked(labels, at, e, e.id);
    out.push({ id: `${spec.id}.${e.id}`, split, kind: 'brief', brief: categoryOf(varied), bundle: spec.bundle, input: v.input, labels: varied, plan: v.plan, base: spec.id });
  }
  for (const m of spec.mixed ?? []) {
    if (m.errors.length < 2) throw new BuildError(`${spec.id}/${m.id}: a mixed variant combines two or more errors`);
    const composition = structuredClone(spec.composition);
    const errors = m.errors.map((id) => {
      const e = spec.errors.find((x) => x.id === id);
      if (!e) throw new BuildError(`${spec.id}/${m.id}: no error ${id}`);
      e.edit(composition);
      return e;
    });
    const at = errors.map((e) => single.get(e.id)!);
    if (new Set(at).size !== at.length) throw new BuildError(`${spec.id}/${m.id}: two errors change the same claim`);
    const v = variant(m.id, composition);
    if (v.changed.length !== at.length || v.changed.some((i) => !at.includes(i))) throw new BuildError(`${spec.id}/${m.id}: the edits together change other claims than one each`);
    let varied = labels;
    errors.forEach((e, j) => (varied = marked(varied, at[j]!, e, m.id)));
    out.push({ id: `${spec.id}.${m.id}`, split, kind: 'brief', brief: categoryOf(varied), bundle: spec.bundle, input: v.input, labels: varied, plan: v.plan, base: spec.id });
  }
  return out;
}

/** Labels in a canonical form for the freeze hash: every claim's text and citations with its label. */
export function labelsHash(batches: readonly CalibrationBatch[]): string {
  const rows = batches.flatMap((b) =>
    b.labels.map((l) => {
      const c = b.input.claims.find((x) => x.id === l.claim)!;
      return [
        b.id,
        b.split,
        b.brief ?? null,
        l.claim,
        c.kind,
        c.ntsbNo ?? null,
        c.text,
        c.passageIds,
        c.absence,
        l.label,
        l.expect ?? null,
        l.family,
        l.mutation ?? null,
        l.provenance,
        l.critical ?? false,
      ];
    }),
  );
  return sha256(JSON.stringify(rows));
}

const labelCounts = (batches: readonly CalibrationBatch[]) => {
  const all = batches.flatMap((b) => b.labels);
  return {
    sha256: labelsHash(batches),
    claims: all.length,
    supported: all.filter((l) => l.label === 'supported').length,
    notSupported: all.filter((l) => l.label === 'not_supported').length,
    unknown: all.filter((l) => l.label === 'unknown').length,
  };
};

/** No case is judged in both splits. */
function checkSplits(batches: readonly CalibrationBatch[]): void {
  const splitOf = new Map<string, string>();
  for (const b of batches) {
    for (const p of b.input.passages) {
      const seen = splitOf.get(p.ntsbNo);
      if (seen && seen !== b.split) throw new BuildError(`case ${p.ntsbNo} is in both splits`);
      splitOf.set(p.ntsbNo, b.split);
    }
  }
  for (const l of batches.flatMap((b) => b.labels)) if (!FAMILIES.includes(l.family)) throw new BuildError(`unknown family ${l.family}`);
  const ids = batches.map((b) => b.id);
  if (new Set(ids).size !== ids.length) throw new BuildError('duplicate batch ids');
}

// ---------------------------------------------------------------------------
// v1 (Task 16c, frozen)

/** The frozen v1 dataset. */
export function readDataset(path = DATASET_PATH): CalibrationDataset {
  return JSON.parse(readFileSync(path, 'utf8')) as CalibrationDataset;
}

/** The structure of a claim as the checker saw it (its text aside, for claims the 16d rules word differently). */
const structure = (c: CheckInput['claims'][number]) => [c.id, c.kind, c.ntsbNo ?? null, c.absence, c.passageIds.join(' ')].join('|');

/**
 * The display plans of the v1 batches, rebuilt by the production code from the 16c items:
 * each rebuilt batch's claims must have the frozen claims' ids, kinds, cases, absence and
 * citations, and every text but a criterion claim's must be the same (`textChanged` lists
 * the rest). Criterion decisions in the plan are the frozen labels' (the decisions the 16c
 * checker judged), never the 16d rules'.
 */
export function v1Plans(dataset: CalibrationDataset = readDataset()): { plans: Map<string, DisplayPlan>; keys: Map<string, string[]>; textChanged: string[] } {
  const evidenceText = readFileSync(EVIDENCE_PATH, 'utf8');
  const evidence = EvidenceFileSchema.parse(JSON.parse(evidenceText));
  if (sha256(evidenceText) !== dataset.evidenceSha256) throw new BuildError('evidence.json is not the evidence the v1 dataset was built from');
  const rebuilt = buildBatches(evidence.bundles, new Map(), CLAIM_BATCHES, BRIEFS, 'v1', (b) => b.split);
  const plans = new Map<string, DisplayPlan>();
  const keys = new Map<string, string[]>();
  const textChanged: string[] = [];
  for (const frozen of dataset.batches) {
    const r = rebuilt.find((x) => x.id === frozen.id);
    if (!r || !r.plan) throw new BuildError(`v1: no rebuilt batch ${frozen.id}`);
    if (r.input.claims.length !== frozen.input.claims.length || r.input.claims.some((c, i) => structure(c) !== structure(frozen.input.claims[i]!))) {
      throw new BuildError(`v1: ${frozen.id} no longer renders the frozen claims`);
    }
    r.input.claims.forEach((c, i) => {
      if (c.text !== frozen.input.claims[i]!.text) {
        if (c.kind !== 'criterion') throw new BuildError(`v1: ${frozen.id}/${c.id} renders another text`);
        textChanged.push(`${frozen.id}/${c.id}`);
      }
    });
    const plan: DisplayPlan = {
      ...r.plan,
      claims: r.plan.claims.map((pc, i) => {
        const l = frozen.labels[i]!;
        return { ...pc, ...(l.criterion ? { criterion: l.criterion } : {}), ...(l.decision ? { decision: l.decision } : {}) };
      }),
    };
    plans.set(frozen.id, plan);
    keys.set(frozen.id, plan.claims.map((c) => c.key));
  }
  return { plans, keys, textChanged };
}

/**
 * Labels v2 applied to the v1 dataset (the 16c inputs): the corrections recorded in
 * `labels.v2.ts` for `v1` or `both`, by batch and claim key; v1 labels themselves never
 * change on disk.
 */
export function v1LabelsV2(dataset: CalibrationDataset = readDataset()): CalibrationDataset {
  const evidenceText = readFileSync(EVIDENCE_PATH, 'utf8');
  const evidence = EvidenceFileSchema.parse(JSON.parse(evidenceText));
  const rebuilt = buildBatches(evidence.bundles, new Map(), CLAIM_BATCHES, BRIEFS, 'v1', (b) => b.split);
  const batches = dataset.batches.map((frozen) => {
    const r = rebuilt.find((x) => x.id === frozen.id)!;
    const labels = frozen.labels.map((l, i) => {
      const v2 = r.labels[i]!;
      if (v2.label === l.label && v2.family === l.family && v2.mutation === l.mutation) return l;
      // A brief's error claims stay the frozen constructed errors; corrections reach the rest.
      if (l.label === 'not_supported' && l.provenance === 'constructed' && frozen.kind === 'brief') return l;
      return { ...l, label: v2.label, family: v2.family, ...(v2.expect ? { expect: v2.expect } : {}), ...(v2.mutation ? { mutation: v2.mutation } : {}), ...(v2.reason ? { reason: v2.reason } : {}) };
    });
    return { ...frozen, labels, ...(frozen.kind === 'brief' ? { brief: categoryOf(labels) } : {}) };
  });
  return { ...dataset, labels: { ...labelCounts(batches), version: LABELS_V2_VERSION }, batches };
}

// ---------------------------------------------------------------------------
// v2 (Task 16d)

/** Batches of items over bundles, rendered by the production code. */
function buildBatches(
  bundles: readonly EvidenceBundle[],
  headers: ReadonlyMap<string, string>,
  claimBatches: readonly ClaimBatch[],
  briefs: readonly BriefSpec[],
  at: Inputs,
  splitOf: (b: EvidenceBundle) => 'dev' | 'holdout',
): CalibrationBatch[] {
  const byQuestion = new Map(bundles.map((b) => [b.question, b]));
  const casesOf = (bundle: string) => {
    const b = byQuestion.get(bundle);
    if (!b) throw new BuildError(`no bundle ${bundle} in the evidence`);
    return { split: splitOf(b), cases: verifiedCases(b, headers) };
  };
  const batches: CalibrationBatch[] = [];
  for (const batch of claimBatches) {
    const { split, cases } = casesOf(batch.bundle);
    batches.push(claimBatch(batch, split, cases, at));
  }
  for (const spec of briefs) {
    const { split, cases } = casesOf(spec.bundle);
    const question = [...QUESTIONS, ...QUESTIONS_16D].find((q) => q.id === spec.bundle)?.question ?? '';
    batches.push(...briefBatches(spec, split, cases, question, at));
  }
  return batches;
}

/**
 * A maximum-size input (gate condition 4): a claim batch's claims followed by a brief's,
 * both of one bundle and so under the same passage aliases, up to `MAX_CHECK_CLAIMS`, with
 * every passage and header of the cases they are about. Its claims keep their labels; it is
 * measured for latency and structure, not for accuracy (`maxSize`).
 */
function maxSizeBatch(id: string, claims: CalibrationBatch, brief: CalibrationBatch): CalibrationBatch {
  if (claims.bundle !== brief.bundle) throw new BuildError(`${id}: ${claims.id} and ${brief.id} are of different bundles`);
  const alias = (p: string) => Number(p.slice(1));
  const passages = [...new Map([...claims.input.passages, ...brief.input.passages].map((p) => [p.passageId, p])).values()].sort((a, b) => alias(a.passageId) - alias(b.passageId));
  const order = new Map(passages.map((p, i) => [p.ntsbNo, i]));
  const cases = [...new Map([...claims.input.cases, ...brief.input.cases].map((c) => [c.ntsbNo, c])).values()].sort((a, b) => (order.get(a.ntsbNo) ?? 99) - (order.get(b.ntsbNo) ?? 99));
  const merged = [
    ...claims.input.claims.map((c, i) => ({ c, l: claims.labels[i]!, from: claims.id })),
    ...brief.input.claims.map((c, i) => ({ c, l: brief.labels[i]!, from: brief.id })),
  ].slice(0, MAX_CHECK_CLAIMS);
  if (merged.length < MAX_CHECK_CLAIMS) throw new BuildError(`${id}: only ${merged.length} claims`);
  const input = CheckInputSchema.parse({ cases, passages, claims: merged.map(({ c }, i) => ({ ...c, id: `C${i + 1}` })) });
  return {
    id,
    split: claims.split,
    kind: 'claims',
    bundle: claims.bundle,
    input,
    labels: merged.map(({ l, from }, i) => {
      const { key: _key, ...rest } = l;
      return { ...rest, claim: `C${i + 1}`, item: `${from}/${l.item}` };
    }),
    plan: claimsPlan(input),
    base: id,
    maxSize: true,
  };
}

export function buildCalibrationV2(evidence: EvidenceFile, evidenceText: string, v2: EvidenceV2File, v2Text: string): CalibrationDataset {
  const problems = [...evidenceProblems(evidence), ...evidenceProblems({ ...evidence, bundles: v2.bundles })];
  if (problems.length > 0) throw new BuildError(`evidence: ${problems.join('; ')}`);
  const headers = new Map(Object.entries(v2.headers));
  const bundles = [...evidence.bundles, ...v2.bundles];
  for (const b of bundles) for (const c of b.cases) if (!headers.has(c.ntsbNo)) throw new BuildError(`evidence-16d.json has no header for ${c.ntsbNo}`);
  // Both 16c splits are development now; the 16d bundles are the held-out set.
  const v1Bundles = new Set(evidence.bundles.map((b) => b.question));
  const batches = buildBatches(bundles, headers, [...CLAIM_BATCHES, ...V2_CLAIM_BATCHES], [...BRIEFS, ...V2_BRIEFS], 'v2', (b) =>
    v1Bundles.has(b.question) ? 'dev' : b.split,
  );
  for (const m of V2_MAX_SIZE) {
    const claims = batches.find((b) => b.id === m.claims);
    const brief = batches.find((b) => b.id === m.brief);
    if (!claims || !brief) throw new BuildError(`${m.id}: no batch ${!claims ? m.claims : m.brief}`);
    batches.push(maxSizeBatch(m.id, claims, brief));
  }
  checkSplits(batches);
  // No 16d held-out case was judged in 16c.
  const v1Cases = new Set(evidence.bundles.flatMap((b) => b.cases.map((c) => c.ntsbNo)));
  for (const b of batches.filter((x) => x.split === 'holdout')) {
    for (const p of b.input.passages) if (v1Cases.has(p.ntsbNo)) throw new BuildError(`held-out case ${p.ntsbNo} was in a 16c split`);
  }
  const split = (s: 'dev' | 'holdout') => labelCounts(batches.filter((b) => b.split === s));
  return {
    version: 'checker-cal-v2',
    note:
      'Checker calibration set v2 (Task 16d). No label is expert ground truth: each is constructed (by how the claim was built, checked against the complete supplied evidence) or model-reviewed; unresolved labels are unknown, and a brief with one never counts as wholly supported. Labels v2 correct the 16c labels (labels.v2.ts, with reasons). Built by evals/checker/build.ts from evidence.json, evidence-16d.json and items/; labels frozen by labels.sha256, each split by its own hash.',
    chronologyRules: CHRONOLOGY_RULES_VERSION,
    displayRules: DISPLAY_RULES_VERSION,
    evidenceSha256: sha256(evidenceText),
    evidenceV2Sha256: sha256(v2Text),
    labels: { ...labelCounts(batches), version: LABELS_V2_VERSION, splits: { dev: split('dev'), holdout: split('holdout') } },
    batches,
  };
}

export function readDatasetV2(path = DATASET_V2_PATH): CalibrationDataset {
  return JSON.parse(readFileSync(path, 'utf8')) as CalibrationDataset;
}

/** The frozen v1 labels' hash (Task 16c, 6e06f1e). */
export const V1_LABELS_SHA256 = '9608ceac09ef823949d3a9f0db88987db584db9f4bf2bd104f3939ed6586ca6d';

export async function buildDataset(opts: { check: boolean; log: (m: string) => void }): Promise<number> {
  const evidenceText = readFileSync(EVIDENCE_PATH, 'utf8');
  const evidence = EvidenceFileSchema.parse(JSON.parse(evidenceText));
  const v2Text = readFileSync(EVIDENCE_V2_PATH, 'utf8');
  const v2 = EvidenceV2FileSchema.parse(JSON.parse(v2Text));
  let dataset: CalibrationDataset;
  try {
    // v1 stays frozen: its labels hash and its claims as the production code renders them.
    const v1 = readDataset();
    if (v1.labels.sha256 !== V1_LABELS_SHA256 || labelsHash(v1.batches) !== V1_LABELS_SHA256) throw new BuildError('dataset.json (v1) is not the frozen 16c dataset');
    v1Plans(v1);
    dataset = buildCalibrationV2(evidence, evidenceText, v2, v2Text);
  } catch (err) {
    if (err instanceof BuildError) {
      opts.log(`build failed: ${err.message}`);
      return 1;
    }
    throw err;
  }
  const text = `${JSON.stringify(dataset, null, 2)}\n`;
  const l = dataset.labels;
  opts.log(
    `v2: ${dataset.batches.length} batches, ${l.claims} claims: ${l.supported} supported, ${l.notSupported} not supported, ${l.unknown} unknown; labels ${l.sha256.slice(0, 16)} (dev ${l.splits!.dev.sha256.slice(0, 16)}, holdout ${l.splits!.holdout.sha256.slice(0, 16)})`,
  );
  if (opts.check) {
    let committed = '';
    try {
      committed = readFileSync(DATASET_V2_PATH, 'utf8');
    } catch {
      opts.log('check failed: dataset.v2.json is missing');
      return 1;
    }
    if (committed !== text) {
      const frozen = (JSON.parse(committed) as CalibrationDataset).labels?.sha256;
      opts.log(`check failed: dataset.v2.json differs from the build${frozen !== l.sha256 ? ` (frozen labels ${String(frozen).slice(0, 16)}, built ${l.sha256.slice(0, 16)})` : ''}`);
      return 1;
    }
    opts.log('check passed: dataset.json is the frozen v1 set; dataset.v2.json is the build of the evidence and items/');
    return 0;
  }
  writeFileSync(DATASET_V2_PATH, text);
  opts.log(`wrote ${DATASET_V2_PATH}`);
  return 0;
}
