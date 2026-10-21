import { COMPLETION_BADGE, type CompletionClass } from '../../../shared/completion.js';
import { cx } from '../lib/cx';

export type StatusKind = CompletionClass | 'not_completed';

/** Badge text. The four completion classes use the shared copy (UI_DESIGN §4.2). */
export const STATUS_BADGE: Readonly<Record<StatusKind, string>> = {
  ...COMPLETION_BADGE,
  not_completed: 'NOT COMPLETED',
};

export interface StatusBadgeProps {
  kind: StatusKind;
  /**
   * The raw `rec_stat` code. Every badge other than COMPLETED shows it on a muted
   * line ("NTSB status: P"); codes are never interpreted beyond the mapping.
   */
  rawStatus?: string | null;
  className?: string;
}

/** Completion status: small bold caps in a 1px ink outline (UI_DESIGN §2.5). */
export function StatusBadge({ kind, rawStatus, className }: StatusBadgeProps) {
  const showRaw = kind !== 'completed' && rawStatus !== undefined;
  const raw = (rawStatus ?? '').trim();
  return (
    <span className={cx('inline-flex flex-wrap items-baseline gap-x-2', className)}>
      <span className="rounded-badge border border-ink px-[5px] py-px text-micro font-bold tracking-caps whitespace-nowrap text-ink">
        {STATUS_BADGE[kind]}
      </span>
      {showRaw && (
        <span className="text-meta text-muted">
          NTSB status: {raw === '' ? 'blank' : <span className="font-mono">{raw}</span>}
        </span>
      )}
    </span>
  );
}
