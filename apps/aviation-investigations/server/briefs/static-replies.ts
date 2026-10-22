/**
 * Static replies to scope outcomes that are not a case search (UI_DESIGN §4.3 "Scope
 * outcomes", §5 "Operational question"). Server templates only: the copy below plus
 * validated values (filter codes, case numbers checked against the dataset, readings
 * from server/briefs/clarify.ts). None is chat and none uses a free search; each still
 * counts toward the abuse rate limits.
 */
import type { BriefFilters, Reading, ScopeReply } from '../../shared/contracts/briefs.js';
import { CLARIFICATION_LABEL, CLARIFICATION_LINE } from './clarify.js';

export const OUT_OF_SCOPE_LINES = [
  'This tool only searches NTSB aviation investigations.',
  'Try a question about what happened in past accidents or incidents.',
] as const;
export const KEYWORD_SEARCH_LABEL = 'Search by keyword instead';

export const OPERATIONAL_TITLE = 'This tool studies past investigations.';
export const OPERATIONAL_LINES = [
  "It can't help with a flight in progress or a maintenance decision. In flight, contact ATC. For airworthiness, use your aircraft's approved data and a certificated mechanic.",
] as const;
export const OPERATIONAL_SUGGESTIONS_LABEL = 'You can still look for past cases like yours:';
/** Two fixed keyword searches (free); no AI-written advice and no planner text. */
export const OPERATIONAL_SUGGESTIONS = [
  { label: 'Power loss after maintenance', q: 'power loss after maintenance', filters: {} },
  { label: 'Engine running rough in flight', q: 'engine running rough', filters: {} },
] as const;

export const STATISTICS_LINES = ['Counting questions are answered from the data directly, not by the AI.'] as const;

export function outOfScopeReply(): ScopeReply {
  return { kind: 'out_of_scope', lines: [...OUT_OF_SCOPE_LINES], keywordSearchLabel: KEYWORD_SEARCH_LABEL };
}

export function operationalReply(): ScopeReply {
  return {
    kind: 'operational_advice',
    title: OPERATIONAL_TITLE,
    lines: [...OPERATIONAL_LINES],
    suggestionsLabel: OPERATIONAL_SUGGESTIONS_LABEL,
    suggestions: OPERATIONAL_SUGGESTIONS.map((s) => ({ label: s.label, q: s.q, filters: { ...s.filters } })),
  };
}

/** `filters`: the planner's filters after validation against Explore's vocabularies. */
export function statisticsReply(filters: BriefFilters): ScopeReply {
  return { kind: 'corpus_statistics', lines: [...STATISTICS_LINES], filters };
}

/**
 * `asked`: case-number-shaped tokens from the planner, in question order; `existing`:
 * those that are cases of the dataset. Nothing else of the planner's output is used.
 */
export function comparisonReply(asked: readonly string[], existing: ReadonlySet<string>): ScopeReply {
  const unique = [...new Set(asked)].slice(0, 4);
  return {
    kind: 'case_comparison',
    found: unique.filter((n) => existing.has(n)),
    notFound: unique.filter((n) => !existing.has(n)),
  };
}

/** `readings`: two or three from `clarificationReadings`. */
export function clarificationReply(readings: readonly Reading[]): ScopeReply {
  return { kind: 'needs_clarification', label: CLARIFICATION_LABEL, line: CLARIFICATION_LINE, readings: [...readings] };
}
