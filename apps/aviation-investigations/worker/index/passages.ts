/**
 * Passages of one case: attribution, embedding input and identity (amendments A2,
 * A3, A10, A16).
 *
 * - **US, answer-eligible cases only.** `buildCasePassages` refuses any other case.
 * - **Attribution follows the section scope.** In a single-aircraft event every
 *   section is aircraft-scoped: its passages are `aircraft`-scoped, aircraft-specific,
 *   carry only that aircraft in their nested filter fields and take their header
 *   from it. In a multi-aircraft event every section is event-scoped (the narrative
 *   row that carried a text does not prove which aircraft it describes): its passages
 *   are `event`-scoped with `aircraftSpecific: false`, carry every aircraft of the
 *   event, and say "Event (n aircraft)" in the header. Retrieval excludes them
 *   whenever an aircraft filter is active, so they never ground an aircraft-specific
 *   claim. Any other combination is a data-model violation and fails the build.
 * - **Embedding input** is `header + "\n" + passage text`, the header being
 *   `"<section label> · <make model | Event (n aircraft)> · <defining phase(s)>"`
 *   (parts without a value are left out). Only the raw passage text is stored, indexed
 *   and cited; the header exists only in the embedding input.
 * - **Identity.** `passage_id` is sha256 over (revision id, start, end,
 *   `CHUNKER_VERSION`): stable across generations while the section text is.
 */
import { createHash } from 'node:crypto';
import type { CaseRecord, CaseRecordAircraft, SectionKind } from '../../server/db/queries/case-records.js';
import { PHASE_GROUPS, PHASE_LABEL, orderPhaseGroups, type PhaseGroup } from '../../shared/codes.js';
import { CHUNKER_VERSION, DEFAULT_CHUNK_OPTIONS, chunkSectionDetailed, type ChunkStats, type PassageDraft } from './chunk.js';
import { countTokens } from './tokens.js';

/** Bump whenever the header or the way it joins the text changes: it invalidates every cached embedding. */
export const EMBEDDING_INPUT_TEMPLATE_VERSION = 'input-v1';

/** Hard limit of one embedding input (`text-embedding-3-*`). */
export const MAX_INPUT_TOKENS = 8_192;

export const SECTION_LABEL: Readonly<Record<SectionKind, string>> = {
  factual: 'Factual narrative',
  analysis: 'Analysis',
  probable_cause: 'Probable cause',
};

/** Phase groups that say nothing about the flight and stay out of the header. */
const VAGUE_PHASES: ReadonlySet<PhaseGroup> = new Set(['unknown', 'other']);
const PHASE_SET: ReadonlySet<string> = new Set(PHASE_GROUPS);

export type PassageScope = 'aircraft' | 'event';

/** What the header says about the aircraft a passage is attributed to. */
export interface CaseHeader {
  /** `aircraft`: the one aircraft the passage belongs to. `event`: every aircraft of the event. */
  scope: PassageScope;
  aircraft: readonly { make: string | null; model: string | null; definingPhaseGroup: string | null }[];
}

const collapse = (s: string | null): string => (s ?? '').replace(/\s+/gu, ' ').trim();

function phaseLabels(groups: readonly (string | null)[]): string {
  const known = groups.filter((g): g is PhaseGroup => g !== null && PHASE_SET.has(g));
  return orderPhaseGroups(known)
    .filter((g) => !VAGUE_PHASES.has(g))
    .map((g) => PHASE_LABEL[g])
    .join(' / ');
}

/** `"<section label> · <make model | Event (n aircraft)> · <defining phase(s)>"`, empty parts left out. */
export function passageHeader(kind: SectionKind, c: CaseHeader): string {
  let who: string;
  if (c.scope === 'aircraft') {
    const a = c.aircraft[0];
    if (!a || c.aircraft.length !== 1) throw new Error('an aircraft-scoped header needs exactly one aircraft');
    who = [collapse(a.make), collapse(a.model)].filter((x) => x !== '').join(' ');
  } else {
    who = `Event (${c.aircraft.length} aircraft)`;
  }
  return [SECTION_LABEL[kind], who, phaseLabels(c.aircraft.map((a) => a.definingPhaseGroup))]
    .filter((x) => x !== '')
    .join(' · ');
}

/** The exact text sent to the embedding model for a passage. */
export function passageEmbeddingInput(p: Pick<PassageDraft, 'kind' | 'text'>, c: CaseHeader): string {
  return `${passageHeader(p.kind, c)}\n${p.text}`;
}

export function passageId(revisionId: string, start: number, end: number, chunkerVersion = CHUNKER_VERSION): string {
  return createHash('sha256').update(JSON.stringify([revisionId, start, end, chunkerVersion])).digest('hex');
}

/** Nested aircraft filter fields copied onto a passage. */
export interface PassageAircraft {
  aircraft_key: number;
  category: string | null;
  make: string | null;
  model: string | null;
  far_part: string | null;
  purpose: string | null;
  eng_types: string[];
  defining_phase_group: string | null;
}

/** Event-level filter fields copied onto every passage of the case. */
export interface PassageFilters {
  country: string;
  ev_year: number | null;
  ev_date: string | null;
  state: string | null;
  answer_eligible: boolean;
  defining_phase_groups: string[];
  highest_injury: string | null;
  wx_cond: string | null;
  light: string | null;
}

export interface CasePassage extends PassageDraft {
  passageId: string;
  chunkerVersion: string;
  ntsbNo: string;
  sectionSha: string;
  scope: PassageScope;
  /** The aircraft of an aircraft-scoped passage; null for an event-scoped one. */
  aircraftKey: number | null;
  /** False for event-scoped passages: they never satisfy an aircraft filter. */
  aircraftSpecific: boolean;
  header: string;
  /** `header + "\n" + text`. */
  input: string;
  /** Exact `cl100k_base` tokens of `input` (header, overlap and text). */
  inputTokens: number;
  filters: PassageFilters;
  aircraft: PassageAircraft[];
}

export interface CasePassagesResult {
  passages: CasePassage[];
  /** One entry per section, in section order. */
  sections: { sectionId: string; kind: SectionKind; scope: PassageScope; stats: ChunkStats }[];
}

function aircraftFields(a: CaseRecordAircraft): PassageAircraft {
  return {
    aircraft_key: a.aircraftKey,
    category: a.category,
    make: a.make,
    model: a.model,
    far_part: a.farPart,
    purpose: a.purpose,
    eng_types: [...new Set(a.engines.map((e) => e.engType).filter((t): t is string => t !== null))],
    defining_phase_group: a.definingPhaseGroup,
  };
}

const header = (a: CaseRecordAircraft) => ({ make: a.make, model: a.model, definingPhaseGroup: a.definingPhaseGroup });

/**
 * Passages of one answer-eligible US case, in section order, chunked with the
 * options `CHUNKER_VERSION` stands for. Throws for any other
 * case, for a section whose scope contradicts the event's aircraft count, and for
 * an input over `MAX_INPUT_TOKENS`.
 */
export function buildCasePassages(r: CaseRecord): CasePassagesResult {
  if (!r.isUs || r.country !== 'USA') {
    throw new Error(`${r.ntsbNo} is not a US event (country ${JSON.stringify(r.country)}); passages are US-only`);
  }
  if (!r.answerEligible) throw new Error(`${r.ntsbNo} is not answer-eligible; only answer-eligible cases get passages`);
  const filters: PassageFilters = {
    country: r.country,
    ev_year: r.evYear,
    ev_date: r.evDate,
    state: r.state,
    answer_eligible: r.answerEligible,
    defining_phase_groups: orderPhaseGroups(r.definingPhaseGroups.filter((g): g is PhaseGroup => PHASE_SET.has(g))),
    highest_injury: r.highestInjury,
    wx_cond: r.wxCondBasic,
    light: r.lightCond,
  };
  const single = r.aircraft.length === 1;
  const passages: CasePassage[] = [];
  const sections: CasePassagesResult['sections'] = [];
  for (const s of r.sections) {
    let scope: PassageScope;
    let attributed: CaseRecordAircraft[];
    if (s.scope === 'aircraft') {
      const own = r.aircraft.find((a) => a.aircraftKey === s.aircraftKey);
      if (!single || !own) {
        throw new Error(
          `${s.sectionId}: an aircraft-scoped section needs a single-aircraft event (${r.aircraft.length} aircraft, section aircraft ${s.aircraftKey})`,
        );
      }
      scope = 'aircraft';
      attributed = [own];
    } else {
      if (r.aircraft.length < 2) throw new Error(`${s.sectionId}: an event-scoped section needs a multi-aircraft event`);
      scope = 'event';
      attributed = r.aircraft;
    }
    const c: CaseHeader = { scope, aircraft: attributed.map(header) };
    const head = passageHeader(s.kind, c);
    const { passages: drafts, stats } = chunkSectionDetailed(
      { sectionId: s.sectionId, revisionId: s.revisionId, kind: s.kind, text: s.text },
      DEFAULT_CHUNK_OPTIONS,
    );
    sections.push({ sectionId: s.sectionId, kind: s.kind, scope, stats });
    for (const d of drafts) {
      const input = `${head}\n${d.text}`;
      const inputTokens = countTokens(input);
      if (inputTokens > MAX_INPUT_TOKENS) {
        throw new Error(`${s.sectionId} part ${d.part}: embedding input of ${inputTokens} tokens exceeds ${MAX_INPUT_TOKENS}`);
      }
      passages.push({
        ...d,
        passageId: passageId(s.revisionId, d.start, d.end),
        chunkerVersion: CHUNKER_VERSION,
        ntsbNo: r.ntsbNo,
        sectionSha: s.sha256,
        scope,
        aircraftKey: scope === 'aircraft' ? s.aircraftKey : null,
        aircraftSpecific: scope === 'aircraft',
        header: head,
        input,
        inputTokens,
        filters,
        aircraft: attributed.map(aircraftFields),
      });
    }
  }
  return { passages, sections };
}
