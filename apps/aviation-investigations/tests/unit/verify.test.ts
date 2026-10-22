import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toCitationText } from '../../worker/ingest/citation-text.js';
import { sourceFormOf } from '../../worker/ingest/load.js';
import {
  sourceProblems,
  verificationReportPath,
  writeReportAtomically,
  type ReportFileOps,
  type SourceRowForCheck,
} from '../../worker/ingest/verify.js';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const none = { hash: false, derivation: false, htmlFlag: false };

/** The source row the loader would store for `source` under a section with `sectionText`. */
function row(sectionText: string, source: string, match: 'exact' | 'whitespace'): SourceRowForCheck {
  const { form, stored } = sourceFormOf(sectionText, source);
  return {
    sourceForm: form,
    sourceText: stored,
    sourceSha256: sha256(source),
    match,
    transformedFromHtml: toCitationText(source).transformedFromHtml,
  };
}

describe('sourceProblems', () => {
  it('accepts plain, CRLF and HTML sources whose canonical text is the section text', () => {
    const plain = 'The engine lost power.\nThe pilot landed.';
    expect(sourceProblems(plain, row(plain, plain, 'exact'))).toEqual(none);
    expect(sourceProblems(plain, row(plain, 'The engine lost power.\r\nThe pilot landed.', 'exact'))).toEqual(none);
    const html = '<p>The engine lost po<span>wer</span>.</p>';
    const canonical = toCitationText(html);
    expect(canonical.transformedFromHtml).toBe(true);
    expect(sourceProblems(canonical.text, row(canonical.text, html, 'exact'))).toEqual(none);
  });

  it('rejects a section text that the source does not produce, even with matching hashes', () => {
    const html = '<p>The engine lost power.</p>';
    const real = toCitationText(html).text;
    const forged = 'The pilot did something else.';
    // The loader stores the HTML verbatim, so its hash still matches; only derivation fails.
    const r = row(real, html, 'exact');
    expect(sourceProblems(forged, r)).toEqual({ hash: false, derivation: true, htmlFlag: false });
  });

  it('requires a whitespace source to differ from the section only in whitespace', () => {
    const section = 'Probable cause:\nfuel exhaustion.';
    const variant = 'Probable cause:\nfuel exhaustion.\n\n';
    expect(sourceProblems(section, row(section, variant, 'whitespace'))).toEqual(none);
    // Identical text claimed as a whitespace variant, and a different text.
    expect(sourceProblems(section, row(section, section, 'whitespace')).derivation).toBe(true);
    expect(sourceProblems(section, row(section, 'Probable cause: fuel starvation.', 'whitespace')).derivation).toBe(true);
  });

  it('flags a wrong HTML flag, a wrong hash and an unrebuildable source', () => {
    const text = 'Plain narrative.';
    expect(sourceProblems(text, { ...row(text, text, 'exact'), transformedFromHtml: true })).toEqual({ ...none, htmlFlag: true });
    expect(sourceProblems(text, { ...row(text, text, 'exact'), sourceSha256: 'f'.repeat(64) })).toEqual({ ...none, hash: true });
    expect(sourceProblems(text, { ...row(text, text, 'exact'), sourceForm: 'stored', sourceText: null })).toEqual({
      hash: true,
      derivation: true,
      htmlFlag: true,
    });
  });
});

describe('writeReportAtomically', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const dir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'aviation-report-test-'));
    dirs.push(d);
    return d;
  };
  // Non-ASCII on purpose: byte and character counts differ.
  const content = `${JSON.stringify({ ok: true, note: 'aggregate counts only, naïve café ✈' }, null, 2)}\n`;
  const bytes = Buffer.from(content, 'utf8');
  const real: ReportFileOps = {
    write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
    fsync: (fd) => fsyncSync(fd),
    close: (fd) => closeSync(fd),
    rename: (from, to) => renameSync(from, to),
  };

  it('publishes every byte under the hash of those bytes', () => {
    const out = dir();
    const r = writeReportAtomically(out, 3, content);
    expect(r.sha256).toBe(sha256(content));
    expect(r.path).toBe(verificationReportPath(out, 3, r.sha256));
    expect(readFileSync(r.path)).toEqual(bytes);
    expect(readdirSync(out)).toEqual([`verify-gen-3-${r.sha256}.json`]);
  });

  it('continues short writes until every byte is written', () => {
    const out = dir();
    let calls = 0;
    const r = writeReportAtomically(out, 3, content, {
      ...real,
      write: (fd, buffer, offset, length) => {
        calls += 1;
        return writeSync(fd, buffer, offset, Math.min(length, 10));
      },
    });
    expect(calls).toBe(Math.ceil(bytes.length / 10));
    expect(readFileSync(r.path)).toEqual(bytes);
    expect(createHash('sha256').update(readFileSync(r.path)).digest('hex')).toBe(r.sha256);
  });

  const failures: [string, Partial<ReportFileOps>, RegExp][] = [
    [
      'a write that stops making progress',
      { write: (fd, buffer, offset, length) => (offset === 0 ? writeSync(fd, buffer, offset, Math.min(length, 10)) : 0) },
      /no progress at byte 10/,
    ],
    [
      'a write that claims more than it wrote (truncated file)',
      { write: (fd, buffer, offset) => (writeSync(fd, buffer, offset, 10), buffer.length - offset) },
      /does not match its content hash/,
    ],
    [
      'a short write followed by an error',
      {
        write: (fd, buffer, offset, length) => {
          if (offset > 0) throw new Error('disk full');
          return writeSync(fd, buffer, offset, Math.min(length, 10));
        },
      },
      /disk full/,
    ],
    [
      'an fsync failure',
      {
        fsync: () => {
          throw new Error('fsync failed');
        },
      },
      /fsync failed/,
    ],
    [
      'a close failure',
      {
        close: (fd) => {
          closeSync(fd);
          throw new Error('close failed');
        },
      },
      /close failed/,
    ],
    [
      'a rename failure',
      {
        rename: () => {
          throw new Error('rename failed');
        },
      },
      /rename failed/,
    ],
  ];
  for (const [name, ops, error] of failures) {
    it(`publishes nothing and leaves no temporary file after ${name}`, () => {
      const out = dir();
      expect(() => writeReportAtomically(out, 3, content, { ...real, ...ops })).toThrow(error);
      expect(readdirSync(out)).toEqual([]);
    });
  }

  it('keeps an already published report when a later attempt fails', () => {
    const out = dir();
    const first = writeReportAtomically(out, 3, content);
    const other = content.replace('true', 'false');
    expect(() =>
      writeReportAtomically(out, 3, other, {
        ...real,
        write: (fd, buffer, offset) => (writeSync(fd, buffer, offset, 10), buffer.length - offset),
      }),
    ).toThrow(/does not match/);
    expect(readdirSync(out)).toEqual([`verify-gen-3-${first.sha256}.json`]);
    expect(readFileSync(first.path)).toEqual(bytes);
  });
});
