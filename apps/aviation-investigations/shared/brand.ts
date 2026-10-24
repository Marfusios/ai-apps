/**
 * The product's name, the owner's credit and the words search engines and link previews show,
 * shared by the web client and the server (which builds each page's head: server/seo/head.ts).
 *
 * Owner decisions of 2026-10-24 (UI_DESIGN §10): the product is AirCase, tagline "aviation
 * casebook". The footer says it was built by Mariusz Kotas and links his website; the About
 * page gives his name, the website and his e-mail address as a `mailto:` link. Both are public
 * on purpose: the owner asked for them. The website opens in a new tab, like the app's links to
 * NTSB reports. The wordmark is set in capitals by CSS; the text is "AirCase". The header says in
 * plain words what the site shows (`PRODUCT_DESCRIPTOR`), and so do the home page's title and
 * the share card. `web/index.html` repeats the home page's title and the site description for
 * the moment before the script runs (tests/web/brand.test.tsx keeps them equal); the server
 * replaces both with each page's own.
 */
export const PRODUCT_NAME = 'AirCase';
/** What AirCase is, in the About page's words and the home page's JSON-LD (`alternateName`). */
export const PRODUCT_TAGLINE = 'aviation casebook';
/** What the site shows, for a stranger: the header's line beside or under the wordmark. */
export const PRODUCT_DESCRIPTOR = 'Plane crash & accident investigations';
/** "AirCase · Plane crash & accident investigations": the home page's title. */
export const PRODUCT_LONG_NAME = `${PRODUCT_NAME} · ${PRODUCT_DESCRIPTOR}`;
/** The live domain, as the share card prints it. */
export const PRODUCT_DOMAIN = 'aircase.app';

export const CREDIT_NAME = 'Mariusz Kotas';
export const CREDIT_SITE = 'mkotas.cz';
export const CREDIT_SITE_HREF = `https://${CREDIT_SITE}`;
export const CREDIT_EMAIL = 'm@mkotas.cz';
export const CREDIT_EMAIL_HREF = `mailto:${CREDIT_EMAIL}`;

/** A page's tab title: its own parts, most specific first, then the product ("Explore · AirCase"). */
export function documentTitle(...parts: string[]): string {
  return [...parts, PRODUCT_NAME].join(' · ');
}

// ---------------------------------------------------------------------------
// Search engines and link previews (README, "Search engines and link previews"). Plain,
// factual text: what each page shows today, no promises and nothing written by AI.

/**
 * The home page's description, `web/index.html`'s until the server replaces it, and the web app
 * manifest's (web/public/manifest.webmanifest).
 */
export const SITE_DESCRIPTION =
  'Search NTSB investigations of US plane crashes and aviation accidents since 2008: what happened, the probable cause and what investigators found.';

/**
 * The share image of every page (Open Graph and Twitter cards), served from `web/public`. Its
 * text: the mark and the wordmark, the descriptor as the headline, `SHARE_CARD_TEXT` under it.
 */
export const SHARE_IMAGE = {
  path: '/social/card.png',
  width: 1200,
  height: 630,
  alt: `${PRODUCT_NAME}: ${PRODUCT_DESCRIPTOR}`,
} as const;

/**
 * The share card's words besides the wordmark and the headline (the descriptor), rendered into
 * `web/public/social/card.png` by `pnpm brand:build` (scripts/build-brand-assets.ts): run it
 * again after changing any of them.
 */
export const SHARE_CARD_TEXT = {
  subline: 'NTSB investigations since 2008: what happened, the probable cause and what investigators found.',
  site: PRODUCT_DOMAIN,
  disclaimer: 'Independent project, not an NTSB service',
} as const;

/**
 * The meta descriptions of the pages without data of their own, at most 160 characters each
 * (a case page's is built from its record, server/seo/head.ts). The two not-found ones repeat
 * the headings those pages show.
 */
export const PAGE_DESCRIPTIONS = {
  explore: 'Search NTSB aviation investigations by keyword, with filters for phase of flight, injury, weather, aircraft, operation, location and year.',
  dashboard: 'Charts of the NTSB aviation investigation record: investigations by year, phase of flight, injury, weather, aircraft and location.',
  about: 'About AirCase, an independent aviation casebook: what you can do with it, where its NTSB data comes from, what it is not and who built it.',
  privacy: 'What AirCase keeps on your device and on its servers. No tracking or advertising cookies; searching, reading cases and comparing need no account.',
  compare: 'Compare up to four NTSB aviation investigations on one page, with their facts lined up and what is the same in all of them shown once.',
  account: 'Your AirCase account. Search, case pages, compare and the dashboard stay open without an account.',
  brief: 'A private brief. It opens only for the person who asked the question.',
  evidence: 'A private AI search. It opens only for the person who asked the question.',
  missingCase: 'No investigation has that number.',
  notFound: 'There is no page here.',
} as const;
