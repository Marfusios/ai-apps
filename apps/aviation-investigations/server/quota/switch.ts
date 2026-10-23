/**
 * The AI kill switch (DESIGN §8): one row, read on every admission. A missing or
 * unreadable row pauses AI (fail closed). It stops interactive AI only; indexing and
 * evaluation are operator-started and bounded by their own monthly allowance.
 *
 * Its second flag, `anonymousEnabled`, is the login-required emergency mode (DESIGN §7):
 * off, anonymous trials are refused (admission `login_required`, status
 * `signed_in_only`) and signed-in AI continues. A missing row turns it off too.
 *
 * `accountCheck` says when a signed-in AI request takes a Turnstile check
 * (server/identity/step-up.ts): `suspicious` (the default: only on the documented signals)
 * or `always` (every signed-in request, an operator's emergency setting). A missing row
 * means `always`.
 *
 * Operators flip them with `pnpm worker ai-switch` (aviation_ingest); the app only reads them.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { ACCOUNT_CHECK_MODES, type AccountCheckMode } from '../db/schema/index.js';
import { QuotaInputError } from './policy.js';

export interface AiSwitchState {
  enabled: boolean;
  /** False in the login-required emergency mode. */
  anonymousEnabled: boolean;
  /** When signed-in AI requests take a Turnstile check. */
  accountCheck: AccountCheckMode;
  note: string | null;
  updatedAt: Date | null;
}

/** Raw row; timestamps come back as epoch milliseconds (raw queries return them as text). */
interface SwitchRow {
  enabled: boolean;
  anonymous_enabled: boolean;
  account_check: string;
  note: string | null;
  updated_ms: string;
}

const COLUMNS = sql`enabled, anonymous_enabled, account_check, note, (extract(epoch FROM updated_at) * 1000)::bigint AS updated_ms`;

function stateOf(row: SwitchRow): AiSwitchState {
  return {
    enabled: row.enabled === true,
    anonymousEnabled: row.anonymous_enabled === true,
    accountCheck: row.account_check === 'suspicious' ? 'suspicious' : 'always',
    note: row.note,
    updatedAt: new Date(Number(row.updated_ms)),
  };
}

export async function readAiSwitch(db: DbOrTx): Promise<AiSwitchState> {
  const res = await db.execute(sql`SELECT ${COLUMNS} FROM ai_switch WHERE id = 1`);
  const row = res.rows[0] as SwitchRow | undefined;
  if (!row) return { enabled: false, anonymousEnabled: false, accountCheck: 'always', note: null, updatedAt: null };
  return stateOf(row);
}

function checkNote(note: string | null): void {
  if (note !== null && note.length > 200) throw new QuotaInputError('The note is limited to 200 characters');
}

async function update(db: DbOrTx, assignments: SQL): Promise<AiSwitchState> {
  const res = await db.execute(sql`UPDATE ai_switch SET ${assignments}, updated_at = now() WHERE id = 1 RETURNING ${COLUMNS}`);
  const row = res.rows[0] as SwitchRow | undefined;
  if (!row) throw new Error('ai_switch row is missing; run the migrations');
  return stateOf(row);
}

/** Turn interactive AI on or off. The note is for operators only (at most 200 characters). */
export async function setAiSwitch(db: DbOrTx, enabled: boolean, note: string | null = null): Promise<AiSwitchState> {
  checkNote(note);
  return update(db, sql`enabled = ${enabled}, note = ${note}`);
}

/**
 * When signed-in AI requests take a Turnstile check: `suspicious` (the default) or
 * `always`. A note replaces the operator note; without one the note is kept.
 */
export async function setAccountCheck(db: DbOrTx, mode: AccountCheckMode, note?: string | null): Promise<AiSwitchState> {
  if (!ACCOUNT_CHECK_MODES.includes(mode)) throw new QuotaInputError('The account check is suspicious or always');
  if (note === undefined) return update(db, sql`account_check = ${mode}`);
  checkNote(note);
  return update(db, sql`account_check = ${mode}, note = ${note}`);
}

/**
 * Allow anonymous trials, or turn on the login-required emergency mode (`false`). A
 * note replaces the operator note; without one the note is kept.
 */
export async function setAnonymousAi(db: DbOrTx, enabled: boolean, note?: string | null): Promise<AiSwitchState> {
  if (note === undefined) return update(db, sql`anonymous_enabled = ${enabled}`);
  checkNote(note);
  return update(db, sql`anonymous_enabled = ${enabled}, note = ${note}`);
}
