import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { CompassMark } from '../components/CompassMark';
import { Placard } from '../components/Placard';

interface ComingSoonProps {
  eyebrow: string;
  /** Page title; also used for the document title. */
  title: string;
  /** Shown in place of the title when it needs markup. */
  heading?: ReactNode;
  description: string;
}

/** Placeholder page: the frame, a title and "Coming soon". */
export function ComingSoon({ eyebrow, title, heading, description }: ComingSoonProps) {
  return (
    <section className="mx-auto w-full max-w-reading px-4 py-14 sm:py-20">
      <title>{`${title} · Aviation Casebook`}</title>
      <div className="card px-6 py-6 sm:px-8 sm:py-7">
        <Placard as="p">{eyebrow}</Placard>
        <h1 className="mt-2 font-serif text-headline font-semibold tracking-headline">{heading ?? title}</h1>
        <p className="mt-3 font-serif text-quote">{description}</p>
        <p className="mt-5 border-t border-hairline pt-3 font-mono text-label tracking-mono text-muted uppercase">
          Coming soon
        </p>
      </div>
    </section>
  );
}

/** Home, "Clear sky" (UI_DESIGN §4.1), until search arrives. */
export function HomePlaceholder() {
  return (
    <section className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <title>Aviation Casebook</title>
      <CompassMark />
      <h1 className="mt-3.5 font-serif text-display font-semibold tracking-headline">Learn from the record.</h1>
      <p className="mt-3 max-w-[46ch] text-muted">
        Keyword search and AI briefs over completed NTSB investigations are coming soon.
      </p>
    </section>
  );
}

export function CasePlaceholder() {
  const { ntsbNo = '' } = useParams();
  return (
    <ComingSoon
      eyebrow="Case"
      title={`Case ${ntsbNo}`}
      heading={<span className="font-mono tracking-mono">{ntsbNo}</span>}
      description="The full investigation in story order: what happened, the flight, and what investigators established, in the NTSB's words."
    />
  );
}

export function NotFound() {
  return (
    <section className="mx-auto w-full max-w-reading px-4 py-14 sm:py-20">
      <title>Page not found · Aviation Casebook</title>
      <div className="card px-6 py-6 sm:px-8 sm:py-7">
        <Placard as="p">Not found</Placard>
        <h1 className="mt-2 font-serif text-headline font-semibold tracking-headline">There is no page here.</h1>
        <p className="mt-3 font-serif text-quote">
          Check the address, or start again from the{' '}
          <Link to="/" className="link">
            home page
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
