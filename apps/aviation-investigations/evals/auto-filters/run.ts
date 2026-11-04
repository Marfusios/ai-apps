/**
 * Task 30: automatic search filters attributed to the accident by an AI check (README.md).
 *
 * `preflight` is free: identities, file shas, sizing; the first preflight of a confirmation part
 * freezes the confirmation probes' sha for the label; it opens the allocation without reserving.
 * `run --part <part> --confirm-cost` runs one part through the production `rankEvidence` and the
 * allocation's spend gate, one call at a time, every attempt journaled before dispatch and never
 * repeated under its label. `summarize` (free) scores what each part's journal completed.
 */
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Client } from '@elastic/elasticsearch';
import { createDb, closeDb, type Db } from '../../server/db/client.js';
import { createEsClient } from '../../server/search/es.js';
import { attributionStage, autoFilterIdentity, autoFilterPolicy, automaticFieldsOf, type EvidenceAutoFilterPolicy } from '../../server/evidence/auto-filters.js';
import { evidenceRankingConfig, evidenceRankingIdentity } from '../../server/evidence/ranking-config.js';
import { attributionWorstCaseUsd, evidenceReservation } from '../../server/evidence/pricing.js';
import { EVIDENCE_AUTO_FILTER_VERSIONS, type EvidenceAutoFilterVersion } from '../../shared/evidence-auto-filters.js';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { automaticCandidates } from '../../shared/automatic-candidates.js';
import { inReleaseQuietWindow } from '../../scripts/release-runner.js';
import { evaluationSettings, type EvaluationSettings } from '../search-quality/config.js';
import { filterIdentity, productionPort } from '../search-quality/ab-production.js';
import { codedMetrics } from '../search-quality/ab-score.js';
import { appendDurable, EvaluationError } from '../search-quality/money.js';
import { ARM_IDS, type Arm, type ArmIdentity, type RankingQuestion, type SearchObservation, type SearchRequest } from '../search-quality/ab-types.js';
import { CappedAllocation, prefixTotals, taskTotals } from '../langfuse/money.js';
import { sha256, stable } from '../langfuse/data.js';
import { assertTarget, codeIdentity, freezeFile, readJournal, verifyTarget, type QuestionSet } from '../applied-filters/run.js';
import { compareNarrowR20, fallbackRates, filterMatch, rowScores, type RowRanking } from '../applied-filters/plan.js';
import { probeWarnings, type LoadedProbes } from './probes.js';
import { attemptKey, partData, seededOrder, type PartData, type PartItem } from './inputs.js';
import {
  AUTO_FIELDS, EXPECTED_MICROS, PART_BUDGET_MICROS, PART_SPECS, PARTS, ROWS30, STOP_STREAK, TASK30_FAMILY, attributedRequest, attributionRates,
  attributionSampleMicros, autoFilters, buttonFilters, c2Verdict, chargeableSampleMicros, decideField, editRequest, expectedRetrievalQuestionMicros,
  expectedSampleMicros, fieldKey, fieldSummary, groupSummary, isPart, laneName, laneSpec, liveRequest, nextStreak30, parseShard, q0Request,
  retrievalQuestionMicros, review24Unsafe, shardItems, stageMicros30, v13Replay, V13_RECORDED, wholeObject, type AttributionPart, type AutoField,
  type FieldSummary, type PartName, type Row30, type ScoredSample, type Shard, type StageMicros30,
} from './plan.js';
import { attributionPort, MODEL, type AttributionObservation } from './port.js';

export const MANIFEST_VERSION = 'task30-auto-filters-v1';
export const DEFAULT_POLICY: EvidenceAutoFilterVersion = 'attributed.v1' as EvidenceAutoFilterVersion;

export function resolvePolicy(version: string): EvidenceAutoFilterPolicy {
  if (!(EVIDENCE_AUTO_FILTER_VERSIONS as readonly string[]).includes(version)) throw new EvaluationError(`Unregistered automatic filter policy: ${version}`);
  const policy = autoFilterPolicy(version as EvidenceAutoFilterVersion);
  if (!attributionStage(policy) || !automaticFieldsOf(policy).length) throw new EvaluationError(`Policy ${version} has no attribution check`);
  return policy;
}
const policyRecord = (policy: EvidenceAutoFilterPolicy) => ({ ...autoFilterIdentity(policy), fields: automaticFieldsOf(policy),
  attribution: (({ model, caps, timeoutMs }) => ({ model, caps, timeoutMs }))(attributionStage(policy)!) });

export function stages(policy: EvidenceAutoFilterPolicy): StageMicros30 {
  return stageMicros30(evidenceRankingConfig(ARM_IDS.Q0), evidenceRankingConfig(ARM_IDS.QH50), attributionWorstCaseUsd(attributionStage(policy)!));
}
/** The registered identities as they are now (the scope timeout change gave them new hashes); recorded, never compared with Task 24's frozen manifest. */
export function currentIdentities(): Record<'Q0' | 'QH50', ArmIdentity> {
  const of = (alias: 'Q0' | 'QH50'): ArmIdentity => {
    const c = evidenceRankingConfig(ARM_IDS[alias]);
    return { alias, ...evidenceRankingIdentity(c), reservationUsd: evidenceReservation(c.scope.model, c.embedding.model, c).reservationUsd,
      changedKnobs: Number(c.lexicalText !== 'question') + Number(!!c.rerank), depth: c.rerank?.depth ?? 0 };
  };
  return { Q0: of('Q0'), QH50: of('QH50') };
}

// ---------------------------------------------------------------------------
// Journals

interface Recorded { event: 'result'; key: string; part: PartName; itemId: string; row?: Row30; set?: string; sample: number; observation: AttributionObservation | SearchObservation }
const confirmFreezePath = (dir: string) => join(dir, 'confirm-freeze.json');
/**
 * The confirmation probes' sha, frozen for this label by its first confirmation preflight (`create`);
 * a run only checks it, and refuses when it is missing or differs.
 */
export function freezeConfirm(dir: string, probes: LoadedProbes, create: boolean): { sha256: string; frozenAt: string; probes: number } {
  const path = confirmFreezePath(dir);
  if (!existsSync(path)) {
    if (!create) throw new EvaluationError('Run the preflight first: it freezes the confirmation probes for this label');
    const record = { sha256: probes.sha256, frozenAt: new Date().toISOString(), probes: probes.file.probes.length };
    writeFileSync(path, stable(record) + '\n', { flag: 'wx', mode: 0o600 });
    return record;
  }
  const frozen = JSON.parse(readFileSync(path, 'utf8')) as { sha256: string; frozenAt: string; probes: number };
  if (frozen.sha256 !== probes.sha256) throw new EvaluationError('The confirmation probes changed after their first preflight under this label');
  return frozen;
}

// ---------------------------------------------------------------------------
// Scoring the attribution parts

function scored(items: readonly PartItem[], journal: Map<string, Recorded>, part: AttributionPart, label: string, samples: readonly number[]) {
  const byId = new Map(items.map(i => [i.id, i]));
  const rows: ScoredSample[] = [], observations: AttributionObservation[] = [];
  let missing = 0;
  for (const item of items) for (const sample of samples) {
    const r = journal.get(attemptKey(label, part, item.id, sample));
    if (!r) { missing += 1; continue; }
    const o = r.observation as AttributionObservation;
    observations.push(o);
    rows.push({ itemId: item.id, sample, applied: autoFilters(o.automaticFilters), gold: byId.get(item.id)!.gold, forced: item.forced,
      reasons: o.autoFilterFields, scopeOutcome: o.scopeOutcome, attributionOutcome: o.attributionOutcome, tags: item.tags });
  }
  return { rows, observations, missing };
}

export function summarizeAttributionPart(part: AttributionPart, data: PartData, journal: Map<string, Recorded>, label: string, policy: EvidenceAutoFilterPolicy) {
  const spec = PART_SPECS[part], samples = Array.from({ length: spec.samples }, (_, i) => i + 1);
  const { rows, observations, missing } = scored(data.items, journal, part, label, samples);
  if (missing) throw new EvaluationError(`Incomplete schedule: ${part} lacks ${missing} sample(s)`);
  if (observations.some(o => o.failure || o.safetyFaults.length)) throw new EvaluationError(`A failed search in ${part}; inspect the journal`);
  if (observations.some(o => o.policy.sha256 !== autoFilterIdentity(policy).sha256)) throw new EvaluationError(`${part} ran another policy`);
  const enabled = automaticFieldsOf(policy) as readonly AutoField[];
  const fields = (part === 'state-replay' ? ['state'] as const : AUTO_FIELDS);
  const usd = (stage: string) => observations.reduce((s, o) => s + o.usage.filter(l => l.stage === stage).reduce((n, l) => n + l.usd, 0), 0);
  const probes = Boolean(data.probes);
  // A scripted scope proposes the item's own values; a real scope's positives are every item whose gold holds the field.
  const basis = spec.scope === 'real' ? 'gold' as const : 'forced' as const;
  return {
    part, family: spec.family, items: data.items.length, samples: spec.samples, attempts: observations.length,
    policy: autoFilterIdentity(policy), enabledFields: enabled,
    fields: Object.fromEntries(fields.map(f => [f, fieldSummary(rows, f, enabled.includes(f), basis)])) as Partial<Record<AutoField, FieldSummary>>, positivesBy: basis,
    wholeObject: wholeObject(rows, enabled.filter(f => (fields as readonly AutoField[]).includes(f))),
    rates: attributionRates(observations.map(o => ({ ...o, scopeReal: o.scope === 'real' }))),
    usd: { total: observations.reduce((s, o) => s + o.actualUsd, 0), scope: usd('scope'), attribution: usd('attribution'), embed: usd('embed') },
    ...(probes ? {
      review24: Object.fromEntries(AUTO_FIELDS.map(f => [f, review24Unsafe(rows, f)])),
      byPattern: groupSummary(rows, 'pattern', basis), bySource: groupSummary(rows, 'source', basis), byKind: groupSummary(rows, 'kind', basis), byField: groupSummary(rows, 'field', basis),
      warnings: probeWarnings(data.probes!.file),
    } : {}),
    ...(data.replay ? { replay: { attributed: (({ tp, fp, fn, tn }) => ({ tp, fp, fn, tn }))(fieldSummary(rows, 'state', enabled.includes('state')).confusion),
      v13Recomputed: v13Replay(data.replay), v13Recorded: V13_RECORDED, byIntent: groupSummary(rows, 'intent'), byRole: groupSummary(rows, 'role') } } : {}),
    ...(data.c2 ? { c2: c2Verdict(data.c2, rows.map(r => {
      const o = observations.find(x => x.itemId === r.itemId)!;
      const failed = !['used', 'non_search'].includes(o.scopeOutcome) || !['applied', 'not_run'].includes(o.attributionOutcome);
      return { id: r.itemId, applied: r.applied, failed };
    })), byStratum: groupSummary(rows, 'stratum') } : {}),
  };
}
export type AttributionSummary = ReturnType<typeof summarizeAttributionPart>;

// ---------------------------------------------------------------------------
// The retrieval part (Task 29's sets on dev)

export function summarizeRetrievalSet(set: QuestionSet, journal: Map<string, Recorded>, label: string, policy: EvidenceAutoFilterPolicy) {
  const get = (row: Row30, q: RankingQuestion, sample: number) => journal.get(attemptKey(label, 'retrieval', q.id, sample, row, set.name))?.observation as SearchObservation | undefined;
  const rankings: RowRanking<Row30>[] = [], losses: { id: string; QH50: number; 'QH50+F': number; 'QH50+A': number }[] = [];
  const identity = autoFilterIdentity(policy);
  let fusedMismatches = 0, automaticFusedMismatches = 0, offeredLive = 0, offeredAuto = 0;
  const applied: Record<AutoField, number> = { state: 0, years: 0, category: 0 }, matches: { kind: string; match: string }[] = [];
  const all: { row: Row30; o: SearchObservation }[] = [];
  for (const q of set.questions) {
    const q0 = get('Q0', q, 1);
    if (!q0) throw new EvaluationError(`Incomplete schedule: ${set.name} ${q.id}`);
    all.push({ row: 'Q0', o: q0 });
    rankings.push({ row: 'Q0', questionId: q.id, sample: 1, ranking: q0.ranking });
    const per = { QH50: [] as number[], 'QH50+F': [] as number[], 'QH50+A': [] as number[] };
    for (const sample of set.samples) {
      const live = get('QH50', q, sample), auto = get('QH50+A', q, sample);
      if (!live || !auto) throw new EvaluationError(`Incomplete schedule: ${set.name} ${q.id}`);
      const liveEdit = get('QH50+F', q, sample), autoEdit = get('QH50+A+F', q, sample);
      for (const [parent, edit, row, withPolicy] of [[live, liveEdit, 'QH50+F', false], [auto, autoEdit, 'QH50+A+F', true]] as const) {
        const filters = buttonFilters(parent);
        // An edit exists exactly when the page showed the button, and ran exactly its filters, on the live configuration.
        if (Boolean(filters) !== Boolean(edit)) throw new EvaluationError(`Edit does not match its button: ${row} ${q.id}`);
        if (filters && edit && (!edit.edited || edit.configuration.version !== ARM_IDS.QH50 || filterIdentity(edit.appliedFilters ?? {}) !== filterIdentity(filters)
          || edit.automaticFilters || (withPolicy && edit.autoFilterPolicy?.sha256 !== identity.sha256))) throw new EvaluationError(`Edit ran other filters: ${row} ${q.id}`);
        if (filters) { if (withPolicy) offeredAuto += 1; else offeredLive += 1; }
      }
      if (live.automaticFilters || live.autoFilterPolicy?.version !== 'none') throw new EvaluationError(`QH50 ran an automatic policy: ${q.id}`);
      if (auto.autoFilterPolicy?.sha256 !== identity.sha256 || auto.edited) throw new EvaluationError(`QH50+A ran another policy: ${q.id}`);
      const automatic = autoFilters(auto.automaticFilters);
      for (const f of AUTO_FIELDS) if (fieldKey(automatic, f) !== null) applied[f] += 1;
      matches.push({ kind: q.class, match: filterMatch(auto.automaticFilters ? automatic as BriefFilters : null, set.keyFilters[q.id]!) });
      if (q0.ranking.join('\n') !== live.fused.join('\n')) fusedMismatches += 1;
      if (!auto.automaticFilters && q0.ranking.join('\n') !== auto.fused.join('\n')) automaticFusedMismatches += 1;
      // No button means the visitor keeps the search they have.
      for (const [row, o] of [['QH50', live], ['QH50+F', liveEdit ?? live], ['QH50+A', auto], ['QH50+A+F', autoEdit ?? auto]] as const) rankings.push({ row, questionId: q.id, sample, ranking: o.ranking });
      all.push({ row: 'QH50', o: live }, { row: 'QH50+A', o: auto }, ...(liveEdit ? [{ row: 'QH50+F' as const, o: liveEdit }] : []), ...(autoEdit ? [{ row: 'QH50+A+F' as const, o: autoEdit }] : []));
      if (q.class === 'narrow') {
        const r20 = (o: SearchObservation) => codedMetrics(o.ranking, q.relevant).narrowR20;
        per.QH50.push(r20(live)); per['QH50+F'].push(r20(liveEdit ?? live)); per['QH50+A'].push(r20(auto));
      }
    }
    if (q.class === 'narrow') {
      const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const v = { id: q.id, QH50: avg(per.QH50), 'QH50+F': avg(per['QH50+F']), 'QH50+A': avg(per['QH50+A']) };
      if (v['QH50+A'] < v.QH50 - 1e-12 || v['QH50+A'] < v['QH50+F'] - 1e-12) losses.push(v);
    }
  }
  const scores = Object.fromEntries(ROWS30.map(row => [row, rowScores(set.questions, rankings, row)])) as Record<Row30, ReturnType<typeof rowScores>>;
  const by = (row: Row30) => all.filter(a => a.row === row).map(a => a.o);
  const rates = Object.fromEntries(ROWS30.map(row => {
    const rows = by(row), checks = rows.filter(o => o.attributionCalled);
    const failures = checks.filter(o => !['applied', 'not_run'].includes(o.attributionOutcome ?? 'not_run')).length;
    return [row, { ...fallbackRates(rows), attributionAttempts: checks.length, attributionFailures: failures, attributionRate: checks.length ? failures / checks.length : 0 }];
  })) as Record<Row30, ReturnType<typeof fallbackRates> & { attributionAttempts: number; attributionFailures: number; attributionRate: number }>;
  const publishable = set.crossGroupShares === 0 && Object.values(rates).every(r => r.scopeRate <= 0.05 + 1e-9 && r.rerankRate <= 0.05 + 1e-9 && r.attributionRate <= 0.05 + 1e-9);
  const tally = (xs: string[]) => Object.fromEntries([...new Set(xs)].sort().map(k => [k, xs.filter(x => x === k).length]));
  const compare = (base: Row30, variant: Row30) => compareNarrowR20(scores[base], scores[variant], 30);
  return {
    set: set.name, questions: set.questions.length, narrow: set.questions.filter(q => q.class === 'narrow').length,
    groups: new Set(set.questions.map(q => q.group)).size, narrowGroups: new Set(set.questions.filter(q => q.class === 'narrow').map(q => q.group)).size,
    samples: set.samples.length, publishable, policy: identity, fallbacks: rates,
    rows: Object.fromEntries(ROWS30.map(row => [row, { narrowR20: scores[row].narrowR20, narrowR10: scores[row].narrowR10, broadP10: scores[row].broadP10,
      broadNdcg10: scores[row].broadNdcg10, searches: by(row).length, usd: by(row).reduce((s, o) => s + o.actualUsd, 0),
      scopeOutcomes: tally(by(row).map(o => o.scopeOutcome)), rerankOutcomes: tally(by(row).map(o => o.rerankOutcome)),
      attributionOutcomes: tally(by(row).filter(o => o.attributionCalled).map(o => o.attributionOutcome ?? 'not_run')) }])),
    narrowR20Differences: { 'QH50+A - QH50': compare('QH50', 'QH50+A'), 'QH50+A - QH50+F': compare('QH50+F', 'QH50+A'),
      'QH50+A+F - QH50+A': compare('QH50+A', 'QH50+A+F'), 'QH50+F - QH50': compare('QH50', 'QH50+F'), 'QH50 - Q0': compare('Q0', 'QH50') },
    automatic: { samples: by('QH50+A').length, appliedByField: applied,
      answerKeyMatch: { narrow: tally(matches.filter(m => m.kind === 'narrow').map(m => m.match)), broad: tally(matches.filter(m => m.kind === 'broad').map(m => m.match)) },
      fieldReasons: Object.fromEntries(AUTO_FIELDS.map(f => [f, tally(by('QH50+A').map(o => o.autoFilterFields?.[f] ?? `scope:${o.scopeOutcome}`))])) },
    buttons: { 'QH50': offeredLive, 'QH50+A': offeredAuto, samples: by('QH50').length },
    perQuestionLosses: losses,
    determinism: { q0VsQh50Fused: fusedMismatches, q0VsQh50aFusedWithoutAutomatic: automaticFusedMismatches },
    labels: { changed: set.changes.filter(c => c.added || c.removed), crossGroupShares: set.crossGroupShares },
    perQuestion: Object.fromEntries(ROWS30.map(row => [row, scores[row].questions])),
  };
}
export type RetrievalSetSummary = ReturnType<typeof summarizeRetrievalSet>;

// ---------------------------------------------------------------------------
// Reports

function writeSummary(dir: string, part: PartName, manifest: { codeCommit: string }, manifestSha256: string, summary: unknown) {
  writeAtomic(join(dir, `summary-${part}.json`), JSON.stringify({ part, manifestSha256, runCommit: manifest.codeCommit, summarizedCommit: codeIdentity(),
    summary }, null, 2) + '\n');
}
const pct = (x: number | null | undefined, digits = 1) => x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(digits)}%`;
function attributionTable(s: AttributionSummary): string[] {
  const lines = [`## ${s.part} (${s.items} items x ${s.samples} sample(s), policy ${s.policy.version} ${s.policy.sha256.slice(0, 12)}, $${s.usd.total.toFixed(4)})`, '',
    '| Field | On | TP | FP wrong/trap | FN | TN | Precision (Wilson LB, simult.) | Recall | Trap items failed (UB) | Model-only trap (UB) | Question precision (LB) | Positive recall |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const f of Object.values(s.fields)) {
    if (!f) continue;
    const c = f.confusion, t = f.traps, qp = f.questionPrecision;
    lines.push(`| ${f.field} | ${f.enabled ? 'yes' : 'no'} | ${c.tp} | ${c.wrongValue}/${c.appliedOnTrap} | ${c.fn} | ${c.tn} | ${pct(f.precision.rate)} (${pct(f.precision.lower95)}, ${pct(f.precision.simultaneousLower)}) | ${pct(f.recall.rate)} | `
      + `${t ? `${t.policy.failures}/${t.policy.items} (${pct(t.policy.upper95, 2)})` : 'n/a'} | ${t ? `${t.modelOnly.failures}/${t.modelOnly.items} (${pct(t.modelOnly.upper95, 2)})` : 'n/a'} | `
      + `${qp.wrong}/${qp.applications} wrong (${pct(qp.lower95, 2)}) | ${f.positives ? `${f.positives.found}/${f.positives.samples}` : 'n/a'} |`);
  }
  lines.push('', `Whole filter object, samples: ${JSON.stringify(s.wholeObject.samples)}; questions: ${JSON.stringify(s.wholeObject.questions)}.`,
    `Scope failures ${s.rates.scope.failures}/${s.rates.scope.attempts}; check failures ${s.rates.attribution.failures}/${s.rates.attribution.attempts}.`);
  if (s.c2) lines.push(`C2 registered rule on the applied fields: years ${s.c2.clears.yearRange ? 'clears' : 'does not clear'}, category ${s.c2.clears.category ? 'clears' : 'does not clear'}.`);
  if (s.replay) lines.push(`State replay: attributed ${JSON.stringify(s.replay.attributed)}; v1.3 recorded guard ${JSON.stringify(s.replay.v13Recorded.guard)}, behind the search gate ${JSON.stringify(s.replay.v13Recorded.pipeline)}.`);
  return lines;
}
function retrievalTable(sets: RetrievalSetSummary[]): string[] {
  const lines = ['## retrieval'];
  for (const s of sets) {
    lines.push('', `${s.set}: ${s.questions} questions (${s.narrow} narrow in ${s.narrowGroups} groups), ${s.samples} sample(s), publishable ${s.publishable}`, '',
      '| Row | Narrow R@20 | R@10 | Broad P@10 | nDCG@10 | Searches | USD |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of ROWS30) { const r = s.rows[row]!; lines.push(`| ${row} | ${pct(r.narrowR20)} | ${pct(r.narrowR10)} | ${pct(r.broadP10)} | ${pct(r.broadNdcg10)} | ${r.searches} | ${r.usd.toFixed(4)} |`); }
    for (const [k, v] of Object.entries(s.narrowR20Differences)) lines.push(`- ${k}: ${(v.delta * 100).toFixed(1)} points, 95% interval ${(v.ci95[0] * 100).toFixed(1)} to ${(v.ci95[1] * 100).toFixed(1)} (${v.questions} questions, ${v.groups} groups)`);
    lines.push(`- QH50+A applied: ${JSON.stringify(s.automatic.appliedByField)} of ${s.automatic.samples} samples; per-question losses: ${s.perQuestionLosses.length}`);
  }
  return lines;
}
function decisionTable(d: ReturnType<typeof decideField>[]): string[] {
  return ['## Per-field decision (confirmation forced run; review-24 veto from the development runs)', '',
    '| Field | On | Trap rule | Precision rule | Review-24 | Recall forced / e2e | Useful |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...d.map(x => `| ${x.field} | ${x.on ? 'yes' : 'no'} (${x.why}) | ${x.trap.verdict} ${x.trap.failures ?? '-'}/${x.trap.items ?? '-'} UB ${pct(x.trap.upper95, 2)} | `
      + `${x.precision.verdict} ${x.precision.wrong ?? '-'}/${x.precision.applications ?? '-'} wrong LB ${pct(x.precision.lower95, 2)} | ${x.review24.verdict} | ${pct(x.recall.forced)} / ${pct(x.recall.e2e)} | ${x.recall.useful ?? 'n/a'} |`)];
}
/** summary.md: one short table per summarized part of the label, and the decision when its inputs exist. */
function writeMarkdown(dir: string) {
  const lines = ['# Task 30 evaluation summary', ''];
  for (const part of PARTS) {
    const path = join(dir, `summary-${part}.json`);
    if (!existsSync(path)) continue;
    const s = JSON.parse(readFileSync(path, 'utf8')).summary;
    lines.push(...(part === 'retrieval' ? retrievalTable(s.sets) : attributionTable(s)), '');
  }
  const decision = join(dir, 'summary-decision.json');
  if (existsSync(decision)) lines.push(...decisionTable(JSON.parse(readFileSync(decision, 'utf8')).fields), '');
  writeAtomic(join(dir, 'summary.md'), lines.join('\n'));
}
function readSummary(dir: string, part: PartName): AttributionSummary | null {
  const path = join(dir, `summary-${part}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).summary as AttributionSummary : null;
}
/** The pre-registered decision from this label's confirmation summaries and the development label's review-24 results. */
function writeDecision(dir: string, devDir: string) {
  const confirmForced = readSummary(dir, 'confirm-forced'), confirmE2e = readSummary(dir, 'confirm-e2e');
  if (!confirmForced && !confirmE2e) return;
  const development = (['dev-forced', 'dev-e2e'] as const).map(part => ({ part, summary: readSummary(devDir, part) }));
  const enabled = new Set((confirmForced ?? confirmE2e)!.enabledFields);
  const fields = AUTO_FIELDS.map(f => decideField(f, { enabled: enabled.has(f), confirmForced: confirmForced?.fields[f] ?? null,
    confirmE2e: confirmE2e?.fields[f] ?? null, development: development.map(d => ({ part: d.part, unsafe: d.summary?.review24?.[f] ?? null })) }));
  writeAtomic(join(dir, 'summary-decision.json'), JSON.stringify({ rule: 'spec.md Evaluation, registered 2026-11-03 22:15 CET', policy: (confirmForced ?? confirmE2e)!.policy,
    development: development.map(d => ({ part: d.part, present: Boolean(d.summary), policy: d.summary?.policy ?? null })), fields }, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Lanes on disk: `<out>/<label>/<part>/manifest.json` once per part, `<part>/<i>of<k>/` per lane.

const partDirOf = (dir: string, part: PartName) => join(dir, part);
const laneDirOf = (dir: string, part: PartName, shard: Shard) => join(dir, part, laneName(shard));
/** The lane record, frozen at the lane's first run: its shard, ledger prefix, lock, cap and items. */
export interface LaneRecord { part: PartName; shard: Shard; allocation: string; lockKey: number; capMicros: number; manifestSha256: string; items: string[] }
/**
 * Freezes a file several lanes may create at once (the part manifest): an atomic first write, then
 * every later writer must hold exactly the same content.
 */
export function freezeShared(path: string, value: unknown, what: string) {
  const text = stable(value) + '\n';
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
  try { linkSync(tmp, path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if (stable(JSON.parse(readFileSync(path, 'utf8'))) !== stable(value)) throw new EvaluationError(`The ${what} differs from the one this part froze first (another commit, policy, input, order or shard count)`);
  } finally { rmSync(tmp, { force: true }); }
}
/** Replaces a report file in one step, so a lane finishing at the same time never reads half of it. */
function writeAtomic(path: string, text: string) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}
/** True when the lane's last allocation event is a balanced close: nothing open, nothing to reconcile. */
export function laneClosed(laneDir: string): boolean {
  const path = join(laneDir, 'allocation.jsonl');
  if (!existsSync(path)) return false;
  const last = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).at(-1);
  if (!last) return false;
  const event = JSON.parse(last) as { event?: string; balanced?: boolean };
  return event.event === 'close' && event.balanced === true;
}
/**
 * Every lane journal of a part, merged. Refuses lanes outside the part's k shards, a lane that does not
 * belong to this run or holds other items, an attempt journaled twice, and an unreconciled lane; a lane
 * not started, still running or not closed makes the part incomplete (`Incomplete schedule`).
 */
export function mergeLanes(dir: string, part: PartName, k: number, manifestSha256: string, itemsOf?: (shard: Shard) => string[]): Map<string, Recorded> {
  const partDirectory = partDirOf(dir, part);
  const names = readdirSync(partDirectory, { withFileTypes: true }).filter(d => d.isDirectory() && /^\d+of\d+$/.test(d.name)).map(d => d.name);
  // A directory a preflight opened but no run used holds no lane record.
  const ran = names.filter(n => existsSync(join(partDirectory, n, 'lane.json')));
  const expected = Array.from({ length: k }, (_, j) => laneName({ i: j + 1, k }));
  const extra = ran.filter(n => !expected.includes(n));
  if (extra.length) throw new EvaluationError(`${part}: lanes outside its ${k} shard(s): ${extra.join(', ')}`);
  const missing = expected.filter(n => !ran.includes(n));
  if (missing.length) throw new EvaluationError(`Incomplete schedule: ${part} lanes not started: ${missing.join(', ')}`);
  const merged = new Map<string, Recorded>();
  for (const [j, name] of expected.entries()) {
    const shard = { i: j + 1, k }, laneDirectory = join(partDirectory, name);
    const lane = JSON.parse(readFileSync(join(laneDirectory, 'lane.json'), 'utf8')) as LaneRecord;
    if (lane.part !== part || lane.shard.i !== shard.i || lane.shard.k !== k || lane.manifestSha256 !== manifestSha256) throw new EvaluationError(`${part}: lane ${name} belongs to another run`);
    if (itemsOf && stable(lane.items) !== stable(itemsOf(shard))) throw new EvaluationError(`${part}: lane ${name} holds other items than its shard`);
    // Throws on an attempt without a durable result: that lane needs reconciliation.
    const journal = readJournal<Recorded>(join(laneDirectory, 'results.jsonl'));
    if (!laneClosed(laneDirectory)) throw new EvaluationError(`Incomplete schedule: ${part} lane ${name} is still running or not closed balanced`);
    const items = new Set(lane.items);
    for (const [key, r] of journal) {
      if (r.part !== part || (itemsOf && !items.has(r.itemId))) throw new EvaluationError(`${part}: lane ${name} journaled an item of another shard`);
      if (merged.has(key)) throw new EvaluationError(`${part}: an attempt is journaled in two lanes`);
      merged.set(key, r);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------

export async function main() {
  const { values } = parseArgs({ options: { mode: { type: 'string', default: 'preflight' }, part: { type: 'string' }, shard: { type: 'string', default: '1/1' },
    'env-files': { type: 'string', default: '.env.local' }, 'keys-file': { type: 'string' }, out: { type: 'string', default: 'data/work/task30' },
    'run-label': { type: 'string' }, policy: { type: 'string', default: DEFAULT_POLICY }, 'dev-label': { type: 'string' }, 'confirm-cost': { type: 'boolean', default: false } } });
  const label = values['run-label'] ?? '';
  if (!['preflight', 'run', 'summarize'].includes(values.mode!) || !/^[a-zA-Z0-9-]{1,40}$/.test(label)) throw new EvaluationError('Invalid mode or run label (--run-label required)');
  if (values['dev-label'] !== undefined && !/^[a-zA-Z0-9-]{1,40}$/.test(values['dev-label'])) throw new EvaluationError('Invalid development label');
  if (values.part !== undefined && !isPart(values.part)) throw new EvaluationError(`Unknown part; one of ${PARTS.join(', ')}`);
  if (values.mode === 'run' && (!values.part || !values['confirm-cost'])) throw new EvaluationError('A paid run needs --part and --confirm-cost');
  let shard: Shard;
  try { shard = parseShard(values.shard!); } catch (e) { throw new EvaluationError((e as Error).message); }
  if (values.part === 'retrieval' && shard.k !== 1) throw new EvaluationError('The retrieval part runs as one lane: --shard 1/1');
  const parts: PartName[] = values.part ? [values.part as PartName] : [...PARTS];
  const policy = resolvePolicy(values.policy!);
  const codeCommit = codeIdentity();
  const root = resolve(values.out!), dir = join(root, label);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (values.mode === 'summarize') return summarize(dir, join(root, values['dev-label'] ?? label), parts, label);

  const needsTarget = parts.includes('retrieval');
  const settings = evaluationSettings(values['env-files']!, values['keys-file'], needsTarget);
  const ai = settings.config.ai;
  if (!ai.anthropic.apiKey || ai.anthropic.scopeModel !== MODEL || !settings.config.databaseIngestUrl
    || (needsTarget && (!settings.config.databaseUrl || !ai.openai.apiKey || ai.openai.embeddingModel !== 'text-embedding-3-small'
      || ai.openai.embeddingDimensions !== 1536 || settings.config.elasticsearch.indexPrefix !== 'ai-aviation-dev'))) {
    throw new EvaluationError('Expected development provider, ledger and index configuration required');
  }
  const s = stages(policy);
  const db = needsTarget ? createDb(settings.config.databaseUrl!, { max: 3, applicationName: 'aircase-task30-ranking-read' }) : undefined;
  const es = needsTarget ? createEsClient(settings.config.elasticsearch, 'read') : undefined;
  try {
    const target = needsTarget ? await verifyTarget(db!, es!) : undefined;
    const preflight: Record<string, unknown>[] = [];
    for (const part of parts) {
      const laneShard = part === 'retrieval' ? { i: 1, k: 1 } : shard;
      try { preflight.push(preflightPart(part, dir, policy, s, target?.sets, values.mode === 'preflight', laneShard, Boolean(values.part))); }
      catch (e) { if (!(e instanceof EvaluationError)) throw e; preflight.push({ part, ready: false, reason: e.message }); }
    }
    console.log(JSON.stringify({ event: 'preflight', label, codeCommit, policy: policyRecord(policy), stages: s, identities: currentIdentities(),
      ...(target ? { generation: target.identity.source.generationId, revision: target.identity.dataset.revision, passages: target.identity.passages.indexVersion } : {}),
      family: TASK30_FAMILY, budgets: PART_BUDGET_MICROS, parts: preflight }));
    if (values.mode === 'preflight') {
      if (values.part) await preflightLane(settings, dir, values.part as PartName, shard, Number(preflight[0]?.firstBlockMicros ?? 1));
      else await familyTotals(settings);
      return;
    }
    const part = parts[0]!, ready = preflight[0]!;
    if (ready.ready === false) throw new EvaluationError(`${part} is not ready: ${String(ready.reason)}`);
    if (part === 'retrieval') await runRetrieval(settings, db!, es!, target!, dir, label, codeCommit, policy, s);
    else await runAttributionLane(settings, dir, label, codeCommit, policy, s, part, shard);
    // The last lane of a part to close finds every lane closed and writes the part's summary.
    summarizePart(dir, dir, part, label);
  } finally {
    await es?.close(); if (db) await closeDb(db);
  }
}

/** The free check of one lane: its allocation opened (lock, family allowance) and its first block asserted, nothing reserved. */
async function preflightLane(settings: EvaluationSettings, dir: string, part: PartName, shard: Shard, firstBlockMicros: number) {
  const task = laneSpec(part, shard);
  const allocation = await CappedAllocation.open(settings, laneDirOf(dir, part, shard), task);
  try {
    await allocation.assertBlock(Math.max(1, firstBlockMicros));
    console.log(JSON.stringify({ event: 'allowance', lane: task.allocation, lockKey: task.lockKey, capMicros: task.capMicros,
      lane_totals: await taskTotals(allocation.db, task), family: await prefixTotals(allocation.db, `${TASK30_FAMILY.prefix}%`), firstBlockMicros }));
  } finally { await allocation.close(); }
}
/** Without --part: what the whole family of lanes has charged and holds open (a read; no lock, nothing reserved). */
async function familyTotals(settings: EvaluationSettings) {
  const db = createDb(settings.config.databaseIngestUrl!, { max: 1, applicationName: 'aircase-task30-preflight' });
  try { console.log(JSON.stringify({ event: 'family', prefix: TASK30_FAMILY.prefix, capMicros: TASK30_FAMILY.capMicros, totals: await prefixTotals(db, `${TASK30_FAMILY.prefix}%`) })); }
  finally { await closeDb(db); }
}

/** One part's free preflight: its inputs validated, sizing per part and per lane, and (for a confirmation part) the probes' freeze. */
export function preflightPart(part: PartName, dir: string, policy: EvidenceAutoFilterPolicy, s: StageMicros30, sets: readonly QuestionSet[] | undefined,
  freeze: boolean, shard: Shard = { i: 1, k: 1 }, oneLane = false) {
  const spec = PART_SPECS[part];
  if (part === 'retrieval') {
    if (!sets) throw new EvaluationError('The retrieval part needs the development target');
    const worst = sets.reduce((n, set) => n + set.questions.length * retrievalQuestionMicros(s, set.samples.length), 0);
    const expected = sets.reduce((n, set) => n + set.questions.length * expectedRetrievalQuestionMicros(set.samples.length), 0);
    const task = laneSpec('retrieval', { i: 1, k: 1 });
    return { part, ready: true, sets: sets.map(set => ({ name: set.name, questions: set.questions.length, samples: set.samples.length,
      labelChanges: set.changes.filter(c => c.added || c.removed), crossGroupShares: set.crossGroupShares })),
      worstCaseMicros: worst, chargeableWorstMicros: worst, expectedMicros: expected, firstBlockMicros: retrievalQuestionMicros(s, 3),
      lanes: [{ lane: '1of1', allocation: task.allocation, lockKey: task.lockKey, capMicros: task.capMicros, expectedMicros: expected, expectedFits: expected <= task.capMicros }],
      importWindowNow: inReleaseQuietWindow(new Date()) };
  }
  const data = partData(part);
  const scripted = spec.scope !== 'real';
  const confirm = spec.family === 'confirm' && data.probes ? freezeConfirm(dir, data.probes, freeze) : undefined;
  // A scripted part calls the check exactly for its items with a candidate; a real scope's answers are unknown before the run.
  const size = (items: readonly PartItem[]) => {
    const attempts = items.length * spec.samples, coverage = scripted ? candidateCoverage(items, policy) : undefined;
    const checks = coverage ? coverage.withCandidate * spec.samples : attempts;
    return { items: items.length, attempts, coverage, worstCaseMicros: attempts * attributionSampleMicros(s),
      chargeableWorstMicros: scripted ? checks * s.attribution : attempts * chargeableSampleMicros(s, false),
      expectedMicros: scripted ? checks * EXPECTED_MICROS.attribution : attempts * expectedSampleMicros(false) };
  };
  const whole = size(data.items), order = seededOrder(data.items);
  const lanes = (oneLane ? [shard] : Array.from({ length: shard.k }, (_, j) => ({ i: j + 1, k: shard.k }))).map(sh => {
    const task = laneSpec(part, sh), l = size(shardItems(order, sh));
    return { lane: laneName(sh), allocation: task.allocation, lockKey: task.lockKey, capMicros: task.capMicros, items: l.items,
      chargeableWorstMicros: l.chargeableWorstMicros, expectedMicros: l.expectedMicros, expectedFits: l.expectedMicros <= task.capMicros };
  });
  return { part, ready: true, file: data.path, sha256: data.sha256, items: whole.items, samples: spec.samples, attempts: whole.attempts,
    ...(whole.coverage ? { candidates: whole.coverage } : {}),
    ...(data.probes ? { sources: tallyBy(data.probes.file.probes.map(p => p.source)), fields: tallyBy(data.probes.file.probes.map(p => p.field)),
      kinds: tallyBy(data.probes.file.probes.map(p => p.kind)), warnings: (({ kindMismatch, goldNotForced }) => ({ kindMismatch: kindMismatch.length, goldNotForced: goldNotForced.length }))(probeWarnings(data.probes.file)) } : {}),
    ...(confirm ? { confirmFreeze: confirm } : {}),
    worstCaseMicros: whole.worstCaseMicros, chargeableWorstMicros: whole.chargeableWorstMicros, expectedMicros: whole.expectedMicros,
    budgetMicros: PART_BUDGET_MICROS[part], firstBlockMicros: spec.samples * attributionSampleMicros(s), lanes, policy: autoFilterIdentity(policy) };
}
const tallyBy = (xs: string[]) => Object.fromEntries([...new Set(xs)].sort().map(k => [k, xs.filter(x => x === k).length]));
/**
 * Free and deterministic: the candidate rules the pipeline runs on a scripted item's filters (the
 * question, those filters, no request filters, the policy's fields). Items with a candidate are
 * exactly the ones whose samples call the check.
 */
export function candidateCoverage(items: readonly PartItem[], policy: EvidenceAutoFilterPolicy) {
  const fields = automaticFieldsOf(policy);
  let withCandidate = 0;
  const reasons: Record<string, Record<string, number>> = Object.fromEntries(fields.map(f => [f, {}]));
  for (const item of items) {
    if (item.scripted?.kind !== 'search') continue;
    const r = automaticCandidates(item.question, item.scripted.filters, {}, fields);
    if (r.candidates.length) withCandidate += 1;
    for (const f of fields) { const k = r.reasons[f]; reasons[f]![k] = (reasons[f]![k] ?? 0) + 1; }
  }
  return { scriptedSearches: items.filter(i => i.scripted?.kind === 'search').length, withCandidate, reasons };
}

/** The part manifest every lane of a part must match: code, policy, ranking, input, order and shard count. */
function attributionManifest(part: AttributionPart, data: PartData, order: readonly PartItem[], codeCommit: string, label: string,
  policy: EvidenceAutoFilterPolicy, s: StageMicros30, k: number, confirmFreeze?: string) {
  const spec = PART_SPECS[part];
  return { version: MANIFEST_VERSION, part, codeCommit, label, family: TASK30_FAMILY, policy: policyRecord(policy),
    ranking: evidenceRankingIdentity(evidenceRankingConfig('er-q-v1')), stages: s, samples: spec.samples, scope: spec.scope, shards: k,
    data: { path: data.path, sha256: data.sha256, items: data.items.length, orderSha256: sha256(stable(order.map(i => i.id))) },
    ...(confirmFreeze ? { confirmFreeze } : {}) };
}

async function runAttributionLane(settings: EvaluationSettings, dir: string, label: string, codeCommit: string,
  policy: EvidenceAutoFilterPolicy, s: StageMicros30, part: AttributionPart, shard: Shard) {
  const spec = PART_SPECS[part], data = partData(part), order = seededOrder(data.items), items = shardItems(order, shard);
  const confirmFreeze = spec.family === 'confirm' ? freezeConfirm(dir, data.probes!, false).sha256 : undefined;
  mkdirSync(partDirOf(dir, part), { recursive: true, mode: 0o700 });
  const manifest = attributionManifest(part, data, order, codeCommit, label, policy, s, shard.k, confirmFreeze);
  freezeShared(join(partDirOf(dir, part), 'manifest.json'), manifest, 'part manifest');
  const hash = sha256(stable(manifest)), task = laneSpec(part, shard), directory = laneDirOf(dir, part, shard);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  freezeShared(join(directory, 'lane.json'), { part, shard, allocation: task.allocation, lockKey: task.lockKey, capMicros: task.capMicros,
    manifestSha256: hash, items: items.map(i => i.id) } satisfies LaneRecord, 'lane record');
  let allocation: CappedAllocation | undefined = await CappedAllocation.open(settings, directory, task);
  try {
    const journalPath = join(directory, 'results.jsonl'), journal = readJournal<Recorded>(journalPath);
    const port = attributionPort(settings, allocation, spec.phase, hash, directory, policy);
    const samples = Array.from({ length: spec.samples }, (_, i) => i + 1);
    let streak = 0, done = 0;
    for (const item of items) {
      const remaining = samples.filter(n => !journal.has(attemptKey(label, part, item.id, n))).length;
      // An item starts only when its remaining worst case fits the lane's cap and the allowance; the gate still checks every stage.
      if (remaining) await allocation.assertBlock(remaining * attributionSampleMicros(s));
      for (const sample of samples) {
        const key = attemptKey(label, part, item.id, sample);
        let observation = journal.get(key)?.observation as AttributionObservation | undefined;
        if (!observation) {
          appendDurable(journalPath, { event: 'started', key, part, itemId: item.id, sample, at: new Date().toISOString() });
          observation = await port.run({ key, part, itemId: item.id, sample }, { id: item.id, question: item.question, scripted: item.scripted });
          const recorded: Recorded = { event: 'result', key, part, itemId: item.id, sample, observation };
          appendDurable(journalPath, recorded); journal.set(key, recorded);
        }
        // A failed search is never scored or repeated under this label, including on resume.
        if (observation.failure || observation.safetyFaults.length) throw new EvaluationError(`Search failed (${observation.failure ?? observation.safetyFaults.join(',')}); stop and inspect the journal`);
        streak = nextStreak30(streak, { scope: observation.scope === 'real' ? observation.scopeOutcome : undefined,
          attribution: observation.attributionCalled ? observation.attributionOutcome : undefined });
        if (streak >= STOP_STREAK) throw new EvaluationError('Three consecutive provider infrastructure outcomes; stopped, incomplete, no retries');
      }
      done += 1;
      if (done % 25 === 0 || done === items.length) console.log(JSON.stringify({ event: 'progress', part, lane: laneName(shard), items: done, of: items.length }));
    }
    const closing = allocation; allocation = undefined;
    console.log(JSON.stringify({ event: 'lane_complete', part, lane: laneName(shard), ledger: await closing.close() }));
  } finally { if (allocation) await allocation.close(); }
}

async function runRetrieval(settings: EvaluationSettings, db: Db, es: Client, target: Awaited<ReturnType<typeof verifyTarget>>,
  dir: string, label: string, codeCommit: string, policy: EvidenceAutoFilterPolicy, s: StageMicros30) {
  const shard = { i: 1, k: 1 }, partDirectory = partDirOf(dir, 'retrieval'), directory = laneDirOf(dir, 'retrieval', shard);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const identities = currentIdentities();
  const manifest = { version: MANIFEST_VERSION, part: 'retrieval', codeCommit, label, family: TASK30_FAMILY,
    target: target.identity, configurations: [identities.Q0, identities.QH50], policy: policyRecord(policy), rows: ROWS30, stages: s, shards: 1,
    sets: target.sets.map(set => ({ name: set.name, samples: set.samples.length, sourceFileSha256: set.sourceFileSha256, goldSha256: set.goldSha256,
      questions: set.questions.map(q => q.id) })) };
  freezeShared(join(partDirectory, 'manifest.json'), manifest, 'part manifest');
  // The re-derived sets, so the free summary needs no database.
  freezeShared(join(partDirectory, 'questions.json'), target.sets, 're-derived question sets');
  const hash = sha256(stable(manifest)), task = laneSpec('retrieval', shard);
  freezeShared(join(directory, 'lane.json'), { part: 'retrieval', shard, allocation: task.allocation, lockKey: task.lockKey, capMicros: task.capMicros,
    manifestSha256: hash, items: target.sets.flatMap(set => set.questions.map(q => `${set.name}:${q.id}`)) } satisfies LaneRecord, 'lane record');
  let allocation: CappedAllocation | undefined = await CappedAllocation.open(settings, directory, task);
  try {
    const journalPath = join(directory, 'results.jsonl'), journal = readJournal<Recorded>(journalPath);
    const port = productionPort(settings, db, es, target.pinned, allocation, 'selection', hash, directory, identities as unknown as Record<Arm, ArmIdentity>);
    let streak = 0;
    const search = async (set: QuestionSet, row: Row30, arm: 'Q0' | 'QH50', q: RankingQuestion, sample: number, request: SearchRequest) => {
      const key = attemptKey(label, 'retrieval', q.id, sample, row, set.name);
      let observation = journal.get(key)?.observation as SearchObservation | undefined;
      if (!observation) {
        if (inReleaseQuietWindow(new Date())) throw new EvaluationError('The daily import window (03:30 to 06:00 Europe/Prague) has started; resume after it');
        await assertTarget(db, target.pinned);
        appendDurable(journalPath, { event: 'started', key, part: 'retrieval', set: set.name, row, itemId: q.id, sample, at: new Date().toISOString() });
        observation = await port.run({ key, questionId: q.id, arm, sample: sample as 1 | 2 | 3 }, q, request);
        const recorded: Recorded = { event: 'result', key, part: 'retrieval', set: set.name, row, itemId: q.id, sample, observation };
        appendDurable(journalPath, recorded); journal.set(key, recorded);
        console.log(JSON.stringify({ event: 'search', set: set.name, row, questionId: q.id, sample, chargedMicros: Math.round(observation.actualUsd * 1e6),
          scope: observation.scopeOutcome, attribution: observation.attributionOutcome, rerank: observation.rerankOutcome, failure: observation.failure, cases: observation.ranking.length }));
      }
      if (observation.failure || observation.safetyFaults.length) throw new EvaluationError(`Search failed (${observation.failure ?? observation.safetyFaults.join(',')}); stop and inspect the journal`);
      streak = nextStreak30(streak, { scope: observation.scopeOutcome !== 'skipped' ? observation.scopeOutcome : undefined,
        rerank: observation.timing.rerank.attempted ? observation.rerankOutcome : undefined,
        attribution: observation.attributionCalled ? observation.attributionOutcome : undefined });
      if (streak >= STOP_STREAK) throw new EvaluationError('Three consecutive provider infrastructure outcomes; stopped, incomplete, no retries');
      return observation;
    };
    const remainingMicros = (set: QuestionSet, q: RankingQuestion) => {
      const has = (row: Row30, sample: number) => journal.get(attemptKey(label, 'retrieval', q.id, sample, row, set.name))?.observation as SearchObservation | undefined;
      let n = has('Q0', 1) ? 0 : s.embed;
      for (const sample of set.samples) {
        for (const [row, edit, cost] of [['QH50', 'QH50+F', s.scope + s.embed + s.rerank], ['QH50+A', 'QH50+A+F', s.scope + s.attribution + s.embed + s.rerank]] as const) {
          const parent = has(row, sample);
          if (!parent) n += cost;
          if ((!parent || (!parent.failure && buttonFilters(parent))) && !has(edit, sample)) n += s.embed + s.rerank;
        }
      }
      return n;
    };
    for (const set of target.sets) {
      for (const q of set.questions) {
        const needed = remainingMicros(set, q);
        if (needed) await allocation.assertBlock(needed);
        await search(set, 'Q0', 'Q0', q, 1, q0Request());
        for (const sample of set.samples) {
          const live = await search(set, 'QH50', 'QH50', q, sample, liveRequest());
          const f = buttonFilters(live);
          if (f) await search(set, 'QH50+F', 'QH50', q, sample, editRequest(f, live));
          const auto = await search(set, 'QH50+A', 'QH50', q, sample, attributedRequest(policy));
          const g = buttonFilters(auto);
          if (g) await search(set, 'QH50+A+F', 'QH50', q, sample, editRequest(g, auto, policy));
        }
      }
      // Each set is summarized as soon as it completes, so a stop in a later set keeps this one's result.
      const done = summarizeRetrievalSet(set, journal, label, policy);
      console.log(retrievalTable([done]).join('\n'));
    }
    const closing = allocation; allocation = undefined;
    console.log(JSON.stringify({ event: 'lane_complete', part: 'retrieval', lane: '1of1', ledger: await closing.close() }));
  } finally { if (allocation) await allocation.close(); }
}

/**
 * Scores one part from all its lanes, or reports why not: a part not started, a lane missing, running or
 * unreconciled, or an incomplete schedule is reported and never scored (nor used for decisions).
 */
function summarizePart(dir: string, devDir: string, part: PartName, label: string): boolean {
  const manifestPath = join(partDirOf(dir, part), 'manifest.json');
  if (!existsSync(manifestPath)) { console.log(JSON.stringify({ event: 'not_started', part })); return false; }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const hash = sha256(stable(manifest));
  try {
    // The part's own policy, as frozen at its first run.
    const policy = resolvePolicy(manifest.policy.version);
    if (autoFilterIdentity(policy).sha256 !== manifest.policy.sha256) throw new EvaluationError(`${part}: its policy is no longer registered with the same identity`);
    if (part === 'retrieval') {
      const journal = mergeLanes(dir, part, manifest.shards, hash);
      const sets = JSON.parse(readFileSync(join(partDirOf(dir, part), 'questions.json'), 'utf8')) as QuestionSet[];
      const done: RetrievalSetSummary[] = [];
      for (const set of sets) {
        try { done.push(summarizeRetrievalSet(set, journal, label, policy)); }
        catch (e) { if (!(e instanceof EvaluationError && /^Incomplete schedule/.test(e.message))) throw e; console.log(JSON.stringify({ event: 'incomplete', part, set: set.name })); }
      }
      if (done.length) writeSummary(dir, part, manifest, hash, { sets: done });
    } else {
      const data = partData(part);
      if (data.sha256 !== manifest.data.sha256) throw new EvaluationError(`${part}: its frozen input changed since the run`);
      const order = seededOrder(data.items);
      if (sha256(stable(order.map(i => i.id))) !== manifest.data.orderSha256) throw new EvaluationError(`${part}: its item order changed since the run`);
      const journal = mergeLanes(dir, part, manifest.shards, hash, sh => shardItems(order, sh).map(i => i.id));
      writeSummary(dir, part, manifest, hash, summarizeAttributionPart(part as AttributionPart, data, journal, label, policy));
    }
  } catch (e) {
    // An incomplete or failed part is reported, never scored.
    if (!(e instanceof EvaluationError)) throw e;
    console.log(JSON.stringify({ event: 'not_scored', part, reason: e.message }));
    return false;
  } finally {
    writeDecision(dir, devDir);
    writeMarkdown(dir);
  }
  return true;
}
/** Free: scores whatever each selected part's lanes completed; incomplete parts are reported, never scored. */
function summarize(dir: string, devDir: string, parts: PartName[], label: string) {
  for (const part of parts) summarizePart(dir, devDir, part, label);
  const path = join(dir, 'summary.md');
  if (existsSync(path)) console.log(readFileSync(path, 'utf8'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => {
  console.error(e instanceof EvaluationError ? e.message : 'Evaluation stopped; raw exception details suppressed. Inspect the durable journal.'); process.exitCode = 1;
});
