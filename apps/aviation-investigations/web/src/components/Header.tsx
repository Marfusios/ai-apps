import { Menu, X } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import { cx } from '../lib/cx';
import { BrandLockup } from './BrandLockup';
import { ThemeSwitch } from './ThemeSwitch';

const NAV = [
  { to: '/explore', label: 'Explore' },
  { to: '/dashboard', label: 'Dashboard' },
] as const;

export interface HeaderProps {
  /** The AI counter (UI_DESIGN §5). Stays visible on phones. */
  aiCounter?: ReactNode;
  /** Sign in, or the account menu when signed in. In the ☰ menu on phones. */
  auth?: ReactNode;
}

/**
 * Global header (UI_DESIGN §3): the lockup (the mark and the wordmark linking home, and what
 * AirCase shows), Explore and Dashboard, the AI counter, the Day/Night switch and sign-in,
 * over the blue rule with its tick scale. Below 1024px the row wraps: the descriptor takes a
 * second line under the wordmark, with the rest of the header on the first (3px apart on a
 * tablet, clear of the active item's underline). Below 640px the nav, switch and sign-in move
 * into a ☰ menu (§6), centred on both lines. The wordmark is one short word, so it is the same
 * at every width.
 */
export function Header({ aiCounter, auth }: HeaderProps) {
  const location = useLocation();
  // The menu belongs to the location it was opened on, so any navigation closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === location.key;
  const menuId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && open) {
      setOpenOn(null);
      menuButton.current?.focus();
    }
  };

  return (
    <header className="header-rule relative z-20 bg-header" onKeyDown={onKeyDown}>
      <div className="relative mx-auto flex min-h-[66px] max-w-page flex-wrap content-center items-center gap-x-3 py-[11px] pr-[62px] pl-4 sm:min-h-0 sm:gap-x-4 sm:gap-y-[3px] sm:px-[22px] lg:flex-nowrap lg:gap-x-[1.4rem]">
        <BrandLockup />
        <nav aria-label="Main" className="hidden gap-[1.1rem] sm:flex" data-print="hide">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className={navClass}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        {/* Grows from nothing, so on a phone it stays on the wordmark's line and a long counter is cut short there. */}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-3.5" data-print="hide">
          {aiCounter && <div className="min-w-0 truncate text-meta text-muted">{aiCounter}</div>}
          <div className="hidden sm:block">
            <ThemeSwitch />
          </div>
          {auth && <div className="hidden items-center sm:flex">{auth}</div>}
          <button
            ref={menuButton}
            type="button"
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => setOpenOn(open ? null : location.key)}
            className="absolute top-1/2 right-2 inline-flex size-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-ink hover:bg-blue-wash sm:hidden"
          >
            {open ? <X size={20} strokeWidth={1.5} aria-hidden="true" /> : <Menu size={20} strokeWidth={1.5} aria-hidden="true" />}
            <span className="sr-only">Menu</span>
          </button>
        </div>
      </div>
      <div id={menuId} hidden={!open} className="border-t border-hairline px-4 pt-2 pb-5 sm:hidden" data-print="hide">
        <nav aria-label="Main">
          <ul>
            {NAV.map((item) => (
              <li key={item.to} className="border-b border-hairline">
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    cx('flex min-h-11 items-center text-lead', isActive ? 'font-bold text-ink' : 'text-muted')
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="mt-4 flex items-center justify-between gap-4">
          <ThemeSwitch />
          {auth}
        </div>
      </div>
    </header>
  );
}

function navClass({ isActive }: { isActive: boolean }): string {
  return cx(
    'inline-flex items-center border-b-2 pb-px pointer-coarse:min-h-11',
    isActive ? 'border-blue text-ink' : 'border-transparent text-muted hover:text-ink',
  );
}
