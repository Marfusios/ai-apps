import { X } from 'lucide-react';
import { Link } from 'react-router';
import { cx } from '../../lib/cx';
import { COMPARE_LIMIT, compareHref } from './url-state';

export const COMPARE_FULL_MESSAGE = 'Compare holds four cases. Remove one first.';

export interface CompareTrayProps {
  selected: readonly string[];
  onRemove: (ntsbNo: string) => void;
  /** A notice to announce, e.g. COMPARE_FULL_MESSAGE after a fifth tick. */
  notice: string | null;
  /** Where "Back to results" on the compare page returns to. */
  from?: string;
}

/**
 * The compare tray (UI_DESIGN §4.6, §6): a dark bar at the bottom listing the
 * ticked cases, up to four, with "Compare →". On phones it reads
 * "Compare · 2 cases · Compare →".
 */
export function CompareTray({ selected, onRemove, notice, from }: CompareTrayProps) {
  if (selected.length === 0 && !notice) return null;
  const ready = selected.length >= 2;
  return (
    <aside
      aria-label="Compare tray"
      data-print="hide"
      className="fixed inset-x-0 bottom-0 z-30 bg-tray text-tray-ink shadow-sheet"
    >
      <div className="mx-auto flex max-w-page items-center gap-x-3.5 gap-y-1 px-4 py-2.5 sm:px-[26px]">
        <span className="text-ui font-bold sm:font-normal">Compare</span>
        <span className="text-ui sm:hidden">
          · {selected.length} {selected.length === 1 ? 'case' : 'cases'}
        </span>
        <ul className="hidden items-center gap-3 sm:flex">
          {selected.map((ntsbNo) => (
            <li key={ntsbNo} className="flex items-center gap-1">
              <span className="font-mono text-ui tracking-mono text-tray-accent">{ntsbNo}</span>
              <button
                type="button"
                onClick={() => onRemove(ntsbNo)}
                className="inline-flex size-5 cursor-pointer items-center justify-center rounded-full text-tray-ink/70 hover:bg-tray-ink/10 hover:text-tray-ink"
              >
                <X size={12} strokeWidth={1.5} aria-hidden="true" />
                <span className="sr-only">Remove {ntsbNo} from compare</span>
              </button>
            </li>
          ))}
        </ul>
        <span className="hidden text-ui text-tray-ink/70 sm:inline">
          {selected.length} of {COMPARE_LIMIT}
        </span>
        <p role="status" className={cx('min-w-0 text-meta', notice ? 'text-tray-ink' : 'sr-only')}>
          {notice}
        </p>
        <span className="ml-auto" />
        {ready ? (
          <Link
            to={compareHref(selected)}
            state={from ? { from } : undefined}
            className="inline-flex items-center gap-1 rounded-full border-[1.5px] border-tray-ink px-3 py-[3px] text-ui font-bold whitespace-nowrap hover:bg-tray-ink/10 pointer-coarse:min-h-11"
          >
            Compare →
          </Link>
        ) : (
          <span className="text-meta whitespace-nowrap text-tray-ink/70">Tick another case to compare</span>
        )}
      </div>
    </aside>
  );
}
