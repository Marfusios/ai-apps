import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { dashboardQuery } from '../api';
import { Button } from '../components/Button';
import { BarList } from '../features/dashboard/BarList';
import { CohortChips } from '../features/dashboard/CohortChips';
import { CoveragePanel } from '../features/dashboard/CoveragePanel';
import { DotMap } from '../features/dashboard/DotMap';
import { exploreHref } from '../features/dashboard/links';
import { QuestionPanel } from '../features/dashboard/QuestionPanel';
import {
  categorySentence,
  injurySentence,
  mapSentence,
  overlapSentence,
  phaseSentence,
  topKnown,
  weatherSentence,
  yearsSentence,
} from '../features/dashboard/sentences';
import { YearChart } from '../features/dashboard/YearChart';
import { formatChartDate, formatCount } from '../lib/format';
import type { DashboardBar } from '../../../shared/contracts/dashboard';

const COHORT_PARAM = 'cohort';

/** "Open the 7,849 landing cases →" for the phone cards. */
function openLink(cohort: 'default' | 'all', bar: DashboardBar | undefined, noun: string) {
  if (!bar) return undefined;
  return {
    href: exploreHref(cohort, { facet: bar.facet, value: bar.value }),
    text: `Open the ${formatCount(bar.count)} ${noun} ${bar.count === 1 ? 'case' : 'cases'}`,
  };
}

/**
 * Dashboard, "Questions" (UI_DESIGN §4.7): each panel is a question an instructor
 * might ask, answered by one fixed-template sentence and its chart. The cohort is
 * in the URL (`?cohort=all` includes the other records).
 */
export function Dashboard() {
  const [params, setParams] = useSearchParams();
  const cohort = params.get(COHORT_PARAM) === 'all' ? 'all' : 'default';
  const current = useQuery(dashboardQuery(cohort));
  const completed = useQuery(dashboardQuery('default'));
  const everything = useQuery(dashboardQuery('all'));
  const data = current.data;

  const setCohort = (next: 'default' | 'all'): void =>
    setParams(next === 'all' ? { [COHORT_PARAM]: 'all' } : {}, { preventScrollReset: true });

  const withData = data?.years.filter((y) => y.completed + y.other > 0) ?? [];
  // Reuse the open cohort's data; the other cohort only supplies the chip counts, which are hidden if it fails.
  const completedData = cohort === 'default' ? current.data : completed.data;
  const allData = cohort === 'all' ? current.data : everything.data;
  const other = completedData && allData ? allData.total - completedData.total : undefined;

  return (
    <div className="mx-auto w-full max-w-page px-4 pt-5 pb-12 sm:px-[26px] sm:pt-[22px]">
      <title>The record, in questions · Aviation Casebook</title>
      <h1 className="font-serif text-[26px] leading-[1.1] font-semibold tracking-headline sm:text-[28px]">The record, in questions</h1>
      <CohortChips
        cohort={cohort}
        completed={completedData?.total}
        other={other}
        yearFrom={withData[0]?.year}
        yearTo={withData[withData.length - 1]?.year}
        onCohort={setCohort}
      />
      {current.isError ? (
        <div role="alert" className="rounded-card border border-hairline bg-raised px-4 py-4">
          <p className="font-serif text-[16px] font-semibold">The dashboard could not be loaded.</p>
          <p className="mt-1 mb-3 text-meta text-muted">Try again in a moment.</p>
          <Button variant="search" size="sm" onClick={() => void current.refetch()}>
            Try again
          </Button>
        </div>
      ) : !data ? (
        <DashboardSkeleton />
      ) : (
        <>
          <div className="grid items-start gap-3.5 lg:grid-cols-2">
            <QuestionPanel id="q-years" question="How complete is the recent record?" sentence={yearsSentence(data.years)} wide>
              <YearChart years={data.years} cohort={cohort} />
            </QuestionPanel>

            <QuestionPanel
              id="q-phase"
              question="When in the flight did it happen?"
              sentence={phaseSentence(data.phase, data.total)}
              open={openLink(cohort, topKnown(data.phase), topKnown(data.phase)?.label.toLowerCase() ?? '')}
            >
              <BarList bars={data.phase} total={data.total} cohort={cohort} label="Phase of the defining event" />
            </QuestionPanel>

            <div className="flex flex-col gap-3.5">
              <QuestionPanel
                id="q-injury"
                question="How serious were the outcomes?"
                sentence={injurySentence(data.injury, data.total)}
                open={openLink(
                  cohort,
                  data.injury.find((b) => b.value === 'FATL'),
                  'fatal',
                )}
              >
                <BarList bars={data.injury} total={data.total} cohort={cohort} label="Highest injury" />
              </QuestionPanel>
              <QuestionPanel
                id="q-weather"
                question="What was the weather?"
                sentence={weatherSentence(data.weather, data.total)}
                open={openLink(
                  cohort,
                  data.weather.find((b) => b.value === 'IMC'),
                  'instrument-conditions',
                )}
              >
                <BarList bars={data.weather} total={data.total} cohort={cohort} label="Weather conditions" />
              </QuestionPanel>
            </div>

            <QuestionPanel
              id="q-category"
              question="What was flying?"
              sentence={categorySentence(data.category, data.total)}
              note={overlapSentence(data.coverage.multiAircraft, data.total)}
              open={openLink(cohort, topKnown(data.category), topKnown(data.category)?.label.toLowerCase() ?? '')}
            >
              <BarList bars={data.category} total={data.total} cohort={cohort} label="Aircraft category" />
            </QuestionPanel>

            <QuestionPanel id="q-where" question="Where?" sentence={mapSentence(data.map, data.total)}>
              <DotMap map={data.map} total={data.total} />
            </QuestionPanel>

            <QuestionPanel id="q-data" question="What can this data tell you?" wide>
              <CoveragePanel coverage={data.coverage} />
              <p className="mt-3 text-label text-muted">
                Counts are investigations, not rates. They say nothing about how many flights, hours or aircraft were flying.
              </p>
            </QuestionPanel>
          </div>
          <p className="mt-4 text-label text-muted">
            Snapshot {formatChartDate(data.dataset.snapshotDate)}. Every bar opens the matching cases in Explore. Nothing here ranks
            aircraft makers.
          </p>
        </>
      )}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div aria-hidden="true" className="grid gap-3.5 lg:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={`h-44 rounded-card border border-hairline bg-raised/60 ${i === 0 ? 'lg:col-span-2' : ''}`} />
      ))}
    </div>
  );
}
