/**
 * Builders for calibration claim items. Server-written claims use the production
 * templates (server/briefs/render.ts, server/briefs/criteria.ts), so a control claim reads
 * exactly as the pipeline would render it.
 */
import type { ClaimKind } from '../../../server/ai/provider.js';
import { CRITERION_CLAIMS, maintenanceWords } from '../../../server/briefs/criteria.js';
import { CLASSIFICATION_CLAIM, MAINTENANCE_CLAIM, SPEAKER_CLAIM, SYMPTOM_CLAIM, chronologyFacts } from '../../../server/briefs/render.js';
import type { ChronologyFact } from '../../../shared/contracts/briefs.js';
import type { ClaimItem, Family, Provenance } from '../types.js';

type Extra = Partial<Pick<ClaimItem, 'absence' | 'criterion' | 'decision' | 'critical' | 'source' | 'paidIndex' | 'provenance'>>;
type Cites = ClaimItem['cites'];

/** A claim labelled supported: a control (model-reviewed unless stated). */
export const yes = (id: string, kind: ClaimKind, ntsbNo: string, cites: Cites, text: string, note: string, extra: Extra = {}): ClaimItem => ({
  id,
  kind,
  case: ntsbNo,
  text,
  cites,
  label: 'supported',
  provenance: 'model-reviewed',
  family: 'control',
  source: 'control',
  note,
  ...extra,
});

/** A claim labelled not supported: a mutation (constructed unless stated), with the verdict it should get. */
export const no = (
  id: string,
  kind: ClaimKind,
  ntsbNo: string,
  cites: Cites,
  text: string,
  family: Exclude<Family, 'control'>,
  mutation: string,
  expect: 'contradicted' | 'not_established',
  note: string,
  extra: Extra = {},
): ClaimItem => ({
  id,
  kind,
  case: ntsbNo,
  text,
  cites,
  label: 'not_supported',
  expect,
  provenance: 'constructed' as Provenance,
  family,
  mutation,
  source: 'control',
  note,
  ...extra,
});

/** A claim review could not settle: kept for realism, outside the accuracy figures. */
export const unsettled = (id: string, kind: ClaimKind, ntsbNo: string, cites: Cites, text: string, note: string, extra: Extra = {}): ClaimItem => ({
  id,
  kind,
  case: ntsbNo,
  text,
  cites,
  label: 'unknown',
  provenance: 'model-reviewed',
  family: 'control',
  source: 'control',
  note,
  ...extra,
});

// ---------------------------------------------------------------------------
// Production claim texts

export const said = (speaker: keyof typeof SPEAKER_CLAIM, quote: string) => `${SPEAKER_CLAIM[speaker]} “${quote}”`;
export const CLASSIFIED = CLASSIFICATION_CLAIM;
export const MAINTAINED = MAINTENANCE_CLAIM;
export const SYMPTOM = SYMPTOM_CLAIM;

/** A timing claim from the relevant maintenance, as `chronologyFacts` renders it. */
export function timing(maintenance: string, fact: Omit<ChronologyFact, 'anchor' | 'passageIds' | 'other'>): string {
  const [f] = chronologyFacts({ maintenance, facts: [{ anchor: 'relevant_maintenance', ...fact, passageIds: ['P1'] }] });
  if (!f) throw new Error(`no timing claim for ${JSON.stringify(fact)}`);
  return f.claim;
}

const win = (days: number | null, flightHours: number | null) => ({ days, flightHours });
const m = (maintenance?: string) => maintenanceWords(maintenance === undefined ? undefined : { maintenance });

/** "Under the timing rules, the event happened within 30 calendar days or 10 flight hours after the relevant maintenance (…)." */
export const within = (maintenance: string | undefined, days: number | null = 30, hours: number | null = 10) =>
  CRITERION_CLAIMS.timing_window.matches(win(days, hours), m(maintenance));
/** The server's "do not settle" claim for a timing window. */
export const windowUnsettled = (maintenance: string | undefined, days: number | null = 30, hours: number | null = 10) =>
  CRITERION_CLAIMS.timing_window.unknown(win(days, hours), m(maintenance));
export const firstFlight = (maintenance: string | undefined) => CRITERION_CLAIMS.first_flight_only.matches(m(maintenance));
export const firstFlightUnsettled = (maintenance: string | undefined) => CRITERION_CLAIMS.first_flight_only.unknown(m(maintenance));
