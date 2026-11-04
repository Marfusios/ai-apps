/**
 * The fields each automatic-filter policy may apply on its own, as `/api/config` reports them
 * (`aiAutomaticFilters`): nothing (`none`), the state (`state-explicit.v1.3`), or an attributed
 * policy's `fields`. Browser-safe, for the mock API, which cannot load the server's policy registry
 * (server/evidence/auto-filters.ts hashes its fingerprints with node:crypto). The server reports its
 * registry's `automaticFieldsOf`; tests/unit/evidence-mock.test.ts holds the two equal for every
 * version, so a subset variant is one entry here beside its registration there, and no mock edit.
 */
import type { ConfigResponse } from './contracts/config.js';
import type { EvidenceAutoFilterVersion } from './evidence-auto-filters.js';

/** A field a policy may apply: the state, the years (both bounds, one field) or the aircraft category. */
export type AutomaticFilterField = NonNullable<ConfigResponse['aiAutomaticFilters']>[number];

export const EVIDENCE_AUTO_FILTER_FIELDS: Readonly<Record<EvidenceAutoFilterVersion, readonly AutomaticFilterField[]>> = Object.freeze({
  none: Object.freeze([]),
  'state-explicit.v1.3': Object.freeze(['state'] as const),
  'attributed.v1': Object.freeze(['state', 'years', 'category'] as const),
});
