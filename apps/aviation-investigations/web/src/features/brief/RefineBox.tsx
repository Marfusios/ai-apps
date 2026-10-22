import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { QUESTION_MAX_CHARS } from '../../../../shared/contracts/briefs';
import { AiNoticeBox } from '../ai/AiNoticeBox';
import { AskAiButton } from '../ai/AskAiButton';
import { remainingWords } from '../ai/status';
import { exploreHref } from './filters';
import { useRefine } from './useRefine';

export const REFINE_PLACEHOLDER = 'e.g. only aeroplanes, not helicopters';
export const REFINEMENTS_USED = 'This brief has used its three refinements. Start a new search to keep going.';

export interface RefineBoxProps {
  briefId: string;
  refinementsLeft: number;
  /** For "Search by keyword instead" after a failure. */
  question: string;
}

/**
 * REFINE (UI_DESIGN §4.3): a free-text refinement adds a step to the same brief and
 * uses one AI search, which the button says before the click ("Refine · uses 1"); the
 * AI counter and the brief's refinements left sit under it. Like Ask AI it needs a
 * click or Ctrl/Cmd+Enter, never plain Enter. After the third refinement the box is
 * replaced by a line.
 */
export function RefineBox({ briefId, refinementsLeft, question }: RefineBoxProps) {
  const refine = useRefine(briefId);
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  if (refinementsLeft <= 0) {
    return (
      <p className="mt-5 border-t border-dashed border-hairline pt-2.5 text-ui text-muted" data-print="hide">
        {REFINEMENTS_USED}{' '}
        <Link to="/" className="text-blue hover:underline">
          New search
        </Link>
      </p>
    );
  }

  const submit = async (): Promise<void> => {
    const value = text.trim();
    if (!value) {
      input.current?.focus();
      refine.setNotice({ kind: 'empty' });
      return;
    }
    if (await refine.refine({ kind: 'text', text: value })) setText('');
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) void submit();
  };
  const counter = remainingWords(refine.status);

  return (
    <form onSubmit={(e) => e.preventDefault()} className="mt-5" data-print="hide" aria-label="Refine this brief">
      <div className="flex flex-wrap items-center gap-2 rounded-[12px] border-[1.5px] border-blue bg-raised py-2 pr-2 pl-3.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-blue">
        <label htmlFor={id} className="text-label font-bold tracking-caps whitespace-nowrap text-blue uppercase">
          Refine
        </label>
        <input
          ref={input}
          id={id}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={QUESTION_MAX_CHARS}
          placeholder={REFINE_PLACEHOLDER}
          autoComplete="off"
          className="min-h-9 min-w-0 flex-1 basis-40 bg-transparent font-serif text-[15px] text-ink outline-none placeholder:italic"
        />
        <AskAiButton label="Refine" usesOne onAsk={() => void submit()} phase={refine.phase} />
      </div>
      <p className="mt-1 text-meta text-muted">
        {counter && `${counter} · `}
        {refinementsLeft} of 3 refinements left in this brief
      </p>
      {refine.notice && (
        <AiNoticeBox notice={refine.notice} keywordHref={exploreHref({}, question)} onRetry={() => void submit()} className="mt-2.5" />
      )}
    </form>
  );
}
