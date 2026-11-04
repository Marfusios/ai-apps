/** Task 30's frozen inputs, checked before use, and the items each attribution part runs. No provider, database or network. */
import { readFileSync } from 'node:fs';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { EvaluationError } from '../search-quality/money.js';
import { fileSha, FROZEN_DIR, sha } from '../search-quality/frozen.js';
import { C2_DIR } from '../search-quality/part5/frozen.js';
import type { C2Dataset } from '../search-quality/part5/field-score.js';
import { opaqueId } from '../langfuse/data.js';
import { mulberry32 } from '../retrieval/experiments/stats.js';
import { loadProbes, type LoadedProbes, type Probe, type ProbeFamily } from './probes.js';
import { autoFilters, PART_SPECS, replayScope, type AttributionPart, type AutoFilters, type PartName, type ReplayCase, type Row30, type ScriptedScope } from './plan.js';

export const REPLAY_PATH = 'tests/fixtures/state-field-replay.json';
/** The recorded Field test C run's observations.json (outside the repository); part 5's exclusion audit lists the same sha. */
export const REPLAY_OBSERVATIONS_SHA256 = '190a710361a82c03f84ef143dc30f8316f2326783e274100de5b08b7f9be22ba';
export const C2_PATH = `${C2_DIR}/fields.json`;
/** Items run in one seeded order, so a part stopped by the cap is a random subset, not the file's first writers. */
export const ORDER_SEED = 30;

export function loadReplay(path = REPLAY_PATH) {
  const bytes = readFileSync(path);
  const data = JSON.parse(bytes.toString('utf8')) as { version: string; questionsSha256: string; observationsSha256: string; cases: ReplayCase[] };
  if (data.version !== 'state-c-replay.v1' || data.cases.length !== 1040 || new Set(data.cases.map(c => c.id)).size !== 1040) throw new EvaluationError('Unexpected state replay membership');
  if (data.observationsSha256 !== REPLAY_OBSERVATIONS_SHA256) throw new EvaluationError('State replay observations changed');
  const audit = JSON.parse(readFileSync(`${C2_DIR}/exclusions.json`, 'utf8')) as { additionalFiles: { source: string; path: string; sha256: string }[] };
  if (!audit.additionalFiles.some(f => f.source === 'task24-fields' && f.path === 'observations.json' && f.sha256 === data.observationsSha256)) throw new EvaluationError('State replay observations are not the audited Field test C run');
  // The questions and gold are Task 24's frozen field set, in its order.
  const fields = `${FROZEN_DIR}/fields.json`;
  if (data.questionsSha256 !== fileSha(fields)) throw new EvaluationError('State replay questions changed');
  const frozen = (JSON.parse(readFileSync(fields, 'utf8')) as { questions: { id: string; question: string; gold: { state?: string[] } }[] }).questions;
  if (frozen.length !== data.cases.length || frozen.some((q, i) => q.id !== data.cases[i]!.id || q.question !== data.cases[i]!.question
    || JSON.stringify([...(q.gold.state ?? [])].sort()) !== JSON.stringify([...data.cases[i]!.gold].sort()))) throw new EvaluationError('State replay disagrees with the frozen field set');
  return { path, sha256: sha(bytes), cases: data.cases };
}
export function loadC2(path = C2_PATH) {
  const recorded = (JSON.parse(readFileSync(`${C2_DIR}/field-manifest.json`, 'utf8')) as { files: Record<string, string> }).files[C2_PATH];
  const bytes = readFileSync(path);
  if (!recorded || sha(bytes) !== recorded) throw new EvaluationError('C2 field set changed');
  const dataset = JSON.parse(bytes.toString('utf8')) as C2Dataset;
  if (dataset.version !== 'task24-fields-c2-v1' || dataset.questions.length !== 1600 || new Set(dataset.questions.map(q => q.id)).size !== 1600) throw new EvaluationError('Unexpected C2 membership');
  return { path, sha256: recorded, dataset };
}

export interface PartItem { id: string; question: string; gold: AutoFilters; forced: AutoFilters | null; scripted: ScriptedScope | null; tags: Record<string, string> }
export const probeItems = (probes: LoadedProbes, scripted: boolean): PartItem[] => probes.file.probes.map((p: Probe) => ({ id: p.id, question: p.question,
  gold: autoFilters(p.gold), forced: autoFilters(p.forced), scripted: scripted ? { kind: 'search', filters: p.forced as BriefFilters } : null,
  tags: { pattern: p.pattern, source: p.source, kind: p.kind, field: p.field } }));
export const replayItems = (cases: readonly ReplayCase[]): PartItem[] => cases.map(c => {
  const [, field = 'other', role = 'other'] = /^t24-field-([A-Za-z]+)-(positive|control)-\d+$/.exec(c.id) ?? [];
  return { id: c.id, question: c.question, gold: autoFilters({ state: c.gold }), scripted: replayScope(c.intent, c.emitted),
    forced: c.intent === 'case_search' ? autoFilters({ state: c.emitted }) : {}, tags: { field, role, intent: c.intent ?? 'scope_failure' } };
});
export const c2Items = (dataset: C2Dataset): PartItem[] => dataset.questions.map(q => ({ id: q.id, question: q.question, gold: autoFilters(q.gold as AutoFilters),
  forced: null, scripted: null, tags: { field: q.field, role: q.role, critical: String(q.critical), stratum: q.stratum, wordingFamily: q.wordingFamily } }));
/** Fisher–Yates with the evaluation's seed. */
export function seededOrder<T>(items: readonly T[], seed = ORDER_SEED): T[] {
  const out = [...items], random = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
}

export interface PartData { path: string; sha256: string; items: PartItem[]; probes?: LoadedProbes; replay?: ReplayCase[]; c2?: C2Dataset }
export function partData(part: AttributionPart): PartData {
  const spec = PART_SPECS[part];
  if (spec.data === 'probes-dev' || spec.data === 'probes-confirm') {
    const family: ProbeFamily = spec.data === 'probes-dev' ? 'dev' : 'confirm';
    const probes = loadProbes(family);
    if (!probes) throw new EvaluationError(`The ${family} probe file is not frozen yet`);
    return { path: probes.path, sha256: probes.sha256, items: probeItems(probes, spec.scope === 'forced'), probes };
  }
  if (spec.data === 'replay') { const r = loadReplay(); return { path: r.path, sha256: r.sha256, items: replayItems(r.cases), replay: r.cases }; }
  const c = loadC2();
  return { path: c.path, sha256: c.sha256, items: c2Items(c.dataset), c2: c.dataset };
}

/** One attempt's journal key: never reused across labels, parts, sets, rows or samples. */
export const attemptKey = (label: string, part: PartName, itemId: string, sample: number, row?: Row30, set?: string) =>
  opaqueId('task30', label, part, ...(set ? [set] : []), itemId, ...(row ? [row] : []), String(sample));
