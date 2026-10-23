/**
 * Run manifests (Task 16d; 16d reply §6 High 2): the immutable identity of a calibration
 * run. A manifest binds the protocol and candidate, the model, thinking mode and effort,
 * the check prompt's version and the sha256 of its system prompt, the output schema's
 * version and the sha256 of the JSON schema the adapter sends, the caps, the call timeout
 * and the maximum claim count, the dataset (its file and evidence hashes and the split's
 * label hash) and the sha256 of every planned trial input, with the planned trial slots.
 * Its id is the sha256 of all of that (the creation time aside). Protocol v3 (Task 16e)
 * adds the run's transport timeout (`measureTimeoutMs`), the allocation it is charged to,
 * the frozen rule versions and the protocol file's sha256.
 *
 * Every trial row carries its manifest id. `--resume` needs an existing manifest file and
 * its trials file, rebuilds the manifest from the code and data as they are now, refuses
 * any difference, and runs only the slots the manifest planned that have no trial yet. A
 * held-out split runs under one manifest only: no new held-out manifest is created once
 * one exists, and resuming never creates one.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Effort, ThinkingMode } from '../../server/ai/anthropic.js';
import type { CalibrationBatch, CalibrationDataset } from './build.js';
import type { Trial } from './metrics.js';

export const MANIFEST_VERSION = 'checker-run-manifest-v1';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** JSON with sorted object keys, so a hash never depends on property order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export interface RunIdentity {
  protocol: string;
  candidate: string;
  split: 'dev' | 'holdout';
  model: string;
  thinking: ThinkingMode;
  effort: Effort;
  prompt: { version: string; systemSha256: string };
  outputSchema: { version: string; sha256: string };
  caps: { input: number; output: number };
  /** The production check timeout (protocol v3: the figures are censored at it). */
  timeoutMs: number;
  maxClaims: number;
  dataset: { version: string; fileSha256: string; evidenceSha256: string; evidenceV2Sha256: string | null; evidenceV3Sha256?: string | null; labelsSha256: string };
  /** Protocol v3: the run's transport timeout, which measures latency past `timeoutMs`. */
  measureTimeoutMs?: number;
  /** Protocol v3: the allocation the run is charged to. */
  allocation?: string;
  /** Protocol v3: the rule versions the run measured (`FROZEN_RULES`). */
  rules?: Record<string, string>;
  /** Protocol v3: the protocol file's sha256. */
  protocolSha256?: string;
  /** sha256 of every planned slot's input, in slot order. */
  inputsSha256: string;
  slots: { batch: string; sample: number }[];
}

export interface RunManifest extends RunIdentity {
  version: typeof MANIFEST_VERSION;
  id: string;
  createdAt: string;
}

/** The planned slots' inputs, hashed. */
export function inputsSha256(batches: readonly CalibrationBatch[], slots: readonly { batch: string; sample: number }[]): string {
  const byId = new Map(batches.map((b) => [b.id, b]));
  return sha(canonical(slots.map((s) => [s.batch, s.sample, byId.get(s.batch)?.input ?? null])));
}

export function manifestId(identity: RunIdentity): string {
  return sha(canonical({ version: MANIFEST_VERSION, ...identity }));
}

export function newManifest(identity: RunIdentity, now = new Date()): RunManifest {
  return { version: MANIFEST_VERSION, ...identity, id: manifestId(identity), createdAt: now.toISOString() };
}

/** The dataset part of an identity, for one split. */
export function datasetIdentity(dataset: CalibrationDataset, fileText: string, split: 'dev' | 'holdout'): RunIdentity['dataset'] {
  const labels = dataset.labels.splits?.[split]?.sha256 ?? dataset.labels.sha256;
  return {
    version: dataset.version,
    fileSha256: sha(fileText),
    evidenceSha256: dataset.evidenceSha256,
    evidenceV2Sha256: dataset.evidenceV2Sha256 ?? null,
    ...(dataset.evidenceV3Sha256 !== undefined ? { evidenceV3Sha256: dataset.evidenceV3Sha256 } : {}),
    labelsSha256: labels,
  };
}

/** Where a manifest and its trials live. */
export function runFiles(dir: string, m: Pick<RunManifest, 'split' | 'candidate' | 'id'>): { manifest: string; trials: string; summary: string } {
  const base = resolve(dir, `${m.split}-${m.candidate}-${m.id.slice(0, 12)}`);
  return { manifest: `${base}.manifest.json`, trials: `${base}.jsonl`, summary: `${base}.summary.json` };
}

export function readManifest(path: string): RunManifest {
  if (!existsSync(path)) throw new Error(`no manifest at ${path}`);
  const m = JSON.parse(readFileSync(path, 'utf8')) as RunManifest;
  if (m.version !== MANIFEST_VERSION) throw new Error('not a run manifest of this version');
  const { version: _v, id, createdAt: _c, ...identity } = m;
  if (manifestId(identity as RunIdentity) !== id) throw new Error('the manifest file does not hash to its id');
  return m;
}

/** Every manifest file in `dir`. */
export function manifestsIn(dir: string): RunManifest[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.manifest.json'))
    .map((f) => readManifest(resolve(dir, f)));
}

/**
 * The recorded trials of a manifest, and the slots still to run. A row of another manifest,
 * or a slot the manifest did not plan, refuses the file.
 */
export function resumeState(m: RunManifest, trialsPath: string): { done: Trial[]; todo: { batch: string; sample: number }[] } {
  if (!existsSync(trialsPath)) throw new Error(`no trials file at ${trialsPath}`);
  const rows = readFileSync(trialsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Trial);
  const planned = new Set(m.slots.map((s) => `${s.batch}#${s.sample}`));
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.manifest !== m.id) throw new Error('the trials file has a row of another manifest');
    const key = `${r.batch}#${r.sample}`;
    if (!planned.has(key)) throw new Error(`the trials file has an unplanned slot ${key}`);
    if (seen.has(key)) throw new Error(`the trials file has slot ${key} twice`);
    seen.add(key);
  }
  return { done: rows, todo: m.slots.filter((s) => !seen.has(`${s.batch}#${s.sample}`)) };
}

/** Same identity, field by field (for a readable refusal). */
export function identityDifferences(a: RunIdentity, b: RunIdentity): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof RunIdentity>;
  return [...keys].filter((k) => canonical(a[k]) !== canonical(b[k]));
}
