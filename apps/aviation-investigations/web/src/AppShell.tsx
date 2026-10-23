import { useQuery } from '@tanstack/react-query';
import { Outlet, ScrollRestoration } from 'react-router';
import { configQuery } from './api';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { AiCounter } from './features/ai/AiCounter';
import { TurnstileGate } from './features/ai/TurnstileGate';

/**
 * The global frame (UI_DESIGN §3) around every route. The snapshot date comes from
 * `/api/config`, the AI counter from `/api/ai/status`; sign-in arrives with accounts.
 * The Turnstile gate wraps every page, so any AI control can ask for a check.
 */
export function AppShell() {
  const config = useQuery(configQuery());
  return (
    <TurnstileGate>
      <div className="flex min-h-dvh flex-col">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <Header aiCounter={<AiCounter />} />
        <main id="main" tabIndex={-1} className="flex flex-1 flex-col pt-2 outline-none">
          <Outlet />
        </main>
        <Footer snapshotDate={config.data?.snapshotDate ?? null} />
        <ScrollRestoration />
      </div>
    </TurnstileGate>
  );
}
