/**
 * The attribution check's input and the server's decision on its answer (`attributed.v1`, attr.a2).
 * The check judges each value on its own: `state:XX` for each state, `years` for the one range,
 * `category:CODE` for each category, as AirCase's own canonical labels, never scope text; the
 * question is the reader's. A field applies only as a whole: only when every one of its values'
 * checks names the field's accident class and quotes a span of the question that contains that
 * value's witness (the exact words the candidate builder matched, shared/automatic-candidates.ts).
 * Anything else applies nothing for that field. A structurally invalid answer (schema, or not
 * exactly one check per value) applies nothing at all. Return values carry no question or quote
 * text except the filters.
 */
import {
  ATTRIBUTION_MAX_CATEGORIES, ATTRIBUTION_MAX_STATES, AttributionInputSchema, validateAttributionOutput,
  type AttributionAbout, type AttributionField, type AttributionInput, type AttributionOutput,
} from '../ai/prompts/attribution.a2.js';
import {
  AUTOMATIC_MAX_CATEGORIES, AUTOMATIC_MAX_STATES, normalizedQuestion, type AutomaticCandidate, type AutomaticField,
  type CandidateReason, type WitnessSpan,
} from '../../shared/automatic-candidates.js';
import { EvidenceAutomaticFiltersSchema, type EvidenceAutomaticFilters } from '../../shared/contracts/evidence.js';
import { AIRCRAFT_CATEGORY, US_STATE } from '../../shared/vocab.js';

/** The two field lists are one, and the candidate builder sends no more values than the check takes. */
type Same<A, B> = [A, B] extends [B, A] ? true : never;
const _same: [Same<AutomaticField, AttributionField>, Same<typeof AUTOMATIC_MAX_STATES, typeof ATTRIBUTION_MAX_STATES>,
  Same<typeof AUTOMATIC_MAX_CATEGORIES, typeof ATTRIBUTION_MAX_CATEGORIES>] = [true, true, true];
void _same;

/** Why a field was or was not applied automatically. Private diagnostics: enums only. */
export type AutoFieldReason = 'applied' | `not_candidate:${CandidateReason}` | `attribution:${AttributionAbout}` | 'attribution_unavailable' | 'bad_quote';

/** The only `about` that can apply each field. */
export const ACCIDENT_CLASS: Readonly<Record<AutomaticField, AttributionAbout>> = Object.freeze({
  state: 'accident_location', years: 'accident_date', category: 'accident_aircraft',
});

/** One value of a candidate as the check reads it, with the span of the question that names it. */
export interface CandidateValue { id: string; field: AutomaticField; value: string; witness: WitnessSpan }

/** A candidate's values, in value order: what the filter would keep, with the years' operators. */
export function candidateValues(c: AutomaticCandidate): CandidateValue[] {
  if (c.field === 'state') return c.state.map((code, i) => ({ id: `state:${code}`, field: c.field, value: `${US_STATE[code]} (${code})`, witness: c.witnesses[i]! }));
  if (c.field === 'category') {
    return c.category.map((code, i) => ({ id: `category:${code}`, field: c.field, value: AIRCRAFT_CATEGORY[code]!.toLowerCase(), witness: c.witnesses[i]! }));
  }
  const { yearFrom: from, yearTo: to } = c;
  const value = from !== undefined && to !== undefined ? from === to ? `${from}` : `${from} to ${to}` : from !== undefined ? `${from} or later` : `${to} or earlier`;
  return [{ id: 'years', field: c.field, value, witness: c.witnesses[0]! }];
}

/** The check's input: the question as asked and every candidate value, fields in order. */
export function attributionInput(question: string, candidates: readonly AutomaticCandidate[]): AttributionInput {
  return AttributionInputSchema.parse({ question, candidates: candidates.flatMap(c => candidateValues(c).map(({ id, field, value }) => ({ id, field, value }))) });
}

/** The answer if it is structurally complete for `input` (schema, exactly one check per value), else null. */
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

/** Why one value's check does not approve it, or 'applied'. */
function valueReason(question: string, v: CandidateValue, checked: AttributionOutput | null): AutoFieldReason {
  const check = checked?.checks.find(k => k.id === v.id);
  if (!check) return 'attribution_unavailable';
  if (check.about !== ACCIDENT_CLASS[v.field]) return `attribution:${check.about}`;
  return quoteCovers(question, check.quote, [v.witness]) ? 'applied' : 'bad_quote';
}

/**
 * The filters the check approves, all or nothing per field, and each candidate field's reason: the
 * first of its values (in value order) that is not approved, else applied. `output` null (the
 * stage failed or was refused) applies nothing.
 */
export function attributedFilters(question: string, candidates: readonly AutomaticCandidate[], output: AttributionOutput | null): {
  filters: EvidenceAutomaticFilters | null; fields: Partial<Record<AutomaticField, AutoFieldReason>>;
} {
  const fields: Partial<Record<AutomaticField, AutoFieldReason>> = {};
  if (!candidates.length) return { filters: null, fields };
  const checked = output && checkedAttribution(attributionInput(question, candidates), output);
  let filters: EvidenceAutomaticFilters | Record<string, never> = {};
  for (const c of candidates) {
    const reason = candidateValues(c).map(v => valueReason(question, v, checked)).find(r => r !== 'applied') ?? 'applied';
    fields[c.field] = reason;
    if (reason === 'applied') filters = { ...filters, ...filtersOf(c) };
  }
  return { filters: Object.keys(filters).length ? EvidenceAutomaticFiltersSchema.parse(filters) : null, fields };
}
