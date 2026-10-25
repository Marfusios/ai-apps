import type { EvidenceCase, EvidenceExcerpt } from '../../../../shared/contracts/evidence';
import { SectionHead } from '../../components/SectionHead';
import { EVIDENCE_HEADING, FOLDED_ONLY, FOLDED_TOO, NO_EXCERPT, numberedKinds, type RelevanceContext } from './display';
import { RelevanceLine } from './EvidenceCard';
import { Excerpt } from './Excerpt';
import { MatchLegend } from './MatchedText';
import { EvidenceNotice } from './Notice';

/** What the drawer adds for a case opened from an evidence search: the search's own projection of it. */
export interface DrawerEvidence {
  /** The search the case was retrieved for (its full sections come from it). */
  searchId: string;
  item: EvidenceCase;
  /** The filters the search applied and whose words it marks, for the relevance facts. */
  context: RelevanceContext;
}

/**
 * The evidence view's projection of one case in the drawer (UI_DESIGN §4.9): under the
 * contract's heading and notice, the relevance facts and the excerpts, each able to open its
 * full section. It follows what investigators established, as the brief's sections do (§4.5).
 * `shown`: the excerpts left once the probable-cause paragraphs are marked in the statement
 * above (`folded`, fold.ts); it says so, so the counted marks are found.
 */
export function EvidenceSection({ searchId, item, context, shown = item.excerpts, folded = false }: DrawerEvidence & { shown?: EvidenceExcerpt[] | undefined; folded?: boolean }) {
  const numbered = numberedKinds(shown);
  return (
    <section className="mt-6" aria-label={EVIDENCE_HEADING} data-evidence-section="">
      <SectionHead tag={<span className="whitespace-nowrap">NTSB text</span>}>{EVIDENCE_HEADING}</SectionHead>
      <EvidenceNotice />
      <RelevanceLine item={item} context={context} className="mt-2" />
      {item.excerpts.some((e) => e.highlights.length > 0) && <MatchLegend marked={context.marked} className="mt-1" />}
      {folded && (
        <p className="mt-2 text-meta text-muted" data-folded-note="">
          {shown.length > 0 ? FOLDED_TOO : FOLDED_ONLY}
        </p>
      )}
      {shown.length > 0 ? (
        <div className="mt-3 space-y-4">
          {shown.map((e, i) => (
            <Excerpt
              key={`${item.case.ntsbNo}:${e.sectionKey}:${e.paragraph.start}`}
              searchId={searchId}
              ntsbNo={item.case.ntsbNo}
              aircraft={item.case.aircraft}
              excerpt={e}
              numbered={numbered.has(e.section)}
              position={{ index: i, count: shown.length }}
            />
          ))}
        </div>
      ) : folded ? null : (
        <p className="mt-2 text-meta text-muted">{NO_EXCERPT}</p>
      )}
    </section>
  );
}
