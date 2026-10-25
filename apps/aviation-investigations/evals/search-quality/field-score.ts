import { eligibleEmittedStates } from '../../shared/state-eligibility.js';
import type { Field, FieldDataset, FieldObservation, Filters } from './types.js';

export function wilson(success: number, total: number, z = 1.959963984540054) {
  if (!total) return { success, total, rate: null, lower: null, upper: null };
  const p = success / total, d = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / d;
  const half = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / d;
  return { success, total, rate: p, lower: Math.max(0, center - half), upper: Math.min(1, center + half) };
}
export function fieldValue(filters: Filters, field: Field): unknown[] {
  if (field === 'yearRange') return ['yearFrom', 'yearTo'].filter(k => filters[k] !== undefined).map(k => [k, filters[k]]);
  const v = filters[field];
  return Array.isArray(v) ? [...new Set(v)].sort() : [];
}
export function scoreFields(dataset: FieldDataset, observations: readonly FieldObservation[]) {
  const byId = new Map(observations.map(o => [o.id, o]));
  if (byId.size !== observations.length || observations.some(o => !dataset.questions.some(q => q.id === o.id))) throw new Error('Duplicate or unknown field observations');
  const fields: Field[] = ['state', 'yearRange', 'category', 'phase', 'injury', 'conditions', 'light'];
  const metrics = (field: Field, guarded: boolean) => {
    let tp = 0, fp = 0, fn = 0, criticalFp = 0, failures = 0, processed = 0;
    const errors: { id: string; gold: unknown[]; predicted: unknown[]; critical: boolean; error: string | null }[] = [];
    const guardReasons: Record<string, number> = {};
    for (const q of dataset.questions.filter(q => q.field === field)) {
      const o = byId.get(q.id);
      if (!o) continue;
      processed++;
      failures += Number(!!o.error);
      const filters = !o.error && o.output?.intent === 'case_search' ? o.output.filters as Filters : {};
      const want = fieldValue(q.gold, field);
      let got = fieldValue(filters, field);
      if (guarded) {
        const g = eligibleEmittedStates(q.question, got as string[]);
        got = g.states; guardReasons[g.reason] = (guardReasons[g.reason] ?? 0) + 1;
      }
      if (want.length && JSON.stringify(want) === JSON.stringify(got)) tp++;
      else {
        fp += Number(got.length > 0); fn += Number(want.length > 0);
        criticalFp += Number(q.critical && got.length > 0);
        if (want.length || got.length) errors.push({ id: q.id, gold: want, predicted: got, critical: q.critical, error: o.error });
      }
    }
    return { tp, fp, fn, criticalFp, processed, failures, precision: wilson(tp, tp + fp), recall: wilson(tp, tp + fn),
      simultaneousPrecision: wilson(tp, tp + fp, 2.449997660602729), guardReasons, errors };
  };
  const raw = Object.fromEntries(fields.map(f => [f, metrics(f, false)]));
  const guardedState = metrics('state', true);
  const auxiliaryStateErrors = dataset.questions.filter(q => q.field !== 'state').flatMap(q => {
    const o = byId.get(q.id);
    const states = !o?.error && o?.output?.intent === 'case_search' ? o.output.filters.state ?? [] : [];
    return eligibleEmittedStates(q.question, states).states.length ? [q.id] : [];
  });
  const complete = byId.size === dataset.questions.length;
  const failures = observations.filter(o => o.error).length;
  const clearsState = complete && guardedState.processed === 800 && guardedState.tp >= 295 && guardedState.fp === 0
    && guardedState.criticalFp === 0 && (guardedState.simultaneousPrecision.lower ?? 0) >= 0.98
    && guardedState.failures / 800 <= .05 && failures / dataset.questions.length <= .05 && auxiliaryStateErrors.length === 0;
  return { version: 'task24-field-metrics-v1', complete, observations: observations.length, failures,
    raw, guardedState, auxiliaryStateErrors, clearsState,
    note: 'Raw means validated case_search fields; invalid/static outputs omit fields. Other six fields are diagnostic only.' };
}
