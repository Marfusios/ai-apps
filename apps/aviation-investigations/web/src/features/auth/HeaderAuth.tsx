import { useQuery } from '@tanstack/react-query';
import { CircleUserRound } from 'lucide-react';
import { NavLink } from 'react-router';
import { cx } from '../../lib/cx';
import { accountQuery } from './api';
import { useSignIn } from './SignInDialog';

/**
 * The header's sign-in slot (UI_DESIGN §3): "Sign in", which opens the sign-in dialog, or the
 * account link when signed in: a person icon in the header bar (owner request, 2026-10-24),
 * with "Account" beside it in the phone menu, where the slot sits among text links. The link's
 * name is "Account" everywhere. Nothing while Google sign-in is not configured.
 */
export function HeaderAuth() {
  const signIn = useSignIn();
  const account = useQuery({ ...accountQuery(), enabled: signIn.enabled });
  if (!signIn.enabled || !account.data) return null;
  if (account.data.signedIn) {
    return (
      <NavLink
        to="/account"
        title="Account"
        className={({ isActive }) =>
          cx(
            'inline-flex items-center gap-2 border-b-2 pb-px text-ui pointer-coarse:min-h-11 sm:pointer-coarse:min-w-11 sm:pointer-coarse:justify-center',
            isActive ? 'border-blue text-ink' : 'border-transparent text-blue hover:text-ink',
          )
        }
      >
        <CircleUserRound size={20} strokeWidth={1.5} aria-hidden="true" focusable="false" className="shrink-0" />
        <span className="sm:sr-only">Account</span>
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

/**
 * Whether the signed-in account is an admin (`/api/account` `isAdmin`, Task 25): the header then
 * links the admin page. The server decides; the page only follows what the account says.
 */
export function useIsAdmin(): boolean {
  const signIn = useSignIn();
  const account = useQuery({ ...accountQuery(), enabled: signIn.enabled });
  return signIn.enabled && account.data?.signedIn === true && account.data.isAdmin === true;
}
