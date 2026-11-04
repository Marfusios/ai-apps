/**
 * The fields the server's evidence policy applies on its own (`/api/config` `aiAutomaticFilters`,
 * Task 30), in words for Explore's AI nudge and About's AI line (Builder copy, for the owner's
 * review): "A US state", "years" and "aircraft type", in that order, joined "A, B or C", "A or B"
 * or "A", the first word capitalised to start its sentence. Only the reported fields are named, so a
 * policy that applies fewer of them never claims the others.
 */
import type { ClientConfig } from '../../api';

type AutomaticFields = NonNullable<ClientConfig['aiAutomaticFilters']>;

const FIELD_WORDS = [['state', 'A US state'], ['years', 'years'], ['category', 'aircraft type']] as const;

/** "A US state, years or aircraft type", "Years or aircraft type", "Aircraft type"…; empty for none. */
export function automaticFieldWords(fields: AutomaticFields): string {
  const words: string[] = FIELD_WORDS.filter(([field]) => fields.includes(field)).map(([, word]) => word);
  const last = words.pop() ?? '';
  const joined = words.length > 0 ? `${words.join(', ')} or ${last}` : last;
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** The sentence after the AI line's opening: what the question can have applied automatically, and that it can be removed. */
export function automaticFieldsSentence(fields: AutomaticFields): string {
  return `${automaticFieldWords(fields)} your question sets for the accidents can be applied automatically, and you can remove them; everything else AI suggests stays a suggestion.`;
}
