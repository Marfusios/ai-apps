import { useId, type FormEvent, type KeyboardEvent, type Ref } from 'react';
import { MAX_QUERY_LENGTH } from '../../../shared/contracts/search';
import { cx } from '../lib/cx';
import { AskAiButton } from './AskAiButton';
import { Button } from './Button';

export const QUESTION_PLACEHOLDER = 'What happened, and what did investigators establish?';

export interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  /** Runs the free keyword Search. */
  onSearch: (value: string) => void;
  /** `home`: the large question box. `bar`: Explore's one-line box. */
  variant: 'home' | 'bar';
  inputRef?: Ref<HTMLTextAreaElement & HTMLInputElement>;
  autoFocus?: boolean;
  className?: string;
}

/**
 * The search box with **Search** and **Ask AI** (UI_DESIGN §4.1, §4.2). Enter runs
 * Search, which is free; Ctrl/Cmd+Enter is reserved for Ask AI, so it never runs
 * Search by accident (§3).
 */
export function SearchBox({ value, onChange, onSearch, variant, inputRef, autoFocus, className }: SearchBoxProps) {
  const label = useId();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSearch(value);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) return; // Reserved for Ask AI.
    onSearch(value);
  };
  const field = {
    id: label,
    value,
    maxLength: MAX_QUERY_LENGTH,
    autoFocus,
    placeholder: QUESTION_PLACEHOLDER,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    onKeyDown,
    enterKeyHint: 'search' as const,
    autoComplete: 'off',
    spellCheck: true,
  };
  const actions = (
    <>
      <Button variant="search" type="submit">
        Search
      </Button>
      <AskAiButton />
    </>
  );

  return (
    <form role="search" onSubmit={submit} className={className}>
      <label htmlFor={label} className="sr-only">
        Search NTSB investigations
      </label>
      {variant === 'home' ? (
        <div className="rounded-box border-[1.5px] border-blue bg-raised py-3 pr-3 pb-2.5 pl-4 text-left shadow-ask focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-blue">
          <textarea
            ref={inputRef}
            rows={2}
            {...field}
            className="block min-h-11 w-full resize-none bg-transparent font-serif text-[17px] leading-snug text-ink outline-none placeholder:italic sm:text-question"
          />
          <div className="mt-1.5 flex items-center justify-end gap-2">{actions}</div>
        </div>
      ) : (
        <div
          className={cx(
            'flex items-center gap-2 rounded-[12px] border-[1.5px] border-blue bg-raised py-[7px] pr-2 pl-3.5',
            'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-blue',
          )}
        >
          <input
            ref={inputRef}
            type="search"
            {...field}
            className="min-w-0 flex-1 bg-transparent font-serif text-[16px] text-ink outline-none placeholder:italic [&::-webkit-search-cancel-button]:hidden"
          />
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </div>
      )}
    </form>
  );
}
