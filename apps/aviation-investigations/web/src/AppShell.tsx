import { useQuery } from '@tanstack/react-query';
import { Outlet, ScrollRestoration } from 'react-router';
import { configQuery } from './api';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { AiCounter } from './features/ai/AiCounter';
import { TurnstileGate } from './features/ai/TurnstileGate';
import { HeaderAuth } from './features/auth/HeaderAuth';
import { SignInProvider } from './features/auth/SignInDialog';
import { Welcome } from './features/auth/Welcome';

/**
 * The global frame (UI_DESIGN §3) around every route. The snapshot date comes from
 * `/api/config`, the AI counter from `/api/ai/status`, the header's sign-in slot from
 * `/api/account`. The sign-in dialog and the Turnstile gate wrap every page, so any
 * control can offer sign-in or ask for a check; a first sign-in's welcome shows on the
 * page it returns to.
 */
export function AppShell() {
  const config = useQuery(configQuery());
  return (
    <SignInProvider>
      <TurnstileGate>
        <div className="flex min-h-dvh flex-col">
          <a href="#main" className="skip-link">
            Skip to content
          </a>
          <Header aiCounter={<AiCounter />} auth={<HeaderAuth />} />
          <main id="main" tabIndex={-1} className="flex flex-1 flex-col pt-2 outline-none">
            <Outlet />
          </main>
          <Footer snapshotDate={config.data?.snapshotDate ?? null} />
          <ScrollRestoration />
        </div>
        <Welcome />
      </TurnstileGate>
    </SignInProvider>
  );
}
