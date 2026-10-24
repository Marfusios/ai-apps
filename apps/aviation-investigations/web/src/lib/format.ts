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

/**
 * The dataset is refreshed from monthly full NTSB snapshots (DESIGN §4), so a snapshot more
 * than this many days old is older than expected.
 */
export const SNAPSHOT_EXPECTED_DAYS = 45;

const DAY_MS = 86_400_000;

/**
 * The real age of an ISO snapshot date once it is older than expected (UI_DESIGN §3: the
 * footer shows it), counted in whole UTC days: "46 days old", then "2 months old" from two
 * whole calendar months on. Null while the snapshot is as fresh as expected, or when the
 * date cannot be read or lies ahead.
 */
export function snapshotAge(snapshotDate: string, now: Date = new Date()): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(snapshotDate);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const taken = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (!Number.isFinite(taken)) return null;
  const days = Math.round((today - taken) / DAY_MS);
  if (days <= SNAPSHOT_EXPECTED_DAYS) return null;
  const months = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m) - (now.getUTCDate() < d ? 1 : 0);
  return months < 2 ? `${days} days old` : `${months} months old`;
}
