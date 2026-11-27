/** Server-owned navigation hints only: every question still runs ordinary retrieval.
 * Ambiguous, negated, quoted, multi-part and injection-like requests receive no hint.
 * Capability notes come from validated scope intents, never this grammar.
 */
export const EVIDENCE_ROUTING_VERSION = 'evidence-hints.v3';
export type EvidenceRoute = { kind: 'search' | 'corpus_statistics' } |
  { kind: 'case_comparison'; numbers: string[] };
const ID = '[A-Z]{3}\\d{2}[A-Z]{2}\\d{3}[A-Z]?';
const separator = '\\s*(?:,|and|with|versus|vs\\.?)\\s*(?:(?:case|investigation|report) )?';
// Each ID has its own capture. Rescanning with ID alone can absorb the A of an
// adjacent AND as an aircraft suffix, unlike the successful whole-question match.
const comparison = new RegExp(`^(?:please )?(?:compare|contrast|show (?:the )?differences between) (?:(?:cases?|investigations?|reports?) )?(${ID})${separator}(${ID})(?:${separator}(${ID}))?(?:${separator}(${ID}))?[.?!]?$`, 'i');
export function evidenceRoute(question: string): EvidenceRoute {
  const q = question.trim().replace(/\s+/g, ' ');
  // Never treat instructions embedded in data, negations or a compound request as authority.
  if (/[<>`{}[\]"“”\n\r;]/.test(question) || /\b(?:ignore|system|developer|instead|pretend|do not|don't|not compare|without comparing)\b/i.test(q)) return { kind: 'search' };
  const matched = comparison.exec(q);
  if (matched) return { kind: 'case_comparison', numbers: [...new Set(matched.slice(1).filter((id): id is string => !!id).map(id => id.toUpperCase()))] };
  const aviation = /\b(?:aviation|aircraft|airplane|helicopter|flight|engine|pilot|ntsb|accidents?|investigations?)\b/i.test(q);
  if (aviation && /^(?:please )?(?:how many|count|what (?:is|are) the (?:number|rate|rates|distribution|trend|trends)|show (?:the )?(?:count|counts|rates|distribution|trends))\b/i.test(q)) return { kind: 'corpus_statistics' };
  return { kind: 'search' };
}

/** JSON remains data even if a client accidentally embeds it in an HTML script element.
 * Consumers must still render suggestion fields as text, under EVIDENCE_SUGGESTION_LABEL.
 */
export function evidenceJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
