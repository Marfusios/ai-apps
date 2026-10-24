import { Link } from 'react-router';
import { Button } from '../components/Button';
import { Placard } from '../components/Placard';

/** Builder copy (Task 22 review W-1), for the owner's review. */
export const ERROR_TITLE = 'Something went wrong.';
export const ERROR_TEXT = 'This page stopped because of an unexpected error. Try again, or start again from the home page.';

/**
 * What a route shows when it fails unexpectedly (a render error, or a page that could not
 * load): the app's own card, never a developer page, and nothing of the error itself. Try
 * again reloads the page, which also fetches a newer build if one replaced the page's code.
 */
export function RouteError() {
  return (
    <section className="mx-auto w-full max-w-reading px-4 py-14 sm:py-20">
      <title>Something went wrong · Aviation Casebook</title>
      <div role="alert" className="card px-6 py-6 sm:px-8 sm:py-7">
        <Placard as="p">Error</Placard>
        <h1 className="mt-2 font-serif text-headline font-semibold tracking-headline">{ERROR_TITLE}</h1>
        <p className="mt-3 font-serif text-quote">{ERROR_TEXT}</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="search" onClick={() => window.location.reload()}>
            Try again
          </Button>
          <Link to="/" className="link text-ui">
            Home
          </Link>
        </div>
      </div>
    </section>
  );
}

/**
 * When the app frame itself fails (header, footer, the providers around every page): a
 * plain frame of its own with the wordmark, so there is still a way home. It uses nothing
 * the failed frame provides.
 */
export function AppError() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="header-rule relative z-20 bg-header">
        <div className="mx-auto flex max-w-page items-center px-4 py-[11px] sm:px-[22px]">
          <a href="/" className="placard wordmark">
            Aviation Casebook
          </a>
        </div>
      </header>
      <main id="main" className="flex flex-1 flex-col pt-2">
        <RouteError />
      </main>
    </div>
  );
}
