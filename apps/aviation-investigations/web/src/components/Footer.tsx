import { Link } from 'react-router';
import { formatChartDate, localIsoDate } from '../lib/format';
import { CreditLine } from './CreditLine';

export interface FooterProps {
  /** Snapshot date of the ingestion run (ISO). Null while it is unknown. */
  snapshotDate: string | null;
  /** When the snapshot is older than expected, its real age, e.g. "14 months old". */
  snapshotAge?: string | null;
  /** Print footer date (ISO); defaults to today in the viewer's time zone. */
  printedDate?: string;
}

const Dot = () => <span aria-hidden="true"> · </span>;

/**
 * "Not an NTSB service · Data: NTSB, snapshot {date} · Privacy · About", and under it the
 * owner's credit line (`CreditLine`: "Built by Mariusz Kotas · mkotas.cz", UI_DESIGN §3,
 * owner decision of 2026-10-24). Print shows "Not an NTSB service · Source: NTSB · printed
 * {date}" (§7) and the same credit line.
 */
export function Footer({ snapshotDate, snapshotAge, printedDate }: FooterProps) {
  const printed = formatChartDate(printedDate ?? localIsoDate());
  return (
    <footer className="mt-auto border-t border-hairline">
      <p className="mx-auto max-w-page px-4 pt-5 text-center text-label text-muted print:hidden">
        <span>Not an NTSB service</span>
        <Dot />
        <span>
          Data: NTSB
          {snapshotDate && `, snapshot ${formatChartDate(snapshotDate)}`}
          {snapshotAge && ` (${snapshotAge})`}
        </span>
        <Dot />
        <Link to="/privacy" className="link">
          Privacy
        </Link>
        <Dot />
        <Link to="/about" className="link">
          About
        </Link>
      </p>
      <p className="hidden px-4 pt-3 text-label text-ink print:block">
        Not an NTSB service · Source: NTSB · printed {printed}
      </p>
      <CreditLine />
    </footer>
  );
}
