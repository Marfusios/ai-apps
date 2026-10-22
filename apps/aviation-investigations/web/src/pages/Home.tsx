import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { configQuery } from '../api';
import { Chip } from '../components/Chip';
import { CompassMark } from '../components/CompassMark';
import { SearchBox } from '../components/SearchBox';
import { formatChartDate, formatCount } from '../lib/format';

/** Home example chips (UI_DESIGN §4.1). They only fill the box; they never run a search. */
export const EXAMPLES = ['Carb icing on climb-out', 'Stall/spin in the pattern', 'Power loss after maintenance'] as const;

/** Home, "Clear sky" (UI_DESIGN §4.1): compass, headline, the question box and examples. */
export function Home() {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const input = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const config = useQuery(configQuery());
  const coverage = config.data?.coverage;

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
      <title>Aviation Casebook</title>
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
          inputRef={input}
          className="mt-4 w-full max-w-[660px]"
        />
        <div className="mt-3 flex max-w-[660px] flex-wrap justify-center gap-[7px]" aria-label="Example questions">
          {EXAMPLES.map((example) => (
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
