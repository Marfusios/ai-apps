/**
 * Scalar parsing for projected CSV fields (amendment A8). An empty or
 * whitespace-only field is NULL and becomes `null` before any conversion, so
 * `Number('')` (which is 0) is never reached. Malformed values are reported to the
 * caller as `{ ok: false }` and never coerced.
 */

export type Parsed<T> = { ok: true; value: T | null } | { ok: false; raw: string };

/** Trimmed value, or null for a blank field. For codes and short identity fields, not narrative text. */
export function blankToNull(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  return value === '' ? null : value;
}

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d+$/;

export function parseDecimal(raw: string | null | undefined): Parsed<number> {
  const value = blankToNull(raw);
  if (value === null) return { ok: true, value: null };
  if (!DECIMAL.test(value)) return { ok: false, raw: raw ?? '' };
  const n = Number(value);
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, raw: raw ?? '' };
}

export function parseInteger(raw: string | null | undefined): Parsed<number> {
  const value = blankToNull(raw);
  if (value === null) return { ok: true, value: null };
  if (!INTEGER.test(value)) return { ok: false, raw: raw ?? '' };
  const n = Number(value);
  return Number.isSafeInteger(n) ? { ok: true, value: n } : { ok: false, raw: raw ?? '' };
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/;

interface IsoParts {
  date: string;
  time: string | null;
}

function isoParts(value: string): IsoParts | null {
  const m = ISO.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return null;
  // Day count of the month in the proleptic Gregorian calendar, no time zone involved.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  if (h !== undefined) {
    if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
    return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}:${s}` };
  }
  return { date: `${y}-${mo}-${d}`, time: null };
}

export type ParsedDate = { ok: true; value: string | null; droppedTime?: string } | { ok: false; raw: string };

/**
 * A calendar date column: `YYYY-MM-DD` or the mdb-export datetime form
 * `YYYY-MM-DDTHH:MM:SS`. Returns the date part. A nonzero time is returned as
 * `droppedTime` so the caller can record it instead of losing it silently.
 */
export function parseIsoDate(raw: string | null | undefined): ParsedDate {
  const value = blankToNull(raw);
  if (value === null) return { ok: true, value: null };
  const parts = isoParts(value);
  if (!parts) return { ok: false, raw: raw ?? '' };
  if (parts.time !== null && parts.time !== '00:00:00') return { ok: true, value: parts.date, droppedTime: parts.time };
  return { ok: true, value: parts.date };
}

/** A local timestamp column, returned in the validated input form with no time zone added. */
export function parseIsoDateTime(raw: string | null | undefined): Parsed<string> {
  const value = blankToNull(raw);
  if (value === null) return { ok: true, value: null };
  return isoParts(value) ? { ok: true, value } : { ok: false, raw: raw ?? '' };
}
