import { spawnSync } from 'node:child_process';
import { ENV_LOCAL, APP_DIR, ensureSecrets } from './local-env.js';

const cmd = process.argv[2];
if (cmd !== 'up' && cmd !== 'down') {
  console.error('usage: services.ts up|down');
  process.exit(2);
}
ensureSecrets(['ELASTIC_PASSWORD', 'POSTGRES_PASSWORD']);
const args =
  cmd === 'up'
    ? ['compose', '--env-file', ENV_LOCAL, 'up', '-d', '--wait', '--wait-timeout', '240']
    : ['compose', '--env-file', ENV_LOCAL, 'down'];
const r = spawnSync('docker', args, { cwd: APP_DIR, stdio: 'inherit' });
process.exit(r.status ?? 1);
