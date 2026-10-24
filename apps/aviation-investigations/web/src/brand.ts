/**
 * The product's name and the owner's credit (owner decisions of 2026-10-24, UI_DESIGN §10):
 * the product is AirCase, tagline "aviation casebook", and the footer and the About page say
 * it was built by Mariusz Kotas, with his e-mail address as a `mailto:` link. The address is
 * public on purpose: the owner asked for it. The wordmark is set in capitals by CSS; the text
 * is "AirCase". `web/index.html` repeats the long form for the moment before the script runs
 * (tests/web/brand.test.tsx keeps the two equal).
 */
export const PRODUCT_NAME = 'AirCase';
export const PRODUCT_TAGLINE = 'aviation casebook';
/** "AirCase · aviation casebook": where the long form helps, as the home page's title. */
export const PRODUCT_LONG_NAME = `${PRODUCT_NAME} · ${PRODUCT_TAGLINE}`;

export const CREDIT_NAME = 'Mariusz Kotas';
export const CREDIT_EMAIL = 'm@mkotas.cz';
export const CREDIT_HREF = `mailto:${CREDIT_EMAIL}`;

/** A page's tab title: its own parts, most specific first, then the product ("Explore · AirCase"). */
export function documentTitle(...parts: string[]): string {
  return [...parts, PRODUCT_NAME].join(' · ');
}
