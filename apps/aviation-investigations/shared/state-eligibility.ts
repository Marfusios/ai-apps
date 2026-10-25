/** Conservative, deterministic permission to use a model-emitted event-state filter.
 * Does not extract new filters, geocode cities, or modify the input. Uncertainty abstains.
 * Version is frozen by the Task 24 field study before provider calls.
 */
import { US_STATE } from './vocab.js';

export const STATE_GUARD_VERSION = 'state-explicit.v1.1';
export const AUTOMATIC_STATE_CODES = Object.freeze([
  'AK', 'AL', 'AR', 'AZ', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA', 'HI', 'IA', 'ID', 'IL', 'IN',
  'KS', 'KY', 'LA', 'MA', 'MD', 'ME', 'MI', 'MN', 'MO', 'MS', 'MT', 'NC', 'ND', 'NE', 'NH', 'NJ',
  'NM', 'NV', 'NY', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'VT', 'WA',
  'WI', 'WV', 'WY',
] as const);
const allowed = new Set<string>(AUTOMATIC_STATE_CODES);
const ambiguous = new Set(['GA', 'NY', 'WA']);
const names = [...AUTOMATIC_STATE_CODES].sort((a, b) => US_STATE[b]!.length - US_STATE[a]!.length);
const unsafe = /\b(?:not|no|without|except|exclude\w*|excluding|outside|avoid\w*|rather\s+than|instead\s+of|other\s+than|neither|nor|anywhere|ignore\w*|disregard\w*|override\w*|instructions?|system|assistant|prompt|pretend\w*|hypothetic\w*|imagine\w*|example\w*|quoted?|quotations?|reference|titled?|named|departure|departed|departing|destination|resident\w*|residence|lives?|living|resides?|registered|registration|manufactured|built|factory|headquarters|mailing|address|born|operator|company|airlines?|based)\b|\b(?:set|add|apply|output|return)\s+(?:the\s+)?(?:state|filter|json)\b/i;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
interface Mention { code: string; start: number; end: number; eligible: boolean }
export interface StateEligibility {
  states: string[];
  reason: 'applied' | 'empty' | 'unsupported_state' | 'unsafe_context' | 'not_explicit' | 'ambiguous_context' | 'set_mismatch';
}

export function eligibleEmittedStates(question: string, emitted: readonly string[]): StateEligibility {
  const states = [...new Set(emitted)].sort();
  const reject = (reason: StateEligibility['reason']): StateEligibility => ({ states: [], reason });
  if (states.length === 0) return reject('empty');
  if (states.some(s => !allowed.has(s))) return reject('unsupported_state');
  if (question.length > 600 || /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(question)) return reject('unsafe_context');
  const text = question.normalize('NFKC');
  if (unsafe.test(text) || /["“”«»`<>]|(?:^|\W)'[^']+'(?:\W|$)/u.test(text)) return reject('unsafe_context');
  // Reject state-named places even when the state would otherwise be eligible.
  // This only removes applications from the evaluated v1 guard.
  for (const code of names) {
    if (new RegExp(`\\b${escape(US_STATE[code]!)}\\s+(?:city|county|river|bay|lake|sound|valley|canyon|islands?|panhandle|keys|gulf|strait|peninsula|range|mountains?)\\b`, 'i').test(text)) return reject('ambiguous_context');
  }
  const mentions: Mention[] = [];
  for (const code of names) {
    const regex = new RegExp(`\\b${escape(US_STATE[code]!)}\\b`, 'gi');
    for (const match of text.matchAll(regex)) {
      const start = match.index!;
      const end = start + match[0].length;
      if (mentions.some(m => start < m.end && end > m.start)) continue; // West Virginia is not also Virginia.
      const before = text.slice(0, start);
      const after = text.slice(end);
      const qualified = /\bstate\s+of\s*$/i.test(before) || /^\s+state\b/i.test(after);
      const location = /\b(?:in|within|across|state\s+of)\s+(?:(?:either|the)\s+)?$/i.test(before)
        || /^\s*(?:investigations?|accidents?|events?|cases?|records?)\b/i.test(after) && start === 0
        || qualified;
      mentions.push({ code, start, end, eligible: location && (!ambiguous.has(code) || qualified) });
    }
  }
  // A postal code must have a location qualifier and a spelled-out city; bare IN/OR/ME never qualify.
  const postal = /\b(?:in|near|at)\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,4}),\s*([A-Z]{2})\b/g;
  for (const m of text.matchAll(postal)) {
    const code = m[2]!;
    if (!allowed.has(code)) continue;
    const end = m.index! + m[0].length;
    const start = end - code.length;
    if (!mentions.some(v => start < v.end && end > v.start)) mentions.push({ code, start, end, eligible: true });
  }
  mentions.sort((a, b) => a.start - b.start);
  // Additional members of one explicit same-field OR/list inherit its location qualifier.
  for (let i = 1; i < mentions.length; i++) {
    const previous = mentions[i - 1]!;
    const current = mentions[i]!;
    const gap = text.slice(previous.end, current.start);
    if (previous.eligible && /^(?:\s+state)?\s*(?:,\s*(?:or\s+)?|or\s+)(?:(?:the\s+)?state\s+of\s+)?$/i.test(gap)) {
      const qualified = /state\s+of\s*$/i.test(gap) || /^\s+state\b/i.test(text.slice(current.end));
      current.eligible = !ambiguous.has(current.code) || qualified;
    }
  }
  if (mentions.length === 0) return reject('not_explicit');
  if (mentions.some(m => !m.eligible)) return reject('ambiguous_context');
  // An OR with a non-state alternative cannot be represented by applying the state alone.
  for (const m of text.matchAll(/\bor\b/gi)) {
    const left = mentions.filter(v => v.end <= m.index!).at(-1);
    const right = mentions.find(v => v.start >= m.index! + 2);
    if (!left || !right || !/^(?:\s+state)?\s*,?\s*$/i.test(text.slice(left.end, m.index))
      || !/^\s+(?:(?:the\s+)?state\s+of\s+)?$/i.test(text.slice(m.index! + 2, right.start))) return reject('ambiguous_context');
  }
  const explicit = [...new Set(mentions.map(m => m.code))].sort();
  if (explicit.length > 1 && /\band\b/i.test(text.slice(mentions[0]!.end, mentions.at(-1)!.start))) return reject('ambiguous_context');
  if (JSON.stringify(explicit) !== JSON.stringify(states)) return reject('set_mismatch');
  return { states, reason: 'applied' };
}
