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
 * decorative 22px mark before the wordmark at every width (the link's box, and so its focus
 * ring, holds both; its accessible name is "AirCase" alone), and the descriptor, plain text
 * outside the link, which says what AirCase shows.
 *
 * - Desktop (from 1024px): the descriptor sits beside the wordmark after a hairline.
 * - Phone and tablet (below 1024px): two lines, the descriptor under the wordmark. The lockup's
 *   box gives way (`display: contents`): its link and descriptor are items of the header's row,
 *   which must be a wrapping flex row below 1024px (`flex flex-wrap`, `lg:flex-nowrap`). The
 *   descriptor takes a line of its own after the row's other items, so it may run under the AI
 *   counter (phone) or the navigation (tablet): there is no room beside them for it.
 *
 * In print the mark and the wordmark print; the descriptor does not (§7).
 */
export function BrandLockup({ reload = false }: BrandLockupProps) {
  const name = (
    <>
      <BrandMark size={22} />
      <span className="wordmark">{PRODUCT_NAME}</span>
    </>
  );
  const linkClass = 'inline-flex items-center gap-2';
  return (
    <div className="contents lg:flex lg:items-center lg:gap-3.5">
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
        className="order-1 basis-full pl-[30px] text-meta whitespace-nowrap text-muted lg:basis-auto lg:border-l lg:border-hairline lg:pl-3"
        data-print="hide"
      >
        {PRODUCT_DESCRIPTOR}
      </p>
    </div>
  );
}
