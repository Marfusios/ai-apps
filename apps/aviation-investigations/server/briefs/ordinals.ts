/**
 * The ordinal-evidence rule, version **`ordinal-evidence-v1`** (Task 16e; gate G6, the 16d
 * verdict's finding 2): which flight after the maintenance the event happened on needs
 * explicit evidence. A passage that narrates "the first flight after the installation …,
 * the second flight …, the accident flight was conducted 2 days later" does not say that
 * the accident flight was the third: the narrative may leave flights out. So a flight
 * ordinal stands only on **explicit ordinal evidence** (the cited passages give that
 * ordinal for a flight: "the third flight", "its first flight since", "the 2nd flight")
 * or an **explicitly complete flight count** ("had not flown since", "no flights were made
 * between", "the only flight since", "two flights since"; for the first flight, maintenance
 * completed "immediately before the flight"). Otherwise uncertainty is kept:
 *
 * - a chronology fact `flight_ordinal` or `intervening_flights` without that evidence in
 *   the passages it cites decides nothing under the timing rules (`chronology-rules-v3`,
 *   server/briefs/criteria.ts: it can still conflict with another fact, never settle one),
 *   and its timing statement is never shown;
 * - a summary sentence, `why` line or gap note that states a flight ordinal ("on the third
 *   flight", "the airplane's first flight after …", "its next flight") without that
 *   evidence in the passages it cites is never shown (server/briefs/display.ts).
 *
 * The rule is a necessary condition, not a proof: evidence that the passages state an
 * ordinal does not establish what it is counted from ("the first flight of the day"), and
 * the evidence checker still judges the claim. It runs in code, on the validated
 * composition and the canonical passage texts, before the check.
 */

export const ORDINAL_EVIDENCE_VERSION = 'ordinal-evidence-v1';

const WORDS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  maiden: 1,
  initial: 1,
};
const COUNT_WORDS: Readonly<Record<string, number>> = {
  no: 0,
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const ORDINAL_NAMES: Readonly<Record<number, string>> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', 6: 'sixth', 7: 'seventh', 8: 'eighth', 9: 'ninth', 10: 'tenth' };

const ORDINAL_WORD = String.raw`first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|maiden|initial|next|\d{1,2}(?:st|nd|rd|th)`;
/** What may follow an ordinal whose noun ("flight") is left out: "the first following the inspection", "its third since", "the second." */
const ELIDED_AFTER = String.raw`(?=\s+(?:following|after|since|subsequent|post|of)\b|\s*[,.;:)]|\s*$)`;
/**
 * A flight ordinal in prose: a determiner, the ordinal, at most one modifier, "flight"
 * ("the third flight", "its 2nd test flight"); or "flight was the" and an ordinal whose
 * noun is left out ("The accident flight was the first following a 100-hour inspection").
 */
const TEXT_ORDINAL = new RegExp(
  String.raw`\b(?:the|its|his|her|their|a|an|that|this|on|[A-Za-z]+['’]s)\s+(?:very\s+)?(${ORDINAL_WORD})\s+(?:[a-z-]+\s+)?flights?\b|\bflights?\s+(?:was|were|is|had\s+been)\s+(?:the|its|their|his|her|[A-Za-z]+['’]s)\s+(?:very\s+)?(${ORDINAL_WORD})\b${ELIDED_AFTER}`,
  'gi',
);
/** A clause that asks rather than states ("do not say whether it was the first flight"): its ordinals are not asserted. */
const WHETHER = /\bwhether\b/i;

/** The value of an ordinal word ("third" → 3, "3rd" → 3, "maiden" → 1), "next", or null. */
function ordinalValue(word: string): number | 'next' | null {
  const w = word.toLowerCase();
  if (w === 'next') return 'next';
  if (w in WORDS) return WORDS[w]!;
  const m = /^(\d{1,2})(?:st|nd|rd|th)$/.exec(w);
  return m ? Number(m[1]) : null;
}

/**
 * The flight ordinals a sentence states (`TEXT_ORDINAL`), in order. An ordinal in a
 * "whether" clause ("the passages do not say whether it was the first flight after the
 * repair") is asked, not stated, and is left out; a negated one ("not the first flight")
 * is stated (that a flight came before) and stays.
 */
export function textOrdinals(text: string): (number | 'next')[] {
  const out: (number | 'next')[] = [];
  for (const m of text.matchAll(TEXT_ORDINAL)) {
    const clause = text.slice(0, m.index).split(/[.;:!?]/).at(-1) ?? '';
    if (WHETHER.test(clause)) continue;
    const v = ordinalValue((m[1] ?? m[2])!);
    if (v !== null) out.push(v);
  }
  return out;
}

/**
 * The ordinal `n` given for a flight: "the third flight", "its 3rd post-maintenance flight",
 * or with the noun left out after "flight was the" ("The accident flight was the first
 * following a 100-hour inspection").
 */
function ordinalPattern(n: number): RegExp {
  const forms = [ORDINAL_NAMES[n], `${n}(?:st|nd|rd|th)`, ...(n === 1 ? ['maiden', 'initial'] : [])].filter(Boolean).join('|');
  return new RegExp(
    String.raw`\b(?:${forms})\s+(?:[a-z-]+\s+)?flights?\b|\bflights?\s+(?:was|were|is|had\s+been)\s+(?:the|its|their|his|her|[A-Za-z]+['’]s)\s+(?:very\s+)?(?:${forms})\b${ELIDED_AFTER}`,
    'i',
  );
}

/** A count of flights: "two flights", "2 other flights", "no flights", "no other flights", "no flight". */
function countPattern(n: number): RegExp {
  const forms = [`${n}`, ...Object.entries(COUNT_WORDS).filter(([, v]) => v === n).map(([w]) => w)].join('|');
  return new RegExp(`\\b(?:${forms})\\s+(?:other\\s+|completed\\s+|previous\\s+|prior\\s+|additional\\s+|further\\s+|subsequent\\s+|intervening\\s+)?flights?\\b`, 'i');
}

/** Phrases that say no flight came between the maintenance and the event flight. */
const NO_FLIGHT_BETWEEN = [
  /\b(?:had|has)\s+not\s+(?:been\s+)?(?:flown|operated)\s+(?:since|after|following)\b/i,
  /\bhad(?:n['’]t|\s+not)\s+flown\b/i,
  /\bno\s+(?:other\s+|previous\s+|prior\s+|additional\s+|intervening\s+)?flights?\s+(?:had\s+been\s+|were\s+|was\s+)?(?:made\s+|flown\s+|conducted\s+|completed\s+)?(?:since|after|between|following)\b/i,
  /\bthe\s+only\s+flight\s+(?:since|after|following)\b/i,
  /\bfirst\s+time\b.{0,80}?\b(?:flown|flew|operated)\s+(?:since|after|following)\b/i,
  /\bimmediately\s+(?:before|prior\s+to)\s+the\s+(?:accident\s+|event\s+|incident\s+)?flight\b/i,
];

/** Whether the passages give explicit evidence for the ordinal (or "next"). */
export function ordinalEvidence(texts: readonly string[], ordinal: number | 'next'): boolean {
  if (ordinal === 'next') return texts.some((t) => /\bnext\s+(?:[a-z-]+\s+)?flight\b/i.test(t));
  if (!Number.isInteger(ordinal) || ordinal < 1) return false;
  const pattern = ordinalPattern(ordinal);
  if (texts.some((t) => pattern.test(t))) return true;
  if (ordinal === 1 && texts.some((t) => NO_FLIGHT_BETWEEN.some((re) => re.test(t)))) return true;
  // An explicit count of the flights in between ("two flights since the overhaul" for the third).
  const count = countPattern(ordinal - 1);
  return ordinal > 1 && texts.some((t) => count.test(t) && /\b(?:since|after|following|between)\b/i.test(t));
}

/** Whether the passages give explicit evidence for `n` completed flights in between. */
export function interveningEvidence(texts: readonly string[], n: number): boolean {
  if (!Number.isInteger(n) || n < 0) return false;
  if (n === 0 && texts.some((t) => NO_FLIGHT_BETWEEN.some((re) => re.test(t)))) return true;
  const count = countPattern(n);
  if (texts.some((t) => count.test(t))) return true;
  return texts.some((t) => ordinalPattern(n + 1).test(t));
}

/** A chronology fact's ordinal evidence: true unless it is a flight count or ordinal without explicit evidence in its passages. */
export function factOrdinalVerified(f: { relation: string; value?: number | undefined; bound?: string | undefined }, texts: readonly string[]): boolean {
  if (f.relation === 'flight_ordinal') return f.value !== undefined && ordinalEvidence(texts, f.value);
  if (f.relation === 'intervening_flights') return f.value !== undefined && interveningEvidence(texts, f.value);
  return true;
}

/** Whether every flight ordinal a sentence states has explicit evidence in the passages it cites. */
export function textOrdinalsVerified(text: string, texts: readonly string[]): boolean {
  return textOrdinals(text).every((o) => ordinalEvidence(texts, o));
}
