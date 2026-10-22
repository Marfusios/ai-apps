import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  BRIEF_FILTER_FACETS,
  FAILURE_TYPES,
  FAILURE_TYPE_LABELS,
  type BriefFilterFacet,
  type BriefFilters,
  type FailureType,
  type InterpretationChip,
  type RefinementChange,
} from '../../../../shared/contracts/briefs';
import { FACET_TITLE, FACET_VALUES, facetValueLabel } from '../../../../shared/contracts/search';
import { configQuery } from '../../api';
import { AiChip } from '../../components/AiChip';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { AiNoticeBox } from '../ai/AiNoticeBox';
import { AskAiButton } from '../ai/AskAiButton';
import { exploreHref, filterChips, withFilter } from './filters';
import { useRefine } from './useRefine';

type Editing =
  | { kind: 'interpretation'; chip: InterpretationChip }
  | { kind: 'remove'; label: string; without: BriefFilters }
  | { kind: 'add' }
  | null;

const field = 'mt-1 block w-full rounded-chip border border-hairline bg-raised px-2 py-1 text-ui text-ink pointer-coarse:min-h-11';

/** A small editor under the chips: it takes focus when it opens and gives it back to its chip when it closes. */
function Editor({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus();
    return () => {
      if (opener?.isConnected && (document.activeElement === document.body || document.activeElement === null)) opener.focus();
    };
  }, []);
  return (
    <div
      ref={box}
      tabIndex={-1}
      role="group"
      aria-label={title}
      data-print="hide"
      className="card mt-2 px-3.5 py-3 outline-none focus-visible:outline-2"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <p className="text-micro font-bold tracking-caps text-muted uppercase">{title}</p>
      {children}
    </div>
  );
}

function InterpretationEditor({ chip, onRun, phase, onClose }: { chip: InterpretationChip; onRun: (c: RefinementChange) => void; phase: ReturnType<typeof useRefine>['phase']; onClose: () => void }) {
  const [days, setDays] = useState(chip.field === 'timing_window' && chip.value.days !== null ? String(chip.value.days) : '');
  const [hours, setHours] = useState(chip.field === 'timing_window' && chip.value.flightHours !== null ? String(chip.value.flightHours) : '');
  const [firstOnly, setFirstOnly] = useState(chip.field === 'first_flight_only' ? chip.value : true);
  const [failure, setFailure] = useState<FailureType>(chip.field === 'failure_type' ? chip.value : 'total_power_loss');
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  const change = (): RefinementChange | null => {
    if (chip.field === 'first_flight_only') return { kind: 'interpretation', field: 'first_flight_only', value: firstOnly };
    if (chip.field === 'failure_type') return { kind: 'interpretation', field: 'failure_type', value: failure };
    const d = days.trim() === '' ? null : Number(days);
    const h = hours.trim() === '' ? null : Number(hours);
    const okDays = d === null || (Number.isInteger(d) && d >= 1 && d <= 365);
    const okHours = h === null || (Number.isInteger(h) && h >= 1 && h <= 500);
    if (!okDays || !okHours || (d === null && h === null)) return null;
    return { kind: 'interpretation', field: 'timing_window', value: { days: d, flightHours: h } };
  };

  return (
    <Editor title="Change the AI's reading" onClose={onClose}>
      {chip.field === 'timing_window' && (
        <div className="mt-1.5 flex flex-wrap gap-3 text-ui">
          <label htmlFor={`${ids}-d`} className="w-32">
            Calendar days
            <input id={`${ids}-d`} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} className={field} placeholder="e.g. 30" />
          </label>
          <label htmlFor={`${ids}-h`} className="w-32">
            Flight hours
            <input id={`${ids}-h`} inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} className={field} placeholder="e.g. 10" />
          </label>
          <p className="basis-full text-meta text-muted">Whole numbers: days 1–365, flight hours 1–500. Either one, or both (within either).</p>
        </div>
      )}
      {chip.field === 'first_flight_only' && (
        <label className="mt-1.5 flex items-center gap-2 text-ui">
          <input type="checkbox" className="check" checked={firstOnly} onChange={(e) => setFirstOnly(e.target.checked)} />
          First flight after maintenance only
        </label>
      )}
      {chip.field === 'failure_type' && (
        <label htmlFor={`${ids}-f`} className="mt-1.5 block max-w-64 text-ui">
          Failure
          <select id={`${ids}-f`} value={failure} onChange={(e) => setFailure(e.target.value as FailureType)} className={field}>
            {FAILURE_TYPES.map((f) => (
              <option key={f} value={f}>
                {FAILURE_TYPE_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-meta text-ink">
          {error}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <AskAiButton
          label="Re-run AI"
          usesOne
          phase={phase}
          onAsk={() => {
            const c = change();
            if (!c) {
              setError('Enter days, flight hours or both, as whole numbers in range.');
              return;
            }
            setError(null);
            onRun(c);
          }}
        />
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Editor>
  );
}

function FilterOffer({ title, filters, onRun, phase, onClose, children }: { title: string; filters: BriefFilters | null; onRun: (f: BriefFilters) => void; phase: ReturnType<typeof useRefine>['phase']; onClose: () => void; children?: ReactNode }) {
  return (
    <Editor title={title} onClose={onClose}>
      {children}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <AskAiButton label="Re-run AI" usesOne phase={phase} onAsk={() => filters && onRun(filters)} />
        {filters && (
          <Link
            to={exploreHref(filters)}
            className="inline-flex items-center rounded-full border-[1.5px] border-blue px-3.5 py-[5px] text-ui font-bold text-blue hover:bg-blue-wash pointer-coarse:min-h-11"
          >
            Show keyword results<span className="sr-only"> (free)</span>
          </Link>
        )}
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Editor>
  );
}

function AddFilter({ filters, onRun, phase, onClose }: { filters: BriefFilters; onRun: (f: BriefFilters) => void; phase: ReturnType<typeof useRefine>['phase']; onClose: () => void }) {
  const [facet, setFacet] = useState<BriefFilterFacet>('phase');
  const values = (FACET_VALUES[facet] as readonly string[]).filter((v) => v !== 'blank');
  const [value, setValue] = useState<string>(values[0] ?? '');
  const ids = useId();
  const next = value ? withFilter(filters, facet, value) : null;
  return (
    <FilterOffer title="Add a filter" filters={next} onRun={onRun} phase={phase} onClose={onClose}>
      <div className="mt-1.5 flex flex-wrap gap-3 text-ui">
        <label htmlFor={`${ids}-f`} className="w-40">
          Filter
          <select
            id={`${ids}-f`}
            value={facet}
            onChange={(e) => {
              const f = e.target.value as BriefFilterFacet;
              setFacet(f);
              setValue((FACET_VALUES[f] as readonly string[]).find((v) => v !== 'blank') ?? '');
            }}
            className={field}
          >
            {BRIEF_FILTER_FACETS.map((f) => (
              <option key={f} value={f}>
                {FACET_TITLE[f]}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${ids}-v`} className="min-w-40 flex-1">
          Value
          <select id={`${ids}-v`} value={value} onChange={(e) => setValue(e.target.value)} className={field}>
            {values.map((v) => (
              <option key={v} value={v}>
                {facetValueLabel(facet, v)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </FilterOffer>
  );
}

export interface BriefChipsProps {
  briefId: string;
  interpretations: readonly InterpretationChip[];
  filters: BriefFilters;
  /** False on an earlier step or when the brief has no refinements left: chips are read-only. */
  editable: boolean;
}

/**
 * The chip row under the question (UI_DESIGN §4.3): magenta, editable interpretation
 * chips (the AI's reading), blue chips for the cohort and filters, and "+ Filter".
 * Editing a reading or changing filters is a refinement and says "· uses 1"; "Show
 * keyword results" opens Explore with the filters for free.
 */
export function BriefChips({ briefId, interpretations, filters, editable }: BriefChipsProps) {
  const config = useQuery(configQuery()).data;
  const refine = useRefine(briefId);
  const [editing, setEditing] = useState<Editing>(null);
  const close = (): void => setEditing(null);
  const run = (change: RefinementChange): void => {
    void refine.refine(change).then((ok) => ok && close());
  };
  const runFilters = (f: BriefFilters): void => run({ kind: 'filters', filters: f });
  const from = filters.yearFrom ?? config?.coverage.yearFrom;
  const to = filters.yearTo ?? config?.coverage.yearTo;
  const hasYears = filters.yearFrom !== undefined || filters.yearTo !== undefined;
  const { yearFrom: _f, yearTo: _t, ...withoutYears } = filters;

  const removable = (label: string, without: BriefFilters) =>
    editable ? (
      <button
        type="button"
        onClick={() => setEditing({ kind: 'remove', label, without })}
        className="touch-target inline-flex cursor-pointer items-center gap-1 rounded-chip border border-blue bg-raised px-2 py-0.5 text-meta whitespace-nowrap text-blue hover:bg-blue-wash"
      >
        {label}
        <X size={11} strokeWidth={1.5} aria-hidden="true" />
        <span className="sr-only">, remove</span>
      </button>
    ) : (
      <Chip>{label}</Chip>
    );

  return (
    <div className="mb-3.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {interpretations.map((chip) => (
          <AiChip
            key={chip.field}
            label={chip.pinned ? 'AI · your pick' : 'AI reading'}
            onEdit={editable ? () => setEditing({ kind: 'interpretation', chip }) : undefined}
          >
            {chip.label}
          </AiChip>
        ))}
        <Chip>Completed investigations</Chip>
        {hasYears ? removable(`United States · ${from ?? '…'}–${to ?? '…'}`, withoutYears) : <Chip>{`United States · ${from ?? '…'}–${to ?? '…'}`}</Chip>}
        {filterChips(filters).map((c) => (
          <span key={c.key}>{removable(c.label, c.without)}</span>
        ))}
        {editable && (
          <Chip variant="add" onClick={() => setEditing({ kind: 'add' })}>
            + Filter
          </Chip>
        )}
      </div>
      {editing?.kind === 'interpretation' && <InterpretationEditor chip={editing.chip} onRun={run} phase={refine.phase} onClose={close} />}
      {editing?.kind === 'remove' && (
        <FilterOffer title={`Without ${editing.label}`} filters={editing.without} onRun={runFilters} phase={refine.phase} onClose={close} />
      )}
      {editing?.kind === 'add' && <AddFilter filters={filters} onRun={runFilters} phase={refine.phase} onClose={close} />}
      <AiNoticeBox notice={refine.notice} keywordHref={exploreHref(filters)} className="mt-2.5" />
    </div>
  );
}
