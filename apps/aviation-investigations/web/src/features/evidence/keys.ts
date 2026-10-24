/**
 * Where an evidence search lives in the app, without its contracts: the page route and the
 * query key of one page (the evidence client, web/src/features/evidence/api.ts, loads with the
 * first AI request; the home page only needs these).
 */

/** The search's page (UI_DESIGN §3): linkable while the search lives. */
export const evidencePath = (id: string): string => `/ai/${id}`;

/** The query key of page `page` of a search; the private `evidence` namespace (web/src/features/auth/visitor.ts). */
export const evidencePageKey = (id: string, page: number) => ['evidence', id, page] as const;

/** `pages`: how many pages of the pinned ranking the page shows ("Show more"; the drawer and Compare read them too). */
export const PAGES_PARAM = 'pages';
