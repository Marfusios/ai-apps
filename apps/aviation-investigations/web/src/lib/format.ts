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
