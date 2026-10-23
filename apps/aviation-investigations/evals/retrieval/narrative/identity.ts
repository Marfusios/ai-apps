/**
 * The frozen experiment identity of Track N judgments (task 10c protocol v4, section 6),
 * and the checks every report join makes before it reads a record.
 *
 * **Pinned texts.** `REQUEST_FORMAT_SHA256` hashes every request a judge or the
 * adjudicator can receive, rendered from one fixed synthetic case: the system prompts,
 * the task lines, the adjudication instructions, the retry feedback and the rendering
 * of the question, the rubric, the case, its parts and the delivered passages.
 * `SCHEMAS_SHA256` hashes the strict output schemas and the output limits. Both are in
 * every judgment's cache key, so an edited prompt or format re-judges even when its
 * version string was not bumped; a unit test pins each hash to its version strings so
 * an edit without a version bump fails the build.
 *
 * **Experiment identity.** A judgment file records the identity it was made under: the
 * judges and the adjudicator (provider, model, frozen settings, caps), the prompt and
 * input versions with the pinned hashes, the validator version, the chunk budget, and
 * the data it judged (the dataset's spec hash with the pool file's version, or the
 * calibration's version, label hash and frozen pass criteria). A report accepts a file
 * only when that identity equals the one the current code, dataset, calibration and
 * pool file give; it names the fields that differ otherwise.
 *
 * **Joining records.** Every record must match the current question and rubric
 * versions, and its evidence identity: the pool's recorded fingerprint (relevance), a
 * delivered bundle of the pool (answerability) or the calibration item's fingerprint.
 * Records of the same pair from several files (a resumed or staged run) are merged: they
 * must agree on every judge's outcome (a failed outcome, never cached, is superseded by
 * a later one) and on any finished adjudication; the most complete record is kept (a
 * finished pair over an exhausted escalation over an incomplete pair). Two finished
 * records that disagree are a conflict, and a conflict or an incompatible file stops the
 * report.
 */
import { judgeIdentity } from './clients.js';
import { ADJUDICATOR, JUDGES_VERSION, JUDGE_A, JUDGE_B } from './config.js';
import { CASE_TOKEN_BUDGET, JUDGE_INPUT_VERSION, renderBundleCase, type CaseEvidence, type DeliveredPassage, type SectionPiece } from './evidence.js';
import type { PairRecord } from './judging.js';
import { VALIDATOR_VERSION, retryFeedback } from './judgment.js';
import {
  ADJUDICATOR_PROMPTS_VERSION,
  ANSWERABILITY_PROMPTS_VERSION,
  JUDGE_PROMPTS_VERSION,
  adjudicationRequest,
  adjudicationRequestForParts,
  answerabilityAdjudicationRequest,
  answerabilityRequest,
  chunkRequest,
  consolidateRequest,
  relevanceRequest,
  type JudgeRequest,
  type PartSummary,
  type ShownVerdict,
} from './prompts.js';
import { AnswerabilitySchema, ChunkVerdictSchema, OUTPUT_LIMITS, VerdictSchema, strictJsonSchema } from './schemas.js';
import { canonicalJson, sha256, type Rubric } from './spec.js';

// ---------------------------------------------------------------------------
// Pinned request formats and schemas

const SAMPLE_RUBRIC: Rubric = {
  relevant: 'Every condition is stated.',
  partial: 'Some conditions are stated.',
  notRelevant: 'Anything else.',
  edgeCases: [
    { situation: 'Both conditions stated.', grade: 2, why: 'All.' },
    { situation: 'One condition stated.', grade: 1, why: 'Some.' },
    { situation: 'Neither stated.', grade: 0, why: 'None.' },
  ],
};

const SAMPLE_EVIDENCE: CaseEvidence = {
  ntsbNo: 'XXX00XX000',
  event: { date: '2020-01-01', city: 'Town', state: 'TX', highestInjury: 'MINR', light: 'NDRK', weather: 'VMC' },
  aircraft: [
    { aircraftKey: 1, aircraftNtsbNo: 'XXX00XX000A', make: 'Make', model: 'Model', category: 'AIR', farPart: '091', purpose: 'INST', damage: 'SUBS', definingPhaseGroup: 'landing', engines: ['REC'] },
    { aircraftKey: 2, aircraftNtsbNo: 'XXX00XX000B', make: 'Other', model: 'Type', category: 'HELI', farPart: '137', purpose: 'AAPL', damage: 'DEST', definingPhaseGroup: 'standing', engines: ['TS'] },
  ],
  sections: [
    { alias: 'S1', sectionId: 's1', sectionKey: 'factual/event-1', kind: 'factual', scope: 'event', aircraftKey: null, revisionId: 'r1', sha256: 'h1', text: 'First paragraph.\n\nSecond paragraph.' },
    { alias: 'S2', sectionId: 's2', sectionKey: 'analysis/aircraft-2', kind: 'analysis', scope: 'aircraft', aircraftKey: 2, revisionId: 'r2', sha256: 'h2', text: 'Analysis text.' },
    { alias: 'S3', sectionId: 's3', sectionKey: 'probable_cause/event-1', kind: 'probable_cause', scope: 'event', aircraftKey: null, revisionId: 'r3', sha256: 'h3', text: 'Probable cause text.' },
  ],
  findings: [{ alias: 'F1', rowId: 'XXX00XX000/1/finding/1', aircraftKey: 1, findingNo: 1, code: '0000000000', description: 'A finding', inProbableCause: true }],
  occurrences: [{ alias: 'O1', rowId: 'XXX00XX000/1/occurrence/1', aircraftKey: 1, occurrenceNo: 1, phaseGroup: 'landing', eventCode: '000', description: 'An occurrence', isDefining: true }],
};

const SAMPLE_PASSAGES: DeliveredPassage[] = [
  { passageId: 'p1', sectionId: 's1', revisionId: 'r1', kind: 'factual', scope: 'event', aircraftKey: null, start: 0, end: 16, text: 'First paragraph.' },
  { passageId: 'p2', sectionId: 's2', revisionId: 'r2', kind: 'analysis', scope: 'aircraft', aircraftKey: 2, start: 0, end: 14, text: 'Analysis text.' },
];

const SAMPLE_PIECES: SectionPiece[][] = [
  [{ alias: 'S1', start: 0, end: 16, part: 1, parts: 2 }],
  [
    { alias: 'S1', start: 16, end: 34, part: 2, parts: 2 },
    { alias: 'S2', start: 0, end: 14, part: 1, parts: 1 },
    { alias: 'S3', start: 0, end: 20, part: 1, parts: 1 },
  ],
];

const SHOWN: ShownVerdict = { grade: 'partial', evidence: [{ source: 'S1', quote: 'First paragraph.' }, { source: 'F1', quote: null }], absent: 'the second condition', rationale: 'One condition.' };

/** Every request kind, rendered from the fixed sample (module comment). */
export function sampleRequests(): JudgeRequest[] {
  const q = { question: 'Which sample cases match?', rubric: SAMPLE_RUBRIC };
  const parts: PartSummary[] = [
    { part: 1, grade: 1, evidence: [{ source: 'S1', quote: 'First paragraph.' }], notes: 'Condition one in S1.' },
    { part: 2, grade: 2, evidence: [{ source: 'S2', quote: 'Analysis text.' }], notes: 'Condition two in S2.' },
  ];
  const bundle = renderBundleCase(SAMPLE_EVIDENCE, SAMPLE_PASSAGES);
  const base = relevanceRequest(q, SAMPLE_EVIDENCE);
  return [
    base,
    { ...base, blocks: [...base.blocks, { text: retryFeedback(['quote_not_found:S1', 'too_much_evidence']) }] },
    relevanceRequest(q, SAMPLE_EVIDENCE, { cacheCase: true, purpose: 'adjudicate-initial' }),
    chunkRequest(q, SAMPLE_EVIDENCE, SAMPLE_PIECES[0] as SectionPiece[], 1, 2, ''),
    chunkRequest(q, SAMPLE_EVIDENCE, SAMPLE_PIECES[1] as SectionPiece[], 2, 2, 'Condition one in S1.'),
    consolidateRequest(q, SAMPLE_EVIDENCE, parts),
    adjudicationRequest(q, SAMPLE_EVIDENCE, SHOWN, [SHOWN, null]),
    adjudicationRequestForParts(q, SAMPLE_EVIDENCE, parts, SHOWN, [null, SHOWN]),
    answerabilityRequest(q, bundle),
    answerabilityAdjudicationRequest(q, bundle, SHOWN, [SHOWN, SHOWN]),
  ];
}

/** The hash of every request format (module comment). */
export const REQUEST_FORMAT_SHA256 = sha256(
  canonicalJson(sampleRequests().map((r) => ({ purpose: r.purpose, system: r.system, output: r.output, blocks: r.blocks.map((b) => ({ text: b.text, cache: b.cache === true })) }))),
);

/** The hash of the strict output schemas and the output limits. */
export const SCHEMAS_SHA256 = sha256(
  canonicalJson({ verdict: strictJsonSchema(VerdictSchema), chunk: strictJsonSchema(ChunkVerdictSchema), answerability: strictJsonSchema(AnswerabilitySchema), limits: OUTPUT_LIMITS }),
);

// ---------------------------------------------------------------------------
// Experiment identity

export type JudgmentSet = 'calibration' | 'relevance' | 'answerability';

export interface ExperimentData {
  /** Relevance and answerability: the dataset and the pool file version. */
  datasetSpecSha256?: string;
  poolVersion?: string;
  /** Calibration: the version, the frozen label hash and the frozen pass criteria. */
  calibrationVersion?: string;
  labelsSha256?: string;
  criteriaSha256?: string;
}

/** Everything a record's meaning depends on (module comment). Run parameters (stage, escalation share, limits) are not part of it. */
export function experimentIdentity(set: JudgmentSet, data: ExperimentData): Record<string, unknown> {
  return {
    track: 'track-n',
    set,
    judges: { version: JUDGES_VERSION, judgeA: judgeIdentity(JUDGE_A), judgeB: judgeIdentity(JUDGE_B), adjudicator: judgeIdentity(ADJUDICATOR) },
    prompts: { judge: JUDGE_PROMPTS_VERSION, adjudicate: ADJUDICATOR_PROMPTS_VERSION, answerability: ANSWERABILITY_PROMPTS_VERSION, requestsSha256: REQUEST_FORMAT_SHA256 },
    schemasSha256: SCHEMAS_SHA256,
    validator: VALIDATOR_VERSION,
    input: { version: JUDGE_INPUT_VERSION, caseTokenBudget: CASE_TOKEN_BUDGET },
    data,
  };
}

/** The dotted paths where two identities differ (empty when equal). */
export function identityDifferences(a: unknown, b: unknown, path = ''): string[] {
  if (canonicalJson(a) === canonicalJson(b)) return [];
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return [path || '(root)'];
  const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])].sort();
  return keys.flatMap((k) => identityDifferences((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
}

// ---------------------------------------------------------------------------
// Joining judgment files

export interface JudgmentFile {
  kind: 'track-n-judgments';
  set: JudgmentSet;
  run: string;
  experiment?: Record<string, unknown>;
  stopped: string | null;
  records: PairRecord[];
}

export const pairKey = (r: Pick<PairRecord, 'kind' | 'family' | 'ntsbNo' | 'bundleKey'>): string => `${r.kind}|${r.family}|${r.ntsbNo}|${r.bundleKey ?? ''}`;

const FINISHED: ReadonlySet<PairRecord['status']> = new Set(['agreed', 'adjudicated', 'abstained', 'adjudication-unjudgeable', 'unjudgeable', 'uncovered']);
const completeness = (r: PairRecord): number => (FINISHED.has(r.status) ? 2 : r.status === 'escalation-budget-exhausted' ? 1 : 0);

export interface JoinResult {
  records: Record<JudgmentSet, PairRecord[]>;
  /** Identical records of one pair read more than once. */
  merged: number;
  /** Less complete records replaced by a more complete one of the same pair (a resumed run). */
  superseded: number;
  /** Incompatible files, records that do not match the current data, and conflicts: any one stops the report. */
  problems: string[];
}

/**
 * Join judgment files (module comment): each file's identity must equal `expected(set)`,
 * each record must pass `check`, and records of one pair are merged or reported as a
 * conflict.
 */
export function joinJudgments(
  files: readonly { name: string; body: JudgmentFile }[],
  expected: (set: JudgmentSet) => Record<string, unknown> | null,
  check: (set: JudgmentSet, r: PairRecord) => string | null,
): JoinResult {
  const problems: string[] = [];
  const groups = new Map<string, { set: JudgmentSet; records: PairRecord[] }>();
  for (const { name, body } of files) {
    if (body.kind !== 'track-n-judgments') {
      problems.push(`${name}: not a Track N judgments file`);
      continue;
    }
    const want = expected(body.set);
    if (want === null) {
      problems.push(`${name}: set ${body.set} cannot be checked without its data (pass the pool file)`);
      continue;
    }
    if (!body.experiment) {
      problems.push(`${name}: no experiment identity recorded`);
      continue;
    }
    const diff = identityDifferences(body.experiment, want);
    if (diff.length > 0) {
      problems.push(`${name}: made under another experiment identity (${diff.slice(0, 6).join(', ')})`);
      continue;
    }
    for (const r of body.records) {
      const bad = check(body.set, r);
      if (bad) {
        problems.push(`${name}: ${r.family} ${r.ntsbNo}: ${bad}`);
        continue;
      }
      const key = `${body.set}|${pairKey(r)}`;
      const g = groups.get(key) ?? { set: body.set, records: [] };
      g.records.push(r);
      groups.set(key, g);
    }
  }
  const out: Record<JudgmentSet, PairRecord[]> = { calibration: [], relevance: [], answerability: [] };
  let merged = 0;
  let superseded = 0;
  for (const [key, g] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const conflict = groupConflict(g.records);
    if (conflict) {
      problems.push(`${key}: ${conflict}`);
      continue;
    }
    const best = Math.max(...g.records.map(completeness));
    const kept = g.records.filter((r) => completeness(r) === best);
    superseded += g.records.length - kept.length;
    merged += kept.length - 1;
    out[g.set].push(kept[0] as PairRecord);
  }
  return { records: out, merged, superseded, problems };
}

/** Why the records of one pair cannot be merged, or null. */
function groupConflict(records: readonly PairRecord[]): string | null {
  const first = records[0] as PairRecord;
  for (const r of records.slice(1)) {
    if (r.questionVersion !== first.questionVersion || r.rubricVersion !== first.rubricVersion || r.fingerprint !== first.fingerprint) return 'records of one pair differ in question, rubric or evidence identity';
  }
  for (const i of [0, 1] as const) {
    const outcomes = new Set(records.map((r) => r.judges[i]).filter((j) => j !== undefined && j.status !== 'failed').map((j) => `${j?.key}|${j?.outcome}`));
    if (outcomes.size > 1) return `judge ${i === 0 ? 'A' : 'B'} has different outcomes for one pair (re-judged without its cache?)`;
  }
  const finished = records.filter((r) => FINISHED.has(r.status));
  if (new Set(finished.map((r) => `${r.status}|${String(r.label)}`)).size > 1) return 'finished records of one pair disagree on the label';
  const decisions = new Set(finished.filter((r) => r.adjudication !== null).map((r) => `${r.adjudication?.initialKey}|${r.adjudication?.key}|${String(r.adjudication?.final)}`));
  if (decisions.size > 1) return 'finished records of one pair disagree on the adjudication';
  return null;
}
