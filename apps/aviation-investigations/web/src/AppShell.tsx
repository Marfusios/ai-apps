import { useQuery } from '@tanstack/react-query';
import { Outlet, ScrollRestoration } from 'react-router';
import { configQuery } from './api';
import { Footer } from './components/Footer';
import { Header } from './components/Header';

/**
 * The global frame (UI_DESIGN §3) around every route. The snapshot date comes from
 * `/api/config`; the AI counter and sign-in arrive with briefs and auth, so those
 * header slots are empty for now.
 */
export function AppShell() {
  const config = useQuery(configQuery());
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Header />
      <main id="main" tabIndex={-1} className="flex flex-1 flex-col pt-2 outline-none">
        <Outlet />
      </main>
      <Footer snapshotDate={config.data?.snapshotDate ?? null} />
      <ScrollRestoration />
    </div>
  );
}
