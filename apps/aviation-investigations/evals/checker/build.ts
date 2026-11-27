/**
 * `pnpm eval:checker build [--check]`: the checker calibration sets, built
 * deterministically from the frozen evidence and the authored items (`items/`). Every
 * check input is rendered by the production code: claim batches through `checkCases`,
 * `checkPassages` and `checkForModel`; complete briefs through `validateComposition` (with
 * the excerpt-context verdicts), `compositionFromModel`, the criteria (`evaluateCase`, the
 * timing rules), `checkInput`, `staticAbstentions`, `displayPlan` and `checkForModel`,
 * exactly as the brief pipeline renders them. A brief's error variant must change exactly
 * one rendered claim, which becomes its known error; a mixed-error variant applies several
 * of them at once.
 *
 * Three datasets:
 * - `dataset.json` (`checker-cal-v1`, Task 16c): frozen. The 16c runs judged its inputs;
 *   `--check` verifies its label hash and keeps it byte-for-byte. `v1Plans` rebuilds the
 *   display plan of each of its briefs with the production code, after checking that the
 *   rebuilt claims are the frozen ones, so the offline simulation projects the 16c
 *   recordings exactly as production would now.
 * - `dataset.v2.json` (`checker-cal-v2`, Task 16d): frozen since Task 16e (its file hash,
 *   `V2_FILE_SHA256`; the 16d runs judged its inputs). `v2Plans` rebuilds its plans with the
 *   production code like `v1Plans`.
 * - `dataset.v3.json` (`checker-cal-v3`, Task 16e): every earlier item (16c, the 16d
 *   additions and the 16d held-out set) as development, rendered by the 16e code
 *   (`chronology-rules-v3`, `display-deps-v2` plans with the static abstentions of
 *   `excerpt-context-v1` and `ordinal-evidence-v2`), with labels v3 (labels v2 and the
 *   errata overlay `checker-errata-v1`, `labels.v3.ts`), and the 16e held-out set of new
 *   `retrieval.v2` bundles. Each brief batch carries its display plan, each batch its
 *   cluster (the source bundle). `labels.sha256` hashes every claim with its label, per
 *   split too, and `--check` refuses any difference from the committed file (exit 1).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CheckInputSchema, MAX_CHECK_CLAIMS, type CheckInput } from '../../server/ai/provider.js';
import { checkForModel, citationsFromModel, compositionFromModel, passageAliases, type PassageAliases } from '../../server/briefs/aliases.js';
import { CHRONOLOGY_RULES_VERSION, evaluateCase, type CriterionCheck } from '../../server/briefs/criteria.js';
import { DISPLAY_RULES_VERSION, type DisplayPlan, type StaticAbstention } from '../../server/briefs/display.js';
import { EXCERPT_CONTEXT_VERSION, excerptVerdict } from '../../server/briefs/excerpts.js';
import { ORDINAL_EVIDENCE_VERSION, textOrdinalsVerified } from '../../server/briefs/ordinals.js';
import { SPEAKER_CLAIM, caseEvidence, checkCases, checkInput, checkPassages, displayPlan, staticAbstentions, type ClaimMeta, type VerifiedCase } from '../../server/briefs/render.js';
import { validateComposition, type AllowedPassage, type Allowlist } from '../../server/briefs/validate.js';
import { APP_DIR } from '../../worker/config.js';
import type { ComposeOutput } from '../../shared/contracts/briefs.js';
import {
  EvidenceFileSchema,
  EvidenceV2FileSchema,
  EvidenceV3FileSchema,
  evidenceProblems,
  sha256,
  verifiedCases,
  type EvidenceBundle,
  type EvidenceFile,
  type EvidenceV2File,
  type EvidenceV3File,
} from './evidence.js';
import { BRIEFS, CLAIM_BATCHES, V2_BRIEFS, V2_CLAIM_BATCHES, V2_MAX_SIZE, V3_BRIEFS, V3_CLAIM_BATCHES } from './items/index.js';
import { BRIEF_LABELS_V2, CLAIM_LABELS_V2, LABELS_V2_VERSION } from './labels.v2.js';
import { BRIEF_ERRATA, CLAIM_ERRATA, DISPUTED, ERRATA_VERSION, LABELS_V3_VERSION } from './labels.v3.js';
import { HELDOUT_V3 } from './protocol.v3.js';
import { QUESTIONS, QUESTIONS_16D, QUESTIONS_16E } from './questions.js';
import type { BriefCategory, BriefClaimLabel, BriefSpec, ClaimBatch, Family, Label, Provenance } from './types.js';
import { FAMILIES, MUTATIONS } from './types.js';

export const DATASET_PATH = resolve(APP_DIR, 'evals/checker/dataset.json');
export const DATASET_V2_PATH = resolve(APP_DIR, 'evals/checker/dataset.v2.json');
export const DATASET_V3_PATH = resolve(APP_DIR, 'evals/checker/dataset.v3.json');
export const EVIDENCE_PATH = resolve(APP_DIR, 'evals/checker/evidence.json');
export const EVIDENCE_V2_PATH = resolve(APP_DIR, 'evals/checker/evidence-16d.json');
export const EVIDENCE_V3_PATH = resolve(APP_DIR, 'evals/checker/evidence-16e.json');

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
  /** Why a label differs from the brief as authored, or was corrected (labels v2, v3). */
  reason?: string;
  /** v3: the label is an erratum of labels v2 (`checker-errata-v1`), with its source. */
  erratum?: string;
  /** v3: review found the label arguable (`DISPUTED`): sensitivity figures read it as `unknown`. */
  disputed?: true;
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
  version: 'checker-cal-v1' | 'checker-cal-v2' | 'checker-cal-v3';
  note: string;
  chronologyRules: string;
  displayRules?: string;
  /** v3: the excerpt-context and ordinal-evidence versions its plans were built under. */
  excerptRules?: string;
  ordinalRules?: string;
  evidenceSha256: string;
  /** v2: the 16d evidence file's sha256 (headers and held-out bundles). */
  evidenceV2Sha256?: string;
  /** v3: the 16e evidence file's sha256 (the 16e held-out bundles), null before it exists. */
  evidenceV3Sha256?: string | null;
  labels: {
    sha256: string;
    claims: number;
    supported: number;
    notSupported: number;
    unknown: number;
    version?: string;
    /** v3: the errata overlay (`labels.v3.ts`) and the count of disputed labels. */
    errata?: string;
    disputed?: number;
    /** v2: the hash and counts of each split's labels (the held-out split freezes on its own). */
    splits?: Record<'dev' | 'holdout', { sha256: string; claims: number; supported: number; notSupported: number; unknown: number }>;
  };
  batches: CalibrationBatch[];
}

export class BuildError extends Error {}

const mutationOf = (family: Family, mutation: string | undefined): boolean =>
  family !== 'control' && mutation !== undefined && (MUTATIONS[family] as readonly string[]).includes(mutation);

function aliasesOf(cases: readonly VerifiedCase[]): PassageAliases {
  return passageAliases(cases);
}

/** A claim batch's plan: independent claims (no summary, no case readings), with the static abstentions (`claimsStatic`). */
function claimsPlan(input: CheckInput, abstain: readonly (StaticAbstention | undefined)[] = []): DisplayPlan {
  return {
    rules: DISPLAY_RULES_VERSION,
    shape: 'claims',
    grouping: null,
    cases: [],
    sentences: [],
    claims: input.claims.map((c, i) => ({ key: `claims.${c.id}`, kind: c.kind, cases: c.ntsbNo ? [c.ntsbNo] : [], ...(abstain[i] ? { abstain: abstain[i] } : {}) })),
    together: [],
  };
}

const escapeRegExp = (t: string) => t.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
const QUOTE_CLAIM = new RegExp(`^(${Object.values(SPEAKER_CLAIM).map(escapeRegExp).join('|')}) “(.*)”$`, 's');

/**
 * The static abstentions of a claim batch's items (Task 16e): the production rules
 * (`staticAbstentions`) read from the items' text, since a claim batch has no composition.
 * A quote claim (`SPEAKER_CLAIM` and the excerpt) gets the excerpt-context verdict of its
 * excerpt's first verbatim occurrence in the passages it cites, for the speaker its
 * template names (an excerpt that is in none of them is left to the checker: production
 * never renders one); a summary, `why`, gap or timing item stating a flight ordinal needs
 * the ordinal's explicit evidence in the passages it cites.
 */
function claimsStatic(input: CheckInput, multiAircraft: ReadonlySet<string>): (StaticAbstention | undefined)[] {
  const texts = new Map(input.passages.map((p) => [p.passageId, p.text]));
  const speakerOf = new Map<string, keyof typeof SPEAKER_CLAIM>(Object.entries(SPEAKER_CLAIM).map(([speaker, t]) => [t, speaker as keyof typeof SPEAKER_CLAIM]));
  return input.claims.map((c): StaticAbstention | undefined => {
    const cited = c.passageIds.flatMap((id) => (texts.has(id) ? [texts.get(id)!] : []));
    if (c.kind === 'attribution') {
      const m = QUOTE_CLAIM.exec(c.text);
      if (!m) return undefined;
      const speaker = speakerOf.get(m[1]!)!;
      const quote = m[2]!;
      for (const passage of cited) {
        const start = passage.indexOf(quote);
        if (start < 0) continue;
        const verdict = excerptVerdict({ passage, span: { start, end: start + quote.length }, speaker, multiAircraft: c.ntsbNo !== undefined && multiAircraft.has(c.ntsbNo) });
        return verdict.problems.length > 0 ? 'excerpt_context' : undefined;
      }
      return undefined;
    }
    if (c.kind === 'summary' || c.kind === 'why' || c.kind === 'gap' || c.kind === 'timing') return textOrdinalsVerified(c.text, cited) ? undefined : 'ordinal_evidence';
    return undefined;
  });
}

type Inputs = 'v1' | 'v2';
const applies = (inputs: BriefClaimLabel['inputs'], at: Inputs) => (inputs ?? 'both') === 'both' || inputs === at;

/** The label corrections a build applies: labels v2, and for v3 the errata overlay and the disputed flags. */
interface LabelSet {
  claims: readonly (Omit<BriefClaimLabel, 'key' | 'label'> & { batch: string; item: string; label: Label; source?: string })[];
  briefs: readonly (BriefClaimLabel & { brief: string; source?: string })[];
  disputed: readonly { brief: string; key: string }[];
}
const LABELS_V2: LabelSet = { claims: CLAIM_LABELS_V2, briefs: BRIEF_LABELS_V2, disputed: [] };
/** Labels v3: labels v2, then the errata (an erratum of a claim v2 corrected replaces that correction). */
const LABELS_V3: LabelSet = {
  claims: [...CLAIM_LABELS_V2.filter((c) => !CLAIM_ERRATA.some((e) => e.batch === c.batch && e.item === c.item)), ...CLAIM_ERRATA],
  briefs: [...BRIEF_LABELS_V2.filter((c) => !BRIEF_ERRATA.some((e) => e.brief === c.brief && e.key === c.key)), ...BRIEF_ERRATA.map((e) => ({ ...e, inputs: 'both' as const }))],
  disputed: DISPUTED,
};

function claimBatch(batch: ClaimBatch, split: 'dev' | 'holdout', cases: readonly VerifiedCase[], at: Inputs, set: LabelSet = LABELS_V2): CalibrationBatch {
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
  const corrections = set.claims.filter((c) => c.batch === batch.id && applies(c.inputs, at));
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
    plan: claimsPlan(input, claimsStatic(input, new Set(cases.filter((c) => about.has(c.ntsbNo) && c.summary.row.aircraft.length > 1).map((c) => c.ntsbNo)))),
    base: batch.id,
  };
}

/** A label with a correction applied (labels v2, the v3 errata), keeping the claim's identity. */
function relabel(
  l: LabelledClaim,
  fix: Omit<Pick<BriefClaimLabel, 'family' | 'mutation' | 'expect' | 'critical' | 'provenance' | 'reason'>, never> & { label: Label; source?: string },
): LabelledClaim {
  const { expect: _e, mutation: _m, critical: _c, ...rest } = l;
  if (fix.label === 'not_supported' && (!fix.family || !fix.expect || !mutationOf(fix.family, fix.mutation))) {
    throw new BuildError(`labels: ${l.item}: a not-supported label needs its family, a mutation of that family and the expected verdict`);
  }
  return {
    ...rest,
    label: fix.label,
    family: fix.label === 'not_supported' ? fix.family! : 'control',
    ...(fix.label === 'not_supported' ? { expect: fix.expect!, mutation: fix.mutation! } : {}),
    ...(fix.critical ? { critical: true } : {}),
    provenance: fix.provenance ?? 'model-reviewed',
    reason: fix.reason,
    ...(fix.source ? { erratum: fix.source } : {}),
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
  const multiAircraftCases = new Set(cases.filter((c) => c.summary.row.aircraft.length > 1).map((c) => c.ntsbNo));
  const checked = validateComposition(composition, allow, { mechanicalCause: spec.mechanicalCause, readerText: question, multiAircraftCases });
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
  const abstain = staticAbstentions(c, citations, byCase, built.input, built.claims);
  return {
    input: CheckInputSchema.parse(checkForModel(built.input, aliases)),
    meta: built.claims,
    plan: displayPlan(c, built.claims, spec.mechanicalCause, { abstain, cases: byCase }),
  };
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

/** The labels of the brief as authored: supported, unless the spec or the label set says otherwise (by stable key). */
function authoredLabels(spec: BriefSpec, input: CheckInput, meta: readonly ClaimMeta[], at: Inputs, set: LabelSet): LabelledClaim[] {
  const corrected = set.briefs.filter((c) => c.brief === spec.id);
  // A correction of the label set replaces the spec's own label of the same claim.
  const fixes = [...(spec.labels ?? []).filter((f) => !corrected.some((c) => c.key === f.key)), ...corrected].filter((f) => applies(f.inputs, at));
  for (const f of fixes) if (!meta.some((m) => m.key === f.key)) throw new BuildError(`${spec.id}: no claim ${f.key} to label`);
  const disputed = new Set(set.disputed.filter((d) => d.brief === spec.id).map((d) => d.key));
  for (const key of disputed) if (!meta.some((m) => m.key === key)) throw new BuildError(`${spec.id}: no disputed claim ${key}`);
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
    const labelled = fix ? relabel(base, fix) : base;
    return disputed.has(m.key) ? { ...labelled, disputed: true as const } : labelled;
  });
}

function briefBatches(spec: BriefSpec, split: 'dev' | 'holdout', cases: readonly VerifiedCase[], question: string, at: Inputs, set: LabelSet = LABELS_V2): CalibrationBatch[] {
  const { input, meta, plan } = renderBrief(spec, spec.composition, cases, question);
  const labels = authoredLabels(spec, input, meta, at, set);
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
        // v3: a disputed flag is part of the frozen labels (absent before v3, so v1 and v2 hashes are unchanged).
        ...(l.disputed ? ['disputed'] : []),
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
 * A label set applied to a frozen dataset's batches, by claim index (each frozen batch's
 * claims are the rebuilt batch's, `v1Plans`/`v2Plans` check it): the rebuilt labels where
 * they differ, except that a brief's constructed error claims stay the frozen errors; the
 * frozen file never changes on disk.
 */
function relabelledFrozen(dataset: CalibrationDataset, rebuilt: readonly CalibrationBatch[], labels: Pick<CalibrationDataset['labels'], 'version' | 'errata'>): CalibrationDataset {
  const batches = dataset.batches.map((frozen) => {
    const r = rebuilt.find((x) => x.id === frozen.id);
    if (!r) throw new BuildError(`no rebuilt batch ${frozen.id}`);
    const relabelled = frozen.labels.map((l, i) => {
      const next = r.labels[i]!;
      const disputed = next.disputed ? { disputed: true as const } : {};
      if (next.label === l.label && next.family === l.family && next.mutation === l.mutation) return { ...l, ...disputed };
      // A brief's error claims stay the frozen constructed errors; corrections reach the rest.
      if (l.label === 'not_supported' && l.provenance === 'constructed' && frozen.kind === 'brief') return l;
      const { expect: _e, mutation: _m, critical: _c, ...rest } = l;
      return {
        ...rest,
        label: next.label,
        family: next.family,
        ...(next.expect ? { expect: next.expect } : {}),
        ...(next.mutation ? { mutation: next.mutation } : {}),
        ...(next.critical ? { critical: true as const } : {}),
        ...(next.reason ? { reason: next.reason } : {}),
        ...(next.erratum ? { erratum: next.erratum } : {}),
        ...disputed,
      };
    });
    return { ...frozen, labels: relabelled, ...(frozen.kind === 'brief' ? { brief: categoryOf(relabelled) } : {}) };
  });
  return { ...dataset, labels: { ...labelCounts(batches), ...labels }, batches };
}

const v1Evidence = () => EvidenceFileSchema.parse(JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')));

/**
 * Labels v2 applied to the v1 dataset (the 16c inputs): the corrections recorded in
 * `labels.v2.ts` for `v1` or `both`, by batch and claim key; v1 labels themselves never
 * change on disk.
 */
export function v1LabelsV2(dataset: CalibrationDataset = readDataset()): CalibrationDataset {
  const rebuilt = buildBatches(v1Evidence().bundles, new Map(), CLAIM_BATCHES, BRIEFS, 'v1', (b) => b.split, LABELS_V2);
  return relabelledFrozen(dataset, rebuilt, { version: LABELS_V2_VERSION });
}

/** Labels v3 (labels v2 and the errata overlay, `labels.v3.ts`) applied to the v1 dataset, for the 16e simulation. */
export function v1LabelsV3(dataset: CalibrationDataset = readDataset()): CalibrationDataset {
  const rebuilt = buildBatches(v1Evidence().bundles, new Map(), CLAIM_BATCHES, BRIEFS, 'v1', (b) => b.split, LABELS_V3);
  return relabelledFrozen(dataset, rebuilt, { version: LABELS_V3_VERSION, errata: ERRATA_VERSION });
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
  set: LabelSet = LABELS_V2,
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
    batches.push(claimBatch(batch, split, cases, at, set));
  }
  for (const spec of briefs) {
    const { split, cases } = casesOf(spec.bundle);
    const question = [...QUESTIONS, ...QUESTIONS_16D, ...QUESTIONS_16E].find((q) => q.id === spec.bundle)?.question ?? '';
    batches.push(...briefBatches(spec, split, cases, question, at, set));
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
    // The static abstentions of each claim's source batch (its plan claims, by index).
    plan: claimsPlan(
      input,
      merged.map(({ from }, i) => {
        const src = from === claims.id ? claims : brief;
        const at = from === claims.id ? i : i - claims.input.claims.length;
        return src.plan?.claims[at]?.abstain;
      }),
    ),
    base: id,
    maxSize: true,
  };
}

/**
 * The 16c items and the 16d additions, rendered by the production code under a label set,
 * with the maximum-size inputs; `splitOf` places each bundle (v2: the 16d bundles are its
 * held-out split; v3: everything here is development).
 */
function v2Items(evidence: EvidenceFile, v2: EvidenceV2File, set: LabelSet, splitOf: (b: EvidenceBundle, v1: boolean) => 'dev' | 'holdout'): CalibrationBatch[] {
  const problems = [...evidenceProblems(evidence), ...evidenceProblems({ ...evidence, bundles: v2.bundles })];
  if (problems.length > 0) throw new BuildError(`evidence: ${problems.join('; ')}`);
  const headers = new Map(Object.entries(v2.headers));
  const bundles = [...evidence.bundles, ...v2.bundles];
  for (const b of bundles) for (const c of b.cases) if (!headers.has(c.ntsbNo)) throw new BuildError(`evidence-16d.json has no header for ${c.ntsbNo}`);
  const v1Bundles = new Set(evidence.bundles.map((b) => b.question));
  const batches = buildBatches(bundles, headers, [...CLAIM_BATCHES, ...V2_CLAIM_BATCHES], [...BRIEFS, ...V2_BRIEFS], 'v2', (b) => splitOf(b, v1Bundles.has(b.question)), set);
  for (const m of V2_MAX_SIZE) {
    const claims = batches.find((b) => b.id === m.claims);
    const brief = batches.find((b) => b.id === m.brief);
    if (!claims || !brief) throw new BuildError(`${m.id}: no batch ${!claims ? m.claims : m.brief}`);
    batches.push(maxSizeBatch(m.id, claims, brief));
  }
  return batches;
}

const v2Evidence = () => EvidenceV2FileSchema.parse(JSON.parse(readFileSync(EVIDENCE_V2_PATH, 'utf8')));

export function readDatasetV2(path = DATASET_V2_PATH): CalibrationDataset {
  return JSON.parse(readFileSync(path, 'utf8')) as CalibrationDataset;
}

/**
 * The display plans of the v2 batches (the 16d inputs), rebuilt by the production code like
 * `v1Plans`: the same claims (ids, kinds, cases, absence, citations; texts but a criterion
 * claim's), so the 16e simulation projects the 16d recordings as production would now.
 * Criterion decisions in the plan are the frozen labels' (the decisions the 16d checker
 * judged).
 */
export function v2Plans(dataset: CalibrationDataset = readDatasetV2()): { plans: Map<string, DisplayPlan>; textChanged: string[] } {
  const rebuilt = v2Items(v1Evidence(), v2Evidence(), LABELS_V2, (b, v1) => (v1 ? 'dev' : b.split));
  const plans = new Map<string, DisplayPlan>();
  const textChanged: string[] = [];
  for (const frozen of dataset.batches) {
    const r = rebuilt.find((x) => x.id === frozen.id);
    if (!r || !r.plan) throw new BuildError(`v2: no rebuilt batch ${frozen.id}`);
    if (r.input.claims.length !== frozen.input.claims.length || r.input.claims.some((c, i) => structure(c) !== structure(frozen.input.claims[i]!))) {
      throw new BuildError(`v2: ${frozen.id} no longer renders the frozen claims`);
    }
    r.input.claims.forEach((c, i) => {
      if (c.text !== frozen.input.claims[i]!.text) {
        if (c.kind !== 'criterion') throw new BuildError(`v2: ${frozen.id}/${c.id} renders another text`);
        textChanged.push(`${frozen.id}/${c.id}`);
      }
    });
    plans.set(frozen.id, {
      ...r.plan,
      claims: r.plan.claims.map((pc, i) => {
        const l = frozen.labels[i]!;
        return { ...pc, ...(l.criterion ? { criterion: l.criterion } : {}), ...(l.decision ? { decision: l.decision } : {}) };
      }),
    });
  }
  return { plans, textChanged };
}

/** Labels v3 applied to the v2 dataset (the 16d inputs), for the 16e simulation; the v2 file never changes. */
export function v2LabelsV3(dataset: CalibrationDataset = readDatasetV2()): CalibrationDataset {
  const rebuilt = v2Items(v1Evidence(), v2Evidence(), LABELS_V3, (b, v1) => (v1 ? 'dev' : b.split));
  return relabelledFrozen(dataset, rebuilt, { version: LABELS_V3_VERSION, errata: ERRATA_VERSION });
}

// ---------------------------------------------------------------------------
// v3 (Task 16e)

export function readDatasetV3(path = DATASET_V3_PATH): CalibrationDataset {
  return JSON.parse(readFileSync(path, 'utf8')) as CalibrationDataset;
}

/** The 16e evidence file and its text, or null before it exists. */
export function readEvidenceV3(path = EVIDENCE_V3_PATH): { file: EvidenceV3File; text: string } | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  return { file: EvidenceV3FileSchema.parse(JSON.parse(text)), text };
}

/**
 * Dataset v3: every 16c and 16d item as development (labels v3), and the 16e held-out set
 * (`V3_BRIEFS`, `V3_CLAIM_BATCHES`) over the 16e bundles, whose cases may be in no earlier
 * bundle. Without the 16e evidence, the development split alone.
 */
export function buildCalibrationV3(evidence: EvidenceFile, evidenceText: string, v2: EvidenceV2File, v2Text: string, v3: { file: EvidenceV3File; text: string } | null): CalibrationDataset {
  const dev = v2Items(evidence, v2, LABELS_V3, () => 'dev');
  const held: CalibrationBatch[] = [];
  if (v3) {
    const problems = evidenceProblems({ ...evidence, bundles: v3.file.bundles });
    if (problems.length > 0) throw new BuildError(`evidence-16e.json: ${problems.join('; ')}`);
    const chosen = heldOutBundlesV3(v3.file, new Set([...evidence.bundles, ...v2.bundles].flatMap((b) => b.cases.map((c) => c.ntsbNo))));
    for (const b of chosen) for (const c of b.cases) if (!v3.file.headers[c.ntsbNo]) throw new BuildError(`evidence-16e.json has no header for ${c.ntsbNo}`);
    const names = new Set(chosen.map((b) => b.question));
    for (const item of [...V3_CLAIM_BATCHES, ...V3_BRIEFS]) if (!names.has(item.bundle)) throw new BuildError(`${item.id}: bundle ${item.bundle} is not one of the held-out bundles (${[...names].join(', ')})`);
    held.push(...buildBatches(chosen, new Map(Object.entries(v3.file.headers)), V3_CLAIM_BATCHES, V3_BRIEFS, 'v2', () => 'holdout', LABELS_V3));
  } else if (V3_CLAIM_BATCHES.length + V3_BRIEFS.length > 0) {
    throw new BuildError('the 16e held-out items need evidence-16e.json');
  }
  const batches = [...dev, ...held];
  checkSplits(batches);
  const split = (s: 'dev' | 'holdout') => labelCounts(batches.filter((b) => b.split === s));
  return {
    version: 'checker-cal-v3',
    note:
      'Checker calibration set v3 (Task 16e). Development: every 16c and 16d item (the 16d held-out pilot included), rendered by the 16e code. Held-out: the 16e bundles under retrieval.v2, cases in no earlier split. No label is expert ground truth: each is constructed (by how the claim was built, checked against the complete supplied evidence) or model-reviewed; unresolved labels are unknown, and a brief with one never counts as wholly supported. Labels v3 are labels v2 with the errata overlay checker-errata-v1 (labels.v3.ts, with reasons); disputed labels are flagged for the sensitivity figures. Built by evals/checker/build.ts from evidence.json, evidence-16d.json, evidence-16e.json and items/; labels frozen by labels.sha256, each split by its own hash.',
    chronologyRules: CHRONOLOGY_RULES_VERSION,
    displayRules: DISPLAY_RULES_VERSION,
    excerptRules: EXCERPT_CONTEXT_VERSION,
    ordinalRules: ORDINAL_EVIDENCE_VERSION,
    evidenceSha256: sha256(evidenceText),
    evidenceV2Sha256: sha256(v2Text),
    evidenceV3Sha256: v3 ? sha256(v3.text) : null,
    labels: {
      ...labelCounts(batches),
      version: LABELS_V3_VERSION,
      errata: ERRATA_VERSION,
      disputed: batches.flatMap((b) => b.labels).filter((l) => l.disputed).length,
      splits: { dev: split('dev'), holdout: split('holdout') },
    },
    batches,
  };
}

/**
 * The 16e held-out bundles by the pre-registered rule (`HELDOUT_V3`): the retrieved 16e
 * bundles that hold no case of an earlier split and at least `minimumCases` cases, the first
 * `bundles` of them in question order (`QUESTIONS_16E`); no case in two of them.
 */
export function heldOutBundlesV3(file: EvidenceV3File, earlier: ReadonlySet<string>): EvidenceV3File['bundles'] {
  if (file.source.retrievalVersion !== HELDOUT_V3.retrievalVersion) throw new BuildError(`evidence-16e.json is not ${HELDOUT_V3.retrievalVersion}`);
  const order = QUESTIONS_16E.map((q) => q.id);
  const byQuestion = new Map(file.bundles.map((b) => [b.question, b]));
  for (const b of file.bundles) if (b.split !== 'holdout' || !order.includes(b.question)) throw new BuildError(`evidence-16e.json: ${b.question} is not a 16e held-out question`);
  const eligible = order.flatMap((q) => {
    const b = byQuestion.get(q);
    return b && b.cases.length >= HELDOUT_V3.minimumCases && !b.cases.some((c) => earlier.has(c.ntsbNo)) ? [b] : [];
  });
  if (eligible.length < HELDOUT_V3.bundles) throw new BuildError(`only ${eligible.length} eligible 16e bundles, ${HELDOUT_V3.bundles} needed`);
  const chosen = eligible.slice(0, HELDOUT_V3.bundles);
  const seen = new Set<string>();
  for (const b of chosen) {
    for (const c of b.cases) {
      if (seen.has(c.ntsbNo)) throw new BuildError(`${c.ntsbNo} is in two held-out bundles`);
      seen.add(c.ntsbNo);
    }
  }
  return chosen;
}

/** The frozen v1 labels' hash (Task 16c, 6e06f1e). */
export const V1_LABELS_SHA256 = '9608ceac09ef823949d3a9f0db88987db584db9f4bf2bd104f3939ed6586ca6d';
/** The frozen v2 dataset file's sha256 (Task 16d, e07e2d9; frozen in Task 16e). */
export const V2_FILE_SHA256 = '25e879adb80f0bc3703b41d32843f8fd441ea1162939e4f52e00fcf6c4dd61f7';

/**
 * Dataset v3's frozen label hashes (Task 16e): the development split (labels v3) and the
 * 16e held-out split, frozen with the 16e evidence before any 16e checker output (protocol
 * v3, `HELDOUT_V3`). A build whose labels or evidence differ refuses: a change is a new,
 * disclosed label set.
 */
export const V3_DEV_LABELS_SHA256 = '3a3b6767b5d7198ef0ab63a545487f0a56f1d67c9840f7e285ea7f341892f98f';
export const V3_HOLDOUT_LABELS_SHA256 = 'c079a152016238854797d78105644d69f81d935253bab4533fe2341ce45978c6';
export const EVIDENCE_V3_SHA256 = '8bf19490d1288ad8b0377ebd4451c9ba086a9a04cd16befe11b92ee33540a6c2';

export async function buildDataset(opts: { check: boolean; log: (m: string) => void }): Promise<number> {
  const evidenceText = readFileSync(EVIDENCE_PATH, 'utf8');
  const evidence = EvidenceFileSchema.parse(JSON.parse(evidenceText));
  const v2Text = readFileSync(EVIDENCE_V2_PATH, 'utf8');
  const v2 = EvidenceV2FileSchema.parse(JSON.parse(v2Text));
  let dataset: CalibrationDataset;
  try {
    // v1 and v2 stay frozen: v1 by its labels hash, v2 by its file hash; the code still renders their claims.
    const v1 = readDataset();
    if (v1.labels.sha256 !== V1_LABELS_SHA256 || labelsHash(v1.batches) !== V1_LABELS_SHA256) throw new BuildError('dataset.json (v1) is not the frozen 16c dataset');
    v1Plans(v1);
    if (sha256(readFileSync(DATASET_V2_PATH, 'utf8')) !== V2_FILE_SHA256) throw new BuildError('dataset.v2.json is not the frozen 16d dataset');
    v2Plans();
    dataset = buildCalibrationV3(evidence, evidenceText, v2, v2Text, readEvidenceV3());
    const splits = dataset.labels.splits!;
    if (dataset.evidenceV3Sha256 !== EVIDENCE_V3_SHA256) throw new BuildError('evidence-16e.json is not the frozen 16e evidence');
    if (splits.dev.sha256 !== V3_DEV_LABELS_SHA256) throw new BuildError(`the development labels (${splits.dev.sha256.slice(0, 16)}) are not the frozen labels v3`);
    if (splits.holdout.sha256 !== V3_HOLDOUT_LABELS_SHA256) throw new BuildError(`the held-out labels (${splits.holdout.sha256.slice(0, 16)}) are not the frozen 16e held-out set`);
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
    `v3: ${dataset.batches.length} batches, ${l.claims} claims: ${l.supported} supported, ${l.notSupported} not supported, ${l.unknown} unknown (${l.disputed} disputed); labels ${l.sha256.slice(0, 16)} (dev ${l.splits!.dev.sha256.slice(0, 16)}, holdout ${l.splits!.holdout.sha256.slice(0, 16)})`,
  );
  if (opts.check) {
    let committed = '';
    try {
      committed = readFileSync(DATASET_V3_PATH, 'utf8');
    } catch {
      opts.log('check failed: dataset.v3.json is missing');
      return 1;
    }
    if (committed !== text) {
      const frozen = (JSON.parse(committed) as CalibrationDataset).labels?.sha256;
      opts.log(`check failed: dataset.v3.json differs from the build${frozen !== l.sha256 ? ` (frozen labels ${String(frozen).slice(0, 16)}, built ${l.sha256.slice(0, 16)})` : ''}`);
      return 1;
    }
    opts.log('check passed: dataset.json and dataset.v2.json are the frozen 16c and 16d sets; dataset.v3.json is the build of the evidence and items/');
    return 0;
  }
  writeFileSync(DATASET_V3_PATH, text);
  opts.log(`wrote ${DATASET_V3_PATH}`);
  return 0;
}
