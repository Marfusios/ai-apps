/**
 * Probable-cause excerpts fold into the statement they quote (UI_DESIGN §4.9). A probable-cause
 * statement is a passage too, so the server can preview a paragraph of it as an excerpt; the
 * card, the drawer and Compare already show the statement verbatim, so the excerpt's marks move
 * into the statement (at its `paragraph` offsets) and it is not shown a second time. The marks
 * stay visible, so the relevance line's counts still describe marked text on screen.
 */
import type { EvidenceExcerpt } from '../../../../shared/contracts/evidence';

/** A marked span of a statement's text, in UTF-16 offsets. */
export interface Mark {
  start: number;
  end: number;
  match: 'literal' | 'synonym';
}

/** A statement that can take folded marks: its section key, and its text as the excerpts' offsets read it. */
export interface Statement {
  key: string;
  text: string;
}

export interface Folded {
  /** Each statement's marks, by section key, in its text's offsets, in order. */
  marks: ReadonlyMap<string, readonly Mark[]>;
  /** The excerpts still shown on their own: all but the probable-cause paragraphs folded into a statement. */
  shown: EvidenceExcerpt[];
}

/**
 * Folds every `probable_cause` excerpt whose statement is shown and holds exactly the excerpt's
 * text at its paragraph offsets. One whose statement is missing, or reads differently there (a
 * case page at another generation), stays an excerpt: marks are never moved onto other words.
 */
export function foldProbableCauses(statements: readonly Statement[], excerpts: readonly EvidenceExcerpt[]): Folded {
  const marks = new Map<string, Mark[]>();
  const shown: EvidenceExcerpt[] = [];
  for (const e of excerpts) {
    const statement = e.section === 'probable_cause' ? statements.find((s) => s.key === e.sectionKey) : undefined;
    if (!statement || statement.text.slice(e.paragraph.start, e.paragraph.end) !== e.text) {
      shown.push(e);
      continue;
    }
    const list = marks.get(statement.key) ?? [];
    for (const h of e.highlights) list.push({ start: h.start + e.paragraph.start, end: h.end + e.paragraph.start, match: h.match });
    marks.set(statement.key, list);
  }
  for (const list of marks.values()) list.sort((a, b) => a.start - b.start);
  return { marks, shown };
}

/** A statement shown trimmed, as cards show it: its marks moved onto the trimmed text. */
export function trimmedWithMarks(text: string, marks: readonly Mark[]): { text: string; marks: Mark[] } {
  const lead = text.length - text.trimStart().length;
  const trimmed = text.trim();
  return {
    text: trimmed,
    marks: marks.filter((m) => m.start >= lead && m.end <= lead + trimmed.length).map((m) => ({ ...m, start: m.start - lead, end: m.end - lead })),
  };
}
