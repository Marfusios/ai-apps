import { setupElasticsearch } from './es-setup.js';
import { ensureSecrets, readLocal, writeLocal } from './local-env.js';
import { setupPostgres } from './pg-setup.js';
import { TURNSTILE_TEST_SECRET_KEYS, TURNSTILE_TEST_SITE_KEYS } from '../server/identity/turnstile.js';

await setupPostgres();
await setupElasticsearch();
// HMAC keys for stored identities (the cost gate refuses to run without them) and the
// Better Auth secret (sign-in also needs a Google OAuth client). Generated once when
// missing, kept on later runs (rotating the HMAC keys resets usage counters, the Better
// Auth secret signs everyone out), never printed.
ensureSecrets(['IDENTITY_HMAC_SECRET', 'IP_HMAC_SECRET', 'BETTER_AUTH_SECRET']);
// Local development uses Cloudflare's public Turnstile test keys (every check passes, any
// hostname). Real keys already in .env.local or the environment are kept; APP_ENV=live
// refuses test keys.
const turnstile = readLocal(['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY']);
if (!(turnstile.TURNSTILE_SITE_KEY || process.env.TURNSTILE_SITE_KEY) && !(turnstile.TURNSTILE_SECRET_KEY || process.env.TURNSTILE_SECRET_KEY)) {
  writeLocal({ TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEYS[0]!, TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET_KEYS[0]! });
}
console.log('Local services configured; credentials written to .env.local.');
