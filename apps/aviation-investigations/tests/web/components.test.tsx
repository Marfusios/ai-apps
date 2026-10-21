import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBlock } from '../../web/src/components/AiBlock';
import { AiChip, aiLabel } from '../../web/src/components/AiChip';
import { Button } from '../../web/src/components/Button';
import { DataCaution } from '../../web/src/components/DataCaution';
import { EVIDENCE_KINDS, EVIDENCE_WORDS, EvidenceGlyph } from '../../web/src/components/EvidenceGlyph';
import { Footer } from '../../web/src/components/Footer';
import { Header } from '../../web/src/components/Header';
import { StatusBadge } from '../../web/src/components/StatusBadge';
import { ThemeSwitch } from '../../web/src/components/ThemeSwitch';
import { TimingChip } from '../../web/src/components/TimingChip';
import { localIsoDate } from '../../web/src/lib/format';
import printCss from '../../web/src/styles/print.css?raw';
import tokensCss from '../../web/src/styles/tokens.css?raw';
import { cssBlock, cssVar } from './helpers';

const DAY = ':root,\n[data-theme="day"]';
const NIGHT = '[data-theme="night"]';

/** True when nothing hides the element from sighted users or assistive technology. */
function isPerceivable(element: HTMLElement): boolean {
  for (let el: HTMLElement | null = element; el; el = el.parentElement) {
    if (el.getAttribute('aria-hidden') === 'true' || el.hidden || el.classList.contains('sr-only')) return false;
  }
  return true;
}

describe('EvidenceGlyph', () => {
  it('glyph renders words for each kind', () => {
    expect(EVIDENCE_WORDS).toEqual({
      causal: 'Causal fault established',
      defect_not_causal: 'Defect found, causal link not established',
      no_fault: 'No fault identified',
      insufficient: 'Insufficient evidence',
    });
    for (const kind of EVIDENCE_KINDS) {
      for (const variant of ['inline', 'pill'] as const) {
        const { container, unmount } = render(<EvidenceGlyph kind={kind} variant={variant} />);
        expect(isPerceivable(screen.getByText(EVIDENCE_WORDS[kind]))).toBe(true);
        // The drawn mark is decorative; the words carry the meaning.
        expect(container.querySelector(`svg[data-glyph="${kind}"]`)?.getAttribute('aria-hidden')).toBe('true');
        unmount();
      }
    }
  });

  it('marks the verdict pill as AI classified', () => {
    const { container } = render(<EvidenceGlyph kind="causal" variant="pill" />);
    expect(isPerceivable(screen.getByText('AI classified'))).toBe(true);
    // UI_DESIGN §2.4: "● Causal fault established · AI CLASSIFIED" (caps set by CSS).
    expect(container.textContent).toBe('Causal fault established · AI classified');
  });
});

describe('AI labels', () => {
  it('AiChip has visible AI label', () => {
    render(<AiChip>“Shortly” = within 30 days or 10 flight hours</AiChip>);
    const label = screen.getByText('AI');
    expect(isPerceivable(label)).toBe(true);
    expect(label.closest('span.border-magenta')).not.toBeNull();
  });

  it('keeps the AI label when a chip label is blank or omits it', () => {
    expect(aiLabel(undefined)).toBe('AI');
    expect(aiLabel('   ')).toBe('AI');
    expect(aiLabel('suggested')).toBe('AI · suggested');
    expect(aiLabel('AI suggested')).toBe('AI suggested');
    render(<AiChip label="  ">5.1 FH</AiChip>);
    expect(isPerceivable(screen.getByText('AI'))).toBe(true);
  });

  it('editable AiChip is a button that still names the AI', () => {
    let edits = 0;
    render(<AiChip onEdit={() => edits++}>Helicopters only</AiChip>);
    const button = screen.getByRole('button');
    expect(button.textContent).toContain('AI');
    expect(button.textContent).toContain('✎');
    fireEvent.click(button);
    expect(edits).toBe(1);
  });

  it('AiBlock always renders its AI label', () => {
    render(<AiBlock label="Summary · check the cited passages">Text</AiBlock>);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('AI · Summary · check the cited passages');
  });

  it('AiBlock label can take the heading level of its page', () => {
    render(
      <AiBlock label="AI summary" as="h3">
        Text
      </AiBlock>,
    );
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('AI summary');
  });

  it('a standalone TimingChip shows its AI label', () => {
    render(<TimingChip>5.1 FH</TimingChip>);
    expect(isPerceivable(screen.getByText('AI'))).toBe(true);
    expect(screen.getByText('5.1 FH').className).toContain('font-mono');
  });

  it('a TimingChip inside an AI-labelled line drops its own AI cell', () => {
    const { container } = render(
      <p>
        <span>Why it matched</span> Test flight after maintenance. <TimingChip labelled={false}>1ST FLIGHT</TimingChip>
      </p>,
    );
    expect(screen.queryByText('AI')).toBeNull();
    expect(container.textContent).toBe('Why it matched Test flight after maintenance. 1ST FLIGHT');
  });
});

describe('tokens', () => {
  it('muted token is #58616B', () => {
    expect(cssVar(cssBlock(tokensCss, DAY), 'muted')).toBe('#58616B');
    expect(cssVar(cssBlock(tokensCss, NIGHT), 'muted')).toBe('#9EA3A9');
  });

  it('defines every UI_DESIGN §2.2 token for day and night', () => {
    const table: Record<string, [string, string]> = {
      paper: ['#F3EEE1', '#1B1D20'],
      raised: ['#FBF8F0', '#24272B'],
      tint: ['#E8E2CC', '#2C3034'],
      ink: ['#1E2A36', '#EDEDEA'],
      muted: ['#58616B', '#9EA3A9'],
      blue: ['#1F519A', '#93B9F7'],
      'on-blue': ['#FFFFFF', '#101418'],
      magenta: ['#A0166C', '#F07DC6'],
      'on-magenta': ['#FFFFFF', '#1B0814'],
      hairline: ['rgba(31, 81, 154, .20)', 'rgba(255, 255, 255, .10)'],
      hatch: ['rgba(30, 42, 54, .13)', 'rgba(237, 237, 234, .15)'],
      'magenta-soft': ['rgba(160, 22, 108, .35)', 'rgba(240, 125, 198, .45)'],
      'blue-wash': ['rgba(31, 81, 154, .12)', 'rgba(147, 185, 247, .16)'],
      grid: ['rgba(31, 81, 154, .055)', 'transparent'],
      tray: ['#1E2A36', '#111214'],
      placard: ['transparent', '#0E0F11'],
    };
    const day = cssBlock(tokensCss, DAY);
    const night = cssBlock(tokensCss, NIGHT);
    for (const [name, [dayValue, nightValue]] of Object.entries(table)) {
      expect([name, cssVar(day, name)]).toEqual([name, dayValue]);
      expect([name, cssVar(night, name)]).toEqual([name, nightValue]);
    }
    // Night has no graticule (§2.8).
    expect(cssVar(night, 'graticule')).toBe('none');
  });
});

describe('ThemeSwitch', () => {
  it('night theme sets data-theme', () => {
    render(<ThemeSwitch />);
    const night = screen.getByRole('button', { name: 'Night' });
    fireEvent.click(night);
    expect(document.documentElement.getAttribute('data-theme')).toBe('night');
    expect(night.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Day' }).getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('day');
  });
});

describe('print', () => {
  it('print stylesheet hides graticule', () => {
    const start = printCss.indexOf('@media print');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = printCss.slice(start).trim();
    const tokens = cssBlock(block, ':root,\n  [data-theme]');
    expect(cssVar(tokens, 'graticule')).toBe('none');
    // Day colours on white, whatever the screen theme; magenta prints as ink.
    expect(cssVar(tokens, 'paper')).toBe('#FFFFFF');
    expect(cssVar(tokens, 'magenta')).toBe(cssVar(tokens, 'ink'));
    expect(block).toMatchSnapshot();
  });
});

describe('StatusBadge', () => {
  it('uses the UI_DESIGN §4.2 badge text and shows raw codes for other statuses', () => {
    const cases = [
      ['completed', 'COMPLETED'],
      ['in_progress', 'IN PROGRESS'],
      ['status_unknown', 'STATUS UNKNOWN'],
      ['other_status', 'OTHER STATUS'],
      ['not_completed', 'NOT COMPLETED'],
    ] as const;
    for (const [kind, text] of cases) {
      const { unmount, container } = render(<StatusBadge kind={kind} rawStatus="P" />);
      expect(screen.getByText(text)).toBeTruthy();
      expect(container.textContent?.includes('NTSB status: P')).toBe(kind !== 'completed');
      unmount();
    }
    render(<StatusBadge kind="status_unknown" rawStatus="  " />);
    expect(screen.getByText(/NTSB status: blank/)).toBeTruthy();
  });
});

describe('DataCaution', () => {
  it('always labels the hatching, and marks AI-flagged cautions', () => {
    const { container } = render(
      <>
        <DataCaution>The header and narrative disagree.</DataCaution>
        <DataCaution variant="chip" label=" ">
          Dates disagree
        </DataCaution>
        <DataCaution variant="chip" ai>
          Narrative dates disagree
        </DataCaution>
      </>,
    );
    expect(screen.getAllByText('Data caution')).toHaveLength(3);
    // Labels are at least the 9.5px label size (UI_DESIGN §2.3).
    for (const label of screen.getAllByText('Data caution')) expect(label.closest('.text-micro')).not.toBeNull();
    expect(container.querySelectorAll('.hatch')).toHaveLength(3);
    expect(screen.getByText('AI')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('The header and narrative disagree.');
  });
});

describe('Button', () => {
  it('appends the counter after a middle dot', () => {
    render(
      <Button variant="ai" counter="3 free">
        Ask AI
      </Button>,
    );
    const button = screen.getByRole('button');
    expect(button.textContent).toBe('Ask AI · 3 free');
    expect(button.getAttribute('type')).toBe('button');
  });
});

describe('frame', () => {
  afterEach(() => vi.useRealTimers());

  it('prints the local date, not the UTC date', () => {
    expect(localIsoDate(new Date(2026, 9, 22, 23, 59))).toBe('2026-10-22');
    expect(localIsoDate(new Date(2026, 0, 1, 0, 1))).toBe('2026-01-01');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 22, 23, 59));
    const { container } = render(
      <MemoryRouter>
        <Footer snapshotDate={null} />
      </MemoryRouter>,
    );
    expect(container.querySelectorAll('footer p')[1]?.textContent).toBe(
      'Not an NTSB service · Source: NTSB · printed 22 OCT 2026',
    );
  });

  it('footer reads as UI_DESIGN §3 with the snapshot date', () => {
    const { container } = render(
      <MemoryRouter>
        <Footer snapshotDate="2026-10-01" printedDate="2026-10-22" />
      </MemoryRouter>,
    );
    const [screenLine, printLine] = container.querySelectorAll('footer p');
    expect(screenLine?.textContent).toBe('Not an NTSB service · Data: NTSB, snapshot 01 OCT 2026 · Privacy · About');
    expect(printLine?.textContent).toBe('Not an NTSB service · Source: NTSB · printed 22 OCT 2026');
    expect(screen.getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe('/privacy');
    expect(screen.getByRole('link', { name: 'About' }).getAttribute('href')).toBe('/about');
  });

  it('header marks the active section and fills the AI counter and auth slots', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Header aiCounter={<span>AI searches left: 3 of 3</span>} auth={<button type="button">Sign in</button>} />
      </MemoryRouter>,
    );
    const [desktopNav] = screen.getAllByRole('navigation', { name: 'Main' });
    expect(within(desktopNav!).getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBe('page');
    expect(within(desktopNav!).getByRole('link', { name: 'Explore' }).getAttribute('aria-current')).toBeNull();
    // 44px targets on touch tablets, where the desktop nav shows.
    expect(within(desktopNav!).getByRole('link', { name: 'Explore' }).className).toContain('pointer-coarse:min-h-11');
    expect(screen.getByText('AI searches left: 3 of 3')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Sign in' }).length).toBeGreaterThan(0);
  });

  it('phone menu opens, and Escape closes it and returns focus', () => {
    render(
      <MemoryRouter>
        <Header />
      </MemoryRouter>,
    );
    const toggle = screen.getByRole('button', { name: 'Menu' });
    const menu = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(menu?.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(menu?.hidden).toBe(false);
    fireEvent.keyDown(menu!, { key: 'Escape' });
    expect(menu?.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });
});
