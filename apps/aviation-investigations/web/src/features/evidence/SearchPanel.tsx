import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router';
import { BRIEF_FILTER_FACETS, type BriefFilterFacet, type BriefFilters } from '../../../../shared/contracts/briefs';
import { MAX_TERMS_CHARS, type EvidencePage } from '../../../../shared/contracts/evidence';
import { FACET_TITLE, FACET_VALUES, facetValueLabel } from '../../../../shared/contracts/search';
import { configQuery } from '../../api';
import { Button } from '../../components/Button';
import { Placard } from '../../components/Placard';
import { cx } from '../../lib/cx';
import { AiNoticeBox } from '../ai/AiNoticeBox';
import { AskAiButton } from '../ai/AskAiButton';
import { exploreHref, withFilter } from '../brief/filters';
import {
  APPLY_BOTH,
  APPLY_FILTERS,
  DRAFT_PENDING_NOTE,
  EDIT_HINT,
  EDITED_LABEL,
  EMPTY_WORDS,
  FILTERS_LABEL,
  KEYWORD_SEARCH,
  NOT_SEARCHED_YET,
  OWN_WORDS,
  QUESTION_AS_ASKED,
  SEARCH_AGAIN,
  SEARCH_SUGGESTED_TERMS,
  SEARCHED_LABEL,
  SUGGESTED_FILTERS,
  SUGGESTION_LABEL,
  SUGGESTION_NOTE,
  TERMS_LABEL,
  UNDO_CHANGES,
  WORDS_LABEL,
  YOUR_SEARCH_LABEL,
  sameSearch,
  suggestionInWords,
  yearsInWords,
  type SearchDraft,
} from './display';
import { useEvidenceSearch } from './useEvidenceSearch';

type FacetLists = Partial<Record<BriefFilterFacet, string[]>>;

/** One filter as a chip: its label, and the filters without it. */
interface FilterChip {
  key: string;
  label: string;
  without: BriefFilters;
}

/** Filters as chips, facet values in the contract's order, years last ("Phase: Approach"). */
export function filterChips(filters: BriefFilters): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const facet of BRIEF_FILTER_FACETS) {
    const values = (filters as FacetLists)[facet] ?? [];
    for (const value of values) {
      const rest = values.filter((v) => v !== value);
      const without = { ...filters } as FacetLists & BriefFilters;
      if (rest.length > 0) without[facet] = rest;
      else delete without[facet];
      chips.push({ key: `${facet}:${value}`, label: `${FACET_TITLE[facet]}: ${facetValueLabel(facet, value)}`, without });
    }
  }
  const years = yearsInWords(filters);
  if (years) {
    const { yearFrom: _from, yearTo: _to, ...without } = filters;
    chips.push({ key: 'years', label: years, without });
  }
  return chips;
}

const chipButton = 'touch-target inline-flex cursor-pointer items-center gap-1 rounded-chip border bg-raised px-2 py-0.5 text-meta text-left';
const field = 'mt-1 block w-full rounded-chip border border-hairline bg-raised px-2 py-1 text-ui text-ink pointer-coarse:min-h-11';

/** "+ Filter": a facet and value, or a year range, added to the draft (free until Search again). */
function AddFilter({ onAdd, onClose, yearBounds }: { onAdd: (change: (f: BriefFilters) => BriefFilters) => void; onClose: () => void; yearBounds: [number, number] }) {
  const [facet, setFacet] = useState<BriefFilterFacet | 'years'>('phase');
  const values = facet === 'years' ? [] : (FACET_VALUES[facet] as readonly string[]).filter((v) => v !== 'blank');
  const [value, setValue] = useState<string>(values[0] ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  const add = (): void => {
    if (facet !== 'years') {
      if (value) onAdd((f) => withFilter(f, facet, value));
      return;
    }
    const year = (s: string): number | undefined => (s.trim() === '' ? undefined : Number(s));
    const [a, b] = [year(from), year(to)];
    const ok = (y: number | undefined): boolean => y === undefined || (Number.isInteger(y) && y >= yearBounds[0] && y <= yearBounds[1]);
    if ((a === undefined && b === undefined) || !ok(a) || !ok(b) || (a !== undefined && b !== undefined && a > b)) {
      setError(`Enter a year from ${yearBounds[0]} to ${yearBounds[1]}, or both in order.`);
      return;
    }
    onAdd((f) => ({ ...f, ...(a !== undefined ? { yearFrom: a } : {}), ...(b !== undefined ? { yearTo: b } : {}) }));
  };
  return (
    <div
      ref={box}
      tabIndex={-1}
      role="group"
      aria-label="Add a filter"
      data-print="hide"
      className="card mt-2 px-3.5 py-3 outline-none focus-visible:outline-2"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <p className="text-micro font-bold tracking-caps text-muted uppercase">Add a filter</p>
      <div className="mt-1.5 flex flex-wrap gap-3 text-ui">
        <label htmlFor={`${ids}-f`} className="w-40">
          Filter
          <select
            id={`${ids}-f`}
            value={facet}
            onChange={(e) => {
              const f = e.target.value as BriefFilterFacet | 'years';
              setFacet(f);
              setError(null);
              setValue(f === 'years' ? '' : ((FACET_VALUES[f] as readonly string[]).find((v) => v !== 'blank') ?? ''));
            }}
            className={field}
          >
            {BRIEF_FILTER_FACETS.map((f) => (
              <option key={f} value={f}>
                {FACET_TITLE[f]}
              </option>
            ))}
            <option value="years">Years</option>
          </select>
        </label>
        {facet === 'years' ? (
          <>
            <label htmlFor={`${ids}-from`} className="w-28">
              From
              <input id={`${ids}-from`} inputMode="numeric" value={from} onChange={(e) => setFrom(e.target.value)} placeholder={String(yearBounds[0])} className={field} />
            </label>
            <label htmlFor={`${ids}-to`} className="w-28">
              To
              <input id={`${ids}-to`} inputMode="numeric" value={to} onChange={(e) => setTo(e.target.value)} placeholder={String(yearBounds[1])} className={field} />
            </label>
          </>
        ) : (
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
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-meta text-ink">
          {error}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button variant="search" size="sm" onClick={add}>
          Add
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * The words the search ran with: "Your question, as asked" with "Use your own words", or the
 * reader's words as a chip with ✎; either opens the field that edits them (Enter keeps, Escape
 * cancels). The draft is free until Search again.
 */
function Words({
  words,
  pending,
  opener,
  onChange,
}: {
  words: string | null;
  /** Typed, not searched yet: dashed, and said so. */
  pending: boolean;
  /** The control that opens the field ("Use your own words" or the chip), for focus from outside. */
  opener: RefObject<HTMLButtonElement | null>;
  onChange: (words: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(words ?? '');
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (editing) input.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      opener.current?.focus();
    }
  }, [editing]);
  const close = (): void => {
    returnFocus.current = true;
    setError(null);
    setEditing(false);
  };
  const keep = (): void => {
    const next = value.trim().replace(/\s+/g, ' ');
    if (next === '') {
      setError(EMPTY_WORDS);
      input.current?.focus();
      return;
    }
    onChange(next);
    close();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      keep();
    }
  };
  const open = (): void => {
    setValue(words ?? '');
    setEditing(true);
  };
  if (!editing && words === null) {
    return (
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-ui text-ink">{QUESTION_AS_ASKED}</span>
        <button ref={opener} type="button" onClick={open} className="cursor-pointer text-meta text-blue hover:underline pointer-coarse:min-h-11" data-print="hide">
          <span aria-hidden="true">✎ </span>
          {OWN_WORDS}
        </button>
      </span>
    );
  }
  if (!editing) {
    return (
      <button ref={opener} type="button" onClick={open} className={cx(chipButton, 'max-w-full border-blue text-blue hover:bg-blue-wash', pending && 'border-dashed')} data-pending={pending || undefined}>
        <span className="font-serif text-[13.5px] break-words">{words}</span>
        <span aria-hidden="true" className="ml-1">
          ✎
        </span>
        <span className="sr-only">{pending ? `, ${NOT_SEARCHED_YET}` : ''}, edit the search words</span>
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2" data-print="hide">
      <label htmlFor={id} className="sr-only">
        {WORDS_LABEL}
      </label>
      <input
        ref={input}
        id={id}
        value={value}
        maxLength={MAX_TERMS_CHARS}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck
        className="min-h-8 min-w-0 flex-1 basis-56 rounded-chip border-[1.5px] border-blue bg-raised px-2 py-0.5 font-serif text-[15px] text-ink outline-none focus-visible:outline-2 pointer-coarse:min-h-11"
      />
      <Button variant="search" size="sm" onClick={keep}>
        Done
      </Button>
      <Button variant="ghost" size="sm" onClick={close}>
        Cancel
      </Button>
      {error && (
        <span role="alert" className="basis-full text-meta text-ink">
          {error}
        </span>
      )}
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
      <dt className="flex-none text-micro font-bold tracking-caps whitespace-nowrap text-muted uppercase sm:w-28 sm:pt-px">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

export interface SearchPanelProps {
  search: Pick<EvidencePage, 'id' | 'question' | 'query' | 'appliedFilters' | 'suggestion'>;
}

/** What a control of the panel runs: the reader's draft, or the suggestion's filters, filters and words, or words. */
type Action = 'draft' | 'filters' | 'both' | 'words';

/**
 * What the search ran with, and the AI's suggestion beside it (UI_DESIGN §4.9; contract
 * `evidence.v2`, the advisory-only design). "Your search" is the reader's: the question as asked
 * or their own words, and the filters they applied, each a chip they can remove (blue). Changing
 * them is free until "Search again · uses 1" (an `edited` search: exactly those filters, and words
 * only when they typed them); the same words and filters open in Explore as a free keyword search at
 * any time. The suggestion (magenta, dashed, under the contract's "not applied" label) shows the
 * filters and terms the AI suggests; "Apply these filters" makes an edited search with exactly
 * those filters and the question as asked, and only "Apply filters and terms" (or "Search these
 * terms") takes its terms. Each says it uses one AI search.
 */
export function SearchPanel({ search }: SearchPanelProps) {
  const current: SearchDraft = { filters: search.appliedFilters, terms: search.query.source === 'edited' ? search.query.terms : null };
  const edited = current.terms !== null || filterChips(current.filters).length > 0;
  const [draft, setDraft] = useState<SearchDraft>(current);
  const [adding, setAdding] = useState(false);
  const [acting, setActing] = useState<Action | null>(null);
  const evidence = useEvidenceSearch();
  const config = useQuery(configQuery()).data;
  const addButton = useRef<HTMLButtonElement>(null);
  const wordsOpener = useRef<HTMLButtonElement>(null);
  // After Undo changes (whose button goes with the changes), focus goes back to what changed.
  const refocus = useRef<'words' | 'filters' | null>(null);
  useEffect(() => {
    const target = refocus.current;
    refocus.current = null;
    if (target === 'words') wordsOpener.current?.focus();
    else if (target === 'filters') addButton.current?.focus();
  }, [draft]);
  const labelId = useId();
  const suggestionId = useId();
  const changed = !sameSearch(draft, current);
  const chips = filterChips(draft.filters);
  // A chip the reader added and has not searched yet looks (and is said) different from an applied one.
  const applied = new Set(filterChips(current.filters).map((c) => `${c.key}=${c.label}`));
  const pending = (chip: { key: string; label: string }): boolean => !applied.has(`${chip.key}=${chip.label}`);
  const suggestion = search.suggestion;
  const suggested = suggestion ? filterChips(suggestion.filters) : [];
  const yearBounds: [number, number] = [config?.coverage.yearFrom ?? 1900, config?.coverage.yearTo ?? 2100];
  const keyword = exploreHref(draft.filters, draft.terms ?? search.question);
  const busy = evidence.phase !== 'idle';
  // The suggestion is applied to the search as it is, never over changes not searched yet: this
  // holds for every way in (its buttons, and Try again after a failed Apply).
  const allowed = (action: Action): boolean => action === 'draft' || !changed;
  const act = (action: Action): void => {
    if (!allowed(action)) return;
    setActing(action);
    if (action === 'draft') {
      // Words go only when the reader typed new ones; without, the search keeps its query.
      const words = draft.terms !== null && draft.terms !== current.terms ? draft.terms : undefined;
      void evidence.edit(search.id, draft.filters, words);
    } else if (suggestion) {
      const filters = action === 'words' ? search.appliedFilters : suggestion.filters;
      void evidence.edit(search.id, filters, action === 'filters' ? undefined : suggestion.terms);
    }
  };
  const control = (action: Action) => ({ phase: acting === action ? evidence.phase : 'idle', disabled: busy && acting !== action, onAsk: () => act(action) }) as const;
  const suggestionControl = (action: Action) => {
    const c = control(action);
    return { ...c, disabled: c.disabled || !allowed(action) } as const;
  };

  return (
    <>
      <section aria-labelledby={labelId} className="rounded-card border border-hairline bg-raised px-3.5 pt-2.5 pb-3 sm:px-4" data-search-panel="">
        <Placard tone="blue" as="h2" id={labelId}>
          {edited ? EDITED_LABEL : YOUR_SEARCH_LABEL}
        </Placard>
        <dl className="mt-2 space-y-2 text-ui">
          <Row label={SEARCHED_LABEL}>
            <Words words={draft.terms} pending={draft.terms !== current.terms} opener={wordsOpener} onChange={(terms) => setDraft((d) => ({ ...d, terms }))} />
          </Row>
          <Row label={FILTERS_LABEL}>
            <ul className="flex flex-wrap items-center gap-1.5" aria-label={FILTERS_LABEL}>
              <li>
                {/* The cohort every AI search reads: context, not a control. */}
                <span className="inline-flex items-center rounded-chip border border-hairline px-2 py-0.5 text-meta whitespace-nowrap text-muted">Completed US investigations</span>
              </li>
              {chips.map((chip) => (
                <li key={chip.key}>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft((d) => ({ ...d, filters: chip.without }));
                      addButton.current?.focus();
                    }}
                    className={cx(chipButton, 'border-blue whitespace-nowrap text-blue hover:bg-blue-wash', pending(chip) && 'border-dashed')}
                    data-pending={pending(chip) || undefined}
                  >
                    {chip.label}
                    <X size={11} strokeWidth={1.5} aria-hidden="true" />
                    <span className="sr-only">{pending(chip) ? `, ${NOT_SEARCHED_YET}` : ''}, remove</span>
                  </button>
                </li>
              ))}
              <li data-print="hide">
                <button
                  ref={addButton}
                  type="button"
                  aria-expanded={adding}
                  onClick={() => setAdding(!adding)}
                  className="touch-target inline-flex cursor-pointer items-center rounded-chip border border-dashed border-blue px-2 py-0.5 text-meta whitespace-nowrap text-blue hover:bg-blue-wash"
                >
                  + Filter
                </button>
              </li>
            </ul>
          </Row>
        </dl>
        {adding && (
          <AddFilter
            yearBounds={yearBounds}
            onClose={() => {
              setAdding(false);
              addButton.current?.focus();
            }}
            onAdd={(change) => {
              setDraft((d) => ({ ...d, filters: change(d.filters) }));
              setAdding(false);
              addButton.current?.focus();
            }}
          />
        )}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2" data-print="hide">
          {changed ? (
            <>
              <AskAiButton label={SEARCH_AGAIN} usesOne {...control('draft')} />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  refocus.current = draft.terms !== current.terms ? 'words' : 'filters';
                  setDraft(current);
                  setAdding(false);
                }}
              >
                {UNDO_CHANGES}
              </Button>
            </>
          ) : (
            <span className="text-meta text-muted">{EDIT_HINT}</span>
          )}
          <Link
            to={keyword}
            className="inline-flex items-center rounded-full border-[1.5px] border-blue px-[11px] py-[3px] text-meta text-blue hover:bg-blue-wash pointer-coarse:min-h-11"
          >
            {KEYWORD_SEARCH}
            <span className="sr-only"> with these words and filters (free)</span>
          </Link>
        </div>
      </section>

      {suggestion && (
        <section
          aria-labelledby={suggestionId}
          className="mt-3 rounded-card border border-dashed border-magenta-soft bg-magenta-wash px-3.5 pt-2.5 pb-3 sm:px-4"
          data-suggestion=""
          data-print="hide"
        >
          <Placard tone="ai" as="h2" id={suggestionId}>
            {SUGGESTION_LABEL}
          </Placard>
          <p className="mt-1.5 text-meta text-muted">{SUGGESTION_NOTE}</p>
          <dl className="mt-2 space-y-2 text-ui">
            <Row label={FILTERS_LABEL}>
              {suggested.length > 0 ? (
                <ul className="flex flex-wrap items-center gap-1.5" aria-label={SUGGESTED_FILTERS}>
                  {suggested.map((chip) => (
                    <li key={chip.key}>
                      <span className="inline-flex items-center rounded-chip border border-dashed border-magenta px-2 py-0.5 text-meta whitespace-nowrap text-magenta">{chip.label}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-meta text-muted">None</span>
              )}
            </Row>
            <Row label={TERMS_LABEL}>
              <span className="font-serif text-[14.5px] break-words text-ink">“{suggestion.terms}”</span>
            </Row>
          </dl>
          {changed && (
            <p className="mt-2 text-meta text-ink" data-draft-pending="">
              {DRAFT_PENDING_NOTE}
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {suggested.length > 0 ? (
              <>
                <AskAiButton look="chip" label={APPLY_FILTERS} usesOne {...suggestionControl('filters')} />
                <AskAiButton look="chip" label={APPLY_BOTH} usesOne {...suggestionControl('both')} />
              </>
            ) : (
              <AskAiButton look="chip" label={SEARCH_SUGGESTED_TERMS} usesOne {...suggestionControl('words')} />
            )}
          </div>
        </section>
      )}
      {suggestion && (
        // Print keeps the suggestion as one line under its label, so "Suggested terms in these excerpts" reads on paper too.
        <p data-print="only" className="mt-2 text-meta text-ink" data-suggestion-print="">
          {suggestionInWords(suggestion)}
        </p>
      )}
      <AiNoticeBox notice={evidence.notice} keywordHref={keyword} onRetry={acting && allowed(acting) ? () => act(acting) : undefined} className="mt-2.5" />
    </>
  );
}
