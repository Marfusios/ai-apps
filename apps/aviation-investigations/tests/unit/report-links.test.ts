import { describe, expect, it } from 'vitest';
import { AVIATION_SEARCH_URL, reportLinkFor, reportUrl } from '../../shared/report-links.js';
import { extractReportId } from '../../worker/ingest/report-links.js';

describe('report links', () => {
  it('rejects non-numeric id', () => {
    for (const bad of ['abc', '', '12a', '../1', '1234567890', ' 1', 'https://evil.example/1']) expect(reportUrl(bad)).toBeNull();
  });
  it('builds fixed-template url', () => {
    expect(reportUrl('67493')).toBe('https://data.ntsb.gov/carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/67493/pdf');
  });
  it('falls back to a labelled search link', () => {
    expect(reportLinkFor([])).toEqual({ kind: 'search', url: AVIATION_SEARCH_URL, label: 'Direct report link unavailable · Search NTSB' });
    expect(reportLinkFor([{ reportId: 'x' }]).kind).toBe('search');
  });
  it('picks the highest id as primary and keeps the others', () => {
    const r = reportLinkFor([{ reportId: '9' }, { reportId: '100' }, { reportId: '9' }]);
    expect(r).toMatchObject({ kind: 'report', reportId: '100', others: [{ reportId: '9' }] });
  });
  it('extracts ids strictly from CAROL urls', () => {
    expect(extractReportId('67493')).toBe('67493');
    expect(extractReportId('https://data.ntsb.gov/carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/67493/pdf')).toBe('67493');
    expect(extractReportId('https://evil.example/x/67493')).toBeNull();
    expect(extractReportId('javascript:1')).toBeNull();
  });
});
