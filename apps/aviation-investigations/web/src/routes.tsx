import type { RouteObject } from 'react-router';
import { AppShell } from './AppShell';
import { About } from './pages/About';
import { Home } from './pages/Home';
import { ComingSoon, NotFound } from './pages/Placeholder';
import { Privacy } from './pages/Privacy';

/**
 * Routes from UI_DESIGN §3. View state (query, facets, open case, compared cases,
 * and later the brief step) lives in the query string, so each view is one route.
 */
const pages: RouteObject[] = [
  { index: true, element: <Home /> },
  // Explore, case and compare load on first use, which keeps the home page light.
  { path: 'explore', lazy: async () => ({ Component: (await import('./pages/Explore')).Explore }) },
  {
    path: 'briefs/:id',
    element: (
      <ComingSoon
        eyebrow="Ask AI"
        title="Brief"
        description="An answer to your question, with every claim one click from the NTSB passage it came from. Briefs last 24 hours."
      />
    ),
  },
  { path: 'cases/:ntsbNo', lazy: async () => ({ Component: (await import('./pages/CasePage')).CasePage }) },
  { path: 'compare', lazy: async () => ({ Component: (await import('./pages/Compare')).Compare }) },
  {
    path: 'dashboard',
    element: (
      <ComingSoon
        eyebrow="Dashboard"
        title="The record, in questions"
        description="How complete the recent record is, when in the flight events happened, and what this data can and cannot tell you."
      />
    ),
  },
  {
    path: 'account',
    element: (
      <ComingSoon
        eyebrow="Account"
        title="Account"
        description="Your AI searches left, and the controls to sign out or delete your account."
      />
    ),
  },
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

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    // Shown for the moment a lazily loaded page is fetched on first load.
    hydrateFallbackElement: <div className="min-h-dvh" />,
    children: [...pages, ...devPages, { path: '*', element: <NotFound /> }],
  },
];
