import { Link } from 'react-router';
import type { EvidencePage } from '../../../../shared/contracts/evidence';
import { cx } from '../../lib/cx';
import { exploreHref } from '../brief/filters';
import { compareHref } from '../explore/url-state';
import { COMPARISON_HINT, COMPARISON_NONE, STATISTICS_EXPLORE, STATISTICS_HINT, filtersInWords } from './display';

const pill = 'inline-flex items-center rounded-full border-[1.5px] border-blue px-3.5 py-[5px] text-ui font-bold text-blue hover:bg-blue-wash pointer-coarse:min-h-11';
const link = 'text-ui text-blue hover:underline pointer-coarse:min-h-11';

/**
 * The hint of an explicit counting or comparison request (contract `evidence.v2`; the server
 * reads it from the question, never the scope stage): fixed copy and free links above the
 * results, which still follow. Counting points to the dashboard (and, when the search applied
 * filters, to Explore with them); comparing names the cases found, with their pages and Compare,
 * and the numbers no case has.
 */
export function EvidenceHint({ hint, className }: { hint: EvidencePage['hint']; className?: string }) {
  if (!hint) return null;
  if (hint.kind === 'corpus_statistics') {
    const filters = filtersInWords(hint.filters);
    return (
      <div className={cx('card px-4 py-3', className)} data-hint="corpus_statistics" data-print="hide">
        <p className="text-ui">{STATISTICS_HINT}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-2">
          <Link to="/dashboard" className={pill}>
            Open the dashboard
          </Link>
          {filters.length > 0 && (
            <Link to={exploreHref(hint.filters)} className={link}>
              {STATISTICS_EXPLORE}: {filters.join(' · ')}
            </Link>
          )}
        </div>
      </div>
    );
  }
  const { found, notFound } = hint;
  return (
    <div className={cx('card px-4 py-3', className)} data-hint="case_comparison" data-print="hide">
      <p className="text-ui">{found.length > 0 ? COMPARISON_HINT : COMPARISON_NONE}</p>
      {found.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-2">
          {found.length > 1 && (
            <Link to={compareHref(found)} className={pill}>
              Compare {found.join(', ')} →
            </Link>
          )}
          {found.map((ntsbNo) => (
            <Link key={ntsbNo} to={`/cases/${ntsbNo}`} className={cx(link, 'font-mono')}>
              {ntsbNo}
            </Link>
          ))}
        </div>
      )}
      {notFound.length > 0 && (
        <p className="mt-2 text-ui text-muted">
          Not found: <span className="font-mono text-ink">{notFound.join(', ')}</span>
        </p>
      )}
    </div>
  );
}
