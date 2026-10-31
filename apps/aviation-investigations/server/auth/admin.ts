import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import type { SignedIn } from './better-auth.js';

/** No cookie-cache or request header grants admin access. Recheck the live Google account. */
export async function isAdmin(db: DbOrTx, user: SignedIn | null, emails: readonly string[]): Promise<boolean> {
  if (!user || !emails.includes(user.email.trim().toLowerCase())) return false;
  const result = await db.execute(sql`SELECT 1 FROM auth_users u
    JOIN auth_accounts a ON a.user_id = u.id AND a.provider_id = 'google'
    JOIN auth_sessions s ON s.user_id = u.id
    WHERE u.id = ${user.userId}::uuid AND s.id = ${user.sessionId}::uuid AND s.expires_at > clock_timestamp()
      AND u.email_verified AND lower(trim(u.email)) = ANY(${sql.param([...emails])}::text[])
      AND a.account_id = ${user.principal.subject} LIMIT 1`);
  return result.rows.length === 1;
}
