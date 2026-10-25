/** Synthetic server-test evidence, independent of the UI and MSW contract fixtures. */
import { EvidenceCaseSchema, type EvidenceCase } from '../../shared/contracts/evidence.js';
import { SEARCH_FALLBACK_LINK } from '../../server/projection/cases.js';

export function syntheticEvidenceCases(count = 2): EvidenceCase[] {
  const text = 'The engine lost power during the flight.';
  return Array.from({ length: count }, (_, i) => EvidenceCaseSchema.parse({
    rank: i + 1, case: { ntsbNo: `CEN19LA${String(i + 1).padStart(3, '0')}`, date: '2019-01-01', city: 'Example',
      state: { code: 'CA', label: 'California' }, country: 'USA', eventType: { code: 'ACC', label: 'Accident' },
      aircraft: [], definingPhases: [], conditions: { code: 'VMC', label: 'Visual' }, light: { code: 'DAYL', label: 'Day' },
      highestInjury: { code: 'NONE', label: 'None' }, completion: { class: 'completed', rawStatus: 'B', hasProbableCause: true,
        mappingVersion: 'v1-empirical', mappingVerified: false } },
    report: SEARCH_FALLBACK_LINK,
    probableCauses: [{ sectionKey: 'probable_cause/event-1', scope: 'event', aircraftKey: null, revision: 'a'.repeat(64), text: 'A loss of engine power for undetermined reasons.' }],
    excerpts: [{ sectionKey: 'analysis/event-1', section: 'analysis', label: 'Analysis', scope: 'event', aircraftKey: null,
      revision: 'b'.repeat(64), paragraph: { start: 0, end: text.length }, seed: { start: 4, end: 20 }, text, highlights: [] }],
    relevance: { filters: [], terms: [], channels: ['keyword'] },
  }));
}
