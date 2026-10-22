import { Link } from 'react-router';
import type { Reading, ScopeReply as ScopeReplyData } from '../../../../shared/contracts/briefs';
import { Placard } from '../../components/Placard';
import { AiNoticeBox } from '../ai/AiNoticeBox';
import { AskAiButton } from '../ai/AskAiButton';
import { compareHref } from '../explore/url-state';
import { exploreHref } from './filters';
import { useRefine } from './useRefine';

const chipLink = 'inline-flex items-center rounded-chip border border-blue bg-raised px-2 py-0.5 text-meta text-blue hover:bg-blue-wash pointer-coarse:min-h-11';
const pillLink =
  'inline-flex items-center rounded-full border-[1.5px] border-blue px-3.5 py-[5px] text-ui font-bold text-blue hover:bg-blue-wash pointer-coarse:min-h-11';

function Readings({ briefId, label, line, readings, refinementsLeft }: { briefId: string; label: string; line: string; readings: readonly Reading[]; refinementsLeft: number }) {
  const refine = useRefine(briefId);
  return (
    <section aria-label={label} className="mt-4">
      <div className="card px-4 py-3.5">
        <Placard tone="ai" as="h2">
          {label}
        </Placard>
        <p className="mt-1 font-serif text-quote">{line}</p>
        {refinementsLeft > 0 ? (
          <ul className="mt-2.5 flex flex-wrap gap-2">
            {readings.map((reading) => (
              <li key={reading.label}>
                <AskAiButton label={reading.label} usesOne look="chip" onAsk={() => void refine.refine(reading.refinement)} phase={refine.phase} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-ui text-muted">This brief has used its three refinements. Start a new search to keep going.</p>
        )}
      </div>
      <AiNoticeBox notice={refine.notice} keywordHref="/explore" className="mt-2.5" />
    </section>
  );
}

export interface ScopeReplyProps {
  briefId: string;
  question: string;
  reply: ScopeReplyData;
  refinementsLeft: number;
}

/**
 * Scope outcomes that are not a case search (UI_DESIGN §4.3, §5): static server copy,
 * never chat and never a free search used. Clarification readings are AI-suggested
 * server templates; picking one runs a normal AI search ("· uses 1").
 */
export function ScopeReply({ briefId, question, reply, refinementsLeft }: ScopeReplyProps) {
  switch (reply.kind) {
    case 'out_of_scope':
      return (
        <div className="card mt-4 px-4 py-3.5">
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
        <div className="card mt-4 border-l-4 border-l-blue px-4 py-3.5">
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
        <div className="card mt-4 px-4 py-3.5">
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
        <div className="card mt-4 px-4 py-3.5">
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
    case 'needs_clarification':
      return <Readings briefId={briefId} label={reply.label} line={reply.line} readings={reply.readings} refinementsLeft={refinementsLeft} />;
  }
}
