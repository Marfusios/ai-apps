import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ReleaseError } from './release-config.js';
import { releaseEffects } from './release-effects.js';
import { runRelease } from './release-runner.js';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { process.exitCode = await runRelease(process.argv.slice(2), releaseEffects(abort.signal)); }
  catch (e) {
    process.stderr.write(`release: failed; ${e instanceof ReleaseError ? e.message : 'operation failed'}\n`);
    process.exitCode = e instanceof ReleaseError ? e.exitCode : 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
