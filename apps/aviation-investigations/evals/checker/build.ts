/**
 * `pnpm eval:checker build [--check]`: the checker calibration set (`dataset.json`), built
 * deterministically from the frozen evidence (`evidence.json`) and the authored items
 * (`items/`). Every check input is rendered by the production code: claim batches through
 * `checkPassages` and `checkForModel`; complete briefs through `validateComposition`,
 * `compositionFromModel`, the criteria (`evaluateCase`, the timing rules), `checkInput`
 * and `checkForModel`, exactly as the brief pipeline renders them. A brief's error variant
 * must change exactly one rendered claim, which becomes its one known error.
 *
 * The labels are frozen: `labels.sha256` hashes every claim with its label, and `--check`
 * rebuilds in memory and refuses any difference from the committed file (exit 1).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CheckInputSchema, type CheckInput } from '../../server/ai/provider.js';
import { checkForModel, citationsFromModel, compositionFromModel, passageAliases, type PassageAliases } from '../../server/briefs/aliases.js';
import type { ReadingState } from '../../server/briefs/clarify.js';
import { CHRONOLOGY_RULES_VERSION, criteriaLines, evaluateCase, type CriterionCheck } from '../../server/briefs/criteria.js';
import { caseEvidence, checkInput, checkPassages, type ClaimMeta, type VerifiedCase } from '../../server/briefs/render.js';
import { validateComposition, type AllowedPassage, type Allowlist } from '../../server/briefs/validate.js';
import { CHECK_PROMPT_VERSION } from '../../server/ai/prompts/check.v4.js';
import { APP_DIR } from '../../worker/config.js';
import type { ComposeOutput } from '../../shared/contracts/briefs.js';
import { EvidenceFileSchema, evidenceProblems, sha256, verifiedCases, type EvidenceFile } from './evidence.js';
import { BRIEFS, CLAIM_BATCHES } from './items/index.js';
import { QUESTIONS } from './questions.js';
import type { BriefSpec, ClaimBatch, Family, Label, Provenance } from './types.js';
import { FAMILIES, MUTATIONS } from './types.js';

export const DATASET_PATH = resolve(APP_DIR, 'evals/checker/dataset.json');
const EVIDENCE_PATH = resolve(APP_DIR, 'evals/checker/evidence.json');

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
}

/** One check call of the calibration: the input exactly as the checker reads it, and the labels. */
export interface CalibrationBatch {
  id: string;
  split: 'dev' | 'holdout';
  kind: 'claims' | 'brief';
  /** For a brief: `supported` (every claim supported or unknown) or `one_error` (exactly one known error). */
  brief?: 'supported' | 'one_error';
  bundle: string;
  input: CheckInput;
  labels: LabelledClaim[];
}

export interface CalibrationDataset {
  version: 'checker-cal-v1';
  note: string;
  checkPrompt: string;
  chronologyRules: string;
  evidenceSha256: string;
  labels: { sha256: string; claims: number; supported: number; notSupported: number; unknown: number };
  batches: CalibrationBatch[];
}

/** The planner's default reading of "shortly" (30 calendar days or 10 flight hours). */
const DEFAULT_READINGS: ReadingState = { timingWindow: { value: { days: 30, flightHours: 10 }, pinned: false } };

class BuildError extends Error {}

const mutationOf = (family: Family, mutation: string | undefined): boolean =>
  family !== 'control' && mutation !== undefined && (MUTATIONS[family] as readonly string[]).includes(mutation);

function aliasesOf(cases: readonly VerifiedCase[]): PassageAliases {
  return passageAliases(cases);
}

function claimBatch(batch: ClaimBatch, split: 'dev' | 'holdout', cases: readonly VerifiedCase[]): CalibrationBatch {
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
  const input = CheckInputSchema.parse(checkForModel({ criteria: criteriaLines(batch.readings ?? DEFAULT_READINGS), passages, claims }, aliases));
  return {
    id: batch.id,
    split,
    kind: 'claims',
    bundle: batch.bundle,
    input,
    labels: batch.claims.map((item, i) => ({
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
    })),
  };
}

/** A composition rendered as the pipeline renders it, or a build error naming why it would not reach the checker. */
function renderBrief(spec: BriefSpec, composition: ComposeOutput, cases: readonly VerifiedCase[], question: string): { input: CheckInput; meta: ClaimMeta[] } {
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
  const built = checkInput(c, citations, byCase, { mechanicalCause: spec.mechanicalCause, criteria: criteriaLines(spec.readings), criterionChecks });
  if (built.overflow) throw new BuildError(`${spec.id}: the claims overflow the check input`);
  if (built.input.claims.length === 0) throw new BuildError(`${spec.id}: no claims to check`);
  return { input: CheckInputSchema.parse(checkForModel(built.input, aliases)), meta: built.claims };
}

const sameClaim = (a: CheckInput['claims'][number], b: CheckInput['claims'][number]) =>
  a.kind === b.kind && a.ntsbNo === b.ntsbNo && a.text === b.text && a.absence === b.absence && a.passageIds.join(' ') === b.passageIds.join(' ');

function briefBatches(spec: BriefSpec, split: 'dev' | 'holdout', cases: readonly VerifiedCase[], question: string): CalibrationBatch[] {
  const { input, meta } = renderBrief(spec, spec.composition, cases, question);
  const labels: LabelledClaim[] = input.claims.map((c, i) => ({
    claim: c.id,
    item: `${spec.id}.${c.id}`,
    kind: c.kind,
    case: c.ntsbNo ?? null,
    label: 'supported',
    provenance: 'model-reviewed',
    family: 'control',
    ...(meta[i]?.criterion ? { criterion: meta[i]!.criterion! } : {}),
    ...(meta[i]?.decision ? { decision: meta[i]!.decision! } : {}),
  }));
  const out: CalibrationBatch[] = [{ id: spec.id, split, kind: 'brief', brief: 'supported', bundle: spec.bundle, input, labels }];
  for (const e of spec.errors) {
    if (!mutationOf(e.family, e.mutation)) throw new BuildError(`${spec.id}/${e.id}: ${e.mutation} is not a ${e.family} mutation`);
    const composition = structuredClone(spec.composition);
    e.edit(composition);
    const { input: variant, meta: variantMeta } = renderBrief(spec, composition, cases, question);
    if (variantMeta.some((m, i) => m.criterion !== meta[i]?.criterion || m.decision !== meta[i]?.decision)) {
      throw new BuildError(`${spec.id}/${e.id}: the edit changed a criterion decision`);
    }
    if (variant.claims.length !== input.claims.length) throw new BuildError(`${spec.id}/${e.id}: the edit changed the number of claims`);
    const changed = variant.claims.map((c, i) => (sameClaim(c, input.claims[i]!) ? -1 : i)).filter((i) => i >= 0);
    if (changed.length !== 1) throw new BuildError(`${spec.id}/${e.id}: the edit changed ${changed.length} claims, not exactly one`);
    const at = changed[0]!;
    out.push({
      id: `${spec.id}.${e.id}`,
      split,
      kind: 'brief',
      brief: 'one_error',
      bundle: spec.bundle,
      input: variant,
      labels: labels.map((l, i) =>
        i === at
          ? {
              ...l,
              item: `${spec.id}.${e.id}.${l.claim}`,
              label: 'not_supported' as const,
              expect: e.expect,
              provenance: 'constructed' as const,
              family: e.family,
              mutation: e.mutation,
              ...(e.critical ? { critical: true } : {}),
            }
          : l,
      ),
    });
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

export function buildCalibration(evidence: EvidenceFile, evidenceText: string): CalibrationDataset {
  const problems = evidenceProblems(evidence);
  if (problems.length > 0) throw new BuildError(`evidence: ${problems.join('; ')}`);
  const bundles = new Map(evidence.bundles.map((b) => [b.question, b]));
  const casesOf = (bundle: string) => {
    const b = bundles.get(bundle);
    if (!b) throw new BuildError(`no bundle ${bundle} in evidence.json`);
    return { split: b.split, cases: verifiedCases(b) };
  };
  const batches: CalibrationBatch[] = [];
  for (const batch of CLAIM_BATCHES) {
    const { split, cases } = casesOf(batch.bundle);
    batches.push(claimBatch(batch, split, cases));
  }
  for (const spec of BRIEFS) {
    const { split, cases } = casesOf(spec.bundle);
    const question = QUESTIONS.find((q) => q.id === spec.bundle)?.question ?? '';
    batches.push(...briefBatches(spec, split, cases, question));
  }
  const ids = batches.map((b) => b.id);
  if (new Set(ids).size !== ids.length) throw new BuildError('duplicate batch ids');
  // Split by case: no case is judged in both splits.
  const splitOf = new Map<string, string>();
  for (const b of batches) {
    for (const p of b.input.passages) {
      const seen = splitOf.get(p.ntsbNo);
      if (seen && seen !== b.split) throw new BuildError(`case ${p.ntsbNo} is in both splits`);
      splitOf.set(p.ntsbNo, b.split);
    }
  }
  const all = batches.flatMap((b) => b.labels);
  for (const l of all) if (!FAMILIES.includes(l.family)) throw new BuildError(`unknown family ${l.family}`);
  return {
    version: 'checker-cal-v1',
    note:
      'Checker calibration set (Task 16c). No label is expert ground truth: each is constructed (by how the claim was built, checked against the complete supplied evidence) or model-reviewed; unresolved labels are unknown. Built by evals/checker/build.ts from evidence.json and items/; labels frozen by labels.sha256 before any checker comparison.',
    checkPrompt: CHECK_PROMPT_VERSION,
    chronologyRules: CHRONOLOGY_RULES_VERSION,
    evidenceSha256: sha256(evidenceText),
    labels: {
      sha256: labelsHash(batches),
      claims: all.length,
      supported: all.filter((l) => l.label === 'supported').length,
      notSupported: all.filter((l) => l.label === 'not_supported').length,
      unknown: all.filter((l) => l.label === 'unknown').length,
    },
    batches,
  };
}

export function readDataset(path = DATASET_PATH): CalibrationDataset {
  return JSON.parse(readFileSync(path, 'utf8')) as CalibrationDataset;
}

export async function buildDataset(opts: { check: boolean; log: (m: string) => void }): Promise<number> {
  const evidenceText = readFileSync(EVIDENCE_PATH, 'utf8');
  const evidence = EvidenceFileSchema.parse(JSON.parse(evidenceText));
  let dataset: CalibrationDataset;
  try {
    dataset = buildCalibration(evidence, evidenceText);
  } catch (err) {
    if (err instanceof BuildError) {
      opts.log(`build failed: ${err.message}`);
      return 1;
    }
    throw err;
  }
  const text = `${JSON.stringify(dataset, null, 2)}\n`;
  const l = dataset.labels;
  opts.log(`${dataset.batches.length} batches, ${l.claims} claims: ${l.supported} supported, ${l.notSupported} not supported, ${l.unknown} unknown; labels ${l.sha256.slice(0, 16)}`);
  if (opts.check) {
    let committed = '';
    try {
      committed = readFileSync(DATASET_PATH, 'utf8');
    } catch {
      opts.log('check failed: dataset.json is missing');
      return 1;
    }
    if (committed !== text) {
      const frozen = (JSON.parse(committed) as CalibrationDataset).labels?.sha256;
      opts.log(`check failed: dataset.json differs from the build${frozen !== l.sha256 ? ` (frozen labels ${String(frozen).slice(0, 16)}, built ${l.sha256.slice(0, 16)})` : ''}`);
      return 1;
    }
    opts.log('check passed: dataset.json is the build of evidence.json and items/');
    return 0;
  }
  writeFileSync(DATASET_PATH, text);
  opts.log(`wrote ${DATASET_PATH}`);
  return 0;
}
