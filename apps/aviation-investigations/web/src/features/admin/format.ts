/**
 * How the admin page says its figures (UI_DESIGN §4.12, Task 25): times in the viewer's own time
 * zone (named once on the page), UTC days as dates, money in dollars with the precision small sums
 * need, and the server's configuration identifiers in plain words. Builder copy for the owner's
 * review.
 */
import { formatCount } from '../../lib/format.js';

/** The viewer's time zone as the browser names it ("Europe/Prague"); UTC when it names none. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const formatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar fields of an instant in `timeZone` (the browser does the zone's arithmetic). */
function fieldsIn(iso: string, timeZone: string): { year: string; month: number; day: number; hour: string; minute: string } {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
    formatters.set(timeZone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return { year: parts.year ?? '', month: Number(parts.month), day: Number(parts.day), hour: parts.hour ?? '', minute: parts.minute ?? '' };
}

/** "31 Oct 2026, 14:02": an instant in `timeZone`, with the site's month names (shared/format.ts). */
export function formatDateTime(iso: string, timeZone: string): string {
  const f = fieldsIn(iso, timeZone);
  return `${f.day} ${MONTH_NAMES[f.month - 1] ?? ''} ${f.year}, ${f.hour}:${f.minute}`;
}

/** "31 Oct 2026": the day of an instant in `timeZone`. */
export function formatDay(iso: string, timeZone: string): string {
  const f = fieldsIn(iso, timeZone);
  return `${f.day} ${MONTH_NAMES[f.month - 1] ?? ''} ${f.year}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A UTC day (`2026-10-30`) as the usage chart says it: "Thu 30 Oct". */
export function formatUtcDay(day: string, { weekday = true }: { weekday?: boolean } = {}): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  const date = `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
  return weekday ? `${WEEKDAYS[d.getUTCDay()]} ${date}` : date;
}

/**
 * Dollars: "$14.87", "$1,234.50"; below ten cents, to the hundredth of a cent, which is what a
 * search costs ("$0.0086"); "$0.00" for nothing, and "under $0.0001" for less than shows.
 */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.0001) return 'under $0.0001';
  if (usd < 0.1) return `$${usd.toFixed(4)}`;
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "15%", "4.2%": how much of `of` is `part` (0% of nothing). */
export function formatShare(part: number, of: number): string {
  if (of <= 0) return '0%';
  const value = (part / of) * 100;
  return value < 10 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

/** "3 days, 4 hours", "5 hours, 12 minutes", "8 minutes": how long, roughly. */
export function durationInWords(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const unit = (n: number, word: string): string => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return hours > 0 ? `${unit(days, 'day')}, ${unit(hours, 'hour')}` : unit(days, 'day');
  if (hours > 0) return minutes % 60 > 0 ? `${unit(hours, 'hour')}, ${unit(minutes % 60, 'minute')}` : unit(hours, 'hour');
  return unit(minutes, 'minute');
}

/**
 * A ranking configuration (`AVIATION_EVIDENCE_RANKING`, shared/evidence-ranking.ts) in plain
 * words: what keyword search reads, then the order ("The question as asked; AI reranks the top
 * 50"); null for an identifier the page does not know (it then shows the identifier alone).
 */
export function rankingInWords(id: string): string | null {
  const m = /^er-(q|t|qt)(?:-(h50|h100|s50))?-v1$/.exec(id);
  if (!m) return null;
  const words = { q: 'The question as asked', t: 'AI’s terms in keyword search, the question in similarity search', qt: 'The question and AI’s terms' }[m[1] as 'q' | 't' | 'qt'];
  const order = { h50: 'AI reranks the top 50', h100: 'AI reranks the top 100', s50: 'AI reranks the top 50 with a larger model' }[m[2] as 'h50' | 'h100' | 's50'] ?? 'in match order';
  return `${words}; ${order}`;
}

/** An automatic-filter policy (`AVIATION_EVIDENCE_AUTO_FILTERS`) in plain words; null for one the page does not know. */
export function automaticFiltersInWords(id: string): string | null {
  if (id === 'none') return 'None: every filter AI suggests stays a suggestion';
  if (/^state-explicit\.v\d+(?:\.\d+)*$/.test(id)) return 'A US state the question names explicitly';
  return null;
}
