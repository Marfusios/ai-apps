import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { pageTitle } from '../../../shared/page-titles';
import { configQuery } from '../api';
import { CREDIT_EMAIL, CREDIT_EMAIL_HREF, CREDIT_NAME, CREDIT_SITE, CREDIT_SITE_HREF, PRODUCT_NAME } from '../brand';
import { Placard } from '../components/Placard';
import { formatChartDate, formatCount } from '../lib/format';

/** `tabTitle` is the browser tab's whole title, the route's shared one (shared/page-titles.ts). */
export function TextPage({ eyebrow, title, tabTitle, children }: { eyebrow: string; title: string; tabTitle: string; children: ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-reading px-4 py-10 sm:py-14">
      <title>{tabTitle}</title>
      <div className="card px-6 py-6 sm:px-8 sm:py-7">
        <Placard as="p">{eyebrow}</Placard>
        <h1 className="mt-2 font-serif text-headline font-semibold tracking-headline">{title}</h1>
        <div className="mt-4 space-y-3 font-serif text-quote [&_h2]:pt-2 [&_h2]:font-sans [&_h2]:text-micro [&_h2]:font-bold [&_h2]:tracking-caps [&_h2]:text-ink [&_h2]:uppercase">
          {children}
        </div>
      </div>
    </section>
  );
}

/**
 * About: what the casebook is and can do today (keyword search, case pages, Compare and the
 * dashboard; the AI features are not open yet, as the Privacy page also says), where its
 * data comes from, what it is not, and who built it (the owner's credit, 2026-10-24: his name,
 * his website and his e-mail address; the footer carries only the name and the website). The line
 * "AI features are not available yet." is static: it changes in the release that opens AI,
 * with the Privacy text (RUNBOOK, "Google sign-in", step 0; tests/web/brand.test.tsx).
 */
export function About() {
  const config = useQuery(configQuery());
  const coverage = config.data?.coverage;
  return (
    <TextPage eyebrow="About" title={`About ${PRODUCT_NAME}`} tabTitle={pageTitle({ kind: 'about' })}>
      <p>
        {PRODUCT_NAME} is an aviation casebook. It helps flight instructors and safety analysts find and compare NTSB
        aviation investigations by what investigators established: the probable cause, the findings and the facts
        behind them.
      </p>
      <h2>What you can do here</h2>
      <p>
        Search the record by keyword and narrow the results with filters. Open any investigation on its own page,
        compare up to four of them on one page, and see how the whole record breaks down on the dashboard. AI features
        are not available yet.
      </p>
      <h2>The data</h2>
      <p>
        Every case comes from the NTSB aviation investigation database (avall.mdb), published as public data by the
        National Transportation Safety Board.
        {config.data && coverage && (
          <>
            {' '}
            This copy is the snapshot of {formatChartDate(config.data.snapshotDate)}: {formatCount(coverage.defaultCohort)}{' '}
            completed US investigations with probable-cause text, {coverage.yearFrom} to {coverage.yearTo}, plus{' '}
            {formatCount(coverage.otherRecords)} other US records shown with their raw NTSB status.
          </>
        )}
      </p>
      <p>
        NTSB text is shown as published. Headlines, labels and data cautions are built from the coded fields by fixed
        rules, never written by AI.
        {coverage?.provisional &&
          ' Which status codes count as a completed investigation is a provisional reading of the data until NTSB metadata confirms it.'}
      </p>
      <h2>What it is not</h2>
      <p>
        {PRODUCT_NAME} is an independent educational project. It is not an NTSB service, and it is not a source of
        operational flight or maintenance instructions. For a flight in progress, contact ATC; for airworthiness, use
        your aircraft’s approved data and a certificated mechanic.
      </p>
      <h2>Built by</h2>
      <p>
        {PRODUCT_NAME} is built by {CREDIT_NAME}. Website:{' '}
        <a href={CREDIT_SITE_HREF} target="_blank" rel="noopener noreferrer" className="link">
          {CREDIT_SITE}
        </a>
        . Contact:{' '}
        <a href={CREDIT_EMAIL_HREF} className="link">
          {CREDIT_EMAIL}
        </a>
        .
      </p>
      <p>
        <Link to="/explore" className="link font-sans text-ui">
          Search the record
        </Link>
      </p>
    </TextPage>
  );
}
