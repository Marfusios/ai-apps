const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * Formats an ISO date (`2026-10-01` or a full timestamp) the way charts print it:
 * `01 OCT 2026`, in UTC. Anything unparseable is returned unchanged.
 */
export function formatChartDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !month) return iso;
  return `${match[3]} ${month} ${match[1]}`;
}

/** Today's date (or `date`) in the viewer's time zone, as `YYYY-MM-DD`. */
export function localIsoDate(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2024-10-16` → `16 Oct 2024` (as recorded; no time zone is applied). */
export function formatDate(iso: string | null): string {
  if (!iso) return 'Date not recorded';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const month = match ? MONTH_NAMES[Number(match[2]) - 1] : undefined;
  if (!match || !month) return iso;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

/** `24291` → `24,291`. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** "1 case", "3 cases". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** Small numbers as words ("Same in all four"). */
export function numberWord(n: number): string {
  return WORDS[n] ?? formatCount(n);
}
