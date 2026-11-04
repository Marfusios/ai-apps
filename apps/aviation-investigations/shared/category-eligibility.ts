/** Permission for one explicit aircraft category in a question without aircraft relationships. */
import { explicitFilterText } from './explicit-filter-text.js';

export const CATEGORY_GUARD_VERSION = 'category-explicit.v1';
// Other canonical categories have no untouched seed cases for this confirmation.
// They remain advisory; adding them changes the evaluated policy.
export const AUTOMATIC_CATEGORY_CODES = Object.freeze(['AIR', 'HELI', 'GLI', 'BALL', 'ULTR', 'PLFT'] as const);
const allowed = new Set<string>(AUTOMATIC_CATEGORY_CODES);
const words: readonly [string, string][] = [
  ['AIR', 'airplanes?'], ['HELI', 'helicopters?'], ['GLI', 'gliders?'], ['BALL', 'balloons?'],
  ['ULTR', 'ultralights?'], ['PLFT', 'powered[- ]lift'],
  ['GYRO', 'gyroplanes?|gyrocraft'], ['WSFT', 'weight[- ]shift'], ['PPAR', 'powered parachutes?'], ['BLIM', 'blimps?'],
];
const relationship = /\b(?:collisions?|collid\w*|mid[- ]?air|between|versus|vs|two|both|multiple|multi[- ]?aircraft|another|other\s+aircraft|formation|towing|towed|towplane|tow\s+plane|alongside|overtak\w*|encounter\w*|hit|struck)\b|\b(?:and|with)\s+(?:a|an|the|another)\b/i;
const attribution = /\b(?:manufactur\w*|models?|simulators?|training|registered|registration|company|companies|operator|transport|transported|passenger|pilot\s+of|instructor|aboard|carried|cargo\s+of)\b|\b(?:airplane|helicopter|glider|balloon|ultralight)\s+(?:pilot|owner|mechanic|factory|parts?)\b/i;
export interface CategoryEligibility {
  categories: string[];
  reason: 'applied' | 'empty' | 'unsupported_category' | 'unsafe_context' | 'not_explicit' | 'ambiguous_context' | 'set_mismatch';
}

export function eligibleEmittedCategories(question: string, emitted: readonly string[]): CategoryEligibility {
  const reject = (reason: CategoryEligibility['reason']): CategoryEligibility => ({ categories: [], reason });
  const categories = [...new Set(emitted)];
  if (!categories.length) return reject('empty');
  if (categories.some(c => !allowed.has(c))) return reject('unsupported_category');
  if (categories.length !== 1) return reject('set_mismatch');
  const text = explicitFilterText(question);
  if (text === null || relationship.test(text) || attribution.test(text)) return reject('unsafe_context');
  const mentions = words.flatMap(([code, pattern]) => [...text.matchAll(new RegExp(`\\b(?:${pattern})\\b`, 'gi'))].map(m => ({ code, start: m.index!, end: m.index! + m[0].length })));
  if (!mentions.length) return reject('not_explicit');
  if (mentions.length !== 1) return reject('ambiguous_context');
  const m = mentions[0]!;
  const before = text.slice(0, m.start), after = text.slice(m.end);
  const noun = /^\s+(?:aircraft\s+)?(?:accidents?|incidents?|events?|occurrences?|crashes|investigations?|cases?)\b/i.test(after);
  const involvement = /\b(?:accidents?|incidents?|events?|occurrences?|crashes)\s+involving\s+(?:a|an|one|a\s+single)\s*$/i.test(before)
    && /^(?:\s+aircraft)?(?:\s*(?:[.,;?!]|$)|\s+(?:concerning|during|in|that)\b)/i.test(after);
  if (!noun && !involvement) return reject('ambiguous_context');
  if (m.code !== categories[0]) return reject('set_mismatch');
  return { categories: [m.code], reason: 'applied' };
}
