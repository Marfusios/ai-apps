import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { SIGN_IN_ERROR_PARAM } from '../../../../shared/contracts/account';
import { configQuery } from '../../api';
import { PRODUCT_NAME } from '../../brand';
import { cx } from '../../lib/cx';
import { returnPath, startGoogleSignIn } from './api';

/** UI_DESIGN §4.8 copy (the sign-in dialog). */
export const SIGN_IN_TITLE = `Sign in to ${PRODUCT_NAME}`;
export const CONTINUE_WITH_GOOGLE = 'Continue with Google';
export const KEPT = [
  "We keep your Google account ID, email and name, and how many AI searches you've used.",
  'Questions and results are held for up to 24 hours to deliver them, then deleted.',
  'Delete your account any time from Account.',
] as const;
export const PRIVACY_LINK = 'Privacy notice';
/** Builder copy, for the owner's review: sign-in came back without signing in, or could not start. */
export const SIGN_IN_FAILED = "Sign-in didn't complete. Try again.";
export const SIGN_IN_UNAVAILABLE = "Sign-in couldn't start. Try again in a moment.";

interface SignInState {
  /** Google sign-in is configured (`GET /api/config` `googleEnabled`): otherwise nothing offers it. */
  enabled: boolean;
  /**
   * The first read of the configuration is still on its way, so whether sign-in is offered is
   * not known yet: controls say nothing about sign-in for that moment. Once a read has failed
   * it is no longer pending: until a later read answers (it is read again, `configQuery`),
   * sign-in is not offered and the controls say what is true either way (Task 22 re-review N-3).
   */
  pending: boolean;
  /** Open the dialog; `failed` adds the line that the last sign-in did not complete. */
  open(options?: { failed?: boolean }): void;
}

// Outside the provider nothing offers sign-in, and that is settled.
const SignInContext = createContext<SignInState>({ enabled: false, pending: false, open: () => {} });

/** The sign-in dialog of the page (any control that offers sign-in opens it). */
export function useSignIn(): SignInState {
  return useContext(SignInContext);
}

/**
 * Holds the one sign-in dialog of the app (UI_DESIGN §4.8). Every sign-in control opens
 * it, so what is kept is always shown before Google. Signing in comes back to the page it
 * started from; a sign-in that came back without signing in (`signin=failed`) opens the
 * dialog again with a line saying so, and the parameter is dropped from the address.
 */
export function SignInProvider({ children }: { children: ReactNode }) {
  const config = useQuery(configQuery());
  const enabled = config.data?.googleEnabled === true;
  const [dialog, setDialog] = useState<{ open: boolean; failed: boolean }>({ open: false, failed: false });
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!config.data) return;
    const params = new URLSearchParams(location.search);
    if (params.get(SIGN_IN_ERROR_PARAM) === null) return;
    const failed = params.get(SIGN_IN_ERROR_PARAM) === 'failed';
    navigate({ pathname: location.pathname, search: returnPath(location.pathname, location.search).slice(location.pathname.length) }, { replace: true, state: location.state });
    if (failed && enabled) setDialog({ open: true, failed: true });
  }, [config.data, enabled, location, navigate]);

  const open = useCallback((options?: { failed?: boolean }) => {
    setDialog({ open: true, failed: options?.failed === true });
  }, []);
  // Pending only until the first answer or the first failure (a re-read after a failure is not).
  const pending = config.data === undefined && config.errorUpdateCount === 0;
  const value = useMemo<SignInState>(() => ({ enabled, pending, open }), [enabled, pending, open]);

  return (
    <SignInContext.Provider value={value}>
      {children}
      {enabled && (
        <SignInDialog
          open={dialog.open}
          failed={dialog.failed}
          onOpenChange={(next) => setDialog((d) => ({ open: next, failed: next ? d.failed : false }))}
          returnTo={returnPath(location.pathname, location.search)}
        />
      )}
    </SignInContext.Provider>
  );
}

export interface SignInDialogProps {
  open: boolean;
  /** The last sign-in came back without signing in. */
  failed?: boolean;
  onOpenChange: (open: boolean) => void;
  /** The page sign-in comes back to. */
  returnTo: string;
  /** Leaves for Google (tests replace it). */
  navigate?: (url: string) => void;
}

/**
 * "Sign in to AirCase" (UI_DESIGN §4.8): Continue with Google, then what is
 * kept, and the privacy notice. A modal dialog: focus moves to the title, Esc closes and
 * focus returns to the control that opened it.
 */
export function SignInDialog({ open, failed = false, onOpenChange, returnTo, navigate }: SignInDialogProps) {
  const title = useRef<HTMLHeadingElement>(null);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'unavailable'>('idle');
  useEffect(() => {
    if (open) setPhase('idle');
  }, [open]);
  const start = async (): Promise<void> => {
    setPhase('starting');
    try {
      await startGoogleSignIn(returnTo, navigate);
    } catch {
      setPhase('unavailable');
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-shade" data-print="hide" />
        <Dialog.Content
          aria-describedby={undefined}
          aria-modal="true"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            title.current?.focus();
          }}
          className="card fixed inset-x-4 top-[12vh] z-50 mx-auto max-w-[420px] px-5 py-4 text-ink shadow-sheet"
          data-print="hide"
        >
          <div className="flex items-start gap-3">
            <Dialog.Title ref={title} tabIndex={-1} className="font-serif text-[18px] leading-tight font-semibold outline-none focus-visible:outline-2">
              {SIGN_IN_TITLE}
            </Dialog.Title>
            <Dialog.Close className="-mt-1 -mr-2 ml-auto inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-blue-wash hover:text-ink pointer-coarse:size-11">
              <X size={18} strokeWidth={1.5} aria-hidden="true" />
              <span className="sr-only">Close</span>
            </Dialog.Close>
          </div>
          {failed && phase === 'idle' && <p className="mt-1.5 text-ui">{SIGN_IN_FAILED}</p>}
          <div className="mt-3">
            <GoogleButton onClick={() => phase !== 'starting' && void start()} busy={phase === 'starting'} />
          </div>
          <div aria-live="polite">{phase === 'unavailable' && <p className="mt-2 text-ui">{SIGN_IN_UNAVAILABLE}</p>}</div>
          <ul className="mt-3 space-y-1 text-meta leading-relaxed">
            {KEPT.map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden="true" className="font-bold text-blue">
                  ·
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-meta">
            <Link to="/privacy" className="link" onClick={() => onOpenChange(false)}>
              {PRIVACY_LINK}
            </Link>
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** "Continue with Google": ink outline, Google's mark (UI_DESIGN §4.8 mockup). */
export function GoogleButton({ onClick, busy = false, className }: { onClick: () => void; busy?: boolean; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-busy={busy}
      aria-disabled={busy}
      className={cx(
        'inline-flex cursor-pointer items-center gap-2 rounded-full border-[1.5px] border-ink bg-raised px-3.5 py-[5px] text-ui font-bold text-ink hover:bg-blue-wash aria-disabled:cursor-wait pointer-coarse:min-h-11',
        className,
      )}
    >
      <span aria-hidden="true" className="google-mark" />
      {CONTINUE_WITH_GOOGLE}
    </button>
  );
}
