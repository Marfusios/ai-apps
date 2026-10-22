/**
 * Report links. The numeric CAROL report ID is unrelated to `ev_id`. URLs are built
 * only from a fixed HTTPS template and a validated numeric ID; no other URL is ever
 * rendered as a report link.
 */

export const AVIATION_SEARCH_URL = 'https://my.ntsb.gov/aviation';
export const REPORT_ID_PATTERN = /^\d{1,9}$/;
export const SEARCH_FALLBACK_LABEL = 'Direct report link unavailable · Search NTSB';

export function isReportId(value: unknown): value is string {
  return typeof value === 'string' && REPORT_ID_PATTERN.test(value);
}

export function reportUrl(reportId: string): string | null {
  if (!isReportId(reportId)) return null;
  return `https://data.ntsb.gov/carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/${reportId}/pdf`;
}

export interface ReportLinkRow {
  reportId: string;
}

export interface ReportLinkResult {
  kind: 'report';
  url: string;
  reportId: string;
  /** Other reports of the same event, highest id first. */
  others: { url: string; reportId: string }[];
}

export interface SearchLinkResult {
  kind: 'search';
  url: typeof AVIATION_SEARCH_URL;
  label: typeof SEARCH_FALLBACK_LABEL;
}

/** Primary = highest numeric report id (deterministic); invalid ids are ignored. */
export function reportLinkFor(rows: readonly ReportLinkRow[]): ReportLinkResult | SearchLinkResult {
  const ids = [...new Set(rows.map((r) => r.reportId).filter(isReportId))].sort((a, b) => Number(b) - Number(a));
  const built = ids.flatMap((reportId) => {
    const url = reportUrl(reportId);
    return url ? [{ url, reportId }] : [];
  });
  const [primary, ...others] = built;
  if (!primary) return { kind: 'search', url: AVIATION_SEARCH_URL, label: SEARCH_FALLBACK_LABEL };
  return { kind: 'report', ...primary, others };
}
