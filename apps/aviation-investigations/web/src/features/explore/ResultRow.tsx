import type { To } from 'react-router';
import type { CaseRow } from '../../../../shared/contracts/search';
import { Highlighted } from '../../components/Highlighted';
import { CaseFacts } from './CaseFacts';

export interface ResultRowProps {
  row: CaseRow;
  /** Opens the drawer over the results (`?case=`). */
  caseTo: To;
  inCompare: boolean;
  onToggleCompare: () => void;
}

/**
 * A result row in three lines (UI_DESIGN §4.2): case number, date, aircraft, place
 * and Compare; a mono line of phase, defining event, conditions and injury; then
 * the probable cause (or the best matching passage) with matched terms marked.
 * Multi-aircraft events get one sub-row per aircraft (decision 18). The first two lines
 * are the case's facts (`CaseFacts`), which the evidence view's cards show too.
 */
export function ResultRow({ row, caseTo, inCompare, onToggleCompare }: ResultRowProps) {
  const snippet = row.snippet;
  return (
    <li className="border-t border-hairline px-0.5 pt-[11px] pb-3" data-row={row.ntsbNo}>
      <CaseFacts row={row} caseTo={caseTo} inCompare={inCompare} onToggleCompare={onToggleCompare} />
      {/* UI_DESIGN §4.2: wherever the field is empty, whatever the status. */}
      {!row.completion.hasProbableCause && <p className="text-meta text-muted">No probable cause on record</p>}
      {snippet && (
        <p className="font-serif text-body leading-[1.45] text-ink">
          <span className="mr-1.5 font-sans text-micro tracking-caps text-muted uppercase">{snippet.label}</span>
          {snippet.truncatedStart && '…'}
          <Highlighted text={snippet.text} highlights={snippet.highlights} />
          {snippet.truncatedEnd && '…'}
        </p>
      )}
    </li>
  );
}
