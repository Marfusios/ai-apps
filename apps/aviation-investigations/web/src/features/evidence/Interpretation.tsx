import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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
import { StaticScopeReply } from '../ai/StaticScopeReply';
import { exploreHref, withFilter } from '../brief/filters';
import {
  EDIT_HINT,
  EDITED_LABEL,
  EDITED_NOTE,
  EMPTY_WORDS,
  FILTERS_LABEL,
  INTERPRETATION_LABEL,
  KEYWORD_SEARCH,
  NOT_APPLIED_LABEL,
  SEARCH_AGAIN,
  UNCHECKED_LABEL,
  UNDO_CHANGES,
  WORDS_LABEL,
  sameSearch,
  yearsInWords,
} from './display';
import { useEvidenceSearch } from './useEvidenceSearch';

type FacetLists = Partial<Record<BriefFilterFacet, string[]>>;

/** One filter chip of the draft: a facet value, or the years; `ai` while it is the scope stage's own. */
interface DraftChip {
  key: string;
  label: string;
  without: BriefFilters;
  ai: boolean;
}

/** The draft's filters as chips, each knowing whether the AI chose it (magenta) or the reader did (blue). */
export function draftChips(draft: BriefFilters, original: BriefFilters, edited: boolean): DraftChip[] {
  const chips: DraftChip[] = [];
  for (const facet of BRIEF_FILTER_FACETS) {
    const values = (draft as FacetLists)[facet] ?? [];
    for (const value of values) {
      const rest = values.filter((v) => v !== value);
      const without = { ...draft } as FacetLists & BriefFilters;
      if (rest.length > 0) without[facet] = rest;
      else delete without[facet];
      const ai = !edited && ((original as FacetLists)[facet] ?? []).includes(value);
      chips.push({ key: `${facet}:${value}`, label: `${FACET_TITLE[facet]}: ${facetValueLabel(facet, value)}`, without, ai });
    }
  }
  const years = yearsInWords(draft);
  if (years) {
    const { yearFrom: _from, yearTo: _to, ...without } = draft;
    const ai = !edited && original.yearFrom === draft.yearFrom && original.yearTo === draft.yearTo;
    chips.push({ key: 'years', label: years, without, ai });
  }
  return chips;
}

const chipButton = 'touch-target inline-flex cursor-pointer items-center gap-1 rounded-chip border bg-raised px-2 py-0.5 text-meta text-left';
const toneOf = (ai: boolean): string => (ai ? 'border-magenta text-magenta hover:bg-magenta-wash' : 'border-blue text-blue hover:bg-blue-wash');
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

/** The search words: a chip with ✎, or the field that edits them (Enter keeps, Escape cancels). */
function Words({ words, ai, onChange }: { words: string; ai: boolean; onChange: (words: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(words);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (editing) input.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      chip.current?.focus();
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
  if (!editing) {
    return (
      <button
        ref={chip}
        type="button"
        onClick={() => {
          setValue(words);
          setEditing(true);
        }}
        className={cx(chipButton, toneOf(ai), 'max-w-full')}
      >
        <span className="font-serif text-[13.5px] break-words">{words}</span>
        <span aria-hidden="true" className="ml-1">
          ✎
        </span>
        <span className="sr-only">, edit the search words</span>
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

export interface InterpretationProps {
  search: Pick<EvidencePage, 'id' | 'question' | 'interpretation' | 'edited'>;
}

/**
 * The search interpretation (UI_DESIGN §4.9; Astra's conditions 1 and 3): the words and
 * filters the AI read from the question, shown as editable chips (magenta: the AI chose them;
 * blue: the reader did), and beside them the readings AirCase cannot check, each with its
 * fixed label and the question's own words, never applied. Changing chips or words is free
 * until "Search again · uses 1" (an `edited` search); the same words and filters open in
 * Explore as a free keyword search at any time.
 */
export function Interpretation({ search }: InterpretationProps) {
  const original = search.interpretation;
  const [draft, setDraft] = useState({ filters: original.filters, terms: original.terms });
  const [adding, setAdding] = useState(false);
  const evidence = useEvidenceSearch();
  const config = useQuery(configQuery()).data;
  const addButton = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const changed = !sameSearch(draft, original);
  const chips = draftChips(draft.filters, original.filters, search.edited);
  const wordsAi = !search.edited && draft.terms === original.terms;
  const yearBounds: [number, number] = [config?.coverage.yearFrom ?? 1900, config?.coverage.yearTo ?? 2100];
  const run = (): void => void evidence.edit(search.id, search.question, draft.filters, draft.terms);
  const keyword = exploreHref(draft.filters, draft.terms);

  return (
    <section
      aria-labelledby={labelId}
      className={cx('rounded-card border px-3.5 pt-2.5 pb-3 sm:px-4', search.edited ? 'border-hairline bg-raised' : 'border-magenta-soft bg-magenta-wash')}
      data-interpretation=""
    >
      <Placard tone={search.edited ? 'blue' : 'ai'} as="h2" id={labelId}>
        {search.edited ? EDITED_LABEL : INTERPRETATION_LABEL}
      </Placard>
      <dl className="mt-2 space-y-2 text-ui">
        <Row label={WORDS_LABEL}>
          <Words words={draft.terms} ai={wordsAi} onChange={(terms) => setDraft((d) => ({ ...d, terms }))} />
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
                  className={cx(chipButton, 'whitespace-nowrap', toneOf(chip.ai))}
                >
                  {chip.label}
                  <X size={11} strokeWidth={1.5} aria-hidden="true" />
                  <span className="sr-only">, remove</span>
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
        {original.unchecked.length > 0 && (
          <Row label={NOT_APPLIED_LABEL}>
            <ul className="space-y-1" data-unchecked="">
              {original.unchecked.map((u, i) => (
                <li key={`${u.kind}-${i}`} className="text-ui leading-snug">
                  <span className="font-bold">{UNCHECKED_LABEL[u.kind]}</span>:{' '}
                  <span className="font-serif text-[14px] italic">“{u.quote}”</span>
                </li>
              ))}
            </ul>
          </Row>
        )}
      </dl>
      {search.edited && <p className="mt-2 text-meta text-muted">{EDITED_NOTE}</p>}
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
            <AskAiButton label={SEARCH_AGAIN} usesOne phase={evidence.phase} onAsk={run} />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft({ filters: original.filters, terms: original.terms });
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
      <AiNoticeBox notice={evidence.notice} keywordHref={keyword} onRetry={changed ? run : undefined} className="mt-2.5" />
      <div aria-live="polite">{evidence.reply && <StaticScopeReply question={evidence.reply.question} reply={evidence.reply.reply} className="mt-2.5" />}</div>
    </section>
  );
}
