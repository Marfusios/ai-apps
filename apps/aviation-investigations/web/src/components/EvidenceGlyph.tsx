import { cx } from '../lib/cx';

export type EvidenceKind = 'causal' | 'defect_not_causal' | 'no_fault' | 'insufficient';

/** UI_DESIGN §2.4. The words always accompany the glyph. */
export const EVIDENCE_WORDS: Readonly<Record<EvidenceKind, string>> = {
  causal: 'Causal fault established',
  defect_not_causal: 'Defect found, causal link not established',
  no_fault: 'No fault identified',
  insufficient: 'Insufficient evidence',
};

/** Display order for evidence groups (UI_DESIGN §4.3). */
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ['causal', 'defect_not_causal', 'no_fault', 'insufficient'];

const SIZE = 11;
const STROKE = 1.6;
const C = SIZE / 2;
const R = (SIZE - STROKE) / 2;

/**
 * The 11px circle with a 1.6px stroke, drawn in magenta because the
 * classification is AI-derived. Decorative: the words carry the meaning.
 */
export function GlyphMark({ kind, className }: { kind: EvidenceKind; className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      width={SIZE}
      height={SIZE}
      aria-hidden="true"
      focusable="false"
      className={cx('shrink-0 overflow-visible', className)}
      data-glyph={kind}
    >
      <circle
        cx={C}
        cy={C}
        r={R}
        strokeWidth={STROKE}
        strokeDasharray={kind === 'insufficient' ? '2.1 1.6' : undefined}
        className={cx('stroke-magenta', kind === 'causal' ? 'fill-magenta' : 'fill-none')}
      />
      {kind === 'defect_not_causal' && (
        <path d={`M${C} ${C - R}A${R} ${R} 0 0 0 ${C} ${C + R}Z`} className="fill-magenta" />
      )}
    </svg>
  );
}

export interface EvidenceGlyphProps {
  kind: EvidenceKind;
  /**
   * `inline` (default): glyph and words, for group headings and lists.
   * `pill`: the verdict pill, "● Causal fault established · AI CLASSIFIED" (§2.4).
   */
  variant?: 'inline' | 'pill';
  className?: string;
}

export function EvidenceGlyph({ kind, variant = 'inline', className }: EvidenceGlyphProps) {
  const words = EVIDENCE_WORDS[kind];
  if (variant === 'pill') {
    return (
      <span
        className={cx(
          'inline-flex items-center gap-[7px] rounded-full border border-magenta-soft py-1 pr-[11px] pl-[9px]',
          'text-ui font-bold text-magenta',
          className,
        )}
      >
        <GlyphMark kind={kind} />
        <span>{words}</span>
        <span className="font-normal">{' · '}</span>
        <span className="text-micro font-normal tracking-caps uppercase">AI classified</span>
      </span>
    );
  }
  return (
    <span className={cx('inline-flex items-center gap-[7px]', className)}>
      <GlyphMark kind={kind} />
      <span>{words}</span>
    </span>
  );
}
