/**
 * `GET /api/cases/:ntsbNo`: one investigation, NTSB data only (UI_DESIGN §2.1,
 * §4.5). The response is public and cacheable (`Cache-Control: public,
 * max-age=300`, an ETag that includes the dataset revision); 404 for unknown
 * numbers. It never contains AI output: AI context is a separate private read
 * keyed by brief, step and case, and every schema here is strict.
 */
import { z } from 'zod';
import { CodedSchema, CompletionSchema, IsoDateSchema, IsoDateTimeSchema, NtsbNoSchema, PhaseGroupSchema, Sha256Schema } from './common.js';
import { AircraftBriefSchema, SECTION_LABEL, SectionKindSchema, type SectionKind } from './search.js';

export { SECTION_LABEL };
export type { SectionKind };

export const EngineSchema = z.strictObject({
  engNo: z.number().int().nonnegative(),
  type: CodedSchema,
  fuelSystem: CodedSchema,
});

export const AircraftDetailSchema = z.strictObject({
  ...AircraftBriefSchema.shape,
  series: z.string().max(60).nullable(),
  homebuilt: z.boolean().nullable(),
  year: z.number().int().min(1900).max(2100).nullable(),
  engines: z.array(EngineSchema).max(16),
  /** More than one sequence step is flagged as this aircraft's defining event. */
  definingEventConflict: z.boolean(),
});
export type AircraftDetail = z.infer<typeof AircraftDetailSchema>;

/** One `Events_Sequence` row: an occurrence in a phase of flight. */
export const SequenceStepSchema = z.strictObject({
  aircraftKey: z.number().int().nonnegative(),
  occurrenceNo: z.number().int().nonnegative(),
  phase: PhaseGroupSchema,
  phaseDetail: CodedSchema,
  event: CodedSchema,
  /** `defining_ev`; null when blank. */
  isDefining: z.boolean().nullable(),
  /** The event code is an impact (drawn as ✕ on the flight profile). */
  impact: z.boolean(),
});
export type SequenceStep = z.infer<typeof SequenceStepSchema>;

/**
 * A narrative section. In a multi-aircraft event every section is event-scoped:
 * `sourceAircraftKeys` records which aircraft's row carried the text (provenance,
 * not attribution). `aircraft` scope is valid only when the case has exactly one
 * aircraft, and then names that aircraft (amendment A3); `CaseDetailSchema`
 * enforces this. Event-scoped sections have `aircraftKey: null`.
 */
export const SectionSchema = z.strictObject({
  /** Unique within the case, e.g. `analysis/event-1`; stable across revisions of the same text. */
  key: z.string().regex(/^[a-z_]+\/(event|aircraft)-\d+$/),
  kind: SectionKindSchema,
  label: z.string().min(1).max(40),
  scope: z.enum(['event', 'aircraft']),
  aircraftKey: z.number().int().nonnegative().nullable(),
  sourceAircraftKeys: z.array(z.number().int().nonnegative()).min(1).max(64),
  /** Canonical citation text: plain text, LF line ends, never markup. */
  text: z.string().min(1).max(200_000),
  /** sha256 of `text`: the section revision citations pin to. */
  revision: Sha256Schema,
  citationTextVersion: z.string().min(1).max(20),
  /** The source was HTML and was converted to text. */
  transformedFromHtml: z.boolean(),
  lastChangedAt: IsoDateTimeSchema.nullable(),
});
export type Section = z.infer<typeof SectionSchema>;

/**
 * A finding. `inProbableCause` is the raw `cm_inPC` flag: it merges causal and
 * contributing findings, so there is deliberately no cause/factor field
 * (DATA_REVIEW; UI_DESIGN §4.5).
 */
export const FindingSchema = z.strictObject({
  aircraftKey: z.number().int().nonnegative(),
  findingNo: z.number().int().nonnegative(),
  code: z.string().max(16).nullable(),
  /**
   * `finding_description` as published, with the deprecated trailing cause/factor
   * marker (" - C", " - F") removed so it cannot read as a label.
   */
  text: z.string().max(400).nullable(),
  inProbableCause: z.boolean().nullable(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const CAUTION_KINDS = [
  'status_blank',
  'status_conflict',
  'injury_mismatch',
  'shared_narrative',
  'defining_event_conflict',
] as const;

/** A deterministic data caution: one plain sentence, never AI-written (UI_DESIGN §2.7). */
export const CautionSchema = z.strictObject({
  kind: z.enum(CAUTION_KINDS),
  text: z.string().min(1).max(400),
});
export type Caution = z.infer<typeof CautionSchema>;

/** Fixed host and path for report links; only a validated numeric report ID is appended (DESIGN §4). */
export const REPORT_URL_PREFIX = 'https://data.ntsb.gov/carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/';
export const AVIATION_SEARCH_URL = 'https://my.ntsb.gov/aviation';

const REPORT_URL = new RegExp(`^${REPORT_URL_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\d{1,10}/pdf$`);

/**
 * The official report, or (when no report ID is resolved) the labelled search
 * fallback: the copyable case number, "Direct report link unavailable" and a link
 * to Aviation Search labelled as a search, not as the report.
 */
export const ReportLinkSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('report'),
    url: z.string().regex(REPORT_URL),
    label: z.string().min(1).max(80),
    /** When the link was resolved; the newest-report link can change later. */
    capturedOn: IsoDateSchema,
  }),
  z.strictObject({
    kind: z.literal('search'),
    url: z.literal(AVIATION_SEARCH_URL),
    label: z.literal('Search NTSB aviation investigations'),
    note: z.literal('Direct report link unavailable'),
  }),
]);
export type ReportLink = z.infer<typeof ReportLinkSchema>;

export const ProvenanceSchema = z.strictObject({
  source: z.literal('NTSB aviation investigation database (avall.mdb)'),
  snapshotDate: IsoDateSchema,
  datasetRevision: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  /** sha256 over this case's source rows; changes exactly when they change. */
  caseRevision: Sha256Schema,
  approvalDate: IsoDateSchema.nullable(),
  lastChangedAt: IsoDateTimeSchema.nullable(),
  citationTextVersion: z.string().min(1).max(20),
  fieldNormalizationVersion: z.string().min(1).max(20),
});

export const WeatherSchema = z.strictObject({
  basic: CodedSchema,
  light: CodedSchema,
  ceiling: z.strictObject({ cover: CodedSchema, heightFt: z.number().int().nullable() }),
  lowestNonCeiling: z.strictObject({ cover: CodedSchema, heightFt: z.number().int().nullable() }),
  visibilitySm: z.number().nonnegative().nullable(),
  wind: z.strictObject({
    directionDeg: z.number().int().nullable(),
    /** `wind_dir_ind` as recorded (Y, V, U). */
    directionIndicator: z.string().max(8).nullable(),
    speedKts: z.number().int().nullable(),
    /** `wind_vel_ind` as recorded (CALM, LVAR, V, U). */
    speedIndicator: z.string().max(8).nullable(),
    gustKts: z.number().int().nullable(),
    gustIndicator: z.string().max(8).nullable(),
  }),
  temperatureC: z.number().nullable(),
  dewPointC: z.number().nullable(),
  /** inHg, rounded to hundredths. Recorded zeros are passed through, not interpreted. */
  altimeterInHg: z.number().nullable(),
  densityAltitudeFt: z.number().int().nullable(),
  precipitation: CodedSchema,
  /** Raw METAR text when the record has one. */
  metar: z.string().max(2000).nullable(),
});
export type Weather = z.infer<typeof WeatherSchema>;

export const InjuriesSchema = z.strictObject({
  fatal: z.number().int().nonnegative().nullable(),
  serious: z.number().int().nonnegative().nullable(),
  minor: z.number().int().nonnegative().nullable(),
  uninjured: z.number().int().nonnegative().nullable(),
});

export const CaseDetailSchema = z.strictObject({
  ntsbNo: NtsbNoSchema,
  eventType: CodedSchema,
  date: IsoDateSchema.nullable(),
  /** `ev_time` as HHMM in the recorded zone; no zone is invented. */
  time: z.strictObject({ hhmm: z.string().regex(/^\d{4}$/).nullable(), zone: CodedSchema }),
  city: z.string().max(120).nullable(),
  state: CodedSchema,
  country: z.string().max(8).nullable(),
  /** Validated decimal coordinates; null when missing or invalid. */
  location: z.strictObject({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).nullable(),
  /** Fixed template over coded fields (shared/case-view.ts), never AI-written. */
  headline: z.string().min(1).max(300),
  completion: CompletionSchema,
  highestInjury: CodedSchema,
  injuries: InjuriesSchema,
  weather: WeatherSchema,
  aircraft: z.array(AircraftDetailSchema).max(64),
  /** Every sequence step of every aircraft, by aircraft then occurrence. */
  sequence: z.array(SequenceStepSchema).max(400),
  /** Factual, analysis, probable cause; within a kind by section key. */
  sections: z.array(SectionSchema).max(200),
  findings: z.array(FindingSchema).max(400),
  cautions: z.array(CautionSchema).max(10),
  report: ReportLinkSchema,
  provenance: ProvenanceSchema,
}).superRefine((detail, ctx) => {
  // Amendment A3 (owner ruling): only a single-aircraft case has aircraft-scoped text.
  const only = detail.aircraft.length === 1 ? (detail.aircraft[0]?.aircraftKey ?? null) : null;
  detail.sections.forEach((section, i) => {
    if (section.scope === 'aircraft' && (only === null || section.aircraftKey !== only)) {
      ctx.addIssue({
        code: 'custom',
        path: ['sections', i, 'scope'],
        message:
          only === null
            ? 'aircraft scope is valid only when the case has exactly one aircraft'
            : 'an aircraft-scoped section must name the case’s aircraft',
      });
    }
    if (section.scope === 'event' && section.aircraftKey !== null) {
      ctx.addIssue({ code: 'custom', path: ['sections', i, 'aircraftKey'], message: 'an event-scoped section has no aircraftKey' });
    }
  });
});
export type CaseDetail = z.infer<typeof CaseDetailSchema>;
