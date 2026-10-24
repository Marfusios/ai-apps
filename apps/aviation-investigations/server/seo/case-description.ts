/**
 * A case page's meta description (README, "Search engines and link previews"), built from the
 * case's record by fixed rules, never by AI, cut at a word to 200 characters:
 * "NTSB accident investigation DFW08TA066, 8 Feb 2008: N66372 (Hughes OH-6), minor injuries.
 * Probable cause: …", or, for a record without probable-cause text, what its status is:
 * "… no injuries. Other investigation status (NTSB status P)." The text is untrusted NTSB data;
 * the head escapes it (server/seo/head.ts).
 */
import { aircraftName } from '../../shared/case-view.js';
import type { CaseDetail } from '../../shared/contracts/cases.js';
import type { Coded } from '../../shared/contracts/common.js';
import { formatDate } from '../../shared/format.js';
import { EVENT_TYPE } from '../../shared/vocab.js';

export const MAX_CASE_DESCRIPTION = 200;

/** Plain text on one line: control characters dropped, whitespace runs as one space. */
function plain(text: string): string {
  return text.replace(/[\u0000-\u0008\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
}

/** "accident", "incident", "occurrence"; nothing for an unknown or unreported type. */
function eventTypeWord(type: Coded): string {
  const code = type.code ?? '';
  return code !== 'UNK' && Object.hasOwn(EVENT_TYPE, code) ? type.label.toLowerCase() : '';
}

/** "N66372 (Hughes OH-6)"; the aircraft name alone when no registration is recorded. */
function aircraftWords(a: CaseDetail['aircraft'][number]): string {
  const registration = (a.registration ?? '').trim();
  return registration ? `${registration} (${aircraftName(a)})` : aircraftName(a);
}

/**
 * The most serious injury: "3 fatal", "serious injuries", "minor injuries", "no injuries".
 * "No injuries" only when every count is recorded as zero; with a count missing it says what
 * the case page says (web/src/features/case/display.ts `injurySummary`): the coded highest
 * injury, or that injuries are not reported.
 */
export function injuryPhrase(detail: Pick<CaseDetail, 'injuries' | 'highestInjury'>): string {
  const { fatal, serious, minor } = detail.injuries;
  if (fatal !== null && fatal > 0) return `${fatal} fatal`;
  if (serious !== null && serious > 0) return 'serious injuries';
  if (minor !== null && minor > 0) return 'minor injuries';
  if (fatal === 0 && serious === 0 && minor === 0) return 'no injuries';
  return detail.highestInjury.code ? `highest injury: ${detail.highestInjury.label.toLowerCase()}` : 'injuries not reported';
}

/**
 * A record without probable-cause text: what its completion class says (shared/completion.ts),
 * with the raw NTSB status as the case page shows it ("blank" when there is none). A completed
 * record says what its page says beside the badge.
 */
export function statusSentence(completion: Pick<CaseDetail['completion'], 'class' | 'rawStatus'>): string {
  const raw = (completion.rawStatus ?? '').trim() || 'blank';
  switch (completion.class) {
    case 'completed':
      return 'Probable-cause text unavailable.';
    case 'in_progress':
      return `Investigation in progress (NTSB status ${raw}).`;
    case 'status_unknown':
      return `Investigation status unknown (NTSB status ${raw}).`;
    case 'other_status':
      return `Other investigation status (NTSB status ${raw}).`;
  }
}

/**
 * `text` within `max` characters (code points): when it is longer, cut after the last whole
 * word that leaves room for "…", without the punctuation before the cut, and "…" added.
 */
export function truncateAtWord(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const room = max - 1;
  let end = room;
  // Unless the text breaks between words exactly there, go back to the last space.
  if (chars[room] !== ' ') {
    const space = chars.lastIndexOf(' ', room - 1);
    if (space > 0) end = space;
  }
  return `${chars.slice(0, end).join('').replace(/[\s,;:.!?–—-]+$/u, '')}…`;
}

/**
 * The case's type, number, date, aircraft and injuries, then its probable cause or, without
 * one, its status (`statusSentence`). An unknown event type, a missing date and a missing
 * registration are left out.
 */
export function caseDescription(detail: CaseDetail): string {
  const opening = ['NTSB', eventTypeWord(detail.eventType), 'investigation', detail.ntsbNo].filter((w) => w !== '').join(' ');
  const when = detail.date ? `, ${formatDate(detail.date)}` : '';
  const aircraft = detail.aircraft.length === 0 ? 'Unidentified aircraft' : detail.aircraft.map(aircraftWords).join(' and ');
  const cause = plain(
    detail.sections
      .filter((s) => s.kind === 'probable_cause')
      .map((s) => s.text)
      .join(' '),
  );
  const ending = cause ? `Probable cause: ${cause}` : statusSentence(detail.completion);
  return truncateAtWord(plain(`${opening}${when}: ${aircraft}, ${injuryPhrase(detail)}. ${ending}`), MAX_CASE_DESCRIPTION);
}
