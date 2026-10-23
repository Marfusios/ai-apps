import type { ReactNode } from 'react';
import type { GroupKind } from '../../../../shared/contracts/briefs';
import { EVIDENCE_WORDS, GlyphMark } from '../../components/EvidenceGlyph';

export const EXAMPLES_TITLE = 'Examples found';

export interface EvidenceGroupProps {
  kind: GroupKind;
  count: number;
  children?: ReactNode;
}

/**
 * One evidence group of the briefing sheet (UI_DESIGN §4.3): the glyph, the group name
 * in bold, the count in muted text and a hairline to the right, then its cases. An empty
 * group still shows, with "none", so absence is explicit. Non-mechanical questions get one
 * "Examples found" list instead. The grouping is the AI's, so it carries an AI label.
 */
export function EvidenceGroup({ kind, count, children }: EvidenceGroupProps) {
  const title = kind === 'examples' ? EXAMPLES_TITLE : EVIDENCE_WORDS[kind];
  return (
    <section aria-label={`${title}, ${count === 0 ? 'none' : `${count} ${count === 1 ? 'case' : 'cases'}`}`} className="mt-4">
      <h3 className="mb-[7px] flex flex-wrap items-center gap-x-[7px] gap-y-0.5 text-ui font-bold after:ml-1 after:h-px after:min-w-6 after:flex-1 after:bg-hairline">
        {kind !== 'examples' && <GlyphMark kind={kind} />}
        <span>{title}</span>
        <span className="font-normal whitespace-nowrap text-muted">{count === 0 ? 'none' : `${count} ${count === 1 ? 'case' : 'cases'}`}</span>
        {kind !== 'examples' && <span className="text-[9px] font-normal tracking-[.12em] whitespace-nowrap text-magenta uppercase">AI classified</span>}
      </h3>
      {children}
    </section>
  );
}
