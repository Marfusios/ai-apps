/** Only permits an exactly matching emitted event-year range; never fills an absent bound. */
import { explicitFilterText } from './explicit-filter-text.js';

export const YEAR_GUARD_VERSION = 'year-explicit.v1';
export interface EventYearRange { yearFrom?: number; yearTo?: number }
export interface YearEligibility {
  range: EventYearRange;
  reason: 'applied' | 'empty' | 'invalid_range' | 'unsafe_context' | 'not_explicit' | 'ambiguous_context' | 'range_mismatch';
}
const validYear = (v: number | undefined) => v === undefined || Number.isInteger(v) && v >= 1900 && v <= 2100;
const otherTime = /\b(?:manufactur\w*|built|build|certificat\w*|certif\w*|rules?|regulat\w*|model\s+year|airworthiness|delivery|delivered|repaired|overhauled|registered|registration|birthday|anniversary|born|publication|published\s+in|issued|released|submitted|reported|report\s+(?:date|year)|investigated|training|recent\w*|latest|last|next|previous|ago|today|yesterday|tomorrow|centur\w*|decades?|early|mid|late|around|approximately|circa|spring|summer|autumn|fall|winter|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const eventAnchor = /\b(?:accidents?|incidents?|events?|occurrences?|crashes)(?:\s+(?:(?:that\s+)?(?:happened|occurred|took\s+place)|occurring|happening))?\s*$/i;
const dateExpression = /\b(?:between\s+(\d{4})\s+and\s+(\d{4})|from\s+(\d{4})\s+(?:to|through)\s+(\d{4})|(in|during|since|before|after|through)\s+(?:the\s+year\s+)?(\d{4}))\b/gi;

export function eligibleEmittedYearRange(question: string, emitted: Readonly<EventYearRange>): YearEligibility {
  const reject = (reason: YearEligibility['reason']): YearEligibility => ({ range: {}, reason });
  const { yearFrom, yearTo } = emitted;
  if (yearFrom === undefined && yearTo === undefined) return reject('empty');
  if (!validYear(yearFrom) || !validYear(yearTo) || yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) return reject('invalid_range');
  const text = explicitFilterText(question);
  if (text === null || otherTime.test(text) || /\b(?:earlier|later|onwards?|inclusive|exclusive|starting|ending|until)\b|\babout\s+\d{4}\b|\b\d{4}s\b|\d{4}[-/]\d|\d[-/]\d{4}/i.test(text)) return reject('unsafe_context');
  const matches = [...text.matchAll(dateExpression)];
  if (!matches.length) return reject('not_explicit');
  if (matches.length !== 1) return reject('ambiguous_context');
  const m = matches[0]!;
  if (!eventAnchor.test(text.slice(0, m.index)) || (text.match(/\b\d{4}\b/g) ?? []).length !== (m[0].match(/\b\d{4}\b/g) ?? []).length) return reject('ambiguous_context');
  let want: EventYearRange;
  if (m[1] || m[3]) want = { yearFrom: Number(m[1] ?? m[3]), yearTo: Number(m[2] ?? m[4]) };
  else {
    const y = Number(m[6]);
    switch (m[5]!.toLowerCase()) {
      case 'in': case 'during': want = { yearFrom: y, yearTo: y }; break;
      case 'since': want = { yearFrom: y }; break;
      case 'after': want = { yearFrom: y + 1 }; break;
      case 'before': want = { yearTo: y - 1 }; break;
      default: want = { yearTo: y }; break;
    }
  }
  if (!validYear(want.yearFrom) || !validYear(want.yearTo) || want.yearFrom !== undefined && want.yearTo !== undefined && want.yearFrom > want.yearTo) return reject('ambiguous_context');
  if (want.yearFrom !== yearFrom || want.yearTo !== yearTo) return reject('range_mismatch');
  return { range: { ...want }, reason: 'applied' };
}
