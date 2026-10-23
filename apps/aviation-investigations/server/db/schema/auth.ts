/**
 * Google sign-in (Task 20; DESIGN §4 "Identity", §7): the tables Better Auth reads and
 * writes through its Drizzle adapter (server/auth/better-auth.ts), under our names. The
 * adapter addresses each table by its Better Auth model (`user`, `session`, `account`,
 * `verification`) and each column by the property name below, which is Better Auth's
 * field name; the PostgreSQL names follow the rest of the schema.
 *
 * What is kept (UI_DESIGN §4.8: "We keep your Google account ID, email and name"):
 *
 * - `auth_users`: name and email, verified by Google, and when the row was made. No
 *   picture (CHECK).
 * - `auth_accounts`: the Google subject (`account_id`, the OIDC `sub`) of each user,
 *   unique per provider: identity is the subject, never the mutable email. No provider
 *   tokens, scopes or password: CHECK constraints refuse them, so a library change that
 *   tried to store one would fail sign-in instead of keeping it.
 * - `auth_sessions`: the database session behind the session cookie and its fixed
 *   expiry. No IP address or user agent (CHECK).
 * - `auth_verifications`: OAuth state for at most 10 minutes (the PKCE verifier, the
 *   return paths, the ID-token nonce and the brief a sign-in may take over), deleted when
 *   the callback consumes it.
 *
 * The anti-abuse record that outlives an account is `abuse_records` (controls.ts), keyed
 * by HMAC(issuer, sub) and never linked to these rows. Grants, account deletion and
 * retention are in migration 0017.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

const tsz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** The only sign-in provider. */
export const AUTH_PROVIDER = 'google';

export const authUsers = pgTable(
  'auth_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email').notNull().unique('auth_users_email_key'),
    emailVerified: boolean('email_verified').notNull(),
    /** Never stored (CHECK): Better Auth's schema has the column, the casebook keeps no picture. */
    image: text('image'),
    createdAt: tsz('created_at').notNull(),
    updatedAt: tsz('updated_at').notNull(),
  },
  (t) => [
    check(
      'auth_users_values_check',
      sql`${t.emailVerified} and ${t.image} is null and length(${t.name}) <= 200 and length(${t.email}) between 3 and 320`,
    ),
  ],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The random session token; the cookie holds it with an HMAC signature. */
    token: text('token').notNull().unique('auth_sessions_token_key'),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    expiresAt: tsz('expires_at').notNull(),
    createdAt: tsz('created_at').notNull(),
    updatedAt: tsz('updated_at').notNull(),
    /** Never stored (CHECK). */
    ipAddress: text('ip_address'),
    /** Never stored (CHECK). */
    userAgent: text('user_agent'),
  },
  (t) => [
    check(
      'auth_sessions_values_check',
      sql`${t.ipAddress} is null and ${t.userAgent} is null and length(${t.token}) between 16 and 255 and ${t.expiresAt} > ${t.createdAt}`,
    ),
    index('auth_sessions_user_idx').on(t.userId),
    index('auth_sessions_expires_idx').on(t.expiresAt),
  ],
);

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The provider's subject: Google's `sub`. */
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    /** The token, scope and password columns are never filled (CHECK). */
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: tsz('access_token_expires_at'),
    refreshTokenExpiresAt: tsz('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: tsz('created_at').notNull(),
    updatedAt: tsz('updated_at').notNull(),
  },
  (t) => [
    unique('auth_accounts_provider_account_key').on(t.providerId, t.accountId),
    unique('auth_accounts_user_provider_key').on(t.userId, t.providerId),
    check(
      'auth_accounts_values_check',
      sql`${t.providerId} = ${sql.raw(`'${AUTH_PROVIDER}'`)} and ${t.accountId} ~ '^[!-~]{1,255}$'
        and ${t.accessToken} is null and ${t.refreshToken} is null and ${t.idToken} is null
        and ${t.accessTokenExpiresAt} is null and ${t.refreshTokenExpiresAt} is null
        and ${t.scope} is null and ${t.password} is null`,
    ),
  ],
);

export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: tsz('expires_at').notNull(),
    createdAt: tsz('created_at').notNull(),
    updatedAt: tsz('updated_at').notNull(),
  },
  (t) => [
    check('auth_verifications_values_check', sql`length(${t.identifier}) <= 200 and length(${t.value}) <= 8192`),
    index('auth_verifications_identifier_idx').on(t.identifier),
    index('auth_verifications_expires_idx').on(t.expiresAt),
  ],
);

/** The tables in the shape the Better Auth Drizzle adapter addresses them (by model name). */
export const AUTH_SCHEMA = {
  user: authUsers,
  session: authSessions,
  account: authAccounts,
  verification: authVerifications,
} as const;

/** Sign-in tables, children first (test resets). */
export const AUTH_TABLES = ['auth_sessions', 'auth_accounts', 'auth_verifications', 'auth_users'] as const;
