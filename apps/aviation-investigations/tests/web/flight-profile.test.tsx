import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FlightProfile, type FlightProfileStep } from '../../web/src/components/FlightProfile';
import {
  FRAMES,
  layoutProfile,
  profileAccessibleName,
  profileCaption,
  type Box,
  type ProfileLayout,
} from '../../web/src/components/flight-profile-layout';

/** DFW08TA066: total power loss while maneuvering, then the descent to terrain. */
const DFW: FlightProfileStep[] = [
  { phaseGroup: 'maneuvering', eventLabel: 'Loss of engine power (total)', isDefining: true, impact: false },
  { phaseGroup: 'emergency_descent', eventLabel: 'Collision with terrain', isDefining: false, impact: true },
];

const CFIT: FlightProfileStep[] = [
  { phaseGroup: 'en_route', eventLabel: 'VFR encounter with IMC', isDefining: false, impact: false },
  { phaseGroup: 'en_route', eventLabel: 'Controlled flight into terrain', isDefining: true, impact: true },
];

/** End points of each segment of an SVG path made of M, H, L and C commands. */
function segments(d: string | null): Box[] {
  if (!d) return [];
  const boxes: Box[] = [];
  let x = 0;
  let y = 0;
  for (const [, command, args] of d.matchAll(/([MHLC])([^MHLC]*)/g)) {
    const n = (args ?? '').trim().split(/[\s,]+/).map(Number);
    const [nx, ny] = command === 'H' ? [n[0]!, y] : [n[n.length - 2]!, n[n.length - 1]!];
    if (command !== 'M') {
      boxes.push({ x1: Math.min(x, nx), y1: Math.min(y, ny), x2: Math.max(x, nx), y2: Math.max(y, ny) });
    }
    x = nx;
    y = ny;
  }
  return boxes;
}

const intersects = (a: Box, b: Box): boolean => a.x1 <= b.x2 && b.x1 <= a.x2 && a.y1 <= b.y2 && b.y1 <= a.y2;

function labelClearOfLines(layout: ProfileLayout): void {
  const box = layout.defining!.labelBox;
  for (const segment of [...segments(layout.flown), ...segments(layout.after)]) {
    expect(intersects(box, segment), `label ${JSON.stringify(box)} crosses ${JSON.stringify(segment)}`).toBe(false);
  }
}

describe('FlightProfile', () => {
  it('names itself as a schematic, not to scale, with every step', () => {
    const name =
      'Schematic flight profile, not to scale: Maneuvering, Loss of engine power (total), defining event; ' +
      'then Emergency descent, Collision with terrain, impact.';
    expect(profileAccessibleName(DFW)).toBe(name);
    render(<FlightProfile steps={DFW} size="mini" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(name);
    expect(screen.getByText('MANEUVERING · LOSS OF ENGINE POWER (TOTAL)')).toBeTruthy();
  });

  it('draws blue up to the defining event, its ring, ink dashes after and an ✕ on impact', () => {
    const { container } = render(<FlightProfile steps={DFW} size="full" />);
    for (const svg of container.querySelectorAll('svg[data-profile="full"]')) {
      expect(svg.getAttribute('aria-label')).toMatch(/^Schematic flight profile, not to scale: /);
      expect(svg.querySelector('[data-segment="flown"]')?.getAttribute('class')).toContain('stroke-blue');
      const after = svg.querySelector('[data-segment="after"]');
      expect(after?.getAttribute('class')).toContain('stroke-ink');
      expect(after?.getAttribute('stroke-dasharray')).toBeTruthy();
      expect(svg.querySelectorAll('[data-mark="defining"] circle')).toHaveLength(2);
      expect(svg.querySelectorAll('[data-mark="impact"]')).toHaveLength(1);
      expect(svg.textContent).toContain('Loss of engine power (total)');
      expect(svg.textContent).toContain('MANEUVERING');
      expect(svg.textContent).toContain('EMERG. DESCENT');
    }
  });

  it('is deterministic', () => {
    const a = layoutProfile(DFW, FRAMES.full);
    expect(layoutProfile(DFW, FRAMES.full)).toEqual(a);
    expect({ flown: a.flown, after: a.after, defining: a.defining, impacts: a.impacts }).toMatchSnapshot();
  });

  it('maps phases to schematic heights: ground low, en route high, approach between', () => {
    const level = (phaseGroup: FlightProfileStep['phaseGroup']): number =>
      layoutProfile([{ phaseGroup, eventLabel: 'x', isDefining: true, impact: false }], FRAMES.full).defining!.y;
    const ground = FRAMES.full.ground;
    expect(level('taxi')).toBe(ground);
    expect(level('en_route')).toBe(FRAMES.full.ceiling);
    expect(level('approach')).toBeLessThan(ground);
    expect(level('approach')).toBeGreaterThan(level('en_route'));
    expect(level('initial_climb')).toBeLessThan(level('takeoff'));
  });

  it('puts an impact on the ground, even when it is the defining event', () => {
    const layout = layoutProfile(CFIT, FRAMES.full);
    expect(layout.defining).toMatchObject({ y: FRAMES.full.ground, impact: true });
    expect(layout.impacts).toEqual([{ x: layout.defining!.x, y: FRAMES.full.ground }]);
    expect(layout.after).toBeNull();
  });

  it('draws the whole flight blue when no step is defining', () => {
    const layout = layoutProfile(
      [
        { phaseGroup: 'approach', eventLabel: 'Hard landing', isDefining: false, impact: false },
        { phaseGroup: 'landing', eventLabel: 'Runway excursion', isDefining: false, impact: false },
      ],
      FRAMES.mini,
    );
    expect(layout.defining).toBeNull();
    expect(layout.after).toBeNull();
    expect(layout.flown).not.toBe('');
  });

  it('handles an empty sequence', () => {
    render(<FlightProfile steps={[]} size="mini" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
      'Schematic flight profile, not to scale: no event sequence on record.',
    );
    expect(profileCaption([])).toBe('NO EVENT SEQUENCE');
  });

  it('keeps labels inside the frame and truncates long ones', () => {
    const long: FlightProfileStep[] = Array.from({ length: 6 }, (_, i) => ({
      phaseGroup: 'en_route',
      eventLabel: `A very long published event description number ${i}`,
      isDefining: i === 3,
      impact: false,
    }));
    for (const frame of [FRAMES.full, FRAMES.fullNarrow]) {
      const layout = layoutProfile(long, frame);
      for (const label of layout.labels) {
        expect(label.x).toBeGreaterThanOrEqual(0);
        expect(label.x).toBeLessThanOrEqual(frame.width);
      }
      expect(layout.labels.filter((l) => l.row === 0)).toHaveLength(1);
      expect(layout.labels.some((l) => l.text.endsWith('…'))).toBe(true);
    }
  });

  it('keeps the defining label off the incoming descent into a CFIT impact', () => {
    for (const frame of [FRAMES.full, FRAMES.fullNarrow]) {
      const layout = layoutProfile(CFIT, frame);
      const incoming = segments(layout.flown).at(-1)!;
      // The incoming segment is the descent from en route to the impact on the ground.
      expect(incoming).toMatchObject({ y1: frame.ceiling, y2: frame.ground, x2: layout.defining!.x });
      expect(intersects(layout.defining!.labelBox, incoming)).toBe(false);
      labelClearOfLines(layout);
      // Lifted above the descent, with a leader down to the ring.
      expect(layout.defining!.leader).not.toBeNull();
      expect(layout.defining!.leader!.y2).toBeLessThan(layout.defining!.y);
    }
  });

  it('keeps the defining label off every line for climbs, descents and go-arounds', () => {
    const sequences: FlightProfileStep[][] = [
      DFW,
      [
        { phaseGroup: 'en_route', eventLabel: 'Fuel exhaustion', isDefining: false, impact: false },
        { phaseGroup: 'approach', eventLabel: 'Loss of engine power (total)', isDefining: true, impact: false },
        { phaseGroup: 'landing', eventLabel: 'Off-field or emergency landing', isDefining: false, impact: false },
      ],
      [
        { phaseGroup: 'approach', eventLabel: 'Unstabilized approach', isDefining: true, impact: false },
        { phaseGroup: 'en_route', eventLabel: 'Go-around', isDefining: false, impact: false },
        { phaseGroup: 'landing', eventLabel: 'Hard landing', isDefining: false, impact: false },
      ],
    ];
    for (const steps of sequences) {
      for (const frame of [FRAMES.full, FRAMES.fullNarrow]) labelClearOfLines(layoutProfile(steps, frame));
    }
  });

  it('leaves the label on the dot when nothing rises above it', () => {
    const layout = layoutProfile(DFW, FRAMES.full);
    expect(layout.defining!.labelY).toBe(Math.round((layout.defining!.y - 13) * 10) / 10);
    expect(layout.defining!.leader).toBeNull();
  });

  it('draws the leader for a lifted label', () => {
    const { container } = render(<FlightProfile steps={CFIT} size="full" />);
    expect(container.querySelectorAll('[data-mark="leader"]').length).toBe(2);
  });
});
