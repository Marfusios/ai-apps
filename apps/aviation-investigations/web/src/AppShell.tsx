import { Outlet, ScrollRestoration } from 'react-router';
import { Footer } from './components/Footer';
import { Header } from './components/Header';

/**
 * The global frame (UI_DESIGN §3) around every route. The AI counter, sign-in and
 * snapshot date arrive with the API and auth work; until then the header slots are
 * empty and the footer omits the date.
 */
export function AppShell() {
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Header />
      <main id="main" tabIndex={-1} className="flex flex-1 flex-col pt-2 outline-none">
        <Outlet />
      </main>
      <Footer snapshotDate={null} />
      <ScrollRestoration />
    </div>
  );
}
