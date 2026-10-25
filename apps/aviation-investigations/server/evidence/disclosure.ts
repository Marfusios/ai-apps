/** Public facts derived from executed queries; never model-written explanations. */
import { EvidenceQuerySchema, type EvidenceQuery, type EvidenceSuggestion } from '../../shared/contracts/evidence.js';
import type { ExecutedTexts, LexicalSource } from './pipeline.js';
import type { SearchData } from './store.js';

export function questionQuery(question: string, source?: LexicalSource, executed?: ExecutedTexts): EvidenceQuery {
  let keywords: Extract<EvidenceQuery, { source: 'question' }>['keywords'] = { kind: 'question' };
  if (executed && (source === 'terms' || source === 'question+terms')) {
    const prefix = question.replace(/\s+/gu, ' ').trim() + ' ';
    const terms = source === 'terms' ? executed.lexical : executed.lexical.startsWith(prefix) ? executed.lexical.slice(prefix.length) : '';
    // Empty suffixes are question fallbacks. No suggested-but-unexecuted word is disclosed.
    if (terms.trim()) keywords = { kind: source, terms };
  }
  return EvidenceQuerySchema.parse({ source: 'question', keywords });
}

/** v2 metadata lacked keywords; retain its actual executed query when upgrading the read. */
export function disclosedQuery(data: Pick<SearchData, 'query' | 'question' | 'lexicalSource' | 'executed'>): EvidenceQuery {
  if (data.query.source === 'edited' || 'keywords' in data.query) return EvidenceQuerySchema.parse(data.query);
  return questionQuery(data.question, data.lexicalSource, data.executed);
}

export function remainingSuggestion(query: EvidenceQuery, suggestion: EvidenceSuggestion | null): EvidenceSuggestion | null {
  if (!suggestion) return null;
  const terms = query.source === 'question' && query.keywords.kind !== 'question' ? null : suggestion.terms;
  const hasFilters = Object.values(suggestion.filters).some(value => Array.isArray(value) ? value.length > 0 : value !== undefined);
  return terms === null && !hasFilters ? null : { filters: suggestion.filters, terms };
}
