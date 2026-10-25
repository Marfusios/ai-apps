import { Info } from 'lucide-react';
import type { EvidenceNote } from '../../../../shared/contracts/evidence';
import { cx } from '../../lib/cx';
import { EVIDENCE_BOUNDARY, EVIDENCE_NOTE_TEXT, EVIDENCE_NOTICE } from './display';

/**
 * The contract's fixed notice (`EVIDENCE_NOTICE`) and, under it, the research-only boundary
 * (`EVIDENCE_BOUNDARY`): on every surface that shows an evidence search's results (the sheet, the
 * drawer, Compare, print and phones), whatever the scope stage did (gate answer 2: both are
 * unconditional; a capability note only adds to them). Ink on `raised` with an ink rule: a standing
 * condition of the results, not an error and not a data caution. A note, never a live region: it is
 * there from the first paint.
 */
export function EvidenceNotice({ className }: { className?: string }) {
  return (
    <div data-evidence-notice-box="" className={cx('rounded-chip border border-hairline border-l-[3px] border-l-ink bg-raised px-3 py-2 text-ui text-ink', className)}>
      <p role="note" data-evidence-notice="">
        {EVIDENCE_NOTICE}
      </p>
      <p data-evidence-boundary="" className="mt-1 text-muted">
        {EVIDENCE_BOUNDARY}
      </p>
    </div>
  );
}

/**
 * A capability note (contract `evidence.v2`, gate answer 2 of 2026-10-25): one of the contract's
 * fixed reminders of what AirCase is (`EVIDENCE_NOTE_TEXT`), which the validated scope intent may
 * select, shown above the results. Calm and non-blocking: not an error or a warning, never a
 * statement about the question, never model text, and never instead of `EVIDENCE_NOTICE`.
 */
export function CapabilityNote({ note, className }: { note: EvidenceNote | null; className?: string }) {
  if (!note) return null;
  return (
    <p data-evidence-note={note} className={cx('flex items-start gap-2 rounded-chip border border-hairline px-3 py-2 text-ui text-ink', className)}>
      <Info size={15} strokeWidth={1.5} aria-hidden="true" className="mt-[3px] flex-none text-muted" />
      <span>{EVIDENCE_NOTE_TEXT[note]}</span>
    </p>
  );
}
