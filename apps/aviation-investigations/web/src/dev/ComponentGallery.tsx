/**
 * Living style guide at /dev/components, included only in development builds.
 * Every component renders twice, in the day and the night ("Panel") theme. The
 * sample cases are public NTSB records used in the approved mockups.
 */
import type { ReactNode } from 'react';
import { PRODUCT_NAME, documentTitle } from '../brand';
import { AiBlock } from '../components/AiBlock';
import { AiChip } from '../components/AiChip';
import { BrandMark } from '../components/BrandMark';
import { Button } from '../components/Button';
import { Chip } from '../components/Chip';
import { CompassMark } from '../components/CompassMark';
import { DataCaution } from '../components/DataCaution';
import { EVIDENCE_KINDS, EvidenceGlyph } from '../components/EvidenceGlyph';
import { FlightProfile, type FlightProfileStep } from '../components/FlightProfile';
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';
import { MonoChip } from '../components/MonoChip';
import { Placard } from '../components/Placard';
import { StatusBadge } from '../components/StatusBadge';
import { ThemeSwitch } from '../components/ThemeSwitch';
import { TimingChip } from '../components/TimingChip';

const noop = (): void => {};

const PROFILES: { name: string; steps: FlightProfileStep[] }[] = [
  {
    name: 'DFW08TA066 · power loss in a hover',
    steps: [
      { phaseGroup: 'maneuvering', eventLabel: 'Loss of engine power (total)', isDefining: true, impact: false },
      { phaseGroup: 'emergency_descent', eventLabel: 'Collision with terrain', isDefining: false, impact: true },
    ],
  },
  {
    name: 'MIA08LA156 · partial power loss on base',
    steps: [
      { phaseGroup: 'approach', eventLabel: 'Loss of engine power (partial)', isDefining: true, impact: false },
      { phaseGroup: 'landing', eventLabel: 'Off-field or emergency landing', isDefining: false, impact: false },
    ],
  },
  {
    name: 'Loss of control after takeoff',
    steps: [
      { phaseGroup: 'taxi', eventLabel: 'Taxi', isDefining: false, impact: false },
      { phaseGroup: 'takeoff', eventLabel: 'Takeoff roll', isDefining: false, impact: false },
      { phaseGroup: 'initial_climb', eventLabel: 'Loss of control in flight', isDefining: true, impact: false },
      { phaseGroup: 'uncontrolled_descent', eventLabel: 'Collision with terrain', isDefining: false, impact: true },
      { phaseGroup: 'post_impact', eventLabel: 'Fire/smoke (post-impact)', isDefining: false, impact: false },
    ],
  },
  {
    name: 'Controlled flight into terrain',
    steps: [
      { phaseGroup: 'en_route', eventLabel: 'VFR encounter with IMC', isDefining: false, impact: false },
      { phaseGroup: 'en_route', eventLabel: 'Controlled flight into terrain', isDefining: true, impact: true },
    ],
  },
  { name: 'No event sequence on record', steps: [] },
];

const TOKENS = [
  ['paper', 'bg-paper'],
  ['raised', 'bg-raised'],
  ['tint', 'bg-tint'],
  ['ink', 'bg-ink'],
  ['muted', 'bg-muted'],
  ['blue', 'bg-blue'],
  ['on-blue', 'bg-on-blue'],
  ['magenta', 'bg-magenta'],
  ['on-magenta', 'bg-on-magenta'],
  ['hairline', 'bg-hairline'],
  ['hatch', 'bg-hatch'],
  ['magenta-soft', 'bg-magenta-soft'],
  ['blue-wash', 'bg-blue-wash'],
  ['tray', 'bg-tray'],
  ['placard', 'bg-placard'],
  ['mark-tile', 'bg-mark-tile'],
  ['mark-glyph', 'bg-mark-glyph'],
] as const;

export function ComponentGallery() {
  return (
    <div className="mx-auto w-full max-w-page px-4 py-8 sm:px-[22px]">
      <title>{documentTitle('Component gallery')}</title>
      <Placard as="p">Development build only</Placard>
      <h1 className="mt-2 font-serif text-headline font-semibold tracking-headline">Sectional components</h1>
      <p className="mt-2 max-w-[70ch] text-muted">
        Each component in the day theme and the night &ldquo;Panel&rdquo; theme. The page theme follows the header
        switch; the panels below are pinned.
      </p>

      <Section title="Header" flush stack>
        <Header
          aiCounter={
            <>
              AI searches left: <b className="text-magenta">3 of 3</b>
            </>
          }
          auth={
            <Button variant="search" size="sm">
              Sign in
            </Button>
          }
        />
        <div className="h-10" />
      </Section>

      <Section title="Mark" note="UI_DESIGN §2.5. The heavier aircraft below 40 px (tab icon, header), the finer one from 40 px.">
        <div className="flex flex-wrap items-end gap-4">
          {[16, 22, 32, 40, 64, 92].map((size) => (
            <BrandMark key={size} size={size} />
          ))}
        </div>
      </Section>

      <Section title="Tokens" note="UI_DESIGN §2.2. Placard is transparent by day.">
        <ul className="grid grid-cols-3 gap-x-3 gap-y-2 sm:grid-cols-5">
          {TOKENS.map(([name, swatch]) => (
            <li key={name} className="flex items-center gap-2">
              <span className={`size-5 shrink-0 rounded-badge border border-hairline ${swatch}`} />
              <span className="truncate font-mono text-label">{name}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Typography" note="B612 for interface text, B612 Mono for codes and counts, Source Serif 4 for words to read.">
        <div className="card space-y-3 p-4">
          <p className="font-serif text-headline font-semibold tracking-headline">Hughes OH-6 helicopter, total power loss in a hover</p>
          <p className="font-serif text-question">Engine power loss shortly after maintenance: confirmed faults or none found?</p>
          <p className="font-serif text-lead">
            The contract mechanic&rsquo;s failure to properly secure the castellated nut that attached the governor lever
            control rod to the idler bell crank.
          </p>
          <p className="font-serif text-lead text-muted italic">What happened, and what did investigators establish?</p>
          <p>
            Interface text in B612: <b>58</b> completed investigations, newest first.
          </p>
          <p className="font-mono tracking-mono">
            <span className="font-bold text-blue">DFW08TA066</span> · MANEUVERING · VMC · DAY · 1 MINOR
          </p>
        </div>
      </Section>

      <Section title="Placards" note="Plain labels by day; engraved placards at night. AI labels stay magenta.">
        <div className="flex flex-wrap items-center gap-4">
          <span className="placard wordmark">{PRODUCT_NAME}</span>
          <Placard>Your question</Placard>
          <Placard tone="ink">The flight</Placard>
          <Placard tone="ai">AI summary · check the cited passages</Placard>
        </div>
      </Section>

      <Section title="Buttons" note="Search is free and blue; anything that runs the AI is magenta.">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="search">Search</Button>
          <Button variant="ai" counter="3 free">
            Ask AI
          </Button>
          <Button variant="ai" counter="2 left">
            Refine
          </Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="search" size="sm">
            Sign in
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="ai" disabled>
            Ask AI
          </Button>
          <span className="text-meta text-muted">AI back tomorrow</span>
          <Button variant="search" disabled>
            Search
          </Button>
        </div>
      </Section>

      <Section title="Chips">
        <div className="flex flex-wrap gap-2">
          <Chip>Completed investigations</Chip>
          <Chip>United States · 2008–2026</Chip>
          <Chip variant="add" onClick={noop}>
            + Filter
          </Chip>
          <Chip variant="filled" onClick={noop}>
            Filters (2)
          </Chip>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Chip variant="example" onClick={noop}>
            Carb icing on climb-out
          </Chip>
          <Chip variant="example" onClick={noop}>
            Stall/spin in the pattern
          </Chip>
          <Chip variant="example" onClick={noop}>
            Power loss after maintenance
          </Chip>
        </div>
      </Section>

      <Section title="AI output" note="Every AI element carries its own label.">
        <div className="flex flex-wrap gap-2">
          <AiChip onEdit={noop}>&ldquo;Shortly&rdquo; = within 30 days or 10 flight hours</AiChip>
          <AiChip label="AI suggested">Helicopters only</AiChip>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <TimingChip>5.1 FH</TimingChip>
          <TimingChip>1ST FLIGHT</TimingChip>
          <TimingChip>≤ 17 DAYS</TimingChip>
          <span className="text-meta text-muted">standalone timing chips keep the AI cell</span>
        </div>
        <p className="mt-3 text-ui text-magenta">
          <span className="mr-1.5 text-micro font-bold tracking-caps uppercase">Why it matched</span>
          Test flight right after rudder maintenance. <TimingChip labelled={false}>1ST FLIGHT</TimingChip>
        </p>
        <AiBlock label="AI summary · check the cited passages" className="mt-4">
          <p>
            Investigators tied one power loss directly to the maintenance: a cotter pin left out when the engine was
            reinstalled, 5.1 flight hours earlier{' '}
            <a href="#citation" className="border-b border-blue font-mono text-meta whitespace-nowrap text-blue">
              DFW08TA066
            </a>
            .
          </p>
        </AiBlock>
      </Section>

      <Section title="Evidence glyphs" note="Magenta because the classification is AI-derived; always with words.">
        <ul className="space-y-1.5 font-bold">
          {EVIDENCE_KINDS.map((kind) => (
            <li key={kind}>
              <EvidenceGlyph kind={kind} />
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap gap-2">
          <EvidenceGlyph kind="causal" variant="pill" />
          <EvidenceGlyph kind="insufficient" variant="pill" />
        </div>
      </Section>

      <Section title="Status badges" note="Every badge other than COMPLETED shows the raw NTSB code.">
        <div className="flex flex-col items-start gap-2">
          <StatusBadge kind="completed" rawStatus="B" />
          <StatusBadge kind="other_status" rawStatus="P" />
          <StatusBadge kind="in_progress" rawStatus="P" />
          <StatusBadge kind="status_unknown" rawStatus="" />
        </div>
      </Section>

      <Section title="Data cautions" note="Hatching with a label; never red, never severity.">
        <DataCaution>
          The record header says 8 February and a minor injury; the factual narrative says 9 February and serious
          injuries. Both are shown as published.
        </DataCaution>
        <div className="mt-3 flex flex-wrap gap-2">
          <DataCaution variant="chip">Header and narrative disagree</DataCaution>
          <DataCaution variant="chip" ai>
            Narrative dates disagree
          </DataCaution>
        </div>
        <DataCaution label="Summary withheld" className="mt-3">
          The AI&rsquo;s summary didn&rsquo;t pass the citation check, so it isn&rsquo;t shown. Below are the 6 cases it
          found, with their NTSB text.
        </DataCaution>
      </Section>

      <Section title="Mono value chips">
        <div className="flex flex-wrap gap-1.5">
          {['VMC', 'DAYLIGHT', 'CLEAR', '10 SM', 'ALTIMETER 30.22'].map((v) => (
            <MonoChip key={v}>{v}</MonoChip>
          ))}
        </div>
      </Section>

      <Section title="Flight profiles" note="Mini on cards and strips, full width in the drawer. Not to scale.">
        <ul className="space-y-2">
          {PROFILES.map((p) => (
            <li key={p.name} className="flex min-w-0 items-center gap-3">
              <FlightProfile steps={p.steps} size="mini" className="min-w-0 flex-1" />
            </li>
          ))}
        </ul>
        <div className="mt-4 space-y-3">
          {PROFILES.slice(0, 4).map((p) => (
            <figure key={p.name} className="card px-4 pt-3 pb-1">
              <figcaption className="text-meta text-muted">{p.name}</figcaption>
              <FlightProfile steps={p.steps} size="full" />
            </figure>
          ))}
        </div>
      </Section>

      <Section title="Case card" note="Raised card with hairline border; a shallow bezel at night.">
        <SampleCard />
      </Section>

      <Section title="Theme switch and compass">
        <div className="flex items-center gap-6">
          <ThemeSwitch />
          <CompassMark />
        </div>
      </Section>

      <Section title="Footer" flush>
        <Footer snapshotDate="2026-10-01" />
      </Section>
    </div>
  );
}

interface SectionProps {
  title: string;
  note?: string;
  /** No inner padding, for full-bleed components. */
  flush?: boolean;
  /** One full-width panel per theme instead of two side by side. */
  stack?: boolean;
  children: ReactNode;
}

function Section({ title, note, flush = false, stack = false, children }: SectionProps) {
  return (
    <section className="mt-10">
      <h2 className="font-serif text-question font-semibold">{title}</h2>
      {note && <p className="mt-0.5 text-meta text-muted">{note}</p>}
      <div className={stack ? 'mt-3 grid gap-4' : 'mt-3 grid gap-4 lg:grid-cols-2'}>
        <ThemePanel theme="day" flush={flush}>
          {children}
        </ThemePanel>
        <ThemePanel theme="night" flush={flush}>
          {children}
        </ThemePanel>
      </div>
    </section>
  );
}

function ThemePanel({ theme, flush, children }: { theme: 'day' | 'night'; flush: boolean; children: ReactNode }) {
  return (
    <div data-theme={theme} className="paper min-w-0 overflow-hidden rounded-card border border-hairline">
      <p className="px-4 pt-3 font-mono text-label tracking-mono text-muted uppercase">{theme}</p>
      <div className={flush ? 'pt-2' : 'p-4 pt-3'}>{children}</div>
    </div>
  );
}

function SampleCard() {
  return (
    <article className="card px-3.5 pt-[11px] pb-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5">
        <a href="#case" className="font-mono font-bold text-blue">
          DFW08TA066
        </a>
        <span className="font-bold">Hughes OH-6A</span>
        <span className="text-meta text-muted">Valentine, TX · 8 Feb 2008</span>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-meta text-blue">
          <input type="checkbox" defaultChecked className="size-3 accent-blue" />
          Compare
        </label>
      </div>
      <p className="mt-1.5 mb-1.5 text-ui text-magenta">
        <span className="mr-1.5 text-micro font-bold tracking-caps uppercase">Why it matched</span>
        Engine replaced shortly before; investigators cite the maintenance error.{' '}
        <TimingChip labelled={false}>5.1 FH</TimingChip>
      </p>
      <blockquote className="border-l-2 border-rule py-px pl-[11px] font-serif text-[13.5px] leading-[1.45]">
        &ldquo;&hellip;the cotter pin that secured the nut was missing. The engine had been replaced 5.1 hours prior to
        the accident by a contract maintenance facility.&rdquo;
        <cite className="mt-1 block font-sans text-[10px] tracking-[.12em] text-muted not-italic">NTSB · ANALYSIS</cite>
      </blockquote>
      <div className="mt-2 flex flex-wrap items-center gap-2.5">
        <FlightProfile steps={PROFILES[0]!.steps} size="mini" />
        <DataCaution variant="chip">Header and narrative disagree</DataCaution>
        <a href="#report" className="link ml-auto text-meta">
          NTSB report ↗
        </a>
      </div>
    </article>
  );
}
