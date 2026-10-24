/** Ownership and content are read by one statement; publication never changes saved rankings. */
import { and, eq, gt, or, sql } from 'drizzle-orm';
import type { ScopeReply } from '../../shared/contracts/briefs.js';
import { EVIDENCE_CONTRACT_VERSION, EVIDENCE_PAGE_SIZE, EVIDENCE_TTL_MS, EvidencePageSchema, type EvidenceInterpretation, type EvidenceCase, type EvidencePage } from '../../shared/contracts/evidence.js';
import type { BriefReader } from '../briefs/store.js';
import type { DbOrTx } from '../db/client.js';
import { evidenceSearches } from '../db/schema/evidence.js';
import type { ProjectionContext } from '../projection/cases.js';
import type { RankedEvidenceCase } from './project.js';

export interface SearchData {
  question: string;
  edited: boolean;
  context: ProjectionContext;
  interpretation?: EvidenceInterpretation;
  ranking?: RankedEvidenceCase[];
  cases?: EvidenceCase[];
  reply?: ScopeReply;
}
export type EvidenceRow = Omit<typeof evidenceSearches.$inferSelect, 'data'> & { data: SearchData };
export const readersWhere = (readers: readonly BriefReader[]) => or(...readers.map((p) => and(eq(evidenceSearches.readOwner, p.hash), eq(evidenceSearches.readOwnerKind, p.kind))));

export async function readOwnedSearch(db: DbOrTx, id: string, readers: readonly BriefReader[], now: Date, lock = false): Promise<EvidenceRow | null> {
  if (!readers.length) return null;
  const query = db.select().from(evidenceSearches).where(and(eq(evidenceSearches.id, id), gt(evidenceSearches.expiresAt, now), readersWhere(readers)));
  const [row] = await (lock ? query.for('no key update') : query);
  return (row as EvidenceRow | undefined) ?? null;
}
export async function insertSearch(db: DbOrTx, input: Omit<typeof evidenceSearches.$inferInsert, 'createdAt' | 'expiresAt' | 'status' | 'data'> & { now: Date; data: SearchData }): Promise<EvidenceRow> {
  const { now, ...values } = input;
  const [row] = await db.insert(evidenceSearches).values({ ...values, createdAt: now, expiresAt: new Date(now.getTime() + EVIDENCE_TTL_MS) }).returning();
  return row as EvidenceRow;
}
export async function finishSearch(db: DbOrTx, id: string, status: 'results' | 'scope_reply' | 'failed', data: SearchData): Promise<boolean> {
  const rows = await db.update(evidenceSearches).set({ status, data }).where(and(eq(evidenceSearches.id, id), eq(evidenceSearches.status, 'running'))).returning({ id: evidenceSearches.id });
  return rows.length === 1;
}
export function pageOf(row: EvidenceRow, page: number): EvidencePage | null {
  if (row.status !== 'results' || !row.data.interpretation || !row.data.cases) return null;
  const total = row.data.cases.length, pages = Math.ceil(total / EVIDENCE_PAGE_SIZE);
  if (page < 1 || page > Math.max(1, pages)) return null;
  return EvidencePageSchema.parse({ version: EVIDENCE_CONTRACT_VERSION, id: row.id, question: row.data.question,
    interpretation: row.data.interpretation, edited: row.data.edited, generation: row.data.context.dataset.revision,
    createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), total, page, pages,
    cases: row.data.cases.slice((page - 1) * EVIDENCE_PAGE_SIZE, page * EVIDENCE_PAGE_SIZE) });
}
export async function takeOverSearch(db: DbOrTx, id: string, trial: string, account: string): Promise<boolean> {
  const result = await db.execute(sql`SELECT move_evidence_owner(${id}::uuid, ${trial}, ${account}) AS moved`);
  return (result.rows[0] as { moved: boolean }).moved;
}

/** Closed leases cannot leave private searches stuck running. Skip rows a live writer holds. */
export async function failOrphanedSearches(db: DbOrTx): Promise<number> {
  const result = await db.execute(sql`
    UPDATE evidence_searches SET status = 'failed' WHERE id IN (
      SELECT e.id FROM evidence_searches e JOIN reservations r ON r.id = e.reservation_id
      WHERE e.status = 'running' AND r.status <> 'open' ORDER BY e.id FOR UPDATE OF e SKIP LOCKED
    )`);
  return result.rowCount ?? 0;
}
