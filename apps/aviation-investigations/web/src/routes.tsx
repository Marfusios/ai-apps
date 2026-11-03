import type { RouteObject } from 'react-router';
import { AppShell } from './AppShell';
import { About } from './pages/About';
import { AppError, RouteError } from './pages/ErrorPage';
import { Home } from './pages/Home';
import { NotFound } from './pages/Placeholder';
import { Privacy } from './pages/Privacy';

/**
 * Routes from UI_DESIGN §3. View state (query, facets, open case, compared cases,
 * the brief step) lives in the query string, so each view is one route.
 */
const pages: RouteObject[] = [
  { index: true, element: <Home /> },
  // Explore, case and compare load on first use, which keeps the home page light.
  { path: 'explore', lazy: async () => ({ Component: (await import('./pages/Explore')).Explore }) },
  { path: 'briefs/:id', lazy: async () => ({ Component: (await import('./pages/Brief')).Brief }) },
  { path: 'ai/:id', lazy: async () => ({ Component: (await import('./pages/Evidence')).Evidence }) },
  { path: 'cases/:ntsbNo', lazy: async () => ({ Component: (await import('./pages/CasePage')).CasePage }) },
  { path: 'compare', lazy: async () => ({ Component: (await import('./pages/Compare')).Compare }) },
  { path: 'dashboard', lazy: async () => ({ Component: (await import('./pages/Dashboard')).Dashboard }) },
  { path: 'account', lazy: async () => ({ Component: (await import('./pages/Account')).Account }) },
  // The admin page: only for an admin account; everyone else sees the normal "not found" page.
  { path: 'admin', lazy: async () => ({ Component: (await import('./pages/Admin')).Admin }) },
  { path: 'privacy', element: <Privacy /> },
  { path: 'about', element: <About /> },
];

/** The living style guide; only in development builds (the branch is removed from production bundles). */
const devPages: RouteObject[] = import.meta.env.DEV
  ? [
      {
        path: 'dev/components',
        lazy: async () => ({ Component: (await import('./dev/ComponentGallery')).ComponentGallery }),
      },
    ]
  : [];

/**
 * Unexpected errors never show the router's developer page (Task 22 review W-1): a page that
 * fails shows the error inside the frame, header and footer kept (the pathless route's
 * `errorElement`); if the frame itself fails, the root's `errorElement` shows a plain frame
 * of its own.
 */
export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    errorElement: <AppError />,
    // Shown for the moment a lazily loaded page is fetched on first load.
    hydrateFallbackElement: <div className="min-h-dvh" />,
    children: [
      {
        errorElement: <RouteError />,
        children: [...pages, ...devPages, { path: '*', element: <NotFound /> }],
      },
    ],
  },
];
