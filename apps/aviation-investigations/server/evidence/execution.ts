/** Build the admitted query facts once, preserving inherited texts and their disclosure. */
import type { CreateEvidenceRequest, EvidenceQuery } from '../../shared/contracts/evidence.js';
import { disclosedQuery, questionQuery } from './disclosure.js';
import { rankingTexts, vectorText, type ExecutedTexts, type LexicalSource } from './pipeline.js';
import { evidenceRankingConfig, type EvidenceRankingConfig } from './ranking-config.js';
import type { SearchData } from './store.js';

export function initialExecution(body: CreateEvidenceRequest, question: string, parent: SearchData | undefined,
  ranking: EvidenceRankingConfig): { executed: ExecutedTexts; lexicalSource: LexicalSource; addedTerms: string | null; query: EvidenceQuery } {
  if (body.kind === 'question' || body.keywords === 'question') {
    const texts = rankingTexts(question, null, body.kind === 'question' ? ranking : evidenceRankingConfig());
    return { ...texts, query: questionQuery(texts.lexicalSource, texts.addedTerms) };
  }
  if (body.terms !== undefined) {
    const text = vectorText(body.terms);
    return { executed: { lexical: text, vector: text }, lexicalSource: 'terms', addedTerms: null,
      query: { source: 'edited', terms: body.terms } };
  }
  if (!parent) throw new Error('missing evidence edit source');
  const query = disclosedQuery(parent);
  const legacyQuery = query.source === 'edited' ? query.terms : question;
  const executed = parent.executed ?? rankingTexts(legacyQuery, null, evidenceRankingConfig()).executed;
  const lexicalSource = parent.lexicalSource ?? (query.source === 'question' ? 'question' : 'terms');
  const addedTerms = parent.addedTerms ?? (query.source === 'question' && query.keywords.kind !== 'question' ? query.keywords.terms : null);
  return { executed, lexicalSource, addedTerms, query };
}
