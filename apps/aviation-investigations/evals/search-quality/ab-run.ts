/** Durable orchestration only. All ranking is delegated to the shared production entry point. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendDurable, EvaluationError } from './money.js';
import { schedule } from './ab-schedule.js';
import { assertComplete, armSummary, compare, chooseWinner, optionalCandidates } from './ab-score.js';
import { CORE_ARMS, type Arm, type ArmIdentity, type RankingPort, type RankingQuestion, type SearchObservation, type ScheduledSearch } from './ab-types.js';

export interface BlockAdmission {
  /** Must check the Task 24 lock, total/phase liability and production category gate. */
  assertBlock(reserveMicros: number): Promise<void>;
  /** True only for an insufficient optional-block allowance, never for accounting faults. */
  canFit(reserveMicros: number): Promise<boolean>;
}
export function readObservations(directory: string): SearchObservation[] {
  const file = join(directory, 'searches.jsonl');
  const records: any[] = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
  const dispatched = records.filter(r => r.event === 'dispatch'), results = records.filter(r => r.event === 'result');
  if (new Set(dispatched.map(r => r.attempt.key)).size !== dispatched.length || new Set(results.map(r => r.result.key)).size !== results.length
    || dispatched.some(r => !results.some(v => v.result.key === r.attempt.key)) || results.some(r => !dispatched.some(v => v.attempt.key === r.result.key))) {
    throw new EvaluationError('A/B dispatch has no unique durable result; reconcile without repeating it');
  }
  const observations: SearchObservation[] = results.map(r => r.result);
  if (observations.some(r => r.failure || r.safetyFaults.length)) throw new EvaluationError('Prior full-search or safety failure; this run is incomplete and cannot resume');
  return observations;
}
export async function runBlock(directory: string, block: string, questions: readonly RankingQuestion[], arms: readonly Arm[],
  identities: Readonly<Record<Arm, ArmIdentity>>, port: RankingPort, admission: BlockAdmission): Promise<SearchObservation[]> {
  const planned = schedule(questions, arms), planPath = join(directory, `${block}-order.json`);
  if (existsSync(planPath)) {
    if (JSON.stringify(JSON.parse(readFileSync(planPath, 'utf8'))) !== JSON.stringify(planned)) throw new EvaluationError('A/B schedule changed');
  } else writeFileSync(planPath, JSON.stringify(planned, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const prior = readObservations(directory), byKey = new Map(prior.map(r => [r.key, r]));
  const pending = planned.filter(r => !byKey.has(r.key));
  if (pending.length) await admission.assertBlock(pending.reduce((n, r) => n + Math.round(identities[r.arm].reservationUsd * 1e6), 0));
  const results: SearchObservation[] = [];
  const infrastructure = new Set(['count_failed', 'rate_limited', 'overloaded', 'timeout', 'provider_error', 'unbilled_provider_error']);
  let infrastructureStreak = 0;
  for (const attempt of planned) {
    const known = byKey.get(attempt.key);
    let result = known;
    if (!result) {
      const question = questions.find(q => q.id === attempt.questionId)!;
      appendDurable(join(directory, 'searches.jsonl'), { event: 'dispatch', attempt, at: new Date().toISOString() });
      result = await port.run(attempt, question);
      appendDurable(join(directory, 'searches.jsonl'), { event: 'result', result });
    }
    results.push(result);
    if (result.failure || result.safetyFaults.length) throw new EvaluationError('A/B full-search or safety failure: retained, stopped without retry');
    infrastructureStreak = infrastructure.has(result.scopeOutcome) || infrastructure.has(result.rerankOutcome) ? infrastructureStreak + 1 : 0;
    if (infrastructureStreak >= 3) throw new EvaluationError('Three consecutive A/B infrastructure failures; incomplete, no retries');
    if (results.length % 10 === 0) console.log(JSON.stringify({ block, completed: results.length, total: planned.length }));
  }
  for (const arm of arms) assertComplete(questions, arm, results);
  return results;
}
export async function runSelection(directory: string, questions: readonly RankingQuestion[], identities: Readonly<Record<Arm, ArmIdentity>>,
  port: RankingPort, admission: BlockAdmission, manifestSha256: string) {
  if (questions.length !== 21) throw new EvaluationError('Selection requires all 21 registered dev questions');
  const rows = await runBlock(directory, 'core', questions, CORE_ARMS, identities, port, admission);
  const h = CORE_ARMS.map(a => armSummary(questions, identities[a], rows));
  const decisionsPath = join(directory, 'optional-blocks.jsonl');
  const decisions: { arm: Arm; admitted: boolean; reason: string }[] = existsSync(decisionsPath)
    ? readFileSync(decisionsPath, 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
  for (const kind of ['depth', 'sonnet'] as const) {
    const leading = optionalCandidates(h, kind);
    const possible: Arm[] = kind === 'depth' ? ['QH100', 'TH100', 'QTH100'] : ['TS50', 'QTS50'];
    for (const arm of [...leading, ...possible.filter(a => !leading.includes(a))]) {
      let decision = decisions.find(d => d.arm === arm);
      if (!decision) {
        const eligible = leading.includes(arm), fits = eligible && await admission.canFit(63 * Math.round(identities[arm].reservationUsd * 1e6));
        decision = { arm, admitted: fits, reason: !eligible ? 'outside_leading_window' : fits ? 'whole_block_fits' : 'whole_block_exceeds_allowance' };
        appendDurable(decisionsPath, decision); decisions.push(decision);
      }
      if (decision.admitted) rows.push(...await runBlock(directory, arm, questions, [arm], identities, port, admission));
    }
  }
  const arms = [...CORE_ARMS, ...decisions.filter(d => d.admitted).map(d => d.arm)];
  if (arms.length > 10) throw new EvaluationError('Registered arm maximum exceeded');
  const comparisons = arms.filter(a => a !== 'Q0').map(a => compare(questions, identities[a], identities.Q0, rows, false));
  const selected = chooseWinner(comparisons);
  const report = { manifestSha256, decisions, comparisons, selected,
    selectedIdentity: selected ? identities[selected] : null, baseline: armSummary(questions, identities.Q0, rows) };
  const path = join(directory, 'selection.json');
  if (existsSync(path)) {
    if (JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) !== JSON.stringify(report)) throw new EvaluationError('Frozen winner changed');
  } else writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return report;
}
export async function runConfirmation(directory: string, selectionFile: string, questions: readonly RankingQuestion[], identities: Readonly<Record<Arm, ArmIdentity>>,
  port: RankingPort, admission: BlockAdmission, manifestSha256: string) {
  const selection = JSON.parse(readFileSync(selectionFile, 'utf8'));
  const winner = selection.selected as Arm | null;
  if (questions.length !== 48 || selection.manifestSha256 !== manifestSha256 || !winner || winner === 'Q0'
    || JSON.stringify(selection.selectedIdentity) !== JSON.stringify(identities[winner])
    || !selection.comparisons.some((c: any) => c.arm === winner && c.qualifies)) throw new EvaluationError('No eligible frozen dev winner for this manifest');
  const choice = { manifestSha256, winner, selectedIdentity: identities[winner] };
  const choicePath = join(directory, 'winner.json');
  if (existsSync(choicePath)) {
    if (JSON.stringify(JSON.parse(readFileSync(choicePath, 'utf8'))) !== JSON.stringify(choice)) throw new EvaluationError('Confirmation winner already fixed; no runner-up');
  } else writeFileSync(choicePath, JSON.stringify(choice, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const rows = await runBlock(directory, 'confirmation', questions, ['Q0', winner], identities, port, admission);
  const report = { ...choice, comparison: compare(questions, identities[winner], identities.Q0, rows, true),
    baseline: armSummary(questions, identities.Q0, rows) };
  writeFileSync(join(directory, 'confirmation.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return report;
}

/** A reserved stage is never repeated even if the outer search journal was lost. */
export const stageAttemptId = (attempt: ScheduledSearch, stage: string) => `${attempt.questionId}:${attempt.arm}:${attempt.sample}:${stage}`;
