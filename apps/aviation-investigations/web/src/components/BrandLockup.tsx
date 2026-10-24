import { Link } from 'react-router';
import { PRODUCT_DESCRIPTOR, PRODUCT_NAME } from '../brand';
import { BrandMark } from './BrandMark';

export interface BrandLockupProps {
  /**
   * Link home with a plain `<a>`, a full page load, instead of the router: for the frame that
   * shows when the app frame itself has failed.
   */
  reload?: boolean;
}

/**
 * The header's lockup (UI_DESIGN §3, owner decisions of 2026-10-24): the home link, with the
 * decorative mark before the wordmark (its accessible name is "AirCase" alone), and the
 * descriptor, plain text outside the link, which says what AirCase shows.
 *
 * - Desktop (from 1024px): the descriptor sits beside the wordmark after a hairline.
 * - Tablet (640–1023px): no descriptor; the nav, the AI counter, the theme switch and sign-in
 *   leave it no room on the header's one line.
 * - Phone: two lines, the descriptor under the wordmark and the 24px mark centred beside both,
 *   in a 32px gutter. The lockup's box gives way (`display: contents`): its link and descriptor
 *   are items of the header's row, which must be a wrapping flex row (`relative flex flex-wrap
 *   content-center`). The descriptor takes a line of its own after the row's other items, so it
 *   may run under the AI counter, and the mark is placed against the row (`absolute`), centred on
 *   its two lines.
 *
 * In print the mark and the wordmark print; the descriptor does not (§7).
 */
export function BrandLockup({ reload = false }: BrandLockupProps) {
  const name = (
    <>
      <BrandMark
        size={22}
        className="absolute top-1/2 -ml-8 size-6 -translate-y-1/2 sm:static sm:ml-0 sm:size-[22px] sm:translate-y-0"
      />
      <span className="wordmark">{PRODUCT_NAME}</span>
    </>
  );
  const linkClass = 'ml-8 inline-flex items-center gap-2 sm:ml-0';
  return (
    <div className="contents sm:flex sm:items-center sm:gap-3.5">
      {reload ? (
        <a href="/" className={linkClass}>
          {name}
        </a>
      ) : (
        <Link to="/" className={linkClass}>
          {name}
        </Link>
      )}
      <p
        className="order-1 basis-full pl-8 text-meta whitespace-nowrap text-muted sm:hidden lg:block lg:basis-auto lg:border-l lg:border-hairline lg:pl-3"
        data-print="hide"
      >
        {PRODUCT_DESCRIPTOR}
      </p>
    </div>
  );
}
