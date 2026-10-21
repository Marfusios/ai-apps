import { setupElasticsearch } from './es-setup.js';
import { setupPostgres } from './pg-setup.js';

await setupPostgres();
await setupElasticsearch();
console.log('Local services configured; credentials written to .env.local.');
