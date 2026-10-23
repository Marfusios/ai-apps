/**
 * The checker calibration's frozen evidence: the real retrieval bundles of `questions.ts`
 * as the brief pipeline checked them (every passage resolved against its canonical row
 * and section revision, `verifyBundle`), with the aircraft of each case. Public NTSB text.
 * The builder rebuilds the pipeline's `VerifiedCase`s from it, so the calibration claims
 * are rendered by production code.
 *
 * - `evidence.json` (`checker-evidence-v1`, Task 16c, frozen): the nine 16c bundles.
 * - `evidence-16d.json` (`checker-evidence-v2`, Task 16d): every case's header line from
 *   the NTSB record's coded fields (`caseHeader`, the check input's server data since
 *   Task 16d), for the 16c cases and the new ones, and the new held-out bundles.
 *
 * Both files were retrieved before retrieval versions existed (task 10e), so they carry no
 * `source.retrievalVersion`: they are `retrieval.v1` bundles. `evidence-16e.json`
 * (`checker-evidence-v3`, Task 16e) holds the 16e held-out bundles, retrieved under
 * `retrieval.v2` with each case's channel provenance.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RetrievalVersionSchema } from '../../shared/contracts/retrieval.js';
import type { CaseSummary } from '../../server/briefs/evidence.js';
import type { VerifiedCase } from '../../server/briefs/render.js';

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const EvidencePassageSchema = z.strictObject({
  passageId: Hex64,
  ntsbNo: z.string().regex(/^[A-Z0-9]{6,16}$/),
  role: z.enum(['retrieved', 'probable_cause', 'fill']),
  reserved: z.boolean(),
  rank: z.number().int().positive().nullable(),
  sectionKind: z.enum(['factual', 'analysis', 'probable_cause']),
  scope: z.enum(['aircraft', 'event']),
  aircraftKey: z.number().int().nonnegative().nullable(),
  sectionId: z.string().min(1),
  revisionId: Hex64,
  sectionSha: Hex64,
  sectionStart: z.number().int().nonnegative(),
  text: z.string().min(1),
  /** sha256 of `text` (UTF-8), so a changed snapshot is caught offline. */
  textSha: Hex64,
});
export type EvidencePassage = z.infer<typeof EvidencePassageSchema>;

export const EvidenceCaseSchema = z.strictObject({
  ntsbNo: z.string().regex(/^[A-Z0-9]{6,16}$/),
  rank: z.number().int().positive(),
  aircraft: z.array(z.strictObject({ aircraftKey: z.number().int().nonnegative(), make: z.string().nullable(), model: z.string().nullable() })).min(1),
  passages: z.array(EvidencePassageSchema).min(1),
});
export type EvidenceCase = z.infer<typeof EvidenceCaseSchema>;

export const EvidenceBundleSchema = z.strictObject({
  question: z.string().min(1),
  split: z.enum(['dev', 'holdout']),
  cases: z.array(EvidenceCaseSchema).min(1).max(6),
});
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

export const EvidenceFileSchema = z.strictObject({
  version: z.literal('checker-evidence-v1'),
  source: z.strictObject({
    generationId: z.number().int().positive(),
    passagesIndex: z.string().min(1),
    chunkerVersion: z.string().min(1),
    /** The retrieval version the bundles were retrieved under; absent in files retrieved before versions existed (`retrieval.v1`). */
    retrievalVersion: RetrievalVersionSchema.optional(),
    retrievedAt: z.iso.datetime(),
    note: z.string(),
  }),
  bundles: z.array(EvidenceBundleSchema).min(1),
});
export type EvidenceFile = z.infer<typeof EvidenceFileSchema>;

/** `evidence-16d.json`: headers for every calibration case, and the 16d bundles. */
export const EvidenceV2FileSchema = z.strictObject({
  version: z.literal('checker-evidence-v2'),
  source: z.strictObject({
    generationId: z.number().int().positive(),
    passagesIndex: z.string().min(1),
    chunkerVersion: z.string().min(1),
    /** As in `checker-evidence-v1`: absent in files retrieved before versions existed (`retrieval.v1`). */
    retrievalVersion: RetrievalVersionSchema.optional(),
    retrievedAt: z.iso.datetime(),
    note: z.string(),
  }),
  /** NTSB number → `checkHeader` of its canonical case summary (the check stage's server data). */
  headers: z.record(z.string().regex(/^[A-Z0-9]{6,16}$/), z.string().min(1).max(400)),
  bundles: z.array(EvidenceBundleSchema),
});
export type EvidenceV2File = z.infer<typeof EvidenceV2FileSchema>;

/**
 * `evidence-16e.json` (`checker-evidence-v3`, Task 16e): the 16e held-out bundles, retrieved
 * under `retrieval.v2` (the production default since task 10e), with each case's header and
 * where retrieval found it: its rank in each channel's window (keyword, vector, and the
 * cases-index channel; null when that channel did not return it) and whether it reached the
 * bundle only through the cases channel, mapped to its own passages (`mapped`). The cases
 * index is recorded by its `_meta` version only.
 */
export const EvidenceV3CaseSchema = EvidenceCaseSchema.extend({
  channels: z.strictObject({
    keyword: z.number().int().positive().nullable(),
    vector: z.number().int().positive().nullable(),
    cases: z.number().int().positive().nullable(),
  }),
  mapped: z.boolean(),
});
export const EvidenceV3FileSchema = z.strictObject({
  version: z.literal('checker-evidence-v3'),
  source: z.strictObject({
    generationId: z.number().int().positive(),
    passagesIndex: z.string().min(1),
    chunkerVersion: z.string().min(1),
    retrievalVersion: z.literal('retrieval.v2'),
    casesIndexVersion: z.string().min(1),
    retrievedAt: z.iso.datetime(),
    note: z.string(),
  }),
  headers: z.record(z.string().regex(/^[A-Z0-9]{6,16}$/), z.string().min(1).max(400)),
  bundles: z.array(EvidenceBundleSchema.extend({ cases: z.array(EvidenceV3CaseSchema).min(1).max(6) })),
});
export type EvidenceV3File = z.infer<typeof EvidenceV3FileSchema>;

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * The pipeline's verified cases of a frozen bundle (only the fields the check renderer and
 * the criteria read). `headers`: each case's server header line; without one (the 16c
 * inputs, which had none) the aircraft names stand in, and only claim structure is read.
 */
export function verifiedCases(bundle: EvidenceBundle, headers: ReadonlyMap<string, string> = new Map()): VerifiedCase[] {
  return bundle.cases.map((c) => ({
    ntsbNo: c.ntsbNo,
    rank: c.rank,
    summary: { row: { aircraft: c.aircraft }, report: {}, aircraftNumbers: [] } as unknown as CaseSummary,
    // Calibration runs the check stage only: its header is the check header.
    header: headers.get(c.ntsbNo) ?? (c.aircraft.map((a) => [a.make, a.model].filter(Boolean).join(' ')).join(', ') || c.ntsbNo),
    checkHeader: headers.get(c.ntsbNo) ?? (c.aircraft.map((a) => [a.make, a.model].filter(Boolean).join(' ')).join(', ') || c.ntsbNo),
    passages: c.passages.map((p) => ({
      passageId: p.passageId,
      role: p.role,
      reserved: p.reserved,
      rank: p.rank,
      sectionKind: p.sectionKind,
      allowed: {
        ntsbNo: p.ntsbNo,
        text: p.text,
        sha: p.sectionSha,
        sectionId: p.sectionId,
        revisionId: p.revisionId,
        sectionKind: p.sectionKind,
        sectionStart: p.sectionStart,
        scope: p.scope,
        aircraftKey: p.aircraftKey,
      },
    })),
  }));
}

/** Problems with a snapshot: a text that no longer hashes to its recorded sha, a case in two splits. */
export function evidenceProblems(file: EvidenceFile): string[] {
  const problems: string[] = [];
  const splitOf = new Map<string, string>();
  for (const b of file.bundles) {
    for (const c of b.cases) {
      const seen = splitOf.get(c.ntsbNo);
      if (seen && seen !== b.split) problems.push(`case ${c.ntsbNo} is in both splits`);
      splitOf.set(c.ntsbNo, b.split);
      for (const p of c.passages) {
        if (sha256(p.text) !== p.textSha) problems.push(`passage ${p.passageId.slice(0, 12)} text does not match its sha`);
        if (p.ntsbNo !== c.ntsbNo) problems.push(`passage ${p.passageId.slice(0, 12)} is not of ${c.ntsbNo}`);
      }
    }
  }
  return problems;
}
