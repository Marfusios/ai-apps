import type { ReactNode } from 'react';
import { Link } from 'react-router';
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
