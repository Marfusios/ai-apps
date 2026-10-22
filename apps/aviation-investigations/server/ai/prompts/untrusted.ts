/**
 * Helpers for placing untrusted text (questions, NTSB passages, generated claims)
 * inside the delimiter tags of a user turn.
 */

const DELIMITER_TAGS = [
  'question',
  'refinement',
  'prior',
  'previous_question',
  'previous_refinement',
  'previous_intent',
  'previous_filters',
  'previous_readings',
  'reading',
  'previous_cases',
  'mechanical_cause',
  'interpretations',
  'case',
  'header',
  'passages',
  'passage',
  'claims',
  'claim',
];

const TAG_START = new RegExp(`<(?=\\s*/?\\s*(?:${DELIMITER_TAGS.join('|')})\\b)`, 'gi');

/**
 * Replace the `<` of anything that looks like one of the prompt's delimiter tags
 * with `‹`, so untrusted text cannot close or open a block. Other text is left byte
 * for byte.
 *
 * The rewrite is visible to the model, so a quote copied across a rewritten tag
 * contains `‹` where the passage has `<`. The quote validator (server/briefs/validate.ts)
 * compares quotes against the original stored passage text, never this rendered copy, so such
 * a quote fails validation and the summary is withheld (fail-safe). NTSB narratives
 * do not normally contain these tags.
 */
export function untrusted(text: string): string {
  return text.replace(TAG_START, '‹');
}

/** Escape a value for a double-quoted tag attribute. */
export function attr(value: string): string {
  return value.replace(/[&"<>]/g, (c) => (c === '&' ? '&amp;' : c === '"' ? '&quot;' : c === '<' ? '&lt;' : '&gt;'));
}
