/**
 * Small pieces the admin page's sections share (UI_DESIGN §4.12): a fact of the system's lists, a
 * configuration's identifier under its words, and a dash that says what is missing.
 */
import type { ReactNode } from 'react';

/** One line of the system's facts: its name, and the value (with an identifier in mono where there is one). */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,9.5rem)_1fr] gap-x-3 py-1 sm:grid-cols-[11rem_1fr]" data-fact={label}>
      <dt className="text-meta text-muted">{label}</dt>
      <dd className="min-w-0 text-meta break-words text-ink">{children}</dd>
    </div>
  );
}

/** A configuration's identifier, under its words (or alone, for one the page has no words for). */
export function Id({ children }: { children: string }) {
  return (
    <span className="block font-mono text-label break-words text-muted" data-code="">
      {children}
    </span>
  );
}

/** "—" for a value that is not there, said as such. */
export function Missing({ words }: { words: string }) {
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{words}</span>
    </>
  );
}
