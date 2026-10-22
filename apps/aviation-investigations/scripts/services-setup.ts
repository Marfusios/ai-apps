import { setupElasticsearch } from './es-setup.js';
import { ensureSecrets } from './local-env.js';
import { setupPostgres } from './pg-setup.js';

await setupPostgres();
await setupElasticsearch();
// HMAC keys for stored identities (the cost gate refuses to run without them). Generated
// once when missing, kept on later runs (rotating them resets usage counters), never printed.
ensureSecrets(['IDENTITY_HMAC_SECRET', 'IP_HMAC_SECRET']);
console.log('Local services configured; credentials written to .env.local.');
