import { describe, expect, it } from 'vitest';
import { aircraftLetter, buildHeadline, dataCautions, displayMake, findingText } from '../../shared/case-view.js';

const hughes = {
  make: 'Hughes',
  model: 'OH-6',
  categoryCode: 'HELI',
  definingEvent: { phase: 'maneuvering' as const, phaseCode: '453', eventCode: '341' },
};

describe('headline template (UI_DESIGN §4.5)', () => {
  it('names the aircraft, category noun, defining event, phase and place', () => {
    expect(buildHeadline({ aircraft: [hughes], eventTypeCode: 'ACC', city: 'Valentine', stateCode: 'TX' })).toBe(
      'Hughes OH-6 helicopter, total loss of engine power in a hover near Valentine, Texas',
    );
  });

  it('leaves out the category noun for airplanes and tidies upper-case makes', () => {
    const piper = {
      make: 'PIPER AIRCRAFT INC',
      model: 'PA-46-600TP',
      categoryCode: 'AIR',
      definingEvent: { phase: 'landing' as const, phaseCode: '550', eventCode: '230' },
    };
    expect(buildHeadline({ aircraft: [piper], eventTypeCode: 'ACC', city: 'THEDFORD', stateCode: 'NE' })).toBe(
      'Piper PA-46-600TP, loss of control on the ground on landing near Thedford, Nebraska',
    );
    expect(displayMake('Barnard/Stancil')).toBe('Barnard/Stancil');
    expect(displayMake('AMERICAN CHAMPION AIRCRAFT')).toBe('American Champion');
  });

  it('multi-aircraft form keeps only what every aircraft shares', () => {
    const a = { make: 'PIPER', model: 'PA 28-180', categoryCode: 'AIR', definingEvent: { phase: 'landing' as const, phaseCode: '550', eventCode: '250' } };
    const b = { make: 'Barnard/Stancil', model: 'Glastar', categoryCode: 'AIR', definingEvent: { phase: 'initial_climb' as const, phaseCode: '350', eventCode: '250' } };
    expect(buildHeadline({ aircraft: [a, b], eventTypeCode: 'ACC', city: 'Sonoma', stateCode: 'CA' })).toBe(
      'Piper PA 28-180 and Barnard/Stancil Glastar, midair collision near Sonoma, California',
    );
    const c = { ...b, definingEvent: { ...b.definingEvent, eventCode: '470' } };
    expect(buildHeadline({ aircraft: [a, c, a], eventTypeCode: 'ACC', city: 'Sonoma', stateCode: 'CA' })).toBe(
      'Piper PA 28-180, Barnard/Stancil Glastar and 1 other aircraft accident near Sonoma, California',
    );
  });

  it('falls back to the event type without a defining event', () => {
    const airbus = { make: 'AIRBUS', model: 'A330', categoryCode: 'AIR', definingEvent: null };
    expect(buildHeadline({ aircraft: [airbus], eventTypeCode: 'INC', city: 'Boston', stateCode: 'MA' })).toBe(
      'Airbus A330 incident near Boston, Massachusetts',
    );
  });
});

describe('findings and cautions', () => {
  it('drops the deprecated cause/factor marker so it never reads as a label', () => {
    expect(findingText('Aircraft-Aircraft handling/service-Maintenance/inspections-(general)-Incorrect service/maintenance - C')).toBe(
      'Aircraft-Aircraft handling/service-Maintenance/inspections-(general)-Incorrect service/maintenance',
    );
    expect(findingText('Environmental issues-Physical environment-Terrain-Rough terrain-Contributed to outcome ')).toBe(
      'Environmental issues-Physical environment-Terrain-Rough terrain-Contributed to outcome',
    );
    expect(findingText('   ')).toBeNull();
  });

  it('flags blank status, an injury code that disagrees with the counts, and shared narratives', () => {
    const base = {
      rawStatus: 'B',
      completed: true,
      hasProbableCause: true,
      highestInjuryCode: 'MINR',
      injuries: { fatal: 0, serious: 0, minor: 1 },
      aircraftCount: 1,
      hasEventScopedSections: false,
      definingConflicts: [],
    };
    expect(dataCautions(base)).toEqual([]);
    expect(dataCautions({ ...base, rawStatus: null }).map((c) => c.kind)).toEqual(['status_blank']);
    expect(dataCautions({ ...base, rawStatus: 'P', completed: false }).map((c) => c.kind)).toEqual(['status_conflict']);
    const injury = dataCautions({ ...base, injuries: { fatal: 0, serious: 1, minor: 0 } });
    expect(injury[0]?.text).toBe('The coded highest injury is minor, but the injury counts list 1 serious. Both are shown as published.');
    expect(dataCautions({ ...base, aircraftCount: 2, hasEventScopedSections: true }).map((c) => c.kind)).toEqual(['shared_narrative']);
  });

  it('letters aircraft by their suffixed number', () => {
    expect(aircraftLetter('SEA08LA057', 'SEA08LA057B', 0)).toBe('B');
    expect(aircraftLetter('DFW08TA066', 'DFW08TA066', 0)).toBe('A');
  });
});
