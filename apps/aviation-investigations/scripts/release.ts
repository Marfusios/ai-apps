import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ReleaseError } from './release-config.js';
import { releaseEffects } from './release-effects.js';
import { runRelease } from './release-runner.js';
import { installReleaseSignals, releaseSignals } from './release-signals.js';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const control = releaseSignals();
  const dispose = installReleaseSignals(control);
  try { process.exitCode = await runRelease(process.argv.slice(2), releaseEffects(control.signal, control.forceSignal)); }
  catch (e) {
    process.stderr.write(`release: failed; ${e instanceof ReleaseError ? e.message : 'operation failed'}\n`);
    process.exitCode = e instanceof ReleaseError ? e.exitCode : 1;
  } finally {
    dispose();
  }
}
