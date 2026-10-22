import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { aiStatusQuery } from '../../api';
import { pausedNote } from './status';

const pill =
  'inline-flex items-center rounded-full border-[1.5px] border-blue px-2.5 py-px text-meta whitespace-nowrap text-blue hover:bg-blue-wash pointer-coarse:min-h-11';

/**
 * The header AI counter (UI_DESIGN §5, §6). It always shows searches left, read from
 * the public AI status before anyone clicks; the number is magenta because it counts
 * AI work. Sign-in arrives with accounts, so the sign-in pills open the account page.
 */
export function AiCounter() {
  const { data: status } = useQuery(aiStatusQuery());
  if (!status) return null;
  const r = status.remaining;
  if (status.state === 'paused') return <span className="text-muted">{pausedNote(status)}</span>;
  if (status.state === 'signed_in_only' && r?.kind !== 'account') {
    return (
      <Link to="/account" className={pill}>
        {status.reason === 'trial_used' ? 'Sign in to keep asking' : 'Sign in to ask the AI'}
      </Link>
    );
  }
  if (r?.kind === 'account') {
    return (
      <span>
        AI left today: <b className="font-bold text-magenta">{`${r.leftToday} of ${r.limitToday}`}</b>
      </span>
    );
  }
  if (r?.kind === 'trial') {
    const left = <b className="font-bold text-magenta">{`${r.left} of ${r.limit}`}</b>;
    return (
      <span>
        <span className="sm:hidden">AI left {left}</span>
        <span className="hidden sm:inline">AI searches left: {left}</span>
      </span>
    );
  }
  return null;
}
