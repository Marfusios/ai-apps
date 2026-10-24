/** Server-owned conservative routing. The optional model output has no routing authority.
 * Ambiguous, negated, quoted, multi-part and injection-like requests keep ordinary retrieval.
 * This grammar is versioned and needs fresh routing confirmation before public launch.
 */
export const EVIDENCE_ROUTING_VERSION = 'evidence-routing.v2';
export type EvidenceRoute = { kind: 'search' } | { kind: 'out_of_scope' | 'operational_advice' | 'corpus_statistics' } |
  { kind: 'case_comparison'; numbers: string[] };
const ID = '[A-Z]{3}\\d{2}[A-Z]{2}\\d{3}[A-Z]?';
const comparison = new RegExp(`^(?:please )?(?:compare|contrast|show (?:the )?differences between) (?:(?:cases?|investigations?|reports?) )?${ID}(?:\\s*(?:,|and|with|versus|vs\\.?)\\s*(?:(?:case|investigation|report) )?${ID}){1,3}[.?!]?$`, 'i');
export function evidenceRoute(question: string): EvidenceRoute {
  const q = question.trim().replace(/\s+/g, ' ');
  // Never treat instructions embedded in data, negations or a compound request as authority.
  if (/[<>`{}\[\]"“”\n\r;]/.test(question) || /\b(?:ignore|system|developer|instead|pretend|do not|don't|not compare|without comparing)\b/i.test(q)) return { kind: 'search' };
  if (comparison.test(q)) return { kind: 'case_comparison', numbers: [...new Set(q.toUpperCase().match(new RegExp(ID, 'g')) ?? [])] };
  const aviation = /\b(?:aviation|aircraft|airplane|helicopter|flight|engine|pilot|ntsb|accidents?|investigations?)\b/i.test(q);
  if (aviation && /^(?:please )?(?:how many|count|what (?:is|are) the (?:number|rate|rates|distribution|trend|trends)|show (?:the )?(?:count|counts|rates|distribution|trends))\b/i.test(q)) return { kind: 'corpus_statistics' };
  // Historical research wins over language that merely describes advice/instructions in reports.
  const historical = /\b(?:investigations?|ntsb|reports?|cases?|accidents?|incidents?|historical|history|past|find|search|research|examples?|studies)\b/i.test(q) || new RegExp(`\\b${ID}\\b`, 'i').test(q);
  if (historical) return { kind: 'search' };
  if (aviation && /^(?:(?:please )?(?:tell|show) me )?(?:how (?:do|should|can) I|what should I do|should I|can I (?:fly|operate)|give me (?:steps|instructions))\b/i.test(q)) return { kind: 'operational_advice' };
  if (!aviation && /^(?:please )?(?:write|compose|translate|calculate|solve|code|generate|give me|what is|what are|who is|who was|tell me)\b/i.test(q) && /\b(?:recipe|recipes|poem|poetry|song|songs|javascript|python|capital|president|celebrity|celebrities|football|pizza)\b/i.test(q)) return { kind: 'out_of_scope' };
  return { kind: 'search' };
}

/** JSON remains data even if a client accidentally embeds it in an HTML script element.
 * Consumers must still render suggestion fields as text, under EVIDENCE_SUGGESTION_LABEL.
 */
export function evidenceJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
