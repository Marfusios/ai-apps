/**
 * The real API server with Google sign-in, for the browser tests of signing in and out
 * (tests/e2e-real/sign-in-out.spec.ts, `pnpm test:e2e:real`). The browser's cookies are
 * Chromium's own, so `SameSite` applies as in production. The parts:
 *
 * - **The app** listens on http://127.0.0.1:E2E_AUTH_PORT (default 5182). Google sign-in uses
 *   aviation_test and synthetic secrets. No web client is served; the tests drive the API
 *   from a page on this origin.
 * - **A stand-in for Google** listens on http://localhost:E2E_GOOGLE_PORT (default 5183),
 *   which is another site. Its authorization endpoint checks the request the way Google
 *   does (tests/support/mock-google.ts) and shows a page whose "Continue" link goes back to
 *   the app's callback with the code. As at Google, where the user continues on Google's
 *   page, the callback is then a top-level navigation started by another site. The server's
 *   code exchange and key fetch go to the same mock, as the global fetch. Nothing leaves the
 *   machine.
 * - **Controls for the tests**, on the stand-in's port and never on the app's:
 *   - `POST /control/deletions {failing}`: the session deletions of the sign-in service fail
 *     ("connection terminated"), as when the database is down.
 *   - `POST /control/hold-sign-in`: a sign-in start's answer is held, after the server has
 *     handled it; `GET /control/held` counts those waiting; `POST /control/release-sign-in`
 *     lets them go.
 *   - `GET /control/sessions`: how many sessions exist.
 *
 * It empties aviation_test's control and auth tables when it starts, as the integration
 * tests do before each test, so run it under the integration lock, never alongside
 * `pnpm test:integration`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Client } from '@elastic/elasticsearch';
import { sql } from 'drizzle-orm';
import { loadConfig, type AppConfig } from '../../shared/config.js';
import { buildApp } from '../../server/app.js';
import { createAuthService } from '../../server/auth/better-auth.js';
import { closeDb } from '../../server/db/client.js';
import { TrialIdentities } from '../../server/identity/trial.js';
import { quotaPolicy } from '../../server/quota/policy.js';
import { resetControls, testDb } from '../integration/helpers.js';
import { GOOGLE_AUTHORIZE_URL, MockGoogle } from '../support/mock-google.js';

const appPort = Number(process.env.E2E_AUTH_PORT) || 5182;
const googlePort = Number(process.env.E2E_GOOGLE_PORT) || 5183;
const APP = `http://127.0.0.1:${appPort}`;
const GOOGLE = `http://localhost:${googlePort}`;
const CLIENT_ID = 'casebook-e2e.apps.googleusercontent.com';
const CLIENT_SECRET = 'synthetic-google-client-secret';

const base = loadConfig({ env: {}, files: [] });
const config: AppConfig = {
  ...base,
  nodeEnv: 'test',
  appEnv: 'dev',
  appUrl: APP,
  auth: {
    identityHmacSecret: 'e2e-identity-hmac-secret-0123456789',
    ipHmacSecret: 'e2e-network-hmac-secret-0123456789',
    secret: 'e2e-better-auth-secret-0123456789abcdef',
    googleClientId: CLIENT_ID,
    googleClientSecret: CLIENT_SECRET,
  },
};

await resetControls();
const db = testDb('app');
// The sign-in service's own pool: its session deletions fail while `failing` is set.
const authDb = testDb('app');
let failing = false;
const pool = authDb.$client as unknown as { query: (...args: unknown[]) => unknown };
const query = pool.query.bind(pool);
pool.query = (statement: unknown, ...rest: unknown[]) => {
  const text = typeof statement === 'string' ? statement : (statement as { text?: unknown } | null)?.text;
  if (failing && typeof text === 'string' && /delete\s+from\s+"?auth_sessions"?/i.test(text)) return Promise.reject(new Error('Connection terminated unexpectedly'));
  return query(statement, ...rest);
};

const google = new MockGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: `${APP}/api/auth/callback/google` });
globalThis.fetch = google.fetch;

const policy = quotaPolicy(config);
const trials = new TrialIdentities({ db, policy, secure: false });
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const signIn = createAuthService(config, { db: authDb, policy, trials, log: quiet, rateLimits: { signIn: 1_000, callback: 1_000, signOut: 1_000 } });
if (!signIn.service) throw new Error(`sign-in is off: ${signIn.problem}`);

const app = buildApp({
  config: { appUrl: APP, trustedProxyCidrs: [] },
  db,
  es: new Client({ node: 'http://localhost:9' }), // never used: no route here reads an index
  auth: signIn.service,
  logger: false,
  rateLimit: { limit: 10_000, windowMs: 60_000 },
});

// A sign-in start's answer can be held after the server has handled it (see the controls).
let hold: { released: Promise<void>; release: () => void; waiting: number } | null = null;
app.addHook('onSend', async (request, _reply, payload) => {
  const held = hold;
  if (held && request.method === 'POST' && request.url.startsWith('/api/auth/sign-in/social')) {
    held.waiting += 1;
    await held.released;
  }
  return payload;
});
await app.listen({ host: '127.0.0.1', port: appPort });

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += String(chunk);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', GOOGLE);
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /o/oauth2/v2/auth') {
    // Google's page: the user continues, and the browser goes back to the app's callback.
    const name = url.searchParams.get('e2e_user') ?? 'pilot';
    url.searchParams.delete('e2e_user');
    const sub = `10${[...name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 1e12, 7).toString().padStart(18, '0')}`;
    const back = google.authorize(`${GOOGLE_AUTHORIZE_URL}${url.search}`, { sub, email: `e2e-${name}@example.com`, name: `E2E ${name}` });
    const href = `${APP}${back}`.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Google stand-in</title><a id="continue" href="${href}">Continue</a>`);
    return;
  }
  if (route === 'GET /control/ready') return json(res, { ready: true });
  if (route === 'POST /control/deletions') {
    failing = (await bodyOf(req)).failing === true;
    return json(res, { failing });
  }
  if (route === 'POST /control/hold-sign-in') {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    hold = { released, release, waiting: 0 };
    return json(res, { held: 0 });
  }
  if (route === 'GET /control/held') return json(res, { held: hold?.waiting ?? 0 });
  if (route === 'POST /control/release-sign-in') {
    hold?.release();
    hold = null;
    return json(res, { held: 0 });
  }
  if (route === 'GET /control/sessions') {
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM auth_sessions`);
    return json(res, { n: (r.rows[0] as { n: number }).n });
  }
  json(res, { error: 'not_found' }, 404);
}

const stand = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => json(res, { error: (err as Error).message }, 500));
});
await new Promise<void>((resolve) => stand.listen(googlePort, 'localhost', resolve));
console.log(`e2e sign-in server on ${APP}, Google stand-in on ${GOOGLE}`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  hold?.release();
  stand.close();
  await app.close().catch(() => undefined);
  await Promise.allSettled([closeDb(db), closeDb(authDb)]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
