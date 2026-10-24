import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { DELETE_PARAM } from '../../../shared/contracts/account';
import { pageTitle } from '../../../shared/page-titles';
import { ApiError, aiStatusQuery, configQuery } from '../api';
import { Button } from '../components/Button';
import { Placard } from '../components/Placard';
import { DeletionUnconfirmedError, SignOutUnconfirmedError, accountQuery, confirmWithGoogle, deleteAccount, signOut, startDeletion } from '../features/auth/api';
import { GoogleButton, useSignIn } from '../features/auth/SignInDialog';

/**
 * Account copy. UI_DESIGN §4.8 gives the contents (name and email, searches left, Sign
 * out, Delete account with what goes, backups and what stays); the sentences are Builder
 * copy for the owner's review, except the searches-left line, which follows the §4.8
 * example.
 */
export const ACCOUNT_COPY = {
  signedOutTitle: 'You aren’t signed in.',
  signedOutText: 'Sign in with Google to keep asking the AI. Search, case pages, compare and the dashboard stay open without an account.',
  unavailable: 'Sign-in isn’t available yet.',
  searchesHeading: 'AI searches left',
  signOut: 'Sign out',
  signOutUnconfirmed: 'This page has forgotten your account, but the server hasn’t confirmed the sign-out. If your account appears here, sign out again.',
  deleteHeading: 'Delete account',
  deleteNow:
    'Deleting your account signs you out everywhere and at once removes your name, your email, the link to your Google account and the AI searches your account holds.',
  deleteBackups: 'Backups never include your account or your AI searches, so a restore can’t bring them back.',
  deleteKept:
    'Two minimal records stay. How many AI searches this Google account has used, kept under a one-way code instead of your details until 7 days after the current month’s limits reset, so that deleting and signing up again doesn’t restart them. And cost records without names or content, for 90 days.',
  deleteAsk: 'Delete your account now? This can’t be undone.',
  deleteConfirm: 'Delete account',
  deleteKeep: 'Keep account',
  deleted: 'Your account is deleted.',
  deleteUnconfirmed: 'This page has forgotten your account, but the server hasn’t confirmed the deletion. If your account appears here, delete it again.',
  failed: 'That didn’t work. Try again in a moment.',
  reauthText: 'To delete your account, first confirm with Google that it’s you.',
  reauthFailed: 'Google didn’t confirm it’s you, so nothing was deleted.',
  reauthOther: 'You signed in with a different Google account, so nothing was deleted.',
  reauthExpired: 'That confirmation has expired. Confirm with Google again.',
} as const;

/** Where deleting stands: nothing asked yet, the last question, or a Google sign-in first. */
type Deleting = 'idle' | 'confirm' | 'reauth';

/** "18 of 20 left today · 109 of 150 left this month" (UI_DESIGN §4.8). */
function SearchesLeft() {
  const status = useQuery(aiStatusQuery());
  const r = status.data?.remaining;
  if (r?.kind !== 'account') return <p className="mt-1 text-ui text-muted">—</p>;
  return (
    <p className="mt-1 text-ui">
      <b className="font-bold text-magenta">{`${r.leftToday} of ${r.limitToday}`}</b> left today
      <span aria-hidden="true"> · </span>
      <span className="sr-only">, </span>
      <b className="font-bold text-magenta">{`${r.leftThisMonth} of ${r.limitThisMonth}`}</b> left this month
    </p>
  );
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-reading px-4 py-10 sm:py-14">
      <title>{pageTitle({ kind: 'account' })}</title>
      <div className="card px-6 py-6 sm:px-8 sm:py-7">
        <Placard as="p">Account</Placard>
        <h1 className="mt-2 font-serif text-headline font-semibold tracking-headline break-words">{title}</h1>
        {children}
      </div>
    </section>
  );
}

/**
 * The account (UI_DESIGN §4.8): name and email, AI searches left, Sign out and Delete
 * account, which first says what goes, what backups hold and what minimal records stay
 * (DESIGN §7). Deleting needs a recent Google sign-in (server/auth/deletion.ts): right
 * after signing in it asks once more and deletes; otherwise it asks to confirm with Google
 * first, comes back here (`delete=confirm`, or `delete=failed`) and then asks once more.
 * Signed out, the page offers sign-in; when Google sign-in is not configured it says so.
 */
export function Account() {
  const config = useQuery(configQuery());
  const signIn = useSignIn();
  const account = useQuery({ ...accountQuery(), enabled: config.data?.googleEnabled === true });
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState<Deleting>('idle');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const panelHeading = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (deleting !== 'idle') panelHeading.current?.focus();
  }, [deleting]);

  // Back from confirming with Google: `delete=confirm` (confirmed only when it was this
  // account, which a fresh read of the account says) or `delete=failed`.
  const googleEnabled = config.data?.googleEnabled === true;
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const value = params.get(DELETE_PARAM);
    if (value === null || !googleEnabled) return;
    for (const name of [DELETE_PARAM, 'error', 'error_description']) params.delete(name);
    const rest = params.toString();
    navigate({ pathname: location.pathname, search: rest ? `?${rest}` : '' }, { replace: true, state: location.state });
    void queryClient
      .fetchQuery({ ...accountQuery(), staleTime: 0 })
      .then((fresh) => {
        if (value === 'confirm' && fresh.signedIn && fresh.deletionConfirmedUntil) setDeleting('confirm');
        else setNotice(value === 'confirm' && fresh.signedIn ? ACCOUNT_COPY.reauthOther : ACCOUNT_COPY.reauthFailed);
      })
      .catch(() => setNotice(ACCOUNT_COPY.failed));
  }, [googleEnabled, location, navigate, queryClient]);

  const run = async (work: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await work();
    } catch (err) {
      if (err instanceof SignOutUnconfirmedError) {
        // Forgotten all the same; the account read again shows whether the session is still there.
        setNotice(ACCOUNT_COPY.signOutUnconfirmed);
      } else if (err instanceof DeletionUnconfirmedError) {
        // Forgotten all the same; the account read again shows whether it is still there.
        setDeleting('idle');
        setNotice(ACCOUNT_COPY.deleteUnconfirmed);
      } else if (err instanceof ApiError && err.body?.error === 'reauth_required') {
        setDeleting('reauth');
        setNotice(ACCOUNT_COPY.reauthExpired);
      } else {
        setNotice(ACCOUNT_COPY.failed);
      }
    } finally {
      setBusy(false);
    }
  };
  const live = (
    <p aria-live="polite" className="mt-3 text-ui empty:hidden">
      {notice}
    </p>
  );

  if (config.data && !config.data.googleEnabled) {
    return (
      <Frame title="Account">
        <p className="mt-3 font-serif text-quote">{ACCOUNT_COPY.unavailable}</p>
      </Frame>
    );
  }
  if (!account.data) {
    return (
      <section className="mx-auto w-full max-w-reading px-4 py-10 sm:py-14" aria-busy="true">
        <title>{pageTitle({ kind: 'account' })}</title>
        <div aria-hidden="true" className="card h-48 opacity-60" />
      </section>
    );
  }
  if (!account.data.signedIn) {
    return (
      <Frame title={ACCOUNT_COPY.signedOutTitle}>
        {live}
        <p className="mt-3 text-ui">{ACCOUNT_COPY.signedOutText}</p>
        <div className="mt-4">
          <GoogleButton onClick={() => signIn.open()} />
        </div>
        <p className="mt-4 text-meta">
          <Link to="/privacy" className="link">
            Privacy notice
          </Link>
        </p>
      </Frame>
    );
  }

  const { user } = account.data;
  const panel = 'mt-4 rounded-card border border-l-4 border-hairline border-l-ink px-4 py-3';
  const panelTitle = 'font-serif text-[17px] font-semibold outline-none';
  return (
    <Frame title={user.name || user.email}>
      <p className="mt-1 text-ui text-muted break-all">{user.email}</p>
      {live}
      <div className="mt-6">
        <Placard tone="ink" as="h2">
          {ACCOUNT_COPY.searchesHeading}
        </Placard>
      </div>
      <SearchesLeft />
      <div className="mt-5">
        <Button variant="search" aria-disabled={busy} onClick={() => void run(() => signOut(queryClient))}>
          {ACCOUNT_COPY.signOut}
        </Button>
      </div>

      <div className="mt-8 border-t border-hairline pt-4">
        <Placard tone="ink" as="h2">
          {ACCOUNT_COPY.deleteHeading}
        </Placard>
      </div>
      <div className="mt-2 space-y-2 text-ui">
        <p>{ACCOUNT_COPY.deleteNow}</p>
        <p>{ACCOUNT_COPY.deleteBackups}</p>
        <p>{ACCOUNT_COPY.deleteKept}</p>
      </div>
      {deleting === 'confirm' ? (
        <div className={panel}>
          <p ref={panelHeading} tabIndex={-1} className={panelTitle}>
            {ACCOUNT_COPY.deleteAsk}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2.5">
            <button
              type="button"
              aria-disabled={busy}
              onClick={() =>
                void run(async () => {
                  await deleteAccount(queryClient);
                  setDeleting('idle');
                  setNotice(ACCOUNT_COPY.deleted);
                })
              }
              className="inline-flex cursor-pointer items-center rounded-full border-[1.5px] border-ink bg-ink px-3.5 py-[5px] text-ui font-bold text-paper hover:shadow-[0_0_0_3px_var(--hairline)] aria-disabled:cursor-wait pointer-coarse:min-h-11"
            >
              {ACCOUNT_COPY.deleteConfirm}
            </button>
            <Button variant="ghost" onClick={() => setDeleting('idle')}>
              {ACCOUNT_COPY.deleteKeep}
            </Button>
          </div>
        </div>
      ) : deleting === 'reauth' ? (
        <div className={panel}>
          <p ref={panelHeading} tabIndex={-1} className={panelTitle}>
            {ACCOUNT_COPY.reauthText}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2.5">
            <GoogleButton busy={busy} onClick={() => void run(() => confirmWithGoogle())} />
            <Button variant="ghost" onClick={() => setDeleting('idle')}>
              {ACCOUNT_COPY.deleteKeep}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <button
            type="button"
            aria-disabled={busy}
            onClick={() =>
              void run(async () => {
                const next = await startDeletion();
                setDeleting(next.next === 'confirm' ? 'confirm' : 'reauth');
              })
            }
            className="inline-flex cursor-pointer items-center rounded-full border-[1.5px] border-ink px-3.5 py-[5px] text-ui font-bold text-ink hover:bg-blue-wash aria-disabled:cursor-wait pointer-coarse:min-h-11"
          >
            {ACCOUNT_COPY.deleteConfirm}
          </button>
        </div>
      )}
    </Frame>
  );
}
