import { sql } from 'drizzle-orm';
import type { Db } from '../../server/db/client.js';
import { VERIFIER_VERSION } from '../../server/db/generations.js';
import { checkExtraction } from './files.js';
import type { ExtractedSnapshot } from './extraction.js';
import { ImportFailure, type ManifestIdentity } from './contracts.js';

/** The read-only seed proves that these projected bytes built this serving corpus. No profile is generated. */
export async function verifyBaseline(
  db: Db,
  snapshot: ExtractedSnapshot,
  baseline: ManifestIdentity,
): Promise<void> {
  await checkExtraction(snapshot.dir, snapshot.hashes);
  const g = (
    await db.execute(sql`select archive_sha256,mapping_version,mapping_verified,citation_text_version,
    field_normalization_version,verification_status,verifier_version from dataset_generations where id=${baseline.generationId}`)
  ).rows[0];
  const facts = snapshot.facts.normalized;
  if (
    !g ||
    g.archive_sha256 !== snapshot.archive ||
    g.mapping_version !== facts.completionMapping.version ||
    g.mapping_verified !== facts.completionMapping.verified ||
    g.citation_text_version !== facts.citationTextVersion ||
    g.field_normalization_version !== facts.fieldNormalizationVersion ||
    g.verification_status !== 'ok' ||
    g.verifier_version !== VERIFIER_VERSION
  )
    throw new ImportFailure('baseline_required');
  const rows = await db.execute(
    sql`select ntsb_no,source_revision from cases where generation_id=${baseline.generationId}`,
  );
  const revisions = new Map(facts.cases.map((c) => [c.ntsbNo, c.sourceRevision]));
  if (
    rows.rows.length !== revisions.size ||
    rows.rows.some((r) => revisions.get(String(r.ntsb_no)) !== r.source_revision)
  ) {
    throw new ImportFailure('baseline_required');
  }
  // sourceRevision is only a tie to the historical load. All new comparison digests are canonical raw-row digests.
}
