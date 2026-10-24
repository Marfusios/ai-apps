/** Ownership and content are read by one statement; publication never changes saved rankings. */
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { and, eq, getTableColumns, gt, or, sql } from 'drizzle-orm';
import type { ScopeReply } from '../../shared/contracts/briefs.js';
import { EVIDENCE_CONTRACT_VERSION, EVIDENCE_PAGE_SIZE, EVIDENCE_TTL_MS, EvidencePageSchema, type EvidenceQuery, type EvidenceSuggestion, type EvidenceHint, type EvidenceCase, type EvidencePage } from '../../shared/contracts/evidence.js';
import type { BriefReader } from '../briefs/store.js';
import type { DbOrTx } from '../db/client.js';
import { evidenceSearches } from '../db/schema/evidence.js';
import type { ProjectionContext } from '../projection/cases.js';
import { suggestedHighlights, type RankedEvidenceCase } from './project.js';

export interface SearchData {
  question: string;
  edited: boolean;
  context: ProjectionContext;
  version: typeof EVIDENCE_CONTRACT_VERSION;
  query: EvidenceQuery;
  appliedFilters: BriefFilters;
  suggestion: EvidenceSuggestion | null;
  hint: EvidenceHint | null;
  ranking?: RankedEvidenceCase[];
  cases?: EvidenceCase[];
  reply?: ScopeReply;
}
export type EvidenceRow = Omit<typeof evidenceSearches.$inferSelect, 'data'> & { data: SearchData; resultTotal?: number; resultPage?: number };
/** UTF-8 budget per stored JSON document, including serialization overhead. Never truncate. */
export const EVIDENCE_DATA_MAX_BYTES = 8 * 1024 * 1024;
export function assertSearchDataBudget(data: SearchData): void {
  // Pretty-print overhead conservatively exceeds PostgreSQL jsonb's separator spaces.
  if (Buffer.byteLength(JSON.stringify(data, null, 1), 'utf8') > EVIDENCE_DATA_MAX_BYTES) throw new Error('evidence storage budget exceeded');
}
/** Validate the ordinary result first. Optional model metadata cannot make it unstoreable.
 * If annotations exceed the byte budget, keep the original-query marks and no suggestion.
 * Canonical paragraphs and cause variants are never truncated to make room for metadata. */
export function withSuggestion(data: SearchData, suggestion: EvidenceSuggestion | null): SearchData {
  assertSearchDataBudget(data);
  if (!suggestion) return data;
  try {
    const decorated = { ...data, suggestion, cases: data.cases?.map(c => suggestedHighlights(c, suggestion.terms)) };
    assertSearchDataBudget(decorated);
    return decorated;
  } catch { return data; }
}

export const readersWhere = (readers: readonly BriefReader[]) => or(...readers.map((p) => and(eq(evidenceSearches.readOwner, p.hash), eq(evidenceSearches.readOwnerKind, p.kind))));

export async function readOwnedSearch(db: DbOrTx, id: string, readers: readonly BriefReader[], now: Date, lock = false,
  selection: { page?: number; caseNo?: string } = {}): Promise<EvidenceRow | null> {
  if (!readers.length) return null;
  const page = selection.page;
  if (page !== undefined && (!Number.isSafeInteger(page) || page < 1 || page > 10)) return null;
  const source = evidenceSearches.data;
  const header = sql`jsonb_build_object('question', ${source}->'question', 'edited', ${source}->'edited',
    'context', ${source}->'context', 'version', ${source}->'version', 'query', ${source}->'query',
    'appliedFilters', ${source}->'appliedFilters', 'suggestion', ${source}->'suggestion', 'hint', ${source}->'hint', 'reply', ${source}->'reply')`;
  const data = page === undefined ? sql<SearchData>`${header}` : sql<SearchData>`${header} || jsonb_build_object('cases',
    jsonb_path_query_array(${source}, ${`$.cases[${(page - 1) * EVIDENCE_PAGE_SIZE} to ${page * EVIDENCE_PAGE_SIZE - 1}]`}::jsonpath))`;
  // No query returns the ranking or all pages to Node. The DB checks case membership too.
  const query = db.select({ ...getTableColumns(evidenceSearches), data,
    resultTotal: sql<number>`coalesce(jsonb_array_length(${source}->'cases'), 0)`,
  }).from(evidenceSearches).where(and(eq(evidenceSearches.id, id), gt(evidenceSearches.expiresAt, now), readersWhere(readers),
    sql`${source}->>'version' = ${EVIDENCE_CONTRACT_VERSION}`,
    ...(selection.caseNo ? [sql`${source}->'ranking' @> ${JSON.stringify([{ ntsbNo: selection.caseNo }])}::jsonb`] : [])));
  const [row] = await (lock ? query.for('no key update') : query);
  return row ? { ...row, ...(page === undefined ? {} : { resultPage: page }) } : null;
}
export async function insertSearch(db: DbOrTx, input: Omit<typeof evidenceSearches.$inferInsert, 'createdAt' | 'expiresAt' | 'status' | 'data'> & { now: Date; data: SearchData }): Promise<EvidenceRow> {
  const { now, ...values } = input;
  assertSearchDataBudget(input.data);
  const [row] = await db.insert(evidenceSearches).values({ ...values, createdAt: now, expiresAt: new Date(now.getTime() + EVIDENCE_TTL_MS) }).returning();
  return row as EvidenceRow;
}
export async function finishSearch(db: DbOrTx, id: string, status: 'results' | 'scope_reply' | 'failed', data: SearchData): Promise<boolean> {
  assertSearchDataBudget(data);
  const rows = await db.update(evidenceSearches).set({ status, data }).where(and(eq(evidenceSearches.id, id), eq(evidenceSearches.status, 'running'))).returning({ id: evidenceSearches.id });
  return rows.length === 1;
}
export function pageOf(row: EvidenceRow, page: number): EvidencePage | null {
  if (row.status !== 'results' || row.data.version !== EVIDENCE_CONTRACT_VERSION || !row.data.query || !row.data.cases) return null;
  const total = row.resultTotal ?? row.data.cases.length, pages = Math.ceil(total / EVIDENCE_PAGE_SIZE);
  if (page < 1 || page > Math.max(1, pages)) return null;
  if (row.resultPage !== undefined && row.resultPage !== page) return null;
  return EvidencePageSchema.parse({ version: EVIDENCE_CONTRACT_VERSION, id: row.id, question: row.data.question,
    query: row.data.query, appliedFilters: row.data.appliedFilters, suggestion: row.data.suggestion, hint: row.data.hint, generation: row.data.context.dataset.revision,
    createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), total, page, pages,
    cases: row.resultPage === page ? row.data.cases : row.data.cases.slice((page - 1) * EVIDENCE_PAGE_SIZE, page * EVIDENCE_PAGE_SIZE) });
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
