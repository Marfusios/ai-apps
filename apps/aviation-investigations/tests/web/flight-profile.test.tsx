import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FlightProfile, type FlightProfileStep } from '../../web/src/components/FlightProfile';
import { FRAMES, layoutProfile, profileAccessibleName, profileCaption } from '../../web/src/components/flight-profile-layout';

/** DFW08TA066: total power loss while maneuvering, then the descent to terrain. */
const DFW: FlightProfileStep[] = [
  { phaseGroup: 'maneuvering', eventLabel: 'Loss of engine power (total)', isDefining: true, impact: false },
  { phaseGroup: 'emergency_descent', eventLabel: 'Collision with terrain', isDefining: false, impact: true },
];

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
    const cfit: FlightProfileStep[] = [
      { phaseGroup: 'en_route', eventLabel: 'VFR encounter with IMC', isDefining: false, impact: false },
      { phaseGroup: 'en_route', eventLabel: 'Controlled flight into terrain', isDefining: true, impact: true },
    ];
    const layout = layoutProfile(cfit, FRAMES.full);
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
});
