/** Public facts derived from executed queries; never model-written explanations. */
import { EvidenceQuerySchema, type EvidenceQuery, type EvidenceSuggestion } from '../../shared/contracts/evidence.js';
import type { LexicalSource } from './pipeline.js';
import type { SearchData } from './store.js';

export function questionQuery(source?: LexicalSource, addedTerms?: string | null): EvidenceQuery {
  const keywords = source === 'terms' || source === 'question+terms'
    ? { kind: source, terms: addedTerms } : { kind: 'question' };
  return EvidenceQuerySchema.parse({ source: 'question', keywords });
}

/** Read the saved suffix, never reconstruct it by normalizing the question again.
 * Pre-suffix v3 rows already have disclosure facts. Pre-v3 rows can use their exact
 * stored lexical/vector prefix, or the retained suggestion conservatively; neither
 * fallback runs today's normalization over historical text.
 */
export function disclosedQuery(data: Pick<SearchData, 'query' | 'lexicalSource' | 'executed' | 'addedTerms' | 'suggestion'>): EvidenceQuery {
  if (data.query.source === 'edited') return EvidenceQuerySchema.parse(data.query);
  if (data.addedTerms !== undefined) return questionQuery(data.lexicalSource, data.addedTerms);
  if ('keywords' in data.query) return EvidenceQuerySchema.parse(data.query);
  const source = data.lexicalSource;
  if (source !== 'terms' && source !== 'question+terms') return questionQuery();
  const texts = data.executed;
  const legacyTerms = source === 'terms' ? texts?.lexical : texts && texts.lexical.startsWith(texts.vector + ' ')
    ? texts.lexical.slice(texts.vector.length + 1) : data.suggestion?.terms;
  return questionQuery(source, legacyTerms); // missing facts fail closed rather than under-disclose
}

export function remainingSuggestion(query: EvidenceQuery, suggestion: EvidenceSuggestion | null): EvidenceSuggestion | null {
  if (!suggestion) return null;
  const terms = query.source === 'question' && query.keywords.kind !== 'question' ? null : suggestion.terms;
  const hasFilters = Object.values(suggestion.filters).some(value => Array.isArray(value) ? value.length > 0 : value !== undefined);
  return terms === null && !hasFilters ? null : { filters: suggestion.filters, terms };
}
