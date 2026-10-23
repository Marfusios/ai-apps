import { Link } from 'react-router';
import { Placard } from '../components/Placard';

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
