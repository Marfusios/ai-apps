import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { HOME_EXAMPLES } from '../../../shared/examples';
import { pageTitle } from '../../../shared/page-titles';
import { configQuery } from '../api';
import { Chip } from '../components/Chip';
import { CompassMark } from '../components/CompassMark';
import { SearchBox } from '../components/SearchBox';
import { AiNoticeBox } from '../features/ai/AiNoticeBox';
import { SearchWait } from '../features/evidence/SearchWait';
import { useEvidenceSearch } from '../features/evidence/useEvidenceSearch';
import { formatChartDate, formatCount } from '../lib/format';

/**
 * Home, "Clear sky" (UI_DESIGN §4.1): compass, headline, the question box and
 * examples. Example chips only fill the box; they never run a search. Ask AI starts an AI
 * evidence search (UI_DESIGN §4.9), shows its checklist under the box while it runs (§4.10) and
 * opens its results.
 */
export function Home() {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const input = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const config = useQuery(configQuery());
  const coverage = config.data?.coverage;
  const ai = useEvidenceSearch();

  const search = (q: string): void => {
    const query = q.trim();
    navigate(query ? `/explore?${new URLSearchParams({ q: query }).toString()}` : '/explore');
  };
  const fill = (example: string): void => {
    setValue(example);
    input.current?.focus();
  };

  return (
    <>
      <title>{pageTitle({ kind: 'home' })}</title>
      <section className="flex flex-1 flex-col items-center justify-center px-4 pt-10 pb-8 text-center sm:pt-14">
        <CompassMark />
        <h1 className="mt-3.5 font-serif text-[28px] leading-[1.08] font-semibold tracking-headline sm:text-[30px]">
          Learn from the record.
        </h1>
        <SearchBox
          variant="home"
          value={value}
          onChange={setValue}
          onSearch={search}
          onAsk={(q) => void ai.ask(q)}
          askPhase={ai.phase}
          inputRef={input}
          className="mt-4 w-full max-w-[660px]"
        />
        <SearchWait pending={ai.pending} className="mt-3" />
        <AiNoticeBox
          notice={ai.notice}
          keywordHref={value.trim() ? `/explore?${new URLSearchParams({ q: value.trim() }).toString()}` : '/explore'}
          onRetry={() => void ai.ask(value)}
          className="mt-3 w-full"
        />
        <div className="mt-3 flex max-w-[660px] flex-wrap justify-center gap-[7px]" aria-label="Example questions">
          {HOME_EXAMPLES.map((example) => (
            <Chip key={example} variant="example" onClick={() => fill(example)}>
              {example}
            </Chip>
          ))}
        </div>
      </section>
      <p className="px-4 pb-4 text-center text-label text-muted" aria-live="polite">
        {coverage && config.data ? (
          <>
            {formatCount(coverage.defaultCohort)} completed US NTSB investigations · {coverage.yearFrom} → {coverage.yearTo} ·
            snapshot {formatChartDate(config.data.snapshotDate)} · not an NTSB service
          </>
        ) : (
          <>&nbsp;</>
        )}
      </p>
    </>
  );
}
