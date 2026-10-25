import { Fragment, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { Link } from 'react-router';
import type { AircraftDetail, CaseDetail, Finding, Section } from '../../../../shared/contracts/cases';
import type { Snippet } from '../../../../shared/contracts/search';
import { PRODUCT_NAME } from '../../brand';
import { DataCaution } from '../../components/DataCaution';
import { FlightProfile } from '../../components/FlightProfile';
import { Highlighted } from '../../components/Highlighted';
import { MonoChip } from '../../components/MonoChip';
import { SectionHead } from '../../components/SectionHead';
import { StatusBadge } from '../../components/StatusBadge';
import { cx } from '../../lib/cx';
import { formatDate } from '../../lib/format';
import { EvidenceSection, type DrawerEvidence } from '../evidence/EvidenceSection';
import { BriefSections, BriefVerdict, citedTarget, passageAnchor, type AiCaseContext } from './BriefContext';
import {
  aircraftName,
  findingParts,
  injurySummary,
  letterOf,
  operationLine,
  profileSteps,
  weatherChips,
} from './display';

export interface CaseStoryProps {
  detail: CaseDetail;
  /** `drawer`: the story over Explore. `page`: the full case page, which adds the narrative. */
  mode: 'drawer' | 'page';
  headingRef?: Ref<HTMLHeadingElement>;
  headingId?: string;
  /** Explore's matched passage for this case (NTSB text), shown in the drawer. */
  matched?: Snippet | null;
  /** Page actions under the meta line (+ Compare, Print for class). */
  actions?: ReactNode;
  /**
   * The viewer's own live brief context for this case (private endpoint), when the story
   * is opened from a brief. Without it the story is NTSB data only.
   */
  ai?: AiCaseContext;
  /** Scroll to the cited passage once the AI context arrives (the drawer opened from a citation). */
  openAtCited?: boolean;
  /** The case as the viewer's evidence search shows it (the drawer over that search), else none. */
  evidence?: DrawerEvidence | null;
}

function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => v !== ''))];
}

/** "8 Feb 2008 · Part 91 · public use, federal · Substantial damage · 1 minor injury" */
function MetaLine({ detail }: { detail: CaseDetail }) {
  const ops = distinct(detail.aircraft.map(operationLine));
  const damage = distinct(detail.aircraft.map((a) => (a.damage.code ? a.damage.label : '')));
  const parts = [formatDate(detail.date), ...ops, damage.join(' / ')].filter(Boolean);
  return (
    <p className="text-ui text-muted">
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          {p}
        </Fragment>
      ))}
      <span aria-hidden="true"> · </span>
      <span className="text-ink">{injurySummary(detail)}</span>
    </p>
  );
}

function AircraftTag({ detail, aircraft, index }: { detail: CaseDetail; aircraft: AircraftDetail; index: number }) {
  return (
    <p className="mb-1 flex flex-wrap items-baseline gap-x-2 text-meta">
      {detail.aircraft.length > 1 && (
        <span className="font-mono font-bold text-muted">{letterOf(detail.ntsbNo, aircraft, index)}</span>
      )}
      <span className="font-bold">{aircraftName(aircraft)}</span>
      {aircraft.registration && <span className="font-mono text-label text-muted">{aircraft.registration}</span>}
    </p>
  );
}

function timeNote(detail: CaseDetail): string | null {
  const { hhmm, zone } = detail.time;
  if (!hhmm) return null;
  return `${hhmm.slice(0, 2)}:${hhmm.slice(2)}${zone.code ? ` ${zone.code}` : ''}`;
}

function TheFlight({ detail }: { detail: CaseDetail }) {
  const multi = detail.aircraft.length > 1;
  const chips = weatherChips(detail.weather);
  const time = timeNote(detail);
  return (
    <section className="mt-6" aria-label="The flight" data-print="keep">
      <SectionHead tag="NTSB event sequence">The flight</SectionHead>
      <div className={cx(multi && 'space-y-3')}>
        {detail.aircraft.map((a, i) => {
          const steps = profileSteps(detail, a.aircraftKey);
          return (
            <div key={a.aircraftKey}>
              {multi && <AircraftTag detail={detail} aircraft={a} index={i} />}
              {steps.length > 0 ? (
                <FlightProfile steps={steps} size="full" />
              ) : (
                <p className="text-ui text-muted">No event sequence on record.</p>
              )}
            </div>
          );
        })}
        {detail.aircraft.length === 0 && <p className="text-ui text-muted">No aircraft or event sequence on record.</p>}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-1 gap-y-1.5 text-ui leading-[1.7]">
        {chips.length > 0 ? (
          chips.map((chip, i) => (
            <Fragment key={chip}>
              {i > 0 && <span aria-hidden="true" className="text-muted">·</span>}
              <MonoChip>{chip}</MonoChip>
            </Fragment>
          ))
        ) : (
          <span className="text-muted">Weather not reported.</span>
        )}
      </div>
      <p className="mt-1 text-meta text-muted">
        Conditions as recorded in the NTSB event record{time ? `; event time ${time}` : ''}.{' '}
        {detail.weather.metar ? 'METAR on record:' : 'No METAR text on record.'}
      </p>
      {detail.weather.metar && (
        <p className="mt-1 font-mono text-label tracking-mono break-words text-ink">{detail.weather.metar}</p>
      )}
    </section>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  const { lead, detail, path } = findingParts(finding);
  return (
    <li className="flex gap-2 border-t border-hairline py-1.5 text-ui">
      <div className="min-w-0 flex-1">
        <p>
          {finding.inProbableCause === true && (
            <span className="mr-2 inline-block rounded-badge border border-ink px-1 align-[1px] text-micro font-bold tracking-[.12em] text-ink uppercase">
              In probable cause
            </span>
          )}
          {lead}
          {detail && `: ${lowerFirst(detail)}`}
        </p>
        {path && <p className="text-label text-muted">{path}</p>}
      </div>
    </li>
  );
}

function Findings({ detail }: { detail: CaseDetail }) {
  if (detail.findings.length === 0) return <p className="mt-2 text-ui text-muted">No findings on record.</p>;
  const multi = detail.aircraft.length > 1;
  if (!multi) {
    return (
      <ul className="mt-2.5" aria-label="Findings">
        {detail.findings.map((f) => (
          <FindingRow key={`${f.aircraftKey}-${f.findingNo}`} finding={f} />
        ))}
      </ul>
    );
  }
  return (
    <div className="mt-3 space-y-3">
      {detail.aircraft.map((a, i) => {
        const own = detail.findings.filter((f) => f.aircraftKey === a.aircraftKey);
        if (own.length === 0) return null;
        return (
          <div key={a.aircraftKey}>
            <p className="text-micro font-bold tracking-caps text-muted uppercase">
              Findings recorded for aircraft {letterOf(detail.ntsbNo, a, i)} · {aircraftName(a)}
            </p>
            <ul className="mt-1" aria-label={`Findings for aircraft ${letterOf(detail.ntsbNo, a, i)}`}>
              {own.map((f) => (
                <FindingRow key={`${f.aircraftKey}-${f.findingNo}`} finding={f} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** For multi-aircraft events: whose row carried an event-wide text (provenance, not attribution). */
function ScopeNote({ detail, section, index, of }: { detail: CaseDetail; section: Section; index: number; of: number }) {
  if (section.scope !== 'event' || detail.aircraft.length < 2) return null;
  const letters = section.sourceAircraftKeys
    .map((key) => {
      const i = detail.aircraft.findIndex((a) => a.aircraftKey === key);
      return i === -1 ? null : letterOf(detail.ntsbNo, detail.aircraft[i] as AircraftDetail, i);
    })
    .filter(Boolean);
  const which = of > 1 ? `Text ${index + 1} of ${of}. ` : '';
  return (
    <p className="mb-1.5 text-meta text-muted">
      <span className="mr-1.5 inline-block rounded-badge border border-rule px-1 text-micro font-bold tracking-[.12em] uppercase">
        Event-wide
      </span>
      {which}Published for the event, not one aircraft; filed with aircraft {letters.join(' and ')}.
    </p>
  );
}

const HEADING_LINE = /^[A-Z0-9 ,.'’&/()-]{4,60}$/;

/** Narrative text: paragraphs on blank lines; short all-caps lines become small headings. */
export function NarrativeText({ text, className }: { text: string; className?: string }) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return (
    <div className={cx('space-y-2.5 font-serif text-quote leading-[1.6]', className)}>
      {paragraphs.map((p, i) =>
        HEADING_LINE.test(p) && /[A-Z]{3}/.test(p) ? (
          <p key={i} className="pt-1 font-sans text-micro font-bold tracking-caps text-muted">
            {p}
          </p>
        ) : (
          <p key={i} className="whitespace-pre-line">
            {p}
          </p>
        ),
      )}
    </div>
  );
}

function ProbableCause({ detail }: { detail: CaseDetail }) {
  const causes = detail.sections.filter((s) => s.kind === 'probable_cause');
  // UI_DESIGN §4.2: wherever the field is empty, whatever the status. A completed
  // record also says "Probable-cause text unavailable" by its badge.
  if (causes.length === 0) return <p className="text-ui text-muted">No probable cause on record.</p>;
  return (
    <div className="space-y-3">
      {causes.map((s, i) => (
        <div key={s.key}>
          <ScopeNote detail={detail} section={s} index={i} of={causes.length} />
          <NarrativeText text={s.text} className="text-lead leading-[1.5]" />
        </div>
      ))}
    </div>
  );
}

function Established({ detail }: { detail: CaseDetail }) {
  return (
    <section className="mt-6" aria-label="What investigators established" id="probable-cause">
      <SectionHead tag="NTSB">What investigators established</SectionHead>
      <ProbableCause detail={detail} />
      <Findings detail={detail} />
    </section>
  );
}

function Matched({ detail, matched }: { detail: CaseDetail; matched: Snippet }) {
  return (
    <section className="mt-6" aria-label="Where your search matched">
      <SectionHead tag={`NTSB · ${matched.label}`}>Where your search matched</SectionHead>
      <p className="font-serif text-quote leading-[1.6] text-muted">
        {matched.truncatedStart && '…'}
        <Highlighted text={matched.text} highlights={matched.highlights} />
        {matched.truncatedEnd && '…'}
      </p>
      <Link to={`/cases/${detail.ntsbNo}#${matched.section}`} className="link mt-1.5 inline-block text-ui">
        Read the full {matched.label.toLowerCase()}
      </Link>
    </section>
  );
}

function NarrativeSections({ detail, kind, title }: { detail: CaseDetail; kind: 'factual' | 'analysis'; title: string }) {
  const sections = detail.sections.filter((s) => s.kind === kind);
  return (
    <section className="mt-7" aria-label={title} id={kind}>
      <SectionHead tag={`NTSB · ${kind}`}>{title}</SectionHead>
      {sections.length === 0 ? (
        <p className="text-ui text-muted">No {kind === 'factual' ? 'factual narrative' : 'analysis'} on record.</p>
      ) : (
        <div className="space-y-4">
          {sections.map((s, i) => (
            <div key={s.key}>
              <ScopeNote detail={detail} section={s} index={i} of={sections.length} />
              <NarrativeText text={s.text} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AircraftFacts({ detail }: { detail: CaseDetail }) {
  if (detail.aircraft.length === 0) return null;
  const multi = detail.aircraft.length > 1;
  return (
    <section className="mt-7" aria-label="The aircraft" data-print="keep">
      <SectionHead tag="NTSB">{multi ? `The aircraft (${detail.aircraft.length})` : 'The aircraft'}</SectionHead>
      <div className={cx('grid gap-3', multi && 'sm:grid-cols-2')}>
        {detail.aircraft.map((a, i) => {
          const rows: [string, string][] = [
            ['Registration', a.registration ?? 'Not recorded'],
            ['Category', a.category.label],
            ['Operation', operationLine(a)],
            ['Damage', a.damage.label],
            [
              'Engines',
              a.engines.length === 0
                ? 'None recorded'
                : distinct(a.engines.map((e) => [e.type.label, e.fuelSystem.code ? e.fuelSystem.label.toLowerCase() : ''].filter(Boolean).join(', '))).join('; ') +
                  (a.engines.length > 1 ? ` (${a.engines.length})` : ''),
            ],
            ['Defining event', a.definingEvent ? `${a.definingEvent.event.label} · ${a.definingEvent.phaseDetail.label}` : a.definingEventConflict ? 'Conflicting flags; none shown' : 'Not coded'],
          ];
          if (a.year) rows.splice(2, 0, ['Built', String(a.year)]);
          if (a.homebuilt) rows.push(['Homebuilt', 'Yes']);
          return (
            <div key={a.aircraftKey} className="rounded-chip border border-hairline px-3 py-2">
              <AircraftTag detail={detail} aircraft={a} index={i} />
              <dl className="text-meta">
                {rows.map(([k, v]) => (
                  <div key={k} className="flex gap-3 border-t border-hairline py-1 first:border-t-0">
                    <dt className="w-24 flex-none text-muted">{k}</dt>
                    <dd className="min-w-0">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CopyCaseNumber({ ntsbNo }: { ntsbNo: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(ntsbNo);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <>
      <span className="font-mono text-ink select-all">{ntsbNo}</span>{' '}
      <button type="button" onClick={copy} className="cursor-pointer text-blue hover:underline" data-print="hide">
        {copied ? 'Copied' : 'Copy'}
        <span className="sr-only"> case number</span>
      </button>
    </>
  );
}

function Provenance({ detail }: { detail: CaseDetail }) {
  const { report, provenance, completion } = detail;
  return (
    <footer className="mt-7 border-t border-hairline pt-3 text-meta leading-[1.6] text-muted">
      {report.kind === 'report' ? (
        <p>
          <a href={report.url} target="_blank" rel="noopener noreferrer" className="font-bold text-blue hover:underline">
            {report.label} ↗
          </a>{' '}
          · link captured {formatDate(report.capturedOn)}
        </p>
      ) : (
        <p>
          {report.note}. Case number <CopyCaseNumber ntsbNo={detail.ntsbNo} /> ·{' '}
          <a href={report.url} target="_blank" rel="noopener noreferrer" className="link">
            {report.label} ↗
          </a>{' '}
          (a search page, not the report)
        </p>
      )}
      <p>
        Source: NTSB, data snapshot {formatDate(provenance.snapshotDate)} · record revision{' '}
        <span className="font-mono">{provenance.caseRevision.slice(0, 12)}</span>
        {provenance.lastChangedAt && ` · last changed ${formatDate(provenance.lastChangedAt)}`}
      </p>
      {!completion.mappingVerified && (
        <p>Completion status follows a provisional mapping ({completion.mappingVersion}) until NTSB metadata confirms it.</p>
      )}
      <p>{PRODUCT_NAME} is not an NTSB service.</p>
    </footer>
  );
}

/**
 * Scrolls to the cited passage once per visit to a case, when its AI context is ready (focus
 * stays on the headline). The drawer starts every case at the top, so coming back to a case
 * (‹ ›, even before the other case showed its passage) scrolls again.
 */
function useOpenAtCited(ai: AiCaseContext | undefined, ntsbNo: string, enabled: boolean): void {
  const done = useRef<string | null>(null);
  const visiting = useRef<string | null>(null);
  useEffect(() => {
    if (visiting.current !== ntsbNo) {
      visiting.current = ntsbNo;
      done.current = null;
    }
    if (!enabled || ai?.state !== 'ready') return;
    const key = `${ai.briefId}:${ai.step}:${ntsbNo}`;
    if (done.current === key) return;
    done.current = key;
    const target = citedTarget(ai.context);
    if (target) document.getElementById(passageAnchor(target))?.scrollIntoView?.({ block: 'start' });
  }, [ai, ntsbNo, enabled]);
}

/**
 * A case in story order (UI_DESIGN §4.5): identity, headline, meta, cautions, the
 * flight, then what investigators established, and provenance. NTSB data only,
 * unless it is opened from the viewer's own live brief (`ai`): then the verdict pill,
 * "why it's in your results" and the cited passages come from the brief's private
 * context. Opened from the viewer's evidence search (`evidence`), it adds that search's
 * projection of the case after what investigators established (UI_DESIGN §4.9). The full page
 * adds the aircraft and the factual and analysis narratives.
 */
export function CaseStory({ detail, mode, headingRef, headingId, matched, actions, ai, openAtCited = false, evidence = null }: CaseStoryProps) {
  const Heading = mode === 'page' ? 'h1' : 'h2';
  const completed = detail.completion.class === 'completed';
  useOpenAtCited(ai, detail.ntsbNo, openAtCited);
  return (
    <article className="text-ink">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-meta">
        <span className="font-mono text-[13px] font-bold tracking-mono text-blue">{detail.ntsbNo}</span>
        <StatusBadge kind={detail.completion.class} rawStatus={completed ? undefined : detail.completion.rawStatus} />
        {completed && !detail.completion.hasProbableCause && <span className="text-muted">Probable-cause text unavailable</span>}
        <span className="text-muted">{detail.eventType.label}</span>
      </div>
      <Heading
        ref={headingRef}
        id={headingId}
        tabIndex={-1}
        className="mt-2 mb-1.5 font-serif text-[23px] leading-[1.15] font-semibold tracking-headline outline-none focus-visible:outline-2 sm:text-headline sm:leading-[1.12]"
      >
        {detail.headline}
      </Heading>
      <MetaLine detail={detail} />
      {actions}
      {ai && <BriefVerdict ai={ai} ntsbNo={detail.ntsbNo} aircraft={detail.aircraft} />}
      {detail.cautions.map((c) => (
        <DataCaution key={c.kind} className="mt-3.5">
          {c.text}
        </DataCaution>
      ))}
      <TheFlight detail={detail} />
      {mode === 'page' ? (
        <>
          <AircraftFacts detail={detail} />
          <NarrativeSections detail={detail} kind="factual" title="Factual narrative" />
          <NarrativeSections detail={detail} kind="analysis" title="Analysis" />
          <Established detail={detail} />
        </>
      ) : (
        <>
          <Established detail={detail} />
          {matched && matched.section !== 'probable_cause' && <Matched detail={detail} matched={matched} />}
        </>
      )}
      {ai && <BriefSections ai={ai} ntsbNo={detail.ntsbNo} aircraft={detail.aircraft} mode={mode} />}
      {/* Keyed by case: stepping to the next case never carries an open section or paragraph over. */}
      {evidence && <EvidenceSection key={evidence.item.case.ntsbNo} searchId={evidence.searchId} item={evidence.item} context={evidence.context} />}
      <Provenance detail={detail} />
    </article>
  );
}
