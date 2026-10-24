import { CREDIT_NAME, CREDIT_SITE, CREDIT_SITE_HREF } from '../brand';

/**
 * The owner's credit, "Built by Mariusz Kotas · mkotas.cz", with the website as a link that opens
 * in a new tab (UI_DESIGN §3, owner decisions of 2026-10-24; his e-mail address is on the About
 * page). It shows on screen and in print. It is a plain paragraph that needs no router, no data
 * and no other component, so the footer of every page and the fallback page of a failed app frame
 * (pages/ErrorPage.tsx) can both carry it.
 */
export function CreditLine() {
  return (
    <p className="mx-auto max-w-page px-4 pt-1 pb-5 text-center text-label text-muted print:mx-0 print:pt-0 print:pb-3 print:text-left print:text-ink">
      <span>Built by {CREDIT_NAME}</span>
      <span aria-hidden="true"> · </span>
      <a href={CREDIT_SITE_HREF} target="_blank" rel="noopener noreferrer" className="link">
        {CREDIT_SITE}
      </a>
    </p>
  );
}
