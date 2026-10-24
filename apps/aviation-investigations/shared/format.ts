/** Text formatters the web client and the server share (the server's case descriptions, server/seo/head.ts). */

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2024-10-16` → `16 Oct 2024` (as recorded; no time zone is applied). */
export function formatDate(iso: string | null): string {
  if (!iso) return 'Date not recorded';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const month = match ? MONTH_NAMES[Number(match[2]) - 1] : undefined;
  if (!match || !month) return iso;
  return `${Number(match[3])} ${month} ${match[1]}`;
}
