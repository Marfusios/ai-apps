/** Bounded, extractive model input only. Displayed evidence is never truncated or rewritten. */
import { PHASE_LABEL } from '../../shared/codes.js';
import type { EvidenceCase } from '../../shared/contracts/evidence.js';
import { countTokens } from '../ai/tokens.js';
import { RerankInputSchema, renderRerankUser, validateRerankOutput, type RerankCase, type RerankInput } from '../ai/prompts/rerank.r1.js';
import type { RerankConfig } from './ranking-config.js';
import type { EvidenceRetrievalResult } from './retrieve.js';

export const RERANK_INPUT_VERSION = 'rerank-input.v1';

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const maskIds = (text: string): string => text.replace(/\b[A-Z]{3}\d{2}[A-Z]{2}\d{3}[A-Z]?\b/gi, '[investigation]');
export function boundedRerankText(source: string, maxTokens: number): { text: string; truncated: boolean } {
  const text = maskIds(source);
  if (text.length <= 12_000 && countTokens(text) <= maxTokens) return { text, truncated: false };
  let end = 0;
  for (const s of segmenter.segment(text)) {
    const next = s.index + s.segment.length;
    if (next > 12_000 || countTokens(text.slice(0, next)) > maxTokens) break;
    end = next;
  }
  return { text: text.slice(0, end).trimEnd(), truncated: true };
}
const shorten = (value: { text: string; truncated: boolean }): boolean => {
  const sentences = [...segmenter.segment(value.text)];
  if (!sentences.length) return false;
  value.text = value.text.slice(0, sentences.at(-1)!.index).trimEnd(); value.truncated = true;
  return true;
};

/** Every cause variant and excerpt has a slot, even when no whole sentence fits its share. */
export interface RerankSourceCase {
  case: { date: EvidenceCase['case']['date']; aircraft: Pick<EvidenceCase['case']['aircraft'][number], 'category' | 'make' | 'model'>[]; definingPhases: EvidenceCase['case']['definingPhases'] };
  probableCauses: { text: string }[];
  excerpts: { text: string }[];
}
export function buildRerankInput(question: string, cases: readonly RerankSourceCase[], config: RerankConfig): RerankInput {
  const prepared = cases.slice(0, config.depth).map((c, i): RerankCase => {
    const first = c.case.aircraft[0];
    const aircraft = first ? [first.category.label, first.make, first.model].filter(Boolean).join(' · ') +
      (c.case.aircraft.length > 1 ? `; and ${c.case.aircraft.length - 1} more` : '') : 'Not reported';
    const date = c.case.date;
    const year = date ? Number(date.slice(0, 4)) : null;
    const row: RerankCase = {
      id: `c${String(i + 1).padStart(2, '0')}`,
      year: year !== null && Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null,
      aircraft: boundedRerankText(aircraft, config.input.aircraftTokens),
      phases: boundedRerankText(c.case.definingPhases.map(p => PHASE_LABEL[p]).join(', ') || 'Not reported', config.input.phaseTokens),
      probableCauses: c.probableCauses.map(p => boundedRerankText(p.text, Math.floor(config.input.causeTokens / c.probableCauses.length))),
      excerpts: c.excerpts.map(p => boundedRerankText(p.text, Math.floor(config.input.excerptTokens / Math.max(1, c.excerpts.length)))),
    };
    // Keep all labels and variant slots. At the total case bound remove whole sentences
    // from the last excerpt, then last cause, then metadata, in this frozen order.
    const fields = [...row.excerpts].reverse().concat([...row.probableCauses].reverse(), [row.phases, row.aircraft]);
    for (const field of fields) while (countTokens(JSON.stringify(row)) > config.input.caseTokens && shorten(field)) { /* bounded by the sentence count */ }
    if (countTokens(JSON.stringify(row)) > config.input.caseTokens) throw new Error('rerank case input bound exceeded');
    return row;
  });
  const input = RerankInputSchema.parse({ question, cases: prepared });
  if (countTokens(renderRerankUser(input)) > config.input.totalTokens) throw new Error('rerank total input bound exceeded');
  return input;
}

export function applyRerank(result: EvidenceRetrievalResult, raw: unknown, labels: readonly string[]): EvidenceRetrievalResult {
  const grades = new Map(validateRerankOutput(raw, labels).grades.map(g => [g.id, g.grade]));
  const order = labels.map((id, index) => ({ index, grade: grades.get(id)! })).sort((a, b) => b.grade - a.grade || a.index - b.index);
  const indices = [...order.map(x => x.index), ...result.cases.slice(labels.length).map((_, i) => i + labels.length)];
  return {
    ranking: indices.map(i => result.ranking[i]!),
    cases: indices.map((i, rank) => ({ ...result.cases[i]!, rank: rank + 1 })),
  };
}

/** Render a fixed, synthetic set through the same preparation as production. Its hash
 * binds masking, sentence boundaries, field order/metadata and truncation to the
 * configuration identity (including renderer escaping and its user-turn prefix). */
export function rerankInputIdentityFixture(config: RerankConfig): string {
  const short = 'See CEN19FA001 and sea08la057A. Engine examination found no fault. ';
  const long = short + 'The pilot reported <power> loss & a precautionary landing. '.repeat(100);
  const make = 'Fixture CEN19FA001 Manufacturer. ';
  const ordinary: RerankSourceCase = {
    case: { date: '2019-12-31', aircraft: [
      { category: { code: 'AIR', label: 'Airplane' }, make, model: 'Model 1. ' + 'Modified model. '.repeat(100) },
      { category: { code: 'HELI', label: 'Helicopter' }, make: 'Fixture', model: 'Model 2' },
    ], definingPhases: ['takeoff', 'initial_climb', 'approach'] },
    probableCauses: [{ text: short }, { text: long }],
    excerpts: [{ text: long }, { text: 'After this work, the engine ran. ' + 'Extra context. '.repeat(100) }, { text: 'A CEN19FA001 reference. 😀 ' + long }],
  };
  const manyVariants: RerankSourceCase = {
    ...ordinary,
    probableCauses: Array.from({ length: 16 }, (_, i) => ({ text: `Variant ${i + 1}. ${long}` })),
  };
  const missing: RerankSourceCase = {
    case: { date: null, aircraft: [], definingPhases: [] },
    probableCauses: [{ text: 'An undetermined loss of power.' }],
    excerpts: [{ text: 'CEN19FA001 ' + 'long-sentence '.repeat(400) }],
  };
  return renderRerankUser(buildRerankInput('Find CEN19FA001-related records: <question> & "quotes". 😀', [ordinary, manyVariants, missing], config));
}
