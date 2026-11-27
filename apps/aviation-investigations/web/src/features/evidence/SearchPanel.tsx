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
  AI_TAG,
  AI_TAG_SPOKEN,
  ALSO_SEARCHED_LABEL,
  APPLY_BOTH,
  APPLY_FILTERS,
  AUTOMATIC_NOTE,
  AUTOMATIC_NOTE_FREE,
  DRAFT_PENDING_NOTE,
  EDIT_HINT,
  EDITED_LABEL,
  EMPTY_WORDS,
  FILTERS_LABEL,
  FREE_COUNTER,
  FROM_QUESTION,
  FROM_QUESTION_SPOKEN,
  KEYWORD_SEARCH,
  KEYWORDS_SEARCHED_LABEL,
  KEYWORDS_SEARCHED_NOTE,
  NOT_SEARCHED_YET,
  OWN_WORDS,
  QUESTION_AS_ASKED,
  SEARCH_AGAIN,
  SEARCH_SUGGESTED_TERMS,
  SEARCHED_LABEL,
  SUGGESTED_FILTERS,
  SUGGESTION_LABEL,
  SUGGESTION_NOTE,
  SUGGESTION_NOTE_AUTOMATIC,
  TERMS_LABEL,
  UNDO_CHANGES,
  UNDO_CHARGED,
  WORDS_LABEL,
  YOUR_SEARCH_LABEL,
  automaticYears,
  isEditedSearch,
  sameSearch,
  suggestionInWords,
  withSuggestedFilters,
  yearsInWords,
  type SearchDraft,
} from './display';
import { SearchWait } from './SearchWait';
import { addedTerms, freeUndoRule, undoWasCharged } from './undo';
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
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- opener is a ref read when editing ends; a new ref must not move focus by itself
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
      <dt className="flex-none text-micro font-bold tracking-caps whitespace-nowrap text-muted uppercase sm:w-36 sm:pt-px">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

/** The small magenta tag of words the AI added: "AI" on screen and on paper, "added by AI" for screen readers. */
function AiTag() {
  return (
    <>
      <span aria-hidden="true" className="rounded-tag border border-magenta-soft px-1 text-micro leading-[1.5] font-bold tracking-caps text-magenta" data-ai-tag="">
        {AI_TAG}
      </span>
      <span className="sr-only">, {AI_TAG_SPOKEN}</span>
    </>
  );
}

export interface SearchPanelProps {
  search: Pick<EvidencePage, 'id' | 'question' | 'query' | 'appliedFilters' | 'automaticFilters' | 'suggestion' | 'freeUndo' | 'undo'>;
}

/** What a control of the panel runs: the reader's draft, or the suggestion's filters, filters and words, or words. */
type Action = 'draft' | 'filters' | 'both' | 'words';

/**
 * What the search ran with, and the AI's suggestion beside it (UI_DESIGN §4.9; contract
 * `evidence.v3`). "Your search" is what retrieval used: the question as asked or the reader's own
 * words, the terms AirCase added to keyword search ("Also searched", or "Keywords searched" when
 * they replaced the question there), each with the AI's tag, and the applied filters, each a chip
 * the reader can remove (blue), a state, years or an aircraft category AirCase applied because the
 * question names it tagged "from your question". Changing them is free until "Search again" (an
 * `edited` search: exactly those filters, words only when they typed them, `keywords: 'question'`
 * when they took the added terms out); it says "· free" when the page says the search's one free
 * undo is there (`undo: 'available'`) and the draft only removes what AirCase added
 * (web/src/features/evidence/undo.ts), else "· uses 1" (also after a free attempt that failed,
 * until the page, read again, says the undo is still there; and right before one is sent the page
 * is read again, "Checking…"). The same words and filters open in Explore as a free keyword search
 * at any time. The suggestion (magenta, dashed, under the
 * contract's "not applied" label) shows what the AI suggests and AirCase did not apply; "Apply these
 * filters" adds them to the search's filters and keeps its words, and only "Apply filters and
 * terms" (or "Search these terms") takes its terms. Each says it uses one AI search.
 */
export function SearchPanel({ search }: SearchPanelProps) {
  const added = addedTerms(search.query);
  const current: SearchDraft = { filters: search.appliedFilters, terms: search.query.source === 'edited' ? search.query.terms : null, addedTerms: added?.terms ?? null };
  const edited = isEditedSearch(search);
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
    // The words' opener is not there while their field is open: "+ Filter" then.
    if (target === 'words') (wordsOpener.current ?? addButton.current)?.focus();
    else if (target === 'filters') addButton.current?.focus();
  }, [draft]);
  const labelId = useId();
  const suggestionId = useId();
  const changed = !sameSearch(draft, current);
  const chips = filterChips(draft.filters);
  // A chip the reader added and has not searched yet looks (and is said) different from an applied one.
  const applied = new Set(filterChips(current.filters).map((c) => `${c.key}=${c.label}`));
  const pending = (chip: { key: string; label: string }): boolean => !applied.has(`${chip.key}=${chip.label}`);
  // What AirCase applied on its own because the question names it: a state, an aircraft category
  // (a chip per value) and the years (one chip, while they are the automatic years).
  const automatic = new Set([
    ...(search.automaticFilters?.state ?? []).map((code) => `state:${code}`),
    ...(search.automaticFilters?.category ?? []).map((code) => `category:${code}`),
    ...(automaticYears(search.appliedFilters, search.automaticFilters) ? ['years'] : []),
  ]);
  const isAutomatic = (chip: { key: string; label: string }): boolean => automatic.has(chip.key) && !pending(chip);
  // The added terms stay in the draft until removed; words of the reader's own replace them.
  const showAdded = added !== null && draft.addedTerms !== null && draft.terms === null;
  // What Search again sends: words only when the reader typed new ones; the question's own keywords once the added terms are out.
  const words = draft.terms !== null && draft.terms !== current.terms ? draft.terms : undefined;
  const keywords = words === undefined && current.addedTerms !== null && draft.addedTerms === null ? ('question' as const) : undefined;
  // A page whose undo hint is known to be out of date offers no free undo (useEvidenceSearch).
  const free = changed && search !== evidence.staleHint && freeUndoRule(search, { filters: draft.filters, terms: words, keywords });
  // The note under filters AirCase applied on its own promises the free undo only while the page
  // says it is there and that is not in doubt, like the button.
  const undoOffered = search.undo === 'available' && search !== evidence.staleHint;
  const suggestion = search.suggestion;
  const suggested = suggestion ? filterChips(suggestion.filters) : [];
  // The block shows only what is still suggested (the server makes a suggestion with nothing left null).
  const suggests = suggestion !== null && (suggested.length > 0 || suggestion.terms !== null);
  const additions = search.automaticFilters !== null || added !== null;
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
      void evidence.edit(search.id, draft.filters, { terms: words, keywords, free });
    } else if (suggestion) {
      // What AirCase applied stays applied: the suggested filters are added to the search's own.
      const filters = action === 'words' ? search.appliedFilters : withSuggestedFilters(search.appliedFilters, suggestion.filters);
      void evidence.edit(search.id, filters, { terms: action === 'filters' ? undefined : (suggestion.terms ?? undefined) });
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
        {undoWasCharged(search.id) && (
          <p className="mt-1 text-meta text-ink" data-undo-charged="" data-print="hide">
            {UNDO_CHARGED}
          </p>
        )}
        <dl className="mt-2 space-y-2 text-ui">
          <Row label={SEARCHED_LABEL}>
            <Words words={draft.terms} pending={draft.terms !== current.terms} opener={wordsOpener} onChange={(terms) => setDraft((d) => ({ ...d, terms }))} />
          </Row>
          {showAdded && (
            <Row label={added.kind === 'terms' ? KEYWORDS_SEARCHED_LABEL : ALSO_SEARCHED_LABEL}>
              <button
                type="button"
                onClick={() => {
                  setDraft((d) => ({ ...d, addedTerms: null }));
                  // The words' opener is not there while their field is open: "+ Filter" then.
                  (wordsOpener.current ?? addButton.current)?.focus();
                }}
                className={cx(chipButton, 'max-w-full flex-wrap border-blue text-blue hover:bg-blue-wash')}
                data-added-terms={added.kind}
              >
                <span className="font-serif text-[13.5px] break-words">“{added.terms}”</span>
                <AiTag />
                <X size={11} strokeWidth={1.5} aria-hidden="true" data-print="hide" />
                <span className="sr-only">, remove</span>
              </button>
              {added.kind === 'terms' && (
                <p className="mt-1 text-meta text-muted" data-keywords-note="">
                  {KEYWORDS_SEARCHED_NOTE}
                </p>
              )}
            </Row>
          )}
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
                    className={cx(chipButton, 'flex-wrap border-blue text-blue hover:bg-blue-wash', pending(chip) && 'border-dashed')}
                    data-pending={pending(chip) || undefined}
                    data-automatic={isAutomatic(chip) || undefined}
                  >
                    <span className="whitespace-nowrap">{chip.label}</span>
                    {isAutomatic(chip) && (
                      <span aria-hidden="true" className="text-micro font-bold tracking-caps whitespace-nowrap text-muted uppercase" data-automatic-tag="">
                        {FROM_QUESTION}
                      </span>
                    )}
                    <X size={11} strokeWidth={1.5} aria-hidden="true" data-print="hide" />
                    <span className="sr-only">
                      {isAutomatic(chip) ? `, ${FROM_QUESTION_SPOKEN}` : ''}
                      {pending(chip) ? `, ${NOT_SEARCHED_YET}` : ''}, remove
                    </span>
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
            {search.automaticFilters !== null && (
              <>
                {/* Fixed words; paper keeps the first sentence only, as it has no controls. */}
                <p className="mt-1 text-meta text-muted" data-automatic-note="" data-print={undoOffered ? 'hide' : undefined}>
                  {undoOffered ? AUTOMATIC_NOTE_FREE : AUTOMATIC_NOTE}
                </p>
                {undoOffered && (
                  <p className="mt-1 text-meta text-muted" data-automatic-note-print="" data-print="only">
                    {AUTOMATIC_NOTE}
                  </p>
                )}
              </>
            )}
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
              <AskAiButton label={SEARCH_AGAIN} usesOne={!free} free={free} {...control('draft')} />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  refocus.current = draft.terms !== current.terms || draft.addedTerms !== current.addedTerms ? 'words' : 'filters';
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

      {suggestion && suggests && (
        <section
          aria-labelledby={suggestionId}
          className="mt-3 rounded-card border border-dashed border-magenta-soft bg-magenta-wash px-3.5 pt-2.5 pb-3 sm:px-4"
          data-suggestion=""
          data-print="hide"
        >
          <Placard tone="ai" as="h2" id={suggestionId}>
            {SUGGESTION_LABEL}
          </Placard>
          <p className="mt-1.5 text-meta text-muted" data-suggestion-note="">
            {additions ? SUGGESTION_NOTE_AUTOMATIC : SUGGESTION_NOTE}
          </p>
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
            {suggestion.terms !== null && (
              <Row label={TERMS_LABEL}>
                <span className="font-serif text-[14.5px] break-words text-ink">“{suggestion.terms}”</span>
              </Row>
            )}
          </dl>
          {changed && (
            <p className="mt-2 text-meta text-ink" data-draft-pending="">
              {DRAFT_PENDING_NOTE}
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {suggested.length > 0 && <AskAiButton look="chip" label={APPLY_FILTERS} usesOne {...suggestionControl('filters')} />}
            {suggested.length > 0 && suggestion.terms !== null && <AskAiButton look="chip" label={APPLY_BOTH} usesOne {...suggestionControl('both')} />}
            {suggested.length === 0 && suggestion.terms !== null && <AskAiButton look="chip" label={SEARCH_SUGGESTED_TERMS} usesOne {...suggestionControl('words')} />}
          </div>
        </section>
      )}
      {suggestion && suggests && (
        // Print keeps the suggestion as one line under its label, so "Suggested terms in these excerpts" reads on paper too.
        <p data-print="only" className="mt-2 text-meta text-ink" data-suggestion-print="">
          {suggestionInWords(suggestion)}
        </p>
      )}
      <SearchWait pending={evidence.pending} className="mt-2.5" />
      <AiNoticeBox
        notice={evidence.notice}
        keywordHref={keyword}
        onRetry={acting && allowed(acting) ? () => act(acting) : undefined}
        retryCounter={acting === 'draft' && free ? FREE_COUNTER : 'uses 1'}
        className="mt-2.5"
      />
    </>
  );
}
