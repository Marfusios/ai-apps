/**
 * The attribution check's input and the server's decision on its answer (`attributed.v1`). The
 * candidates are AirCase's own canonical labels, never scope text; the question is the reader's.
 * A candidate applies only as a whole, only when its check names the field's accident class and
 * its quote is a span of the question that contains every value's witness (the exact words the
 * candidate builder matched, shared/automatic-candidates.ts). Anything else applies nothing for
 * that field. A structurally invalid answer (schema, or not exactly one check per candidate)
 * applies nothing at all. Return values carry no question or quote text except the filters.
 */
import { AttributionInputSchema, validateAttributionOutput, type AttributionAbout, type AttributionField, type AttributionInput, type AttributionOutput } from '../ai/prompts/attribution.a1.js';
import { normalizedQuestion, type AutomaticCandidate, type AutomaticField, type CandidateReason, type WitnessSpan } from '../../shared/automatic-candidates.js';
import { EvidenceAutomaticFiltersSchema, type EvidenceAutomaticFilters } from '../../shared/contracts/evidence.js';
import { AIRCRAFT_CATEGORY, US_STATE } from '../../shared/vocab.js';

/** The two field lists are one: a candidate's field is its check's id. */
const _sameFields: [AutomaticField, AttributionField] extends [AttributionField, AutomaticField] ? true : never = true;
void _sameFields;

/** Why a field was or was not applied automatically. Private diagnostics: enums only. */
export type AutoFieldReason = 'applied' | `not_candidate:${CandidateReason}` | `attribution:${AttributionAbout}` | 'attribution_unavailable' | 'bad_quote';

/** The only `about` that can apply each field. */
export const ACCIDENT_CLASS: Readonly<Record<AutomaticField, AttributionAbout>> = Object.freeze({
  state: 'accident_location', years: 'accident_date', category: 'accident_aircraft',
});

/** A candidate's values as the check reads them: what the filter would keep, with its operators. */
export function candidateValues(c: AutomaticCandidate): string[] {
  if (c.field === 'state') return c.state.map(code => `${US_STATE[code]} (${code})`);
  if (c.field === 'category') return c.category.map(code => AIRCRAFT_CATEGORY[code]!.toLowerCase());
  const { yearFrom: from, yearTo: to } = c;
  return [from !== undefined && to !== undefined ? from === to ? `${from}` : `${from} to ${to}` : from !== undefined ? `${from} or later` : `${to} or earlier`];
}

/** The check's input: the question as asked and the candidates in field order. */
export function attributionInput(question: string, candidates: readonly AutomaticCandidate[]): AttributionInput {
  return AttributionInputSchema.parse({ question, candidates: candidates.map(c => ({ id: c.field, values: candidateValues(c) })) });
}

/** The answer if it is structurally complete for `input` (schema, exactly one check per candidate), else null. */
export function checkedAttribution(input: AttributionInput, output: unknown): AttributionOutput | null {
  try { return validateAttributionOutput(output, input); } catch { return null; }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * True when some occurrence of the quote (normalised like the question, compared without case) in
 * the normalised question contains every witness span. An empty quote, a quote that is not in the
 * question, or one taken from another occurrence of the same words does not.
 */
export function quoteCovers(question: string, quote: string, witnesses: readonly WitnessSpan[]): boolean {
  const text = normalizedQuestion(question), q = normalizedQuestion(quote);
  if (!q || !witnesses.length) return false;
  let re: RegExp;
  try { re = new RegExp(escape(q), 'giu'); } catch { return false; }
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index, end = start + m[0].length;
    if (witnesses.every(w => start <= w.start && w.end <= end)) return true;
    re.lastIndex = start + 1; // overlapping occurrences too
  }
  return false;
}

/** The candidate's own filter keys. */
function filtersOf(c: AutomaticCandidate): EvidenceAutomaticFilters {
  if (c.field === 'state') return { state: [...c.state] as EvidenceAutomaticFilters['state'] };
  if (c.field === 'category') return { category: [...c.category] };
  return { ...(c.yearFrom !== undefined ? { yearFrom: c.yearFrom } : {}), ...(c.yearTo !== undefined ? { yearTo: c.yearTo } : {}) };
}

/**
 * The filters the check approves, all or nothing per field, and each candidate field's reason.
 * `output` null (the stage failed or was refused) applies nothing.
 */
export function attributedFilters(question: string, candidates: readonly AutomaticCandidate[], output: AttributionOutput | null): {
  filters: EvidenceAutomaticFilters | null; fields: Partial<Record<AutomaticField, AutoFieldReason>>;
} {
  const fields: Partial<Record<AutomaticField, AutoFieldReason>> = {};
  if (!candidates.length) return { filters: null, fields };
  const checked = output && checkedAttribution(attributionInput(question, candidates), output);
  let filters: EvidenceAutomaticFilters | Record<string, never> = {};
  for (const c of candidates) {
    const check = checked?.checks.find(k => k.id === c.field);
    if (!check) fields[c.field] = 'attribution_unavailable';
    else if (check.about !== ACCIDENT_CLASS[c.field]) fields[c.field] = `attribution:${check.about}`;
    else if (!quoteCovers(question, check.quote, c.witnesses)) fields[c.field] = 'bad_quote';
    else { fields[c.field] = 'applied'; filters = { ...filters, ...filtersOf(c) }; }
  }
  return { filters: Object.keys(filters).length ? EvidenceAutomaticFiltersSchema.parse(filters) : null, fields };
}
