import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';
import { cx } from '../../lib/cx';

/** Renders a template sentence; `**…**` spans are the computed numbers. */
export function Sentence({ text, className }: { text: string; className?: string }) {
  const parts = text.split('**');
  return (
    <p className={cx('text-[12px] leading-[1.45] text-muted', className)}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <b key={i} className="font-bold text-ink">
            {part}
          </b>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </p>
  );
}

/**
 * One dashboard panel (UI_DESIGN §4.7): the question in serif, one factual
 * sentence as the visible caption, then the chart. On a phone each is its own card
 * and may end with "Open the N … cases →".
 */
export function QuestionPanel({
  id,
  question,
  sentence,
  children,
  wide = false,
  note,
  open,
}: {
  id: string;
  question: string;
  sentence?: string;
  children: ReactNode;
  wide?: boolean;
  note?: string | null;
  open?: { href: string; text: string };
}) {
  return (
    <section aria-labelledby={id} className={cx('rounded-card border border-hairline bg-raised/80 px-4 py-3.5', wide && 'lg:col-span-2')}>
      <h2 id={id} className="mb-0.5 font-serif text-[18px] leading-[1.2] font-semibold">
        {question}
      </h2>
      {sentence && <Sentence text={sentence} className="mb-2.5" />}
      {children}
      {note && <p className="mt-2 text-label text-muted">{note}</p>}
      {open && (
        <Link
          to={open.href}
          className="mt-2.5 inline-flex text-meta text-blue hover:underline pointer-coarse:min-h-11 pointer-coarse:items-center lg:hidden"
        >
          {open.text} →
        </Link>
      )}
    </section>
  );
}
