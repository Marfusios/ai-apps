/**
 * Track N experiment identity and report joins: the pinned prompt, format, schema and
 * validator hashes, the identity a judgment file must match, the record checks, the
 * merge of resumed records and the refusal of conflicts; the holdout-once guard.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { families, guardHoldout, readCalibration, readDataset, recordCheck } from '../../evals/retrieval/narrative/commands.js';
import { bundleKeyOf } from '../../evals/retrieval/narrative/judging.js';
import type { FamilyPool, PoolFile } from '../../evals/retrieval/narrative/pool.js';
import { itemKey } from '../../evals/retrieval/narrative/calibration.js';
import { JUDGE_INPUT_VERSION, VOCABULARY_SHA256 } from '../../evals/retrieval/narrative/evidence.js';
import {
  REQUEST_FORMAT_SHA256,
  SCHEMAS_SHA256,
  experimentIdentity,
  identityDifferences,
  joinJudgments,
  type JudgmentFile,
} from '../../evals/retrieval/narrative/identity.js';
import type { PairRecord } from '../../evals/retrieval/narrative/judging.js';
import { VALIDATOR_VERSION } from '../../evals/retrieval/narrative/judgment.js';
import { ADJUDICATOR_PROMPTS_VERSION, ANSWERABILITY_PROMPTS_VERSION, JUDGE_PROMPTS_VERSION } from '../../evals/retrieval/narrative/prompts.js';

const APP_DIR = resolve(import.meta.dirname, '../..');

/**
 * The pins: an edit to a prompt, a request format, a schema or the validator must bump its
 * version string and update the pin here in the same change (identity.ts).
 */
const REQUEST_PINS: Record<string, string> = {
  'track-n-judge.v3|track-n-adjudicate.v2|track-n-answerability.v3|judge-input-v3': '705e188c6248bfb57ce1e2aa68d39fa5c872851d8ac32c09b77642fc139c9908',
};
/** The facet vocabularies the header renders (review N10): part of every fingerprint and of the request-format hash above. */
const VOCABULARY_PINS: Record<string, string> = {
  'judge-input-v3': 'a1109e135e336bf4b4048a5fd2e856020cbba9e6993cd7bdbba6da24b168cd8b',
};
const SCHEMA_PINS: Record<string, string> = {
  'track-n-validate.v1+quote-ws-v2': '8f2c3ad326bbb8def6d1155addac0e379f88f07d06fd9783ba3fee51ea045e85',
};
const VALIDATOR_SOURCE_PINS: Record<string, string> = {
  'track-n-validate.v1+quote-ws-v2': '38f4c369fdfa57c92bc5cf60c59a44f9488546b53a1366360737802e012f4d6b',
};

describe('pinned prompts, formats, schemas and validator', () => {
  it('ties every request format to its version strings (bump the versions when a prompt or a format changes)', () => {
    const versions = [JUDGE_PROMPTS_VERSION, ADJUDICATOR_PROMPTS_VERSION, ANSWERABILITY_PROMPTS_VERSION, JUDGE_INPUT_VERSION].join('|');
    expect({ versions, sha256: REQUEST_FORMAT_SHA256 }).toEqual({ versions, sha256: REQUEST_PINS[versions] });
  });

  it('ties the facet vocabularies to the input version: an edited vocabulary changes every fingerprint and the request hash', () => {
    expect({ version: JUDGE_INPUT_VERSION, sha256: VOCABULARY_SHA256 }).toEqual({ version: JUDGE_INPUT_VERSION, sha256: VOCABULARY_PINS[JUDGE_INPUT_VERSION] });
    expect((experimentIdentity('calibration', {}) as { input: { vocabularySha256: string } }).input.vocabularySha256).toBe(VOCABULARY_SHA256);
  });

  it('ties the output schemas and limits, and the validator source, to the validator version', () => {
    expect({ version: VALIDATOR_VERSION, sha256: SCHEMAS_SHA256 }).toEqual({ version: VALIDATOR_VERSION, sha256: SCHEMA_PINS[VALIDATOR_VERSION] });
    const source = createHash('sha256').update(readFileSync(resolve(APP_DIR, 'evals/retrieval/narrative/judgment.ts'))).digest('hex');
    expect({ version: VALIDATOR_VERSION, sha256: source }).toEqual({ version: VALIDATOR_VERSION, sha256: VALIDATOR_SOURCE_PINS[VALIDATOR_VERSION] });
  });
});

// ---------------------------------------------------------------------------

const record = (over: Partial<PairRecord> = {}, a = 'oa', b = 'ob'): PairRecord => ({
  kind: 'relevance',
  family: 'fam',
  ntsbNo: 'CEN20LA001',
  bundleKey: null,
  questionVersion: 'q-1',
  rubricVersion: 'r-1',
  fingerprint: 'fp',
  judges: [
    { role: 'judge-a', provider: 'anthropic', model: 'm', key: 'ka', outcome: a, status: 'valid', grade: 2, reason: null, absent: null, cached: false },
    { role: 'judge-b', provider: 'openai', model: 'm', key: 'kb', outcome: b, status: 'valid', grade: 1, reason: null, absent: null, cached: false },
  ],
  adjudication: null,
  label: 'unknown',
  status: 'escalation-budget-exhausted',
  attempts: [],
  verdicts: [],
  ...over,
});
const adjudicated = (final: 0 | 1 | 2, key = 'kf'): Partial<PairRecord> => ({
  status: 'adjudicated',
  label: final,
  adjudication: { initialKey: 'ki', key, order: ['judge-a', 'judge-b'], initial: final, initialStatus: 'valid', final, status: 'valid', cached: false },
});
const identity = experimentIdentity('relevance', { datasetSpecSha256: 'spec', poolVersion: 'pool' });
const file = (name: string, records: PairRecord[], experiment: Record<string, unknown> | null = identity): { name: string; body: JudgmentFile } => ({
  name,
  body: { kind: 'track-n-judgments', set: 'relevance', run: name, ...(experiment ? { experiment } : {}), stopped: null, records },
});
const pass = () => null;

describe('joining judgment files', () => {
  it('merges identical records and lets a finished record supersede a stopped one (a resumed run)', () => {
    const month1 = file('m1', [record(), record({ ntsbNo: 'CEN20LA002', status: 'agreed', label: 2 })]);
    const month2 = file('m2', [record(adjudicated(2)), record({ ntsbNo: 'CEN20LA002', status: 'agreed', label: 2 })]);
    const j = joinJudgments([month1, month2], () => identity, pass);
    expect(j.problems).toEqual([]);
    expect(j.records.relevance.map((r) => [r.ntsbNo, r.status])).toEqual([
      ['CEN20LA001', 'adjudicated'],
      ['CEN20LA002', 'agreed'],
    ]);
    expect({ merged: j.merged, superseded: j.superseded }).toEqual({ merged: 1, superseded: 1 });
  });

  it('refuses a file made under another experiment identity, and names what differs', () => {
    const other = experimentIdentity('relevance', { datasetSpecSha256: 'spec', poolVersion: 'another-pool' });
    const j = joinJudgments([file('old', [record()], other), file('none', [record()], null)], () => identity, pass);
    expect(j.problems).toEqual(['old: made under another experiment identity (data.poolVersion)', 'none: no experiment identity recorded']);
    expect(identityDifferences({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 }, d: 4 })).toEqual(['a.c', 'd']);
  });

  it('refuses records that fail the current data checks (an old rubric, another evidence fingerprint)', () => {
    const j = joinJudgments([file('f', [record({ rubricVersion: 'r-old' })])], () => identity, (_set, r) => (r.rubricVersion === 'r-1' ? null : 'its question or rubric version is not the dataset\'s'));
    expect(j.problems).toEqual(["f: fam CEN20LA001: its question or rubric version is not the dataset's"]);
    expect(j.records.relevance).toEqual([]);
  });

  it('refuses conflicts: a judge with two outcomes for one pair, or two finished records with different labels', () => {
    const judge = joinJudgments([file('a', [record()]), file('b', [record({}, 'another-outcome')])], () => identity, pass);
    expect(judge.problems[0]).toMatch(/judge A has different outcomes/);
    const label = joinJudgments([file('a', [record(adjudicated(2))]), file('b', [record(adjudicated(1, 'kf2'))])], () => identity, pass);
    expect(label.problems[0]).toMatch(/disagree on the label/);
    // A failed judge outcome (never cached) is superseded, not a conflict.
    const failed = record({ status: 'incomplete', judges: [{ ...(record().judges[0] as PairRecord['judges'][number]), status: 'failed', grade: null, outcome: 'failed-hash' }, record().judges[1] as PairRecord['judges'][number]] });
    const resumed = joinJudgments([file('a', [failed]), file('b', [record(adjudicated(2))])], () => identity, pass);
    expect(resumed.problems).toEqual([]);
    expect(resumed.records.relevance[0]?.status).toBe('adjudicated');
  });
});

describe('the holdout runs once per configuration', () => {
  it('lets the same configuration resume and refuses another one on the same holdout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'narrative-holdout-'));
    const a = experimentIdentity('calibration', { calibrationVersion: 'v', labelsSha256: 'labels', criteriaSha256: 'c' });
    const b = { ...a, judges: { changed: true } };
    guardHoldout(dir, 'labels', a);
    guardHoldout(dir, 'labels', a);
    expect(() => guardHoldout(dir, 'labels', b)).toThrow(/needs a fresh holdout set/);
    // A new calibration set (new labels) is a fresh holdout.
    guardHoldout(dir, 'labels-2', b);
    expect(readFileSync(join(dir, 'holdout-runs.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

describe('record checks against the current data', () => {
  const d = readDataset();
  const c = readCalibration();
  const fam = families(d)[0] as ReturnType<typeof families>[number];
  const passages = [{ passageId: 'p1', sectionId: 's', revisionId: 'r', kind: 'factual' as const, scope: 'aircraft' as const, aircraftKey: 1, start: 0, end: 5, textSha256: 'x' }];
  const pool = {
    family: fam.id,
    questionVersion: fam.questionVersion,
    rubricVersion: fam.rubricVersion,
    type: fam.type,
    members: [fam.id],
    memberVersions: { [fam.id]: fam.memberVersion },
    fingerprints: { CASE1: 'fp-pool' },
    cohortSize: 1,
    cases: [{ ntsbNo: 'CASE1', sources: ['method'], bestRank: {}, lureRank: null, delivered: true }],
    tail: { nearSize: 0, farSize: 0, near: [], far: [] },
    runs: [{ member: fam.id, method: 'p50-kt', sample: 1, ranking: ['CASE1'], bundle: [{ ntsbNo: 'CASE1', caseRank: 1, passages }] }],
    version: 'v',
  } as FamilyPool;
  const check = recordCheck(d, c, { families: [pool] } as unknown as PoolFile);
  const ours = { family: fam.id, ntsbNo: 'CASE1', questionVersion: fam.questionVersion, rubricVersion: fam.rubricVersion, fingerprint: 'fp-pool' };

  it('accepts a relevance record of the pool with its recorded fingerprint, and refuses another fingerprint or rubric', () => {
    expect(check('relevance', record(ours))).toBeNull();
    expect(check('relevance', record({ ...ours, fingerprint: 'changed' }))).toMatch(/fingerprint is not the one the pool recorded/);
    expect(check('relevance', record({ ...ours, rubricVersion: 'r-old' }))).toMatch(/rubric version/);
    expect(check('relevance', record({ ...ours, ntsbNo: 'CASE2' }))).toMatch(/not in the family's pool/);
  });

  it('accepts an answerability record of a delivered bundle only', () => {
    expect(check('answerability', record({ ...ours, kind: 'answerability', bundleKey: bundleKeyOf(passages) }))).toBeNull();
    expect(check('answerability', record({ ...ours, kind: 'answerability', bundleKey: 'other' }))).toMatch(/not a delivered bundle/);
  });

  it('accepts a calibration record of a frozen item with its fingerprint only', () => {
    const item = c.items.find((i) => i.kind === 'relevance') as (typeof c.items)[number];
    const r = record({ kind: 'relevance', family: item.question, ntsbNo: item.case.ntsbNo, questionVersion: item.questionVersion, rubricVersion: item.rubricVersion, fingerprint: item.case.fingerprint });
    expect(itemKey(item)).toBe(`relevance|${item.question}|${item.case.ntsbNo}|`);
    expect(check('calibration', r)).toBeNull();
    expect(check('calibration', { ...r, fingerprint: 'changed' })).toMatch(/fingerprint/);
    expect(check('calibration', { ...r, ntsbNo: 'NOPE' })).toMatch(/no frozen calibration item/);
  });
});
