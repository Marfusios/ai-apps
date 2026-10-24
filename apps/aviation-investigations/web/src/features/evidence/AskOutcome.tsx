import { lazy, Suspense } from 'react';
import { AiNoticeBox } from '../ai/AiNoticeBox';
import type { AiNotice } from '../ai/useAiRequest';
import type { ShownScopeReply } from './useEvidenceSearch';

// The static replies load with the reply (after an AI request), not with the home page.
const StaticScopeReply = lazy(async () => ({ default: (await import('../ai/StaticScopeReply')).StaticScopeReply }));

export interface AskOutcomeProps {
  notice: AiNotice | null;
  /** A static scope reply the question got instead of a search (out of scope, operational, counting, comparison). */
  reply: ShownScopeReply | null;
  /** Where "Search by keyword instead" goes. */
  keywordHref: string;
  /** "Try again" after a failure (runs the AI again, "· uses 1"). */
  onRetry?: () => void;
  className?: string;
}

/**
 * What an Ask AI box says when its question did not open a search page (UI_DESIGN §4.9, §5):
 * the AI notices (paused, check, limits, failure) and the static scope replies, which have no
 * page of their own and use no search. Both sit in polite live regions rendered before
 * anything appears in them, so a screen reader announces what arrives.
 */
export function AskOutcome({ notice, reply, keywordHref, onRetry, className }: AskOutcomeProps) {
  return (
    <>
      <AiNoticeBox notice={notice} keywordHref={keywordHref} onRetry={onRetry} className={className} />
      <div aria-live="polite" className="w-full max-w-[640px] text-left">
        {reply && (
          <Suspense fallback={null}>
            <StaticScopeReply question={reply.question} reply={reply.reply} className={className} />
          </Suspense>
        )}
      </div>
    </>
  );
}
