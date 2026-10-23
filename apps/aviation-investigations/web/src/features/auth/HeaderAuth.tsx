import { useQuery } from '@tanstack/react-query';
import { NavLink } from 'react-router';
import { cx } from '../../lib/cx';
import { accountQuery } from './api';
import { useSignIn } from './SignInDialog';

/**
 * The header's sign-in slot (UI_DESIGN §3): "Sign in", which opens the sign-in dialog, or
 * "Account" when signed in. Nothing while Google sign-in is not configured.
 */
export function HeaderAuth() {
  const signIn = useSignIn();
  const account = useQuery({ ...accountQuery(), enabled: signIn.enabled });
  if (!signIn.enabled || !account.data) return null;
  if (account.data.signedIn) {
    return (
      <NavLink
        to="/account"
        className={({ isActive }) =>
          cx('inline-flex items-center border-b-2 pb-px text-ui pointer-coarse:min-h-11', isActive ? 'border-blue text-ink' : 'border-transparent text-blue hover:text-ink')
        }
      >
        Account
      </NavLink>
    );
  }
  return (
    <button
      type="button"
      onClick={() => signIn.open()}
      className="inline-flex cursor-pointer items-center rounded-full border-[1.5px] border-blue px-2.5 py-px text-meta whitespace-nowrap text-blue hover:bg-blue-wash pointer-coarse:min-h-11"
    >
      Sign in
    </button>
  );
}
