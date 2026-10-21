import { describe, expect, it } from 'vitest';
import {
  CITATION_TEXT_VERSION,
  TEXT_NORMALIZATION_VERSION,
  htmlToText,
  looksLikeHtml,
  toCitationText,
} from '../../worker/ingest/citation-text.js';

// Probable-cause markup exactly as stored in the NTSB source for three real cases.
const ERA24LA303 =
  '<p style="margin-top:0pt;margin-bottom:8pt;line-height:108%;font-size:12pt;background-color:#ffffff;">' +
  '<span style="font-family:\'Roboto\';color:rgb(0,0,0);background-color:#ffffff;">The in-flight separation of o</span>' +
  '<span style="font-family:\'Roboto\';background-color:#ffffff;">ne of the wooden propeller blades for unknown reasons.</span></p>';
const WPR26LA114 =
  '<p style="margin-top:0pt;margin-bottom:8pt;line-height:108%;font-size:12pt;background-color:#ffffff;"><br />' +
  '<span style="font-family:\'Roboto\';background-color:#ffffff;">The pilot’s decision to operate the airplane with a known ' +
  'mechanical defect, and the improper application of the main wheel brakes, which resulted in the airplane nosing over.</span></p>';

describe('versions', () => {
  it('records v1 for the citation text and the text normalization', () => {
    expect(CITATION_TEXT_VERSION).toBe('v1');
    expect(TEXT_NORMALIZATION_VERSION).toBe('v1');
  });
});

describe('looksLikeHtml', () => {
  it('detects the markup that occurs in the source', () => {
    expect(looksLikeHtml(ERA24LA303)).toBe(true);
    expect(looksLikeHtml('<br /><br />')).toBe(true);
    expect(looksLikeHtml('deer.  <span style="color: black;">&nbsp;</span> AIRCRAFT')).toBe(true);
    expect(looksLikeHtml('wind 040&deg;at 11 knots')).toBe(true);
    expect(looksLikeHtml('n.&#730; 31')).toBe(true);
    expect(looksLikeHtml('<DIV>x</DIV>')).toBe(true);
  });

  it('leaves angle brackets and ampersands in plain narratives alone', () => {
    for (const plain of [
      'we are just <unintelligible>."  The controller asked',
      'traffic <insert specific position of aircraft ahead>',
      'available from the FAA’s website at <http://www.faa.gov>.',
      'reflectivity values (<15 DBz) and < 10 knots',
      'AT&T and R&D; Smith & Wesson',
      'unknown &foo; entity and legacy &amp without semicolon',
      '<pre-flight> <brake> <division> <spanner>',
    ]) {
      expect(looksLikeHtml(plain), plain).toBe(false);
    }
  });
});

describe('toCitationText', () => {
  it('passes plain text through unchanged except CRLF to LF', () => {
    const source = 'Line one\r\nLine two  \r\n\r\nTrailing space. ';
    expect(toCitationText(source)).toEqual({
      text: 'Line one\nLine two  \n\nTrailing space. ',
      transformedFromHtml: false,
    });
  });

  it('keeps plain pseudo-tags verbatim', () => {
    const source = 'replied, "whiskey alpha we are just <unintelligible>."';
    expect(toCitationText(source)).toEqual({ text: source, transformedFromHtml: false });
  });

  it('joins a word split across inline spans (ERA24LA303)', () => {
    expect(toCitationText(ERA24LA303)).toEqual({
      text: 'The in-flight separation of one of the wooden propeller blades for unknown reasons.',
      transformedFromHtml: true,
    });
  });

  it('drops the leading break inside the paragraph (WPR26LA114)', () => {
    expect(toCitationText(WPR26LA114).text).toBe(
      'The pilot’s decision to operate the airplane with a known mechanical defect, and the improper ' +
        'application of the main wheel brakes, which resulted in the airplane nosing over.',
    );
  });

  it('turns markup-only text into an empty string', () => {
    expect(toCitationText('<br /><br />')).toEqual({ text: '', transformedFromHtml: true });
  });

  it('keeps plain-text paragraphs and decodes the stray NBSP span in a mixed narrative', () => {
    const source = 'hunting for blacktail deer.  <span style="color: black;">&nbsp;</span> AIRCRAFT INFORMATION\n\nAn examination';
    expect(toCitationText(source).text).toBe('hunting for blacktail deer.    AIRCRAFT INFORMATION\n\nAn examination');
  });

  it('decodes only semicolon-terminated entities', () => {
    expect(toCitationText('wind 040&deg;at 11 knots, AT&T &amp no &notit; &#730; &lt;5').text).toBe(
      'wind 040°at 11 knots, AT&T &amp no &notit; ˚ <5',
    );
  });

  it('maps block boundaries and breaks to single newlines', () => {
    expect(htmlToText('<p>First.</p><p>Second.</p>')).toBe('First.\nSecond.');
    expect(htmlToText('<div>A<br>B</div>\n<p>C</p>')).toBe('A\nB\nC');
    expect(htmlToText('<p>A<br /></p><p>B</p>')).toBe('A\nB');
    expect(htmlToText('A<br><br>B')).toBe('A\n\nB');
  });

  it('keeps unknown tags, stray closing tags and words in odd tags as literal text', () => {
    expect(htmlToText('<p>he said <unintelligible> then</p>')).toBe('he said <unintelligible> then');
    expect(htmlToText('<p>a </foo> b</p>')).toBe('a </foo> b');
    expect(htmlToText('<p>about <a few miles> out</p>')).toBe('about <a few miles> out');
    expect(htmlToText('<p>x<5 and < 10 <http://www.faa.gov>.</p>')).toBe('x<5 and < 10 <http://www.faa.gov>.');
  });

  it('drops stray closing tags of known elements and comments', () => {
    expect(htmlToText('a</span> b<!-- note --> c</p>d')).toBe('a b c\nd');
    expect(htmlToText('<p>a</span></foo></div>b</p>')).toBe('a</foo>\nb');
  });

  it('is deterministic', () => {
    expect(toCitationText(ERA24LA303)).toEqual(toCitationText(ERA24LA303));
  });

  it('converts CRLF inside transformed text as well', () => {
    expect(toCitationText('<p>A\r\nB</p>').text).toBe('A\nB');
  });
});
