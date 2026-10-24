/**
 * The product's name and the owner's credit (owner decisions of 2026-10-24, UI_DESIGN §10):
 * the product is AirCase, tagline "aviation casebook". The footer says it was built by Mariusz
 * Kotas and links his website; the About page gives his name, the website and his e-mail
 * address as a `mailto:` link. Both are public on purpose: the owner asked for them. The
 * website opens in a new tab, like the app's links to NTSB reports. The wordmark is set in
 * capitals by CSS; the text is "AirCase". `web/index.html` repeats the long form for the moment
 * before the script runs (tests/web/brand.test.tsx keeps the two equal).
 */
export const PRODUCT_NAME = 'AirCase';
export const PRODUCT_TAGLINE = 'aviation casebook';
/** "AirCase · aviation casebook": where the long form helps, as the home page's title. */
export const PRODUCT_LONG_NAME = `${PRODUCT_NAME} · ${PRODUCT_TAGLINE}`;

export const CREDIT_NAME = 'Mariusz Kotas';
export const CREDIT_SITE = 'mkotas.cz';
export const CREDIT_SITE_HREF = `https://${CREDIT_SITE}`;
export const CREDIT_EMAIL = 'm@mkotas.cz';
export const CREDIT_EMAIL_HREF = `mailto:${CREDIT_EMAIL}`;

/** A page's tab title: its own parts, most specific first, then the product ("Explore · AirCase"). */
export function documentTitle(...parts: string[]): string {
  return [...parts, PRODUCT_NAME].join(' · ');
}
