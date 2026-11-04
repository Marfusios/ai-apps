/**
 * Which scope suggestions a question search applies on its own: `none`, the dev-only state guard
 * `state-explicit.v1.3` (deterministic, state only), or an attributed policy (deterministic
 * candidates, then one attribution check, server/evidence/pipeline.ts): `attributed.v1` (state,
 * years and category; dev-only) and its confirmed subsets `attributed.v1-state` and
 * `attributed.v1-state-years`, which differ from it only in their fields. The policy object is
 * hashed into the identity every saved search records.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { STATE_PROBE_VERSION, stateGuardFingerprint } from './auto-filter-probes.js';
import { CANDIDATE_PROBE_VERSION, candidateFingerprint } from './candidate-probes.js';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { EvidenceAutomaticFiltersSchema, type EvidenceAutomaticFilters } from '../../shared/contracts/evidence.js';
import { eligibleEmittedStates, STATE_GUARD_VERSION, type StateEligibility } from '../../shared/state-eligibility.js';
import { AUTOMATIC_FIELDS, CATEGORY_MENTION_VERSION, STATE_MENTION_VERSION, YEAR_MENTION_VERSION, type AutomaticField } from '../../shared/automatic-candidates.js';
import { DEFAULT_EVIDENCE_AUTO_FILTERS, type EvidenceAutoFilterVersion } from '../../shared/evidence-auto-filters.js';
import { ATTRIBUTION_SYSTEM, ATTRIBUTION_VERSION, AttributionWireOutputSchema } from '../ai/prompts/attribution.a2.js';
import { ATTRIBUTION_CAPS } from '../ai/pricing.js';
import { ATTRIBUTION_MODEL } from '../ai/provider.js';
import { canonicalConfig } from '../search/retrieval-config.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

/**
 * An attributed policy for one enabled-field set. Its `fields` drive candidate construction, the
 * check's input, `/api/config` and the identity, so a subset variant is one more registration.
 */
function attributed<const V extends string>(version: V, fields: readonly AutomaticField[]) {
  return deepFreeze({
    version,
    fields: AUTOMATIC_FIELDS.filter(f => fields.includes(f)),
    rules: { state: STATE_MENTION_VERSION, years: YEAR_MENTION_VERSION, category: CATEGORY_MENTION_VERSION },
    attribution: {
      stage: 'attribution' as const, model: ATTRIBUTION_MODEL,
      prompt: { version: ATTRIBUTION_VERSION, sha256: hash(ATTRIBUTION_SYSTEM), schemaSha256: hash(JSON.stringify(z.toJSONSchema(AttributionWireOutputSchema))) },
      caps: { input: ATTRIBUTION_CAPS.input, output: ATTRIBUTION_CAPS.output }, timeoutMs: 8_000,
      settings: { thinking: 'off' as const, effort: 'low' as const, retries: 0 as const, cache: 'system-5m' as const },
    },
    behaviour: { version: CANDIDATE_PROBE_VERSION, sha256: candidateFingerprint(fields) },
    appliesTo: 'question-case-search' as const,
  });
}

/**
 * Each policy is built on first use: a behavioural fingerprint costs several hundred milliseconds,
 * which importers that never select a policy (the worker CLI), or a server running another one,
 * need not pay.
 */
const builders = {
  none: () => Object.freeze({ version: 'none', guard: null, behaviour: null, field: null, appliesTo: 'question-case-search' } as const),
  'state-explicit.v1.3': () => Object.freeze({ version: 'state-explicit.v1.3', guard: STATE_GUARD_VERSION,
    behaviour: Object.freeze({ version: STATE_PROBE_VERSION, sha256: stateGuardFingerprint() }), field: 'state', appliesTo: 'question-case-search' } as const),
  'attributed.v1': () => attributed('attributed.v1', AUTOMATIC_FIELDS),
  // The confirmed subsets (Task 30 confirmation): the same rules, prompt, caps and settings, fewer fields.
  'attributed.v1-state': () => attributed('attributed.v1-state', ['state']),
  'attributed.v1-state-years': () => attributed('attributed.v1-state-years', ['state', 'years']),
} as const satisfies Record<EvidenceAutoFilterVersion, () => unknown>;
type Registry = { readonly [V in EvidenceAutoFilterVersion]: ReturnType<(typeof builders)[V]> };
const built: { -readonly [V in EvidenceAutoFilterVersion]?: Registry[V] } = {};
export type EvidenceAutoFilterPolicy = Registry[EvidenceAutoFilterVersion];
export type AttributedAutoFilterPolicy = Extract<EvidenceAutoFilterPolicy, { attribution: unknown }>;
export type AttributionStageConfig = AttributedAutoFilterPolicy['attribution'];
export function autoFilterPolicy<V extends EvidenceAutoFilterVersion = EvidenceAutoFilterVersion>(version: V = DEFAULT_EVIDENCE_AUTO_FILTERS as V): Registry[V] {
  if (!Object.hasOwn(builders, version)) throw new Error('unknown evidence automatic filter policy');
  return (built[version] ??= builders[version]() as Registry[V]) as Registry[V];
}
export const autoFilterIdentity = (policy: EvidenceAutoFilterPolicy) => ({ version: policy.version,
  sha256: createHash('sha256').update(canonicalConfig(policy)).digest('hex') });
export function assertAutoFilterPolicy(policy: EvidenceAutoFilterPolicy): void {
  if (canonicalConfig(policy) !== canonicalConfig(autoFilterPolicy(policy.version))) throw new Error('unregistered evidence automatic filter policy');
}
/** The attribution stage a policy runs, or null (`none`, `state-explicit.v1.3`). */
export const attributionStage = (policy: EvidenceAutoFilterPolicy): AttributionStageConfig | null =>
  'attribution' in policy ? policy.attribution : null;
/** The fields a policy may apply on its own: `[]`, `['state']`, or the attributed policy's fields. */
export function automaticFieldsOf(policy: EvidenceAutoFilterPolicy): readonly AutomaticField[] {
  if ('fields' in policy) return policy.fields;
  return policy.field ? [policy.field] : [];
}
/**
 * The summary of a search's automatic filters: the v1.3 guard's reason, or for `attributed.v1`
 * `applied` (any field) / `not_applied`. Per-field reasons are separate (`autoFilterFields`).
 */
export type AutoFilterReason = StateEligibility['reason'] | 'disabled' | 'edited' | 'scope_unavailable' | 'non_search' | 'not_applied';
/** The deterministic policies (`none`, `state-explicit.v1.3`); `attributed.v1` decides in `rankEvidence`. */
export function automaticState(policy: EvidenceAutoFilterPolicy, question: string, emitted: BriefFilters | null,
  edited: boolean, nonSearch: boolean): { filters: EvidenceAutomaticFilters | null; reason: AutoFilterReason } {
  assertAutoFilterPolicy(policy);
  if (policy.version === 'none') return { filters: null, reason: 'disabled' };
  if (edited) return { filters: null, reason: 'edited' };
  if (!emitted) return { filters: null, reason: nonSearch ? 'non_search' : 'scope_unavailable' };
  if (policy.version !== 'state-explicit.v1.3') throw new Error('an attributed policy needs its attribution check');
  const decision = eligibleEmittedStates(question, emitted.state ?? []);
  return { filters: decision.states.length ? EvidenceAutomaticFiltersSchema.parse({ state: decision.states }) : null, reason: decision.reason };
}
