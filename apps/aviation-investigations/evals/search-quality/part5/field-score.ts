import { eligibleEmittedYearRange } from '../../../shared/year-eligibility.js';
import { eligibleEmittedCategories } from '../../../shared/category-eligibility.js';
import { fieldValue, wilson } from '../field-score.js';
import type { FieldQuestion, FieldObservation, Filters } from '../types.js';
import type { GenerationSource } from '../../retrieval/generation.js';

export interface C2Question extends FieldQuestion { stratum: string; field: 'yearRange' | 'category' }
export interface C2Dataset { version: 'task24-fields-c2-v1'; source: GenerationSource; questions: C2Question[] }
export function guardedFields(question: string, filters: Filters): Filters {
  const range = eligibleEmittedYearRange(question, { yearFrom: filters.yearFrom as number | undefined, yearTo: filters.yearTo as number | undefined }).range;
  const categories = eligibleEmittedCategories(question, (filters.category ?? []) as string[]).categories;
  return { ...range, ...(categories.length ? { category: categories } : {}) };
}
export function scoreC2(dataset: C2Dataset, observations: readonly FieldObservation[]) {
  const byId = new Map(observations.map(o => [o.id, o]));
  if (byId.size !== observations.length || observations.some(o => !dataset.questions.some(q => q.id === o.id))) throw new Error('Duplicate or unknown C2 observation');
  const metrics = (field: C2Question['field'], guarded: boolean) => {
    let tp = 0, fp = 0, fn = 0, criticalFp = 0, failures = 0, processed = 0;
    const errors: { id: string; gold: unknown[]; predicted: unknown[]; auxiliary: boolean; error: string | null }[] = [];
    const strata: Record<string, { planned: number; processed: number; tp: number; fp: number; fn: number; failures: number }> = {};
    const reasons: Record<string, number> = {};
    for (const q of dataset.questions) {
      const own = q.field === field;
      const key = own ? `${q.role}/${q.stratum}` : 'auxiliary/other-field';
      const s = strata[key] ??= { planned: 0, processed: 0, tp: 0, fp: 0, fn: 0, failures: 0 }; s.planned++;
      const o = byId.get(q.id); if (!o) continue;
      s.processed++; if (own) processed++;
      if (o.error) { s.failures++; if (own) failures++; }
      const raw = !o.error && o.output?.intent === 'case_search' ? o.output.filters as Filters : {};
      const want = fieldValue(q.gold, field);
      let got = fieldValue(raw, field);
      if (guarded) {
        const g = field === 'yearRange'
          ? eligibleEmittedYearRange(q.question, { yearFrom: raw.yearFrom as number | undefined, yearTo: raw.yearTo as number | undefined })
          : eligibleEmittedCategories(q.question, (raw.category ?? []) as string[]);
        reasons[g.reason] = (reasons[g.reason] ?? 0) + 1;
        got = 'range' in g ? fieldValue(g.range as Filters, field) : g.categories;
      }
      const correct = want.length > 0 && JSON.stringify(want) === JSON.stringify(got);
      if (correct) { tp++; s.tp++; }
      else {
        if (got.length) { fp++; s.fp++; criticalFp += Number(q.critical || !own); }
        if (want.length) { fn++; s.fn++; }
        if (got.length || want.length) errors.push({ id: q.id, gold: want, predicted: got, auxiliary: !own, error: o.error });
      }
    }
    return { tp, fp, fn, criticalFp, processed, failures, precision: wilson(tp,tp+fp),
      simultaneousPrecision: wilson(tp,tp+fp,1.959963984540054), recall: wilson(tp,tp+fn), strata, guardReasons: reasons, errors };
  };
  const raw = { yearRange: metrics('yearRange',false), category: metrics('category',false) };
  const guarded = { yearRange: metrics('yearRange',true), category: metrics('category',true) };
  const complete = dataset.questions.length === 1600 && byId.size === 1600;
  const failures = observations.filter(o => o.error).length;
  const clears = Object.fromEntries(Object.entries(guarded).map(([field,m]) => [field,complete && m.processed===800 && m.tp>=295
    && m.fp===0 && m.criticalFp===0 && (m.simultaneousPrecision.lower ?? 0)>=.98 && m.failures/800<=.05
    && failures/1600<=.05 && Object.values(m.strata).every(s=>s.processed===s.planned)]));
  const families = Object.fromEntries([...new Set(dataset.questions.map(q=>q.wordingFamily))].map(family => {
    const qs=dataset.questions.filter(q=>q.wordingFamily===family);
    return [family,{ planned:qs.length, processed:qs.filter(q=>byId.has(q.id)).length,
      errors:qs.filter(q=>guarded[q.field].errors.some(e=>e.id===q.id)).length,
      failures:qs.filter(q=>byId.get(q.id)?.error).length }];
  }));
  return { version:'task24-fields-c2-metrics-v1',complete,observations:observations.length,failures,raw,guarded,clears,families,
    multiplicity:{ fields:2,oneSidedAlphaPerField:.025,z:1.959963984540054 },
    note:'All 1600 questions audited for each applied field, including unintended emissions in the other field sample. Static or failed output is omission; no generation retry or repair.' };
}
