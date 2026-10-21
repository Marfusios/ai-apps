import { describe, expect, it } from 'vitest';
import {
  blankToNull,
  parseDecimal,
  parseInteger,
  parseIsoDate,
  parseIsoDateTime,
} from '../../worker/ingest/scalars.js';

describe('blankToNull', () => {
  it('maps empty and whitespace-only fields to null and trims others', () => {
    expect(blankToNull('')).toBeNull();
    expect(blankToNull('   ')).toBeNull();
    expect(blankToNull(undefined)).toBeNull();
    expect(blankToNull(' BUS ')).toBe('BUS');
  });
});

describe('parseDecimal', () => {
  it('maps blank to null, never to 0', () => {
    expect(parseDecimal('')).toEqual({ ok: true, value: null });
    expect(parseDecimal(' ')).toEqual({ ok: true, value: null });
  });

  it('keeps real zeros', () => {
    expect(parseDecimal('0')).toEqual({ ok: true, value: 0 });
    expect(parseDecimal('-0.5')).toEqual({ ok: true, value: -0.5 });
  });

  it('parses the source float spellings', () => {
    expect(parseDecimal('30.190001')).toEqual({ ok: true, value: 30.190001 });
    expect(parseDecimal('-80.65988900000001')).toEqual({ ok: true, value: -80.65988900000001 });
    expect(parseDecimal('1e-05')).toEqual({ ok: true, value: 0.00001 });
  });

  it('rejects values Number() would coerce', () => {
    for (const raw of ['0x10', 'Infinity', '1,5', '12 knots', '.', '-', '1e', 'NaN', '049130N']) {
      expect(parseDecimal(raw), raw).toEqual({ ok: false, raw });
    }
  });
});

describe('parseInteger', () => {
  it('parses integers and maps blank to null', () => {
    expect(parseInteger('1907')).toEqual({ ok: true, value: 1907 });
    expect(parseInteger('')).toEqual({ ok: true, value: null });
    expect(parseInteger('0')).toEqual({ ok: true, value: 0 });
  });

  it('rejects fractions and unsafe integers', () => {
    expect(parseInteger('1.5')).toEqual({ ok: false, raw: '1.5' });
    expect(parseInteger('99999999999999999999')).toEqual({ ok: false, raw: '99999999999999999999' });
    expect(parseInteger('1a')).toEqual({ ok: false, raw: '1a' });
  });
});

describe('ISO dates', () => {
  it('parses the mdb-export date and datetime forms without inventing a time zone', () => {
    expect(parseIsoDate('2008-02-08T00:00:00')).toEqual({ ok: true, value: '2008-02-08' });
    expect(parseIsoDate('2008-02-08')).toEqual({ ok: true, value: '2008-02-08' });
    expect(parseIsoDateTime('2025-09-23T18:50:18')).toEqual({ ok: true, value: '2025-09-23T18:50:18' });
    expect(parseIsoDateTime('2025-09-23')).toEqual({ ok: true, value: '2025-09-23' });
  });

  it('maps blank to null', () => {
    expect(parseIsoDate('')).toEqual({ ok: true, value: null });
    expect(parseIsoDateTime('')).toEqual({ ok: true, value: null });
  });

  it('reports a time part on a date column instead of dropping it silently', () => {
    expect(parseIsoDate('2008-02-08T13:05:00')).toEqual({ ok: true, value: '2008-02-08', droppedTime: '13:05:00' });
  });

  it('rejects impossible calendar dates and other formats', () => {
    for (const raw of ['2008-02-30', '2009-02-29T00:00:00', '2008-13-01', '02/08/08 00:00:00', '2008-2-8', '2008-02-08T24:00:00', '2008-02-08Z']) {
      expect(parseIsoDate(raw), raw).toEqual({ ok: false, raw });
    }
    expect(parseIsoDate('2008-02-29')).toEqual({ ok: true, value: '2008-02-29' });
    expect(parseIsoDateTime('2008-02-08T10:61:00')).toEqual({ ok: false, raw: '2008-02-08T10:61:00' });
  });
});
