import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { configQuery } from '../api';
import { Placard } from '../components/Placard';
import { formatChartDate, formatCount } from '../lib/format';

export function TextPage({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-reading px-4 py-10 sm:py-14">
      <title>{`${title} · Aviation Casebook`}</title>
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

/** About: what the casebook is, where its data comes from, and what it is not. */
export function About() {
  const config = useQuery(configQuery());
  const coverage = config.data?.coverage;
  return (
    <TextPage eyebrow="About" title="About Aviation Casebook">
      <p>
        Aviation Casebook helps flight instructors and safety analysts find and compare NTSB aviation investigations by
        what investigators established: the probable cause, the findings and the facts behind them.
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
        Aviation Casebook is an independent educational project. It is not an NTSB service, and it is not a source of
        operational flight or maintenance instructions. For a flight in progress, contact ATC; for airworthiness, use
        your aircraft’s approved data and a certificated mechanic.
      </p>
      <p>
        <Link to="/explore" className="link font-sans text-ui">
          Search the record
        </Link>
      </p>
    </TextPage>
  );
}
