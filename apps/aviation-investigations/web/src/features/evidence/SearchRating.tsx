import { useId, useState } from 'react';
import { EVIDENCE_FEEDBACK_RATINGS, type EvidenceFeedbackRating } from '../../../../shared/contracts/evidence';
import { isNotFound } from '../../api';
import { cx } from '../../lib/cx';
import { VisitorChangedError, visitorGeneration } from '../auth/visitor';
import { rateEvidence } from './api';
import { rememberRating, useRating } from './ratings';

// ---------------------------------------------------------------------------
// Builder copy (Task 25), for the owner's review.

export const RATING_QUESTION = 'Was this search useful?';
export const RATING_LABELS: Readonly<Record<EvidenceFeedbackRating, string>> = { useful: 'Useful', not_useful: 'Not useful' };
export const RATING_THANKS = 'Thanks — noted.';
export const RATING_SAVING = 'Saving…';
export const RATING_FAILED = 'Your rating didn’t save.';
export const RATING_RETRY = 'Try again';
export const RATING_GONE = 'This search is no longer available, so it can’t be rated.';

const chip =
  'touch-target inline-flex cursor-pointer items-center rounded-chip border border-blue px-2.5 py-0.5 text-meta whitespace-nowrap aria-disabled:cursor-default pointer-coarse:min-h-11';

/**
 * "Was this search useful?" (UI_DESIGN §4.11, Task 25): two chips on the results sheet, Useful and
 * Not useful. A click sends the rating (`POST /api/evidence/:id/feedback`, no AI search used);
 * once the server has it, the chosen chip is filled and the line says "Thanks — noted.". The
 * visitor can change it, the latest counting. The page keeps what it sent in memory only (the
 * server never sends a rating back), so after a reload the search shows unrated again. A rating
 * that did not save says so, with Try again; a search that is gone says it can no longer be
 * rated. It does not print.
 */
export function SearchRating({ searchId, className }: { searchId: string; className?: string }) {
  const rated = useRating(searchId);
  const [sending, setSending] = useState<EvidenceFeedbackRating | null>(null);
  const [failure, setFailure] = useState<{ rating: EvidenceFeedbackRating; gone: boolean } | null>(null);
  const questionId = useId();

  const rate = async (rating: EvidenceFeedbackRating): Promise<void> => {
    if (sending !== null || failure?.gone) return;
    // The server has this one already (the reader came back to it after a change that did not save).
    if (rated === rating) {
      setFailure(null);
      return;
    }
    const visitor = visitorGeneration();
    setSending(rating);
    setFailure(null);
    try {
      await rateEvidence(searchId, rating, visitor);
      // A visitor who left meanwhile keeps nothing of it.
      if (visitorGeneration() === visitor) rememberRating(searchId, rating);
    } catch (err) {
      if (err instanceof VisitorChangedError || visitorGeneration() !== visitor) return;
      setFailure({ rating, gone: isNotFound(err) });
    } finally {
      setSending(null);
    }
  };

  const status = sending !== null ? RATING_SAVING : failure ? (failure.gone ? RATING_GONE : RATING_FAILED) : rated !== null ? RATING_THANKS : '';
  return (
    <div className={cx('flex flex-wrap items-center gap-x-3 gap-y-2', className)} data-search-rating="" data-print="hide">
      <p id={questionId} className="text-ui text-ink">
        {RATING_QUESTION}
      </p>
      <div role="group" aria-labelledby={questionId} className="flex flex-wrap items-center gap-1.5">
        {EVIDENCE_FEEDBACK_RATINGS.map((rating) => {
          // The rating the server has: a change that did not save leaves it chosen.
          const chosen = rated === rating;
          return (
            <button
              key={rating}
              type="button"
              aria-pressed={chosen}
              aria-disabled={sending !== null || failure?.gone === true}
              data-rating={rating}
              onClick={() => void rate(rating)}
              className={cx(chip, chosen ? 'bg-blue font-bold text-on-blue' : 'bg-raised text-blue hover:bg-blue-wash aria-disabled:hover:bg-raised')}
            >
              {RATING_LABELS[rating]}
            </button>
          );
        })}
      </div>
      <span className="flex flex-wrap items-center gap-x-2">
        <span aria-live="polite" className="text-meta text-muted" data-rating-status="">
          {status}
        </span>
        {failure && !failure.gone && (
          <button type="button" onClick={() => void rate(failure.rating)} className="cursor-pointer text-meta text-blue hover:underline pointer-coarse:min-h-11">
            {RATING_RETRY}
          </button>
        )}
      </span>
    </div>
  );
}
