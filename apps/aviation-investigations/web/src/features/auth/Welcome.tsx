import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { WELCOME_PARAM } from '../../../../shared/contracts/account';
import { aiStatusQuery, configQuery } from '../../api';
import { Button } from '../../components/Button';
import { welcomeText } from '../ai/limits';
import { accountQuery, returnPath } from './api';

/**
 * UI_DESIGN §4.8 copy (first sign-in). The training-email opt-in is deferred (Owner). The
 * line under the title names the limits the API reports (`welcomeText`, web/src/features/ai/limits.ts).
 */
export const WELCOME_TITLE = 'Welcome aboard.';
export const WELCOME_CONTINUE = 'Continue';

/**
 * The first sign-in's welcome (UI_DESIGN §4.8): a new account comes back from Google to
 * the page it started from with `welcome=1`; while it is signed in, this says what the
 * account has, once. Continue drops the parameter, so a refresh or a shared link never
 * shows it again.
 */
export function Welcome() {
  const location = useLocation();
  const navigate = useNavigate();
  const account = useQuery(accountQuery());
  const limits = useQuery(configQuery()).data?.aiLimits;
  const status = useQuery(aiStatusQuery()).data;
  const title = useRef<HTMLHeadingElement>(null);
  const asked = new URLSearchParams(location.search).get(WELCOME_PARAM) === '1';
  const open = asked && account.data?.signedIn === true;
  const close = (): void => {
    navigate({ pathname: location.pathname, search: returnPath(location.pathname, location.search).slice(location.pathname.length) }, { replace: true, state: location.state });
  };
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-shade" data-print="hide" />
        <Dialog.Content
          aria-describedby={undefined}
          aria-modal="true"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            title.current?.focus();
          }}
          className="card fixed inset-x-4 top-[14vh] z-50 mx-auto max-w-[420px] px-5 py-4 text-ink shadow-sheet"
          data-print="hide"
        >
          <Dialog.Title ref={title} tabIndex={-1} className="font-serif text-[18px] leading-tight font-semibold outline-none focus-visible:outline-2">
            {WELCOME_TITLE}
          </Dialog.Title>
          <p className="mt-1.5 text-ui">{welcomeText(limits, status)}</p>
          <div className="mt-3.5">
            <Dialog.Close asChild>
              <Button variant="search">{WELCOME_CONTINUE}</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
