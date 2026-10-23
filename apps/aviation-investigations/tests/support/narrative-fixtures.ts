/**
 * Synthetic Track N case records for unit tests (case numbers are fixtures, not real
 * NTSB cases): the database row shape `loadCaseEvidence` reads, and the evidence built
 * from it.
 */
import { assembleCaseRecords } from '../../server/db/queries/case-records.js';
import { caseRecordRows, evidenceOf, type CaseEvidence } from '../../evals/retrieval/narrative/evidence.js';
import { sha256 } from '../../evals/retrieval/narrative/spec.js';

export const FACTUAL =
  'The pilot reported that the engine lost total power during the climb after takeoff. He performed a forced landing in a field.\n\n' +
  'Postaccident examination of the engine revealed no mechanical malfunctions or anomalies that would have precluded normal operation.';
export const PROBABLE = 'A total loss of engine power for reasons that could not be determined because postaccident examination did not reveal any anomalies.';

/** A synthetic record in the database's row shape (case numbers are fixtures). */
export function rows(over: { factual?: string; probable?: string; badSha?: boolean } = {}) {
  const factual = over.factual ?? FACTUAL;
  const probable = over.probable ?? PROBABLE;
  return caseRecordRows({
    cases: [
      {
        ntsb_no: 'FIX20NV001',
        country: 'USA',
        is_us: true,
        latitude: null,
        longitude: null,
        ev_date: '2020-05-04',
        ev_year: 2020,
        city: 'Boulder City',
        state: 'NV',
        light_cond: 'DAYL',
        wx_cond_basic: 'VMC',
        highest_injury: 'MINR',
        raw_status: 'Completed',
        completion_class: 'completed',
        has_probable_cause: true,
        completed_with_cause: true,
        answer_eligible: true,
        defining_phase_groups: ['initial_climb'],
        sequence_phase_groups: ['initial_climb'],
      },
    ],
    aircraft: [
      {
        ntsb_no: 'FIX20NV001',
        aircraft_key: 1,
        aircraft_ntsb_no: null,
        make: 'Cessna',
        model: '182',
        category: 'AIR',
        far_part: '091',
        purpose: 'SKYD',
        damage: 'SUBS',
        homebuilt: false,
        defining_occurrence_no: 2,
        defining_phase_group: 'initial_climb',
        defining_event_conflict: false,
        sequence_phase_groups: ['initial_climb'],
      },
    ],
    engines: [{ ntsb_no: 'FIX20NV001', aircraft_key: 1, eng_no: 1, eng_type: 'REC' }],
    sections: [
      {
        ntsb_no: 'FIX20NV001',
        section_id: 'FIX20NV001:probable_cause/aircraft-1',
        section_key: 'probable_cause/aircraft-1',
        kind: 'probable_cause',
        scope: 'aircraft',
        aircraft_key: 1,
        text: probable,
        sha256: sha256(probable),
        revision_id: 'b'.repeat(64),
        citation_text_version: 'v1',
      },
      {
        ntsb_no: 'FIX20NV001',
        section_id: 'FIX20NV001:factual/aircraft-1',
        section_key: 'factual/aircraft-1',
        kind: 'factual',
        scope: 'aircraft',
        aircraft_key: 1,
        text: factual,
        sha256: over.badSha ? 'c'.repeat(64) : sha256(factual),
        revision_id: 'a'.repeat(64),
        citation_text_version: 'v1',
      },
    ],
    findings: [
      { ntsb_no: 'FIX20NV001', aircraft_key: 1, finding_no: 1, code: '0105850000', description: 'Aircraft-Aircraft power plant-Engine (reciprocating)-(general)-Unknown/Not determined - C', in_probable_cause: true },
    ],
    sequence: [
      { ntsb_no: 'FIX20NV001', aircraft_key: 1, occurrence_no: 1, phase_no: 1, phase_group: 'initial_climb', event_code: '341', description: 'Initial climb Loss of engine power (total)', is_defining: true },
    ],
  });
}
export const evidence = (over: Parameters<typeof rows>[0] = {}): CaseEvidence => evidenceOf(assembleCaseRecords(1, rows(over))[0] as never);

