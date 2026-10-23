/**
 * What a label set was derived from, and whether a run's target still gives the same
 * labels. Generation ids are per-database sequences, so a dataset records the
 * generation's identity (`dataset_generations`: archive sha256, completion mapping,
 * field normalization and citation text versions) next to its id, and a run re-derives
 * every question's labels on the target generation (read-only) before anything is
 * embedded (`targetProblems`). Used by both evaluation tracks.
 */
import type pg from 'pg';
import { z } from 'zod';

/** The fields a dataset's `source` records about its generation, besides the id. */
export const GENERATION_IDENTITY_FIELDS = {
  archiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
  mappingVersion: z.string().min(1),
  fieldNormalizationVersion: z.string().min(1),
  citationTextVersion: z.string().min(1),
} as const;

export interface GenerationSource {
  generationId: number;
  archiveSha256: string;
  /** Completion mapping (which records are answer-eligible). */
  mappingVersion: string;
  /** Scalars, codes and flags. */
  fieldNormalizationVersion: string;
  /** Narrative section text. */
  citationTextVersion: string;
}

/** A generation's identity, read from `dataset_generations` (the app role may read it). */
export async function readGenerationSource(client: pg.ClientBase, generationId: number): Promise<GenerationSource> {
  const r = await client.query<{ archive_sha256: string; mapping_version: string; field_normalization_version: string; citation_text_version: string }>(
    `select archive_sha256, mapping_version, field_normalization_version, citation_text_version
       from dataset_generations where id = $1`,
    [generationId],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`generation ${generationId} does not exist`);
  return {
    generationId,
    archiveSha256: row.archive_sha256,
    mappingVersion: row.mapping_version,
    fieldNormalizationVersion: row.field_normalization_version,
    citationTextVersion: row.citation_text_version,
  };
}

/** One question's labels: its positive cases, and (coded) the coded cases its filters cannot reach. */
export interface QuestionLabels {
  relevant: readonly string[];
  unreachable?: readonly string[];
}

/** A run's target: its generation's identity and every question's labels re-derived there. */
export interface TargetCheck {
  source: GenerationSource;
  labels: ReadonlyMap<string, QuestionLabels>;
  /** Not problems: things an operator should know (e.g. new codes of a frozen code family). */
  warnings: string[];
}

const IDENTITY: readonly [keyof Omit<GenerationSource, 'generationId'>, string][] = [
  ['archiveSha256', 'source archive sha256'],
  ['mappingVersion', 'completion mapping version'],
  ['fieldNormalizationVersion', 'field normalization version'],
  ['citationTextVersion', 'citation text version'],
];

function setDifference(recorded: readonly string[], derived: readonly string[]): string {
  const r = new Set(recorded);
  const d = new Set(derived);
  const added = derived.filter((n) => !r.has(n));
  const removed = recorded.filter((n) => !d.has(n));
  const show = (xs: string[]) => `${xs.slice(0, 5).join(', ')}${xs.length > 5 ? ', ...' : ''}`;
  return [added.length > 0 ? `+${added.length} (${show(added)})` : '', removed.length > 0 ? `-${removed.length} (${show(removed)})` : ''].filter(Boolean).join(' ');
}

/**
 * Problems that make a run invalid: the target generation differs from the dataset's
 * (id or identity), or some question's labels re-derived on the target differ from the
 * dataset's. Empty when the dataset's labels hold on the target.
 */
export function targetProblems(
  set: 'silver' | 'coded',
  recorded: { source: GenerationSource; labels: ReadonlyMap<string, QuestionLabels> },
  target: TargetCheck,
): string[] {
  const problems: string[] = [];
  if (recorded.source.generationId !== target.source.generationId) {
    problems.push(`generation: the ${set} set was built from generation ${recorded.source.generationId}; the target is generation ${target.source.generationId}`);
  }
  for (const [field, label] of IDENTITY) {
    if (recorded.source[field] !== target.source[field]) {
      problems.push(`generation: the ${set} set was built from ${label} ${recorded.source[field]}; the target generation has ${target.source[field]}`);
    }
  }
  for (const [id, labels] of recorded.labels) {
    const derived = target.labels.get(id);
    if (!derived) {
      problems.push(`labels: ${id} was not re-derived on the target`);
      continue;
    }
    const sorted = (xs: readonly string[] | undefined) => [...(xs ?? [])].sort();
    if (JSON.stringify(sorted(labels.relevant)) !== JSON.stringify(sorted(derived.relevant))) {
      problems.push(`labels: ${id}: the target derives ${derived.relevant.length} positive cases, the dataset has ${labels.relevant.length}: ${setDifference(labels.relevant, derived.relevant)}`);
    }
    if (JSON.stringify(sorted(labels.unreachable)) !== JSON.stringify(sorted(derived.unreachable))) {
      problems.push(`labels: ${id}: unreachable cases differ on the target: ${setDifference(labels.unreachable ?? [], derived.unreachable ?? [])}`);
    }
  }
  return problems;
}
