/** One unchanged scope.e3 attempt per frozen field question. Paid execution is explicit. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createAnthropicProvider } from '../../server/ai/anthropic.js';
import { StageError, evidenceScopeCtx, type StageUsage, type LlmProvider } from '../../server/ai/provider.js';
import { validateEvidenceScope, type EvidenceScopeOutput } from '../../server/ai/prompts/scope.e1.js';
import { stageCostUsd } from '../../server/ai/pricing.js';
import { ceilUsd, type SpendGate } from '../../worker/index/spend-gate.js';
import { mulberry32 } from '../retrieval/experiments/stats.js';
import { evaluationSettings } from './config.js';
import { TaskAllocation, EvaluationError, appendDurable, allocationTotals } from './money.js';
import { FROZEN_DIR, verifyFieldManifest, SCOPE_MODEL } from './frozen.js';
import { scoreFields } from './field-score.js';
import type { FieldDataset, FieldObservation, FieldQuestion } from './types.js';

export async function fieldAttempt(question: FieldQuestion, provider: LlmProvider, gate: SpendGate,
  reservationUsd: number, journal: (record: unknown) => void): Promise<FieldObservation> {
  const reservation = await gate.reserve({ category: 'evaluation', usd: reservationUsd, purpose: question.id });
  try { journal({ event: 'dispatch', id: question.id, reservationId: reservation.reservationId, at: new Date().toISOString() }); }
  catch { await gate.settle(reservation, { usd: 0 }); throw new EvaluationError('Dispatch journal failed; no model call made'); }
  const start = performance.now();
  let output: EvidenceScopeOutput | null = null, usage: StageUsage | null = null, error: string | null = null;
  let billing: 'usage' | 'none' | 'uncertain' = 'uncertain';
  try {
    const r = await provider.evidenceScope!({ question: question.question }, evidenceScopeCtx(AbortSignal.timeout(10_000), 10_000));
    usage = r.usage; billing = 'usage';
    output = validateEvidenceScope(r.output, question.question);
    if (r.model !== SCOPE_MODEL || r.promptVersion !== 'scope.e3' || r.warnings.length) {
      throw new EvaluationError('Provider identity or cap warning changed');
    }
  } catch (e) {
    if (e instanceof EvaluationError) {
      const usd = usage ? ceilUsd(stageCostUsd(SCOPE_MODEL, usage)) : reservationUsd;
      journal({ event: 'fatal_result', id: question.id, reservationId: reservation.reservationId, usage, chargedUsd: usd });
      await gate.settle(reservation, usage ? { usd } : 'uncertain'); throw e;
    }
    if (e instanceof StageError) {
      error = e.category; billing = e.billing.kind;
      if (e.billing.kind === 'usage') usage = e.billing.usage;
    } else {
      // Unknown exceptions may follow a billed response; never infer non-billing from a message.
      error = usage ? 'invalid_output' : 'provider_failure';
    }
    output = null;
  }
  const chargedUsd = billing === 'usage' && usage ? ceilUsd(stageCostUsd(SCOPE_MODEL, usage)) : billing === 'none' ? 0 : reservationUsd;
  const result: FieldObservation = { id: question.id, output, usage, error, elapsedMs: Math.round(performance.now() - start), reservationId: reservation.reservationId, chargedUsd };
  let durable = true;
  try { journal({ event: 'result', billing, ...result }); } catch { durable = false; }
  await gate.settle(reservation, billing === 'uncertain' ? 'uncertain' : { usd: chargedUsd });
  if (!durable) throw new EvaluationError('Paid result journal failed; do not repeat the attempt');
  journal({ event: 'settled', id: question.id, reservationId: reservation.reservationId, chargedUsd });
  if (chargedUsd > reservationUsd + 1e-9) throw new EvaluationError('Provider charge exceeded its frozen bound; stop');
  return result;
}

export function shuffledQuestions(questions: readonly FieldQuestion[]) {
  const copy = [...questions], random = mulberry32(2026102504);
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j]!, copy[i]!]; }
  return copy;
}

async function main() {
  const { values } = parseArgs({ options: { 'env-files': { type: 'string' }, 'keys-file': { type: 'string' },
    'out-dir': { type: 'string' }, 'confirm-cost': { type: 'boolean' } } });
  const frozen = verifyFieldManifest();
  const dataset = JSON.parse(readFileSync(`${FROZEN_DIR}/fields.json`, 'utf8')) as FieldDataset;
  const directory = resolve(values['out-dir'] ?? 'data/work/task24/fields');
  const questions = shuffledQuestions(dataset.questions);
  if (!values['confirm-cost']) {
    console.log(JSON.stringify({ paid: false, frozen: frozen.hash, questions: questions.length,
      reservationUsd: frozen.manifest.settings.reservationUsd, worstBlockUsd: ceilUsd(questions.length * frozen.manifest.settings.reservationUsd) })); return;
  }
  if (!values['env-files']) throw new EvaluationError('Explicit development environment files required');
  const settings = evaluationSettings(values['env-files'], values['keys-file']);
  if (!settings.config.ai.anthropic.apiKey || settings.config.ai.anthropic.scopeModel !== SCOPE_MODEL) throw new EvaluationError('Configured scope model/key differs from freeze');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const startPath = join(directory, 'start.json'), attemptsPath = join(directory, 'attempts.jsonl');
  const saved: any[] = existsSync(attemptsPath) ? readFileSync(attemptsPath, 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
  if (existsSync(startPath)) {
    if (JSON.parse(readFileSync(startPath, 'utf8')).manifestSha256 !== frozen.hash) throw new EvaluationError('Resume manifest changed');
  } else if (saved.length) throw new EvaluationError('Prior dispatch has no frozen start');
  const dispatched = new Set(saved.filter(r => r.event === 'dispatch').map(r => r.id));
  const prior = new Map<string, FieldObservation>(saved.filter(r => r.event === 'result').map(r => [r.id, r as FieldObservation]));
  if ([...dispatched].some(id => !prior.has(id)) || prior.size !== saved.filter(r => r.event === 'result').length) throw new EvaluationError('Incomplete or duplicate billed observation; reconcile without retry');
  const allocation = await TaskAllocation.open(settings, directory);
  const observations: FieldObservation[] = [];
  let completed = false;
  try {
    const pending = questions.filter(q => !prior.has(q.id));
    if (pending.length) await allocation.assertBlock('fields', pending.length * Math.round(frozen.manifest.settings.reservationUsd * 1e6));
    if (!existsSync(startPath)) writeFileSync(startPath, JSON.stringify({ manifestSha256: frozen.hash, at: new Date().toISOString(),
      order: questions.map(q => q.id) }) + '\n', { flag: 'wx', mode: 0o600 });
    const provider = createAnthropicProvider({ apiKey: settings.config.ai.anthropic.apiKey, models: { scope: SCOPE_MODEL, answer: SCOPE_MODEL, check: SCOPE_MODEL } });
    const gate = allocation.gate('fields', frozen.hash, 'anthropic', SCOPE_MODEL, 'scope_eval');
    let consecutiveInfrastructureFailures = 0;
    for (const question of questions) {
      const result = prior.get(question.id) ?? await fieldAttempt(question, provider, gate, frozen.manifest.settings.reservationUsd,
        record => appendDurable(attemptsPath, record));
      observations.push(result);
      if (result.error && ['auth', 'bad_request', 'cap_exceeded', 'invalid_input'].includes(result.error)) throw new EvaluationError('Scope dependency/cap preflight failed; stopped without retry');
      consecutiveInfrastructureFailures = result.error && ['timeout', 'count_failed', 'rate_limited', 'overloaded', 'network', 'provider_error', 'provider_failure', 'unexpected'].includes(result.error)
        ? consecutiveInfrastructureFailures + 1 : 0;
      if (consecutiveInfrastructureFailures >= 3) throw new EvaluationError('Three consecutive infrastructure failures; incomplete run stopped without retry');
      if (observations.length % 20 === 0) console.log(JSON.stringify({ completed: observations.length, total: questions.length,
        failures: observations.filter(o => o.error).length }));
    }
    completed = true;
  } finally {
    const phaseLedger = await allocationTotals(allocation.db, 'fields');
    const totalLedger = await allocation.close();
    writeFileSync(join(directory, 'observations.json'), JSON.stringify({ manifestSha256: frozen.hash, completed, phaseLedger, totalLedger, observations }, null, 2) + '\n', { mode: 0o600 });
    const metrics = scoreFields(dataset, observations);
    writeFileSync(join(directory, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ completed, observations: observations.length, failures: metrics.failures, clearsState: metrics.clearsState, phaseLedger, totalLedger }));
  }
}
if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().catch(e => { console.error(e instanceof EvaluationError ? e.message : 'Field run stopped; raw exception details suppressed.'); process.exitCode = 1; });
}
