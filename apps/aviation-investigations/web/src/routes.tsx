import type { RouteObject } from 'react-router';
import { AppShell } from './AppShell';
import { CasePlaceholder, ComingSoon, HomePlaceholder, NotFound } from './pages/Placeholder';

/**
 * Routes from UI_DESIGN §3. View state (query, facets, open case, brief step,
 * compared cases) lives in the query string, so each view is one route here.
 * Replace a placeholder `element` with the real page as it arrives.
 */
const pages: RouteObject[] = [
  { index: true, element: <HomePlaceholder /> },
  {
    path: 'explore',
    element: (
      <ComingSoon
        eyebrow="Keyword search"
        title="Explore"
        description="Search completed NTSB investigations by keyword, with counts for phase, injury, conditions and year."
      />
    ),
  },
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
  { path: 'cases/:ntsbNo', element: <CasePlaceholder /> },
  {
    path: 'compare',
    element: (
      <ComingSoon
        eyebrow="Compare"
        title="Compare"
        description="Up to four investigations side by side as flight strips, ready to print for class."
      />
    ),
  },
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
  {
    path: 'privacy',
    element: (
      <ComingSoon eyebrow="Privacy" title="Privacy" description="What Aviation Casebook keeps, for how long, and why." />
    ),
  },
  {
    path: 'about',
    element: (
      <ComingSoon
        eyebrow="About"
        title="About"
        description="An independent educational project built on public NTSB investigation data. It is not an NTSB service."
      />
    ),
  },
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
    children: [...pages, ...devPages, { path: '*', element: <NotFound /> }],
  },
];
