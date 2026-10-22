import { Fragment } from 'react';

export interface Span {
  start: number;
  end: number;
}

/**
 * Plain text with server-given highlight offsets drawn as `<mark class="hit">`.
 * The text is rendered as text, never as markup (UI_DESIGN §9).
 */
export function Highlighted({ text, highlights }: { text: string; highlights: readonly Span[] }) {
  if (highlights.length === 0) return <>{text}</>;
  const out = [];
  let at = 0;
  highlights.forEach((h, i) => {
    if (h.start > at) out.push(<Fragment key={`t${i}`}>{text.slice(at, h.start)}</Fragment>);
    out.push(
      <mark key={`m${i}`} className="hit">
        {text.slice(h.start, h.end)}
      </mark>,
    );
    at = h.end;
  });
  if (at < text.length) out.push(<Fragment key="tail">{text.slice(at)}</Fragment>);
  return <>{out}</>;
}
