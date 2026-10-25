import { Link } from 'react-router';
import type { ScopeReply } from '../../../../shared/contracts/briefs';
import { cx } from '../../lib/cx';
import { exploreHref } from '../brief/filters';
import { compareHref } from '../explore/url-state';

const chipLink = 'inline-flex items-center rounded-chip border border-blue bg-raised px-2 py-0.5 text-meta text-blue hover:bg-blue-wash pointer-coarse:min-h-11';
const pillLink =
  'inline-flex items-center rounded-full border-[1.5px] border-blue px-3.5 py-[5px] text-ui font-bold text-blue hover:bg-blue-wash pointer-coarse:min-h-11';

/** A brief's static replies (every scope outcome but a clarification round). */
export type StaticReply = Exclude<ScopeReply, { kind: 'needs_clarification' }>;

/**
 * Out of scope, operational advice, counting and comparison (UI_DESIGN §4.3 "Scope outcomes",
 * §5): the server's fixed copy and free links for a brief. An evidence search never gets one
 * (contract `evidence.v2`: nothing blocks a search; a note shows above its results instead).
 */
export function StaticScopeReply({ question, reply, className = 'mt-4' }: { question: string; reply: StaticReply; className?: string }) {
  switch (reply.kind) {
    case 'out_of_scope':
      return (
        <div className={cx('card px-4 py-3.5', className)}>
          <p className="font-serif text-[18px] leading-tight font-semibold">{reply.lines[0]}</p>
          {reply.lines.slice(1).map((line) => (
            <p key={line} className="mt-1 text-ui">
              {line}
            </p>
          ))}
          <div className="mt-2.5">
            <Link to={exploreHref({}, question)} className={pillLink}>
              {reply.keywordSearchLabel}
            </Link>
          </div>
        </div>
      );
    case 'operational_advice':
      return (
        <div className={cx('card border-l-4 border-l-blue px-4 py-3.5', className)}>
          <p className="font-serif text-[18px] leading-tight font-semibold">{reply.title}</p>
          {reply.lines.map((line) => (
            <p key={line} className="mt-1 text-ui">
              {line}
            </p>
          ))}
          <p className="mt-2 text-meta text-muted">{reply.suggestionsLabel}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {reply.suggestions.map((s) => (
              <Link key={s.label} to={exploreHref(s.filters, s.q)} className={chipLink}>
                {s.label}
              </Link>
            ))}
          </div>
        </div>
      );
    case 'corpus_statistics':
      return (
        <div className={cx('card px-4 py-3.5', className)}>
          {reply.lines.map((line) => (
            <p key={line} className="font-serif text-[18px] leading-tight font-semibold">
              {line}
            </p>
          ))}
          <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
            <Link to="/dashboard" className={pillLink}>
              Open the dashboard
            </Link>
            <Link to={exploreHref(reply.filters)} className="text-ui text-blue hover:underline">
              Show these cases in Explore
            </Link>
          </div>
        </div>
      );
    case 'case_comparison':
      return (
        <div className={cx('card px-4 py-3.5', className)}>
          <p className="font-serif text-[18px] leading-tight font-semibold">
            {reply.found.length > 0 ? 'Comparing cases is free; it doesn’t need the AI.' : 'None of those case numbers is in this snapshot.'}
          </p>
          {reply.found.length > 0 && (
            <div className="mt-2.5">
              <Link to={compareHref(reply.found)} className={pillLink}>
                Compare {reply.found.join(', ')} →
              </Link>
            </div>
          )}
          {reply.notFound.length > 0 && (
            <p className="mt-2 text-ui text-muted">
              Not found: <span className="font-mono text-ink">{reply.notFound.join(', ')}</span>
            </p>
          )}
        </div>
      );
  }
}
