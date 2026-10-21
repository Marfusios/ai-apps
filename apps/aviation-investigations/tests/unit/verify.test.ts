import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { toCitationText } from '../../worker/ingest/citation-text.js';
import { sourceFormOf } from '../../worker/ingest/load.js';
import { sourceProblems, type SourceRowForCheck } from '../../worker/ingest/verify.js';

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
