import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { AiStatusResponse } from '../../../../shared/contracts/ai';
import { aiStatusQuery } from '../../api';
import { Button } from '../../components/Button';
import { cx } from '../../lib/cx';
import { GoogleButton, useSignIn } from '../auth/SignInDialog';
import { retryDay } from './status';
import type { AiNotice } from './useAiRequest';

/** UI_DESIGN §5 copy (owner-approved unless marked Proposed there). */
export const COPY = {
  pausedDaily: [
    'AI search is done for today.',
    "This beta runs on a small daily AI budget, and today's is used up. It resets at 00:00 UTC.",
  ],
  pausedMonthlyTitle: 'AI search is done for this month.',
  pausedUnavailableTitle: 'AI search is temporarily unavailable.',
  everythingElse: 'Everything else works: keyword search, every case, comparisons and printing.',
  keyword: 'Search by keyword instead',
  trialUsed: [
    'That was your third free AI search.',
    'Sign in with Google to keep asking. New accounts start with 5 AI searches a day, rising to 20 after three days.',
    'Search, case pages, compare and the dashboard stay open without an account.',
  ],
  freePaused: [
    'Free AI searches are used up for today.',
    'Signed-in AI search is still open today. Sign in with Google to ask.',
    'Free searches return tomorrow; keyword search and every case work now.',
  ],
  failure: ["The AI search didn't finish.", 'Something went wrong before an answer was ready.'],
  notSpent: "This didn't use one of your searches.",
  spent: 'This counted as a search, because the AI work was already under way.',
  /** No answer came back, so whether it counted is unknown (Builder copy). */
  unknownSpent: 'If it went through, Try again opens it without using another search.',
  continueWithGoogle: 'Continue with Google',
  /** A retry from the trial a brief moved away from (Builder copy, for the owner's review). */
  moved: ['This AI search moved to the account that signed in.', 'Sign in with that account to view it.'],
} as const;

function Box({ edge, title, children }: { edge?: 'ink' | 'blue'; title: string; children?: ReactNode }) {
  return (
    <div
      className={cx(
        'card px-4 py-3.5 text-left',
        edge === 'ink' && 'border-caution-edge border-l-4 border-l-ink',
        edge === 'blue' && 'border-l-4 border-l-blue',
      )}
    >
      <p className="font-serif text-[18px] leading-tight font-semibold">{title}</p>
      <div className="mt-1 space-y-1 text-ui">{children}</div>
    </div>
  );
}

/** "Continue with Google": opens the sign-in dialog (what is kept, then Google). Nothing while sign-in is off. */
function SignInButton() {
  const signIn = useSignIn();
  if (!signIn.enabled) return null;
  return (
    <div className="mt-2.5">
      <GoogleButton onClick={() => signIn.open()} />
    </div>
  );
}

/** "AI search is done for today." and its variants (an ink-edged box; a normal state). */
function Paused({ status, keywordHref }: { status: Extract<AiStatusResponse, { state: 'paused' }> | null; keywordHref: string }) {
  const r = status?.reason;
  const remaining = status?.remaining;
  if ((r === 'daily_cap' || r === 'monthly_cap') && remaining?.kind === 'account') {
    return (
      <Box edge="ink" title={r === 'daily_cap' ? `You've used today's ${remaining.limitToday} AI searches.` : `You've used this month's ${remaining.limitThisMonth} AI searches.`}>
        <p>
          {r === 'daily_cap' || !status?.retryAt
            ? 'They reset at 00:00 UTC. Keyword search, cases and compare work as usual.'
            : `They reset on ${retryDay(status.retryAt)}. Keyword search, cases and compare work as usual.`}
        </p>
      </Box>
    );
  }
  const keyword = (
    <div className="mt-2.5">
      <Link to={keywordHref} className="inline-flex items-center rounded-full border-[1.5px] border-blue px-3.5 py-[5px] text-ui font-bold text-blue hover:bg-blue-wash">
        {COPY.keyword}
      </Link>
    </div>
  );
  if (r === 'daily_budget' && status?.retryAt) {
    return (
      <Box edge="ink" title={COPY.pausedDaily[0]}>
        <p>{COPY.pausedDaily[1]}</p>
        <p>{COPY.everythingElse}</p>
        {keyword}
      </Box>
    );
  }
  if (r === 'monthly_budget' && status?.retryAt) {
    return (
      <Box edge="ink" title={COPY.pausedMonthlyTitle}>
        <p>It returns on {retryDay(status.retryAt)}.</p>
        <p>{COPY.everythingElse}</p>
        {keyword}
      </Box>
    );
  }
  return (
    <Box edge="ink" title={COPY.pausedUnavailableTitle}>
      <p>{COPY.everythingElse}</p>
      {keyword}
    </Box>
  );
}

export interface AiNoticeBoxProps {
  /** Null renders the empty live region, so a notice that appears later is announced. */
  notice: AiNotice | null;
  /** Where "Search by keyword instead" goes (Explore with the question). */
  keywordHref: string;
  /** "Try again" after a failure; it runs the AI again, so it shows "· uses 1". */
  onRetry?: () => void;
  className?: string;
}

/**
 * The message under an AI control after a request did not start (UI_DESIGN §5). It sits
 * in a polite live region that is rendered before any message, so screen readers announce
 * a notice when it appears.
 */
export function AiNoticeBox({ notice, keywordHref, onRetry, className }: AiNoticeBoxProps) {
  const live = useQuery(aiStatusQuery());
  const body = (() => {
    if (!notice) return null;
    switch (notice.kind) {
      case 'paused':
        return <Paused status={notice.status ?? (live.data?.state === 'paused' ? live.data : null)} keywordHref={keywordHref} />;
      case 'trial_used':
        return (
          <Box title={COPY.trialUsed[0]}>
            <p>{COPY.trialUsed[1]}</p>
            <SignInButton />
            <p className="pt-1 text-meta text-muted">{COPY.trialUsed[2]}</p>
          </Box>
        );
      case 'free_paused':
        return (
          <Box title={COPY.freePaused[0]}>
            <p>{COPY.freePaused[1]}</p>
            <SignInButton />
            {!notice.loginRequired && <p className="pt-1 text-meta text-muted">{COPY.freePaused[2]}</p>}
          </Box>
        );
      case 'moved':
        return (
          <Box title={COPY.moved[0]}>
            <p>{COPY.moved[1]}</p>
            <SignInButton />
          </Box>
        );
      case 'rate':
        return <Box title={`Slow down a moment. Try again in ${notice.seconds} seconds.`} />;
      case 'failure':
        return (
          <Box title={COPY.failure[0]}>
            <p>{COPY.failure[1]}</p>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {onRetry && (
                <Button variant="ai" counter="uses 1" onClick={onRetry}>
                  Try again
                </Button>
              )}
              <Link to={keywordHref} className="text-ui text-blue hover:underline">
                {COPY.keyword}
              </Link>
            </div>
            <p className="pt-1 text-meta text-muted">{notice.spent === 'no' ? COPY.notSpent : COPY.unknownSpent}</p>
          </Box>
        );
      case 'check':
        return (
          <Box title={notice.reason === 'failed' ? "The quick check didn't finish." : "The quick check couldn't load, so the AI can't run right now."}>
            <p>{notice.reason === 'failed' ? 'Ask again to take a new check.' : COPY.everythingElse}</p>
            {onRetry && (
              <div className="mt-2.5">
                <Button variant="ai" counter="uses 1" onClick={onRetry}>
                  Try again
                </Button>
              </div>
            )}
            {/* The check sent nothing, but an earlier send of this request may have counted. */}
            <p className="pt-1 text-meta text-muted">{notice.unknownBefore ? COPY.unknownSpent : COPY.notSpent}</p>
          </Box>
        );
      case 'empty':
        return <Box title="Type a question first, then ask the AI." />;
      case 'message':
        return <Box title={notice.text} />;
    }
  })();
  return (
    <div aria-live="polite" className={cx('max-w-[640px]', body && className)}>
      {body}
    </div>
  );
}
