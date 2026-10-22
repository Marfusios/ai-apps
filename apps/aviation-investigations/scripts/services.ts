import { spawnSync } from 'node:child_process';
import { ENV_LOCAL, APP_DIR, ensureSecrets } from './local-env.js';

const cmd = process.argv[2];
if (cmd !== 'up' && cmd !== 'down') {
  console.error('usage: services.ts up|down');
  process.exit(2);
}
ensureSecrets(['ELASTIC_PASSWORD', 'POSTGRES_PASSWORD']);
// Optional stand-alone services (project ai-aviation-local); deployments use the shared ones.
const compose = ['compose', '-f', 'compose.local-services.yaml', '--env-file', ENV_LOCAL];
const args = cmd === 'up' ? [...compose, 'up', '-d', '--wait', '--wait-timeout', '240'] : [...compose, 'down'];
const r = spawnSync('docker', args, { cwd: APP_DIR, stdio: 'inherit' });
process.exit(r.status ?? 1);
