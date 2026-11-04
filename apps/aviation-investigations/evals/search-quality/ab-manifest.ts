/** Immutable construction pins. A separate reviewed gate certificate is mandatory for payment. */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileSha, sha } from './frozen.js';
import type { Arm, ArmIdentity } from './ab-types.js';
import { EvaluationError } from './money.js';
export const AB_MANIFEST_PATH = 'evals/search-quality/frozen/ab-manifest.json';
export interface ABManifest {
  version: 'task24-ab-freeze-v1'; frozenAt: string; codeCommit: string; serverCommit: string;
  protocolSha256: string; fieldDesignSha256: string;
  files: Record<string, string>; arms: Record<Arm, ArmIdentity>;
  target: unknown; coreWorstCaseUsd: number; seeds: { order: 2026102502; bootstrap: 2026102503; resamples: 10000; samples: 3 };
  modelPreflight: unknown; gateStatus: 'pending-controller-review';
}
export function readABManifest(path = AB_MANIFEST_PATH) {
  const bytes = readFileSync(path), manifest = JSON.parse(bytes.toString()) as ABManifest;
  if (manifest.version !== 'task24-ab-freeze-v1' || manifest.coreWorstCaseUsd > 9 || manifest.seeds.samples !== 3
    || manifest.seeds.order !== 2026102502 || manifest.seeds.bootstrap !== 2026102503 || manifest.seeds.resamples !== 10000) throw new EvaluationError('Invalid registered A/B freeze');
  for (const [path, hash] of Object.entries(manifest.files)) if (fileSha(path) !== hash) throw new EvaluationError(`Frozen A/B file changed: ${path}`);
  for (const commit of [manifest.serverCommit, manifest.codeCommit]) {
    try { execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { stdio: 'ignore' }); }
    catch { throw new EvaluationError('Frozen commits are not in this branch'); }
  }
  return { manifest, hash: sha(bytes) };
}
export interface GateCertificate {
  version: 'task24-gate-certificate-v1'; verdict: 'GATE 24-R: CLEARED'; reviewedServerCommit: string;
  manifestSha256: string; reportSha256: string; pricesChecked: string; authorisedByController: true;
}
export function requireRankingGate(path: string | undefined, reportPath: string | undefined, manifest: ABManifest, manifestHash: string) {
  if (!path || !reportPath) throw new EvaluationError('Paid A/B waits for the controller report and GATE 24-R');
  const cert = JSON.parse(readFileSync(path, 'utf8')) as GateCertificate;
  const report = readFileSync(reportPath, 'utf8');
  if (cert.version !== 'task24-gate-certificate-v1' || cert.verdict !== 'GATE 24-R: CLEARED' || cert.authorisedByController !== true
    || cert.reviewedServerCommit !== manifest.serverCommit || cert.manifestSha256 !== manifestHash || cert.reportSha256 !== sha(report)
    || !report.includes('GATE 24-R: CLEARED') || !/^\d{4}-\d{2}-\d{2}$/.test(cert.pricesChecked)) throw new EvaluationError('Controller/gate certificate does not clear this frozen implementation');
  return cert;
}
