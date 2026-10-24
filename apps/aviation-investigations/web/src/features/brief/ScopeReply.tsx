import { useState } from 'react';
import type { Reading, ScopeReply as ScopeReplyData } from '../../../../shared/contracts/briefs';
import { Placard } from '../../components/Placard';
import { StaticScopeReply } from '../ai/StaticScopeReply';
import { AiNoticeBox } from '../ai/AiNoticeBox';
import { AskAiButton } from '../ai/AskAiButton';
import { useRefine } from './useRefine';

function Readings({ briefId, label, line, readings, refinementsLeft, closed }: { briefId: string; label: string; line: string; readings: readonly Reading[]; refinementsLeft: number; closed: boolean }) {
  const refine = useRefine(briefId);
  // The reading last picked, so a notice's Try again can send it again.
  const [picked, setPicked] = useState<Reading['refinement'] | null>(null);
  const pick = (refinement: Reading['refinement']): void => {
    setPicked(refinement);
    void refine.refine(refinement);
  };
  return (
    <section aria-label={label} className="mt-4">
      <div className="card px-4 py-3.5">
        <Placard tone="ai" as="h2">
          {label}
        </Placard>
        <p className="mt-1 font-serif text-quote">{line}</p>
        {closed ? (
          <ul className="mt-2.5 flex flex-wrap gap-2">
            {readings.map((reading) => (
              <li key={reading.label} className="rounded-chip border border-hairline px-2 py-0.5 text-meta text-muted">
                {reading.label}
              </li>
            ))}
          </ul>
        ) : refinementsLeft > 0 ? (
          <ul className="mt-2.5 flex flex-wrap gap-2">
            {readings.map((reading) => (
              <li key={reading.label}>
                <AskAiButton label={reading.label} usesOne look="chip" onAsk={() => pick(reading.refinement)} phase={refine.phase} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-ui text-muted">This brief has used its three refinements. Start a new search to keep going.</p>
        )}
      </div>
      <AiNoticeBox notice={refine.notice} keywordHref="/explore" onRetry={picked ? () => pick(picked) : undefined} className="mt-2.5" />
    </section>
  );
}

export interface ScopeReplyProps {
  briefId: string;
  question: string;
  reply: ScopeReplyData;
  refinementsLeft: number;
  /** Briefs are off (Task 23): the readings are shown, never offered as paid picks. */
  closed?: boolean;
}

/**
 * Scope outcomes that are not a case search (UI_DESIGN §4.3, §5): static server copy,
 * never chat and never a free search used. Clarification readings are AI-suggested
 * server templates; picking one runs a normal AI search ("· uses 1").
 */
export function ScopeReply({ briefId, question, reply, refinementsLeft, closed = false }: ScopeReplyProps) {
  if (reply.kind === 'needs_clarification') {
    return <Readings briefId={briefId} label={reply.label} line={reply.line} readings={reply.readings} refinementsLeft={refinementsLeft} closed={closed} />;
  }
  return <StaticScopeReply question={question} reply={reply} />;
}
