/**
 * Labels v2 (Task 16d; 16c review I4, 16d gate): corrections of the 16c labels, each with
 * its reason. The v1 dataset (`dataset.json`) and its results stay as they are; these apply
 * to the v1 inputs when the 16c recordings are re-read (`v1LabelsV2`) and to dataset v2.
 * `inputs` says which inputs a correction is for: the 16c inputs had no case headers, so a
 * detail only the header gives (an aircraft model) was unsupported there, and it is
 * server data in the 16d inputs.
 *
 * Sources: the 16c report's "disputed labels", the 16c review's label audit (§5, I4, M3,
 * M4, M5) and a re-review of the most-flagged supported brief claims against the complete
 * supplied passages (model-reviewed; no label is expert ground truth). A claim review
 * cannot settle stays `unknown`: a brief with one never counts as wholly supported, and
 * the unknown-label coverage is reported.
 */
import type { BriefClaimLabel, Label } from './types.js';

export const LABELS_V2_VERSION = 'checker-labels-v2';

const ENGINE_HOURS =
  'The passage counts these hours from the maintenance records ("about 198 hours after the cylinders were replaced"; "the engine had been operated for about 1,130 hours since its last overhaul") and never calls them flight hours; the claim asserts flight hours (16c review I4, M4).';

/** A brief claim, by brief spec id and stable claim key; every variant of the brief inherits it. */
export const BRIEF_LABELS_V2: readonly (BriefClaimLabel & { brief: string })[] = [
  ...['holdout.b6', 'holdout.b6-first'].flatMap((brief): (BriefClaimLabel & { brief: string })[] => [
    {
      brief,
      key: 'case.CEN17LA292.timing.0',
      label: 'not_supported',
      family: 'timing',
      mutation: 'operating_hours_as_flight_hours',
      expect: 'not_established',
      reason: `"about 198 flight hours": ${ENGINE_HOURS}`,
    },
    {
      brief,
      key: 'case.ERA15LA377.timing.0',
      label: 'not_supported',
      family: 'timing',
      mutation: 'operating_hours_as_flight_hours',
      expect: 'not_established',
      reason: `"about 1130 flight hours": ${ENGINE_HOURS}`,
    },
  ]),
  {
    brief: 'holdout.b8',
    key: 'summary.0',
    label: 'not_supported',
    family: 'unsupported_addition',
    mutation: 'added_detail',
    expect: 'not_established',
    inputs: 'v1',
    reason:
      'No supplied passage names a Cessna 150M (ERA15MA259\'s passages are event-scoped and the 16c check input had no case header), and "did not resolve the conflict" is not "failure to provide an appropriate resolution to the conflict" (16c review I4, M5).',
  },
  {
    brief: 'holdout.b8',
    key: 'summary.0',
    label: 'unknown',
    inputs: 'v2',
    reason:
      'With the case header as server data the aircraft are named, but "did not resolve the conflict" for "failure to provide an appropriate resolution to the conflict" drops "appropriate": review cannot settle whether that changes the meaning.',
  },
  {
    brief: 'holdout.b8',
    key: 'summary.1',
    label: 'unknown',
    reason:
      '"In the other three cases" refers to the sentence before it; the substance (both pilots or both instructors failed to see and avoid) is in every cited probable cause, but read alone the claim needs context outside itself (16c report; 16c review I4).',
  },
  ...['dev.b1', 'dev.b1-hours'].map(
    (brief): BriefClaimLabel & { brief: string } => ({
      brief,
      key: 'summary.2',
      label: 'unknown',
      reason:
        '"the engines failed" covers WPR23LA307, which had a partial loss of engine power (P1); whether "failed" overstates a partial loss is a judgment call (16c report; 16c review I4).',
    }),
  ),
  {
    brief: 'dev.b2',
    key: 'case.WPR14LA118.timing.1',
    label: 'unknown',
    reason:
      '"about 42 calendar days" for the pilot-reported "about 6 weeks" (P5): an exact unit conversion that keeps "about", or day-level precision from a week-level approximation; review cannot settle it (16c report; 16c review I4).',
  },
  {
    brief: 'holdout.b5',
    key: 'case.CEN23LA246.criterion.timing_window',
    label: 'unknown',
    reason:
      'The "at most 11 days" behind this decision is worked out from "Eleven days before the accident flight, the pilot observed …", a time measured from the observation, not from the maintenance; under the timing rules a time from another anchor settles nothing, so the claim is supported only under a lenient reading (16c review M3).',
  },
];

/** A claim-batch item, by batch id and item id. */
export const CLAIM_LABELS_V2: readonly (Omit<BriefClaimLabel, 'key' | 'label'> & { batch: string; item: string; label: Label })[] = [
  {
    batch: 'holdout.oil',
    item: 'cen23.window',
    label: 'unknown',
    reason:
      'The same decision as holdout.b5\'s: "within 30 calendar days" rests on a limit worked out from a time measured from the pilot\'s observation, which the timing rules do not count (16c review M3).',
  },
  {
    batch: 'holdout.midair',
    item: 'era15.recs',
    label: 'not_supported',
    family: 'unsupported_addition',
    mutation: 'added_detail',
    expect: 'not_established',
    inputs: 'v1',
    reason: 'No supplied passage names a Cessna 150M, and the 16c check input had no case header (16c review I4, M5).',
  },
];
