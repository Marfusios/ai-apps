/**
 * Labels v3 (Task 16e; the 16d verdict's "next round"): labels v2 with a versioned errata
 * overlay, `checker-errata-v1`. The frozen datasets (`dataset.json`, `dataset.v2.json`) and
 * every result computed from them stay as they are; the overlay applies when dataset v3 is
 * built and when the 16c and 16d recordings are re-read (`pnpm eval:checker simulate`), so
 * each correction's effect can be shown.
 *
 * - **Errata** change a label, each with its source and reason: the four development errata
 *   the 16d report recorded and did not correct in its frozen set, the "third flight" claims
 *   (a claim-batch item and a 16c brief's three claims) the 16d verdict's finding 2 rules
 *   out, and the "same mechanic" excerpt the excerpt policy (`excerpt-context-v1`) and the
 *   gate's list of unresolved references rule out.
 * - **Disputed** labels stay as they are, flagged: review found them arguable but not
 *   wrong (the 16d review's §7). The sensitivity figures treat them as `unknown`.
 *
 * No label is expert ground truth: every correction here is model-reviewed against the
 * complete supplied passages, and the frozen hash of each split binds the result.
 */
import type { BriefClaimLabel, Label } from './types.js';

export const ERRATA_VERSION = 'checker-errata-v1';
export const LABELS_V3_VERSION = 'checker-labels-v3';

type ClaimCorrection = Omit<BriefClaimLabel, 'key' | 'label' | 'inputs'> & { label: Label; source: string };
type BriefCorrection = Omit<BriefClaimLabel, 'inputs'> & { source: string };

const ENGINE_HOURS =
  'The passage counts these hours without calling them flight hours ("about N hours" from maintenance records); the claim says flight hours. Under labels v2 (16c review M4) that is `operating_hours_as_flight_hours`; the 16d report listed this item as an erratum it did not correct.';

/** Claim-batch items, by batch id and item id. */
export const CLAIM_ERRATA: readonly (ClaimCorrection & { batch: string; item: string })[] = [
  { batch: 'holdout.engine', item: 'era13.hours', label: 'not_supported', family: 'timing', mutation: 'operating_hours_as_flight_hours', expect: 'not_established', source: '16d report, labels v2 errata', reason: ENGINE_HOURS },
  { batch: 'holdout.engine', item: 'cen17.hours', label: 'not_supported', family: 'timing', mutation: 'operating_hours_as_flight_hours', expect: 'not_established', source: '16d report, labels v2 errata', reason: ENGINE_HOURS },
  { batch: 'dev.midair2', item: 'era24.about', label: 'not_supported', family: 'timing', mutation: 'operating_hours_as_flight_hours', expect: 'not_established', source: '16d report, labels v2 errata', reason: ENGINE_HOURS },
  {
    batch: 'dev.paid',
    item: 'c01',
    label: 'not_supported',
    family: 'timing',
    mutation: 'wrong_ordinal',
    expect: 'not_established',
    source: '16d verdict, finding 2',
    reason:
      'P6 narrates the first and second flights after the installation and says the accident flight "was conducted 2 days later": the passage does not say that no flight came in between, so "the third flight" is not established (no explicit ordinal and no complete count; ordinal-evidence-v1).',
  },
  {
    batch: 'dev.paid',
    item: 'c16',
    label: 'unknown',
    source: '16d verdict, finding 2',
    reason:
      'The label added up the three narrated flights (about 5, 10 and 30 minutes); with flights possibly unreported in the 2 days and no date for the installation, the passages bound neither the flight hours nor the days, so review cannot settle "within 30 calendar days or 10 flight hours".',
  },
];

const THIRD_FLIGHT =
  'The brief puts the event on "the third flight" after the installation. P6 narrates the first and second flights after it and says the accident flight "was conducted 2 days later": it does not say that no flight came in between, so the ordinal is not established (no explicit ordinal and no complete count; ordinal-evidence-v1). The same claim as dev.paid c01.';

/**
 * Brief claims, by brief spec id and stable claim key. A brief's error variants inherit
 * them; a reading variant is a spec of its own (`dev.b1-hours`, `holdout.b5-week`) and is
 * listed with the same correction.
 */
export const BRIEF_ERRATA: readonly (BriefCorrection & { brief: string })[] = [
  ...['dev.b1', 'dev.b1-hours'].flatMap((brief) => ['summary.1', 'case.WPR18LA021.why', 'case.WPR18LA021.timing.0'].map((key) => ({ brief, key }))).map(({ brief, key }) => ({
    brief,
    key,
    label: 'not_supported' as const,
    family: 'timing' as const,
    mutation: 'wrong_ordinal',
    expect: 'not_established' as const,
    source: '16d verdict, finding 2',
    reason: THIRD_FLIGHT,
  })),
  ...['holdout.b5', 'holdout.b5-week'].map((brief) => ({
    brief,
    key: 'case.CEN23LA246.timing.0',
    label: 'unknown' as const,
    source: '16d report, labels v2 errata',
    reason:
      '"at most 11 calendar days" is worked out from "Eleven days before the accident flight, the pilot observed …", a time from the observation, not from the maintenance (16c review M3); labels v2 made the criterion claim built on it `unknown` and left this one.',
  })),
  {
    brief: 'holdout16d.throttle',
    key: 'case.ERA13LA342.quote.1',
    label: 'not_supported',
    family: 'attribution',
    mutation: 'quote_context_loss',
    expect: 'not_established',
    source: '16e excerpt policy; 16d verdict, finding 1',
    reason:
      '"…by the same mechanic.": the excerpt does not say the same as whom (the sentence before it), and the gate lists "the same" among the unresolved references an excerpt may not keep; the claim says the words keep their meaning without the surrounding text.',
  },
];

/** Labels kept as they are and flagged: arguable, not wrong (the 16d review, §7). Sensitivity reads them as `unknown`. */
export const DISPUTED: readonly { brief: string; key: string; reason: string }[] = [
  ...['holdout16d.day-after', 'holdout16d.day-after-hours'].map((brief) => ({
    brief,
    key: 'case.CEN14FA434.classification',
    reason:
      'The "insufficient" classification follows the probable cause (the reason could not be determined because thermal damage prevented a complete examination); a limited examination that found nothing could also be read as a negative one (16d review §7: defensible, disputable).',
  })),
  ...['summary.0', 'case.ERA13LA342.why'].map((key) => ({
    brief: 'holdout16d.throttle',
    key,
    reason: '"came loose 6 days and 1 flight hour after the most recent engine maintenance": the passages date the maintenance relative to the accident, not the separation (16d review §7: arguable).',
  })),
];
