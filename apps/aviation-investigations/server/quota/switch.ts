/**
 * The AI kill switch (DESIGN §8): one row, read on every admission. A missing or
 * unreadable row pauses AI (fail closed). It stops interactive AI only; indexing and
 * evaluation are operator-started and bounded by their own monthly allowance.
 * Operators flip it with `pnpm worker ai-switch` (aviation_ingest); the app only reads it.
 */
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { QuotaInputError } from './policy.js';

export interface AiSwitchState {
  enabled: boolean;
  note: string | null;
  updatedAt: Date | null;
}

/** Raw row; timestamps come back as epoch milliseconds (raw queries return them as text). */
interface SwitchRow {
  enabled: boolean;
  note: string | null;
  updated_ms: string;
}

export async function readAiSwitch(db: DbOrTx): Promise<AiSwitchState> {
  const res = await db.execute(
    sql`SELECT enabled, note, (extract(epoch FROM updated_at) * 1000)::bigint AS updated_ms FROM ai_switch WHERE id = 1`,
  );
  const row = res.rows[0] as SwitchRow | undefined;
  if (!row) return { enabled: false, note: null, updatedAt: null };
  return { enabled: row.enabled === true, note: row.note, updatedAt: new Date(Number(row.updated_ms)) };
}

/** Turn interactive AI on or off. The note is for operators only (at most 200 characters). */
export async function setAiSwitch(db: DbOrTx, enabled: boolean, note: string | null = null): Promise<AiSwitchState> {
  if (note !== null && note.length > 200) throw new QuotaInputError('The note is limited to 200 characters');
  const res = await db.execute(
    sql`UPDATE ai_switch SET enabled = ${enabled}, note = ${note}, updated_at = now() WHERE id = 1
        RETURNING enabled, note, (extract(epoch FROM updated_at) * 1000)::bigint AS updated_ms`,
  );
  const row = res.rows[0] as SwitchRow | undefined;
  if (!row) throw new Error('ai_switch row is missing; run the migrations');
  return { enabled: row.enabled, note: row.note, updatedAt: new Date(Number(row.updated_ms)) };
}
