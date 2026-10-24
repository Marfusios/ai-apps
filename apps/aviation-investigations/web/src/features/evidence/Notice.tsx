import { cx } from '../../lib/cx';
import { EVIDENCE_NOTICE } from './display';

/**
 * The contract's fixed notice (`EVIDENCE_NOTICE`): on every surface that shows an evidence
 * search's results (the sheet, the drawer, Compare, print and phones), whatever the unchecked
 * readings say. Ink on `raised` with an ink rule: a standing condition of the results, not an
 * error and not a data caution. A note, never a live region: it is there from the first paint.
 */
export function EvidenceNotice({ className }: { className?: string }) {
  return (
    <p role="note" data-evidence-notice="" className={cx('rounded-chip border border-hairline border-l-[3px] border-l-ink bg-raised px-3 py-2 text-ui text-ink', className)}>
      {EVIDENCE_NOTICE}
    </p>
  );
}
