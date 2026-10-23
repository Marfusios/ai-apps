/**
 * Task 16d development additions (dataset v2, development split): the regressions the 16d
 * gate added for check.v7. A complete sentence of a finding or an analysis does not keep
 * its meaning when it needs words outside it to say what it is about ("This failure
 * caused the loss of power"): check.v5 said it did. Each regression is a real sentence of
 * the bundle whose subject points back to the sentence before it, with controls that name
 * what they are about. The maximum-size inputs (60 claims) are derived in build.ts from
 * these bundles' reviewed claims.
 */
import type { BriefSpec, ClaimBatch } from '../types.js';
import { no, said, yes } from './helpers.js';

const CONTEXT = (what: string) => `The excerpt needs the sentence before it to say which ${what} it means; read alone it does not say what it is about (16d gate: complete sentences need their antecedent too).`;

/** q-power-loss-maintenance: ERA20LA050 (P2, P3). */
const POWER: ClaimBatch = {
  id: 'dev16d.context-power',
  bundle: 'q-power-loss-maintenance',
  cases: ['ERA20LA050'],
  claims: [
    no(
      'era20.these',
      'attribution',
      'ERA20LA050',
      ['P2'],
      said(
        'investigators',
        'These discrepancies were consistent with improper maintenance practices on the fuel system and likely resulted in a reduction in fuel flow during the initial climb after takeoff, and a loss of engine power due to fuel starvation.',
      ),
      'attribution',
      'quote_context_loss',
      'not_established',
      CONTEXT('discrepancies (the weak fuel pump, the misplaced electric pump, the finger-tight fittings)'),
      { critical: true },
    ),
    yes(
      'era20.pc',
      'attribution',
      'ERA20LA050',
      ['P3'],
      said('investigators', 'Improper maintenance practices on the fuel system causing fuel starvation and a total loss of engine power.'),
      'P3, the probable cause, whole: it names what it is about.',
    ),
  ],
};

/** q-fuel-line-fitting: ERA21LA127 (P7, P8, P9). */
const FUEL: ClaimBatch = {
  id: 'dev16d.context-fuel',
  bundle: 'q-fuel-line-fitting',
  cases: ['ERA21LA127'],
  claims: [
    no(
      'era21.this',
      'attribution',
      'ERA21LA127',
      ['P8'],
      said('investigators', 'This deformation may have inhibited the proper frictional resistance in the threads to prevent the nut from backing off in service.'),
      'attribution',
      'quote_context_loss',
      'not_established',
      CONTEXT('deformation (of the soft adapter shoulder under the retaining ring)'),
      { critical: true },
    ),
    no(
      'era21.next',
      'attribution',
      'ERA21LA127',
      ['P8'],
      said('investigators', 'The accident flight was the airplane’s next flight.'),
      'attribution',
      'quote_context_loss',
      'not_established',
      'P8: "next" after the forced landing and the reattachment of the fitting; the excerpt does not say after what.',
    ),
    yes(
      'era21.adapter',
      'attribution',
      'ERA21LA127',
      ['P9'],
      said(
        'investigators',
        'The pilot’s failure to apply adequate torque on the fuel pressure line aluminum adaptor fitting, which resulted in the loosening of the adapter, a loss of fuel flow, and a total loss of engine power.',
      ),
      'P9, the probable cause: it names the fitting, the failure and the result.',
    ),
  ],
};

/** q-first-flight-annual: CEN22LA322 (P3, P4). */
const FIRST: ClaimBatch = {
  id: 'dev16d.context-first',
  bundle: 'q-first-flight-annual',
  cases: ['CEN22LA322'],
  claims: [
    no(
      'cen22.these',
      'attribution',
      'CEN22LA322',
      ['P3'],
      said('investigators', 'These cylinders exhibited pitting damage from the spacer.'),
      'attribution',
      'quote_context_loss',
      'not_established',
      CONTEXT('cylinders (Nos. 1 and 2) and which spacer (one of the airbox’s three metal spacers)'),
      { critical: true },
    ),
    yes(
      'cen22.pc',
      'attribution',
      'CEN22LA322',
      ['P4'],
      said('investigators', 'The loss of engine power due to metal contamination within the cylinder following poor maintenance.'),
      'P4, the probable cause, whole.',
    ),
  ],
};

export const V2_DEV_CLAIM_BATCHES: readonly ClaimBatch[] = [POWER, FUEL, FIRST];
export const V2_DEV_BRIEFS: readonly BriefSpec[] = [];

/**
 * The maximum-size inputs (gate condition 4: latency, output size and timeouts at the
 * largest checks): for each bundle, a claim batch's reviewed claims followed by a brief's,
 * up to `MAX_CHECK_CLAIMS`, with their labels; built in build.ts (`maxSizeBatch`). They are
 * measured for latency and structure and kept out of the accuracy figures (their claims
 * are the same claims as their sources').
 */
export const V2_MAX_SIZE: readonly { id: string; claims: string; brief: string }[] = [
  { id: 'dev16d.max-power', claims: 'dev.paid', brief: 'dev.b1' },
  { id: 'dev16d.max-first', claims: 'dev.ff', brief: 'dev.b2' },
  { id: 'dev16d.max-oil', claims: 'holdout.oil', brief: 'holdout.b5' },
];
