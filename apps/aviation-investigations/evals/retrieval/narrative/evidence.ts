/**
 * What a Track N judge reads (task 10c protocol v4, section 2).
 *
 * **Case relevance** is judged on the case's complete imported evidence, read from the
 * canonical database (`loadCaseEvidence`, one read-only snapshot): the event and its
 * aircraft, every narrative section and variant (`case_sections`: kind, event or
 * aircraft scope, revision), every coded finding (`case_findings`, without
 * `cause_factor`, its description without the deprecated " - C"/" - F" suffix) and every
 * occurrence (`case_sequence`). Sections are labelled S1.., findings F1.., occurrences
 * O1.. in the canonical record order; the labels map back to canonical identities
 * (section id and revision; `<case>/<aircraft>/finding/<n>`,
 * `<case>/<aircraft>/occurrence/<n>`). Each section's text is checked against its
 * recorded sha256 before it is used.
 *
 * **Fingerprint.** `fingerprint` is sha256 over the input version and the canonical
 * content (section revision ids and hashes, rows, event and aircraft fields), so the
 * same content keeps its judgments across generations and any change re-judges.
 *
 * **Long cases** (`planChunks`). A case whose rendered evidence is above
 * `CASE_TOKEN_BUDGET` (`cl100k_base` tokens) is split by section into ordered chunks:
 * each chunk repeats the header, findings and occurrences and takes whole sections in
 * order while they fit; a section larger than the room left is split at paragraph, then
 * line, then sentence, then word boundaries into parts that keep their offsets in the
 * section. Nothing is ever truncated or skipped: every character of every section lies
 * in exactly one part. The judge grades the chunks in order, each with the notes carried
 * forward from the earlier ones, and a consolidation step sees every chunk verdict. A
 * case whose evidence cannot be split within the budget is `uncovered` and graded
 * `unknown`.
 *
 * **Bundle answerability** reads only what a retrieval bundle delivered for the case:
 * the header (as the answer model's case header does) and the delivered passages P1..,
 * with their provenance. Its fingerprint covers the passage ids and texts, so the
 * judgment is keyed by the actual supplied bundle.
 *
 * Untrusted text (sections, descriptions, passages) is placed inside delimiter tags with
 * the `<` of anything shaped like one of them replaced (`untrustedText`); quotes are
 * always verified against the stored text, never against this rendered copy.
 */
import pg from 'pg';
import { assembleCaseRecords, type CaseRecord, type CaseRecordRows } from '../../../server/db/queries/case-records.js';
import { countTokens } from '../../../server/ai/tokens.js';
import { normalizeFindingDescription } from '../coded/coded.js';
import { canonicalJson, sha256 } from './spec.js';

export const JUDGE_INPUT_VERSION = 'judge-input-v1';
/** The per-judgment budget for a case's rendered evidence (`cl100k_base` tokens); above it the case is chunked. */
export const CASE_TOKEN_BUDGET = 12_000;

export type SectionKind = 'factual' | 'analysis' | 'probable_cause';

export interface EvidenceAircraft {
  aircraftKey: number;
  aircraftNtsbNo: string | null;
  make: string | null;
  model: string | null;
  category: string | null;
  farPart: string | null;
  purpose: string | null;
  damage: string | null;
  definingPhaseGroup: string | null;
  engines: string[];
}

export interface EvidenceSection {
  alias: string;
  sectionId: string;
  sectionKey: string;
  kind: SectionKind;
  scope: 'event' | 'aircraft';
  aircraftKey: number | null;
  revisionId: string;
  sha256: string;
  text: string;
}

export interface EvidenceFinding {
  alias: string;
  /** `<case>/<aircraft key>/finding/<finding no>`. */
  rowId: string;
  aircraftKey: number;
  findingNo: number;
  code: string | null;
  description: string | null;
  inProbableCause: boolean | null;
}

export interface EvidenceOccurrence {
  alias: string;
  /** `<case>/<aircraft key>/occurrence/<occurrence no>`. */
  rowId: string;
  aircraftKey: number;
  occurrenceNo: number;
  phaseGroup: string;
  eventCode: string | null;
  description: string | null;
  isDefining: boolean | null;
}

export interface CaseEvidence {
  ntsbNo: string;
  event: { date: string | null; city: string | null; state: string | null; highestInjury: string | null; light: string | null; weather: string | null };
  aircraft: EvidenceAircraft[];
  sections: EvidenceSection[];
  findings: EvidenceFinding[];
  occurrences: EvidenceOccurrence[];
}

// ---------------------------------------------------------------------------
// Loading

/** Section rows whose text does not hash to the recorded sha256 (an integrity failure). */
export class EvidenceIntegrityError extends Error {
  constructor(readonly ntsbNo: string, readonly sectionId: string) {
    super(`${sectionId}: the stored text does not match its sha256`);
    this.name = 'EvidenceIntegrityError';
  }
}

/** A canonical case record as the judge's evidence (aliases in record order). */
export function evidenceOf(r: CaseRecord): CaseEvidence {
  return {
    ntsbNo: r.ntsbNo,
    event: { date: r.evDate, city: r.city, state: r.state, highestInjury: r.highestInjury, light: r.lightCond, weather: r.wxCondBasic },
    aircraft: r.aircraft.map((a) => ({
      aircraftKey: a.aircraftKey,
      aircraftNtsbNo: a.aircraftNtsbNo,
      make: a.make,
      model: a.model,
      category: a.category,
      farPart: a.farPart,
      purpose: a.purpose,
      damage: a.damage,
      definingPhaseGroup: a.definingPhaseGroup,
      engines: [...new Set(a.engines.map((e) => e.engType).filter((t): t is string => t !== null))],
    })),
    sections: r.sections.map((s, i) => {
      if (sha256(s.text) !== s.sha256) throw new EvidenceIntegrityError(r.ntsbNo, s.sectionId);
      return {
        alias: `S${i + 1}`,
        sectionId: s.sectionId,
        sectionKey: s.sectionKey,
        kind: s.kind,
        scope: s.scope,
        aircraftKey: s.aircraftKey,
        revisionId: s.revisionId,
        sha256: s.sha256,
        text: s.text,
      };
    }),
    findings: r.findings.map((f, i) => ({
      alias: `F${i + 1}`,
      rowId: `${r.ntsbNo}/${f.aircraftKey}/finding/${f.findingNo}`,
      aircraftKey: f.aircraftKey,
      findingNo: f.findingNo,
      code: f.code,
      description: f.description === null ? null : normalizeFindingDescription(f.description),
      inProbableCause: f.inProbableCause,
    })),
    occurrences: r.sequence.map((q, i) => ({
      alias: `O${i + 1}`,
      rowId: `${r.ntsbNo}/${q.aircraftKey}/occurrence/${q.occurrenceNo}`,
      aircraftKey: q.aircraftKey,
      occurrenceNo: q.occurrenceNo,
      phaseGroup: q.phaseGroup,
      eventCode: q.eventCode,
      description: q.description,
      isDefining: q.isDefining,
    })),
  };
}

/** The evidence rows of a set of cases; every value a bind parameter; never `cause_factor`. */
export const EVIDENCE_QUERIES = {
  cases: `select ntsb_no, country, is_us, latitude, longitude, ev_date::text as ev_date, ev_year, city, state, light_cond, wx_cond_basic,
                 highest_injury, raw_status, completion_class, has_probable_cause, completed_with_cause, answer_eligible,
                 defining_phase_groups, sequence_phase_groups
            from cases where generation_id = $1 and ntsb_no = any($2::text[]) order by ntsb_no`,
  aircraft: `select ntsb_no, aircraft_key, aircraft_ntsb_no, make, model, category, far_part, purpose, damage, homebuilt,
                    defining_occurrence_no, defining_phase_group, defining_event_conflict, sequence_phase_groups
               from case_aircraft where generation_id = $1 and ntsb_no = any($2::text[])`,
  engines: `select ntsb_no, aircraft_key, eng_no, eng_type from case_engines where generation_id = $1 and ntsb_no = any($2::text[])`,
  sections: `select ntsb_no, section_id, section_key, kind, scope, aircraft_key, text, sha256, revision_id, citation_text_version
               from case_sections where generation_id = $1 and ntsb_no = any($2::text[])`,
  findings: `select ntsb_no, aircraft_key, finding_no, code, description, in_probable_cause
               from case_findings where generation_id = $1 and ntsb_no = any($2::text[])`,
  sequence: `select ntsb_no, aircraft_key, occurrence_no, phase_no, phase_group, event_code, description, is_defining
               from case_sequence where generation_id = $1 and ntsb_no = any($2::text[])`,
} as const;

type Row = Record<string, unknown>;

/** Rows as `assembleCaseRecords` reads them. */
export function caseRecordRows(r: { cases: Row[]; aircraft: Row[]; engines: Row[]; sections: Row[]; findings: Row[]; sequence: Row[] }): CaseRecordRows {
  return {
    cases: r.cases.map((c) => ({
      ntsbNo: c.ntsb_no as string,
      country: c.country as string | null,
      isUs: c.is_us as boolean,
      latitude: c.latitude as number | null,
      longitude: c.longitude as number | null,
      evDate: c.ev_date as string | null,
      evYear: c.ev_year as number | null,
      city: c.city as string | null,
      state: c.state as string | null,
      lightCond: c.light_cond as string | null,
      wxCondBasic: c.wx_cond_basic as string | null,
      highestInjury: c.highest_injury as string | null,
      rawStatus: c.raw_status as string | null,
      completionClass: c.completion_class as CaseRecord['completionClass'],
      hasProbableCause: c.has_probable_cause as boolean,
      completedWithCause: c.completed_with_cause as boolean,
      answerEligible: c.answer_eligible as boolean,
      definingPhaseGroups: c.defining_phase_groups as string[],
      sequencePhaseGroups: c.sequence_phase_groups as string[],
    })),
    aircraft: r.aircraft.map((a) => ({
      ntsbNo: a.ntsb_no as string,
      aircraftKey: a.aircraft_key as number,
      aircraftNtsbNo: a.aircraft_ntsb_no as string | null,
      make: a.make as string | null,
      model: a.model as string | null,
      category: a.category as string | null,
      farPart: a.far_part as string | null,
      purpose: a.purpose as string | null,
      damage: a.damage as string | null,
      homebuilt: a.homebuilt as boolean | null,
      definingOccurrenceNo: a.defining_occurrence_no as number | null,
      definingPhaseGroup: a.defining_phase_group as string | null,
      definingEventConflict: a.defining_event_conflict as boolean,
      sequencePhaseGroups: a.sequence_phase_groups as string[],
    })),
    engines: r.engines.map((e) => ({ ntsbNo: e.ntsb_no as string, aircraftKey: e.aircraft_key as number, engNo: e.eng_no as number, engType: e.eng_type as string | null })),
    sections: r.sections.map((s) => ({
      ntsbNo: s.ntsb_no as string,
      sectionId: s.section_id as string,
      sectionKey: s.section_key as string,
      kind: s.kind as SectionKind,
      scope: s.scope as 'event' | 'aircraft',
      aircraftKey: s.aircraft_key as number | null,
      text: s.text as string,
      sha256: s.sha256 as string,
      revisionId: s.revision_id as string,
      citationTextVersion: s.citation_text_version as string,
    })),
    findings: r.findings.map((f) => ({
      ntsbNo: f.ntsb_no as string,
      aircraftKey: f.aircraft_key as number,
      findingNo: f.finding_no as number,
      code: f.code as string | null,
      description: f.description as string | null,
      inProbableCause: f.in_probable_cause as boolean | null,
    })),
    sequence: r.sequence.map((q) => ({
      ntsbNo: q.ntsb_no as string,
      aircraftKey: q.aircraft_key as number,
      occurrenceNo: q.occurrence_no as number,
      phaseNo: q.phase_no as number | null,
      phaseGroup: q.phase_group as string,
      eventCode: q.event_code as string | null,
      description: q.description as string | null,
      isDefining: q.is_defining as boolean | null,
    })),
  };
}

export interface LoadedEvidence {
  evidence: Map<string, CaseEvidence>;
  /** Cases the generation does not hold. */
  missing: string[];
  /** Cases whose stored section text fails its hash: never judged (`unknown`). */
  integrity: { ntsbNo: string; sectionId: string }[];
}

/** The complete evidence of `ntsbNos` from one generation, in one read-only, repeatable-read snapshot (batches of 200). */
export async function loadCaseEvidence(client: pg.ClientBase, generationId: number, ntsbNos: readonly string[]): Promise<LoadedEvidence> {
  const wanted = [...new Set(ntsbNos)].sort();
  const out: LoadedEvidence = { evidence: new Map(), missing: [], integrity: [] };
  await client.query('begin transaction isolation level repeatable read read only');
  try {
    for (let i = 0; i < wanted.length; i += 200) {
      const batch = wanted.slice(i, i + 200);
      const q = async (sql: string) => (await client.query<Row>(sql, [generationId, batch])).rows;
      const rows = caseRecordRows({
        cases: await q(EVIDENCE_QUERIES.cases),
        aircraft: await q(EVIDENCE_QUERIES.aircraft),
        engines: await q(EVIDENCE_QUERIES.engines),
        sections: await q(EVIDENCE_QUERIES.sections),
        findings: await q(EVIDENCE_QUERIES.findings),
        sequence: await q(EVIDENCE_QUERIES.sequence),
      });
      for (const record of assembleCaseRecords(generationId, rows)) {
        try {
          out.evidence.set(record.ntsbNo, evidenceOf(record));
        } catch (err) {
          if (!(err instanceof EvidenceIntegrityError)) throw err;
          out.integrity.push({ ntsbNo: err.ntsbNo, sectionId: err.sectionId });
        }
      }
      const found = new Set(rows.cases.map((c) => c.ntsbNo));
      out.missing.push(...batch.filter((n) => !found.has(n)));
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Identities

/** The complete-input fingerprint (module comment). */
export function fingerprint(e: CaseEvidence): string {
  return sha256(
    canonicalJson({
      version: JUDGE_INPUT_VERSION,
      ntsbNo: e.ntsbNo,
      event: e.event,
      aircraft: e.aircraft,
      sections: e.sections.map((s) => ({ sectionId: s.sectionId, kind: s.kind, scope: s.scope, aircraftKey: s.aircraftKey, revisionId: s.revisionId, sha256: s.sha256 })),
      findings: e.findings.map(({ alias: _a, ...f }) => f),
      occurrences: e.occurrences.map(({ alias: _a, ...o }) => o),
    }),
  );
}

/** A passage a retrieval bundle delivered for one case. */
export interface DeliveredPassage {
  passageId: string;
  sectionId: string;
  revisionId: string;
  kind: SectionKind;
  scope: 'event' | 'aircraft';
  aircraftKey: number | null;
  /** UTF-16 offsets of the passage in its section. */
  start: number;
  end: number;
  text: string;
}

/** The bundle fingerprint: the input version, the case and its delivered passages (ids and texts), in delivered order. */
export function bundleFingerprint(ntsbNo: string, event: CaseEvidence['event'], aircraft: readonly EvidenceAircraft[], passages: readonly DeliveredPassage[]): string {
  return sha256(
    canonicalJson({
      version: JUDGE_INPUT_VERSION,
      ntsbNo,
      event,
      aircraft,
      passages: passages.map((p) => ({ passageId: p.passageId, textSha256: sha256(p.text) })),
    }),
  );
}

// ---------------------------------------------------------------------------
// Rendering

/** Delimiter tags of the judge prompts. */
const JUDGE_TAGS = [
  'question',
  'rubric',
  'case',
  'header',
  'sections',
  'section',
  'findings',
  'occurrences',
  'passages',
  'passage',
  'notes',
  'chunk',
  'verdicts',
  'verdict',
  'initial',
  'adjudication',
];
const TAG_START = new RegExp(`<(?=\\s*/?\\s*(?:${JUDGE_TAGS.join('|')})\\b)`, 'gi');

/** Replace the `<` of anything shaped like a judge-prompt delimiter tag with `‹`; other text is kept byte for byte. */
export const untrustedText = (text: string): string => text.replace(TAG_START, '‹');

/** Escape a value for a double-quoted tag attribute. */
export const attr = (value: string): string => value.replace(/[&"<>]/g, (c) => (c === '&' ? '&amp;' : c === '"' ? '&quot;' : c === '<' ? '&lt;' : '&gt;'));

const SECTION_LABEL: Readonly<Record<SectionKind, string>> = { factual: 'factual information', analysis: 'analysis', probable_cause: 'probable cause' };
const yesNo = (b: boolean | null): string => (b === null ? 'not recorded' : b ? 'yes' : 'no');
const value = (v: string | null | undefined): string => (v === null || v === undefined || v.trim() === '' ? 'not recorded' : v.trim());

function aircraftLine(a: EvidenceAircraft): string {
  const name = [a.make, a.model].filter((x): x is string => x !== null && x.trim() !== '').join(' ') || 'make and model not recorded';
  return (
    `Aircraft ${a.aircraftKey}${a.aircraftNtsbNo ? ` (${a.aircraftNtsbNo})` : ''}: ${untrustedText(name)}; category ${value(a.category)}; ` +
    `operating rules ${value(a.farPart)}; purpose ${value(a.purpose)}; damage ${value(a.damage)}; ` +
    `defining event phase ${value(a.definingPhaseGroup)}; engine type ${a.engines.length > 0 ? a.engines.join(', ') : 'not recorded'}`
  );
}

/** The event and aircraft facts every judge input starts with. */
export function renderHeader(e: Pick<CaseEvidence, 'ntsbNo' | 'event' | 'aircraft'>): string {
  const ev = e.event;
  return [
    '<header>',
    `Case ${e.ntsbNo}. Date ${value(ev.date)}; location ${untrustedText([ev.city, ev.state].filter((x): x is string => x !== null && x.trim() !== '').join(', ') || 'not recorded')}; ` +
      `highest injury ${value(ev.highestInjury)}; light ${value(ev.light)}; basic weather ${value(ev.weather)}; ${e.aircraft.length} aircraft.`,
    ...e.aircraft.map(aircraftLine),
    '</header>',
  ].join('\n');
}

function sectionOpen(s: EvidenceSection, part?: { part: number; parts: number; start: number; end: number }): string {
  const scope = s.scope === 'aircraft' ? `scope="aircraft" aircraft="${s.aircraftKey}"` : 'scope="event"';
  const p = part && part.parts > 1 ? ` part="${part.part}" parts="${part.parts}"` : '';
  return `<section id="${s.alias}" kind="${attr(SECTION_LABEL[s.kind])}" ${scope}${p}>`;
}

export function renderRows(e: Pick<CaseEvidence, 'findings' | 'occurrences'>): string {
  const findings = e.findings.map(
    (f) =>
      `${f.alias} aircraft="${f.aircraftKey}" code="${attr(value(f.code))}" cited_in_probable_cause="${yesNo(f.inProbableCause)}": ${untrustedText(value(f.description))}`,
  );
  const occurrences = e.occurrences.map(
    (o) =>
      `${o.alias} aircraft="${o.aircraftKey}" code="${attr(value(o.eventCode))}" phase="${attr(o.phaseGroup)}" defining_event="${yesNo(o.isDefining)}": ${untrustedText(value(o.description))}`,
  );
  return [
    '<findings>',
    ...(findings.length > 0 ? findings : ['(no coded findings)']),
    '</findings>',
    '<occurrences>',
    ...(occurrences.length > 0 ? occurrences : ['(no coded occurrences)']),
    '</occurrences>',
  ].join('\n');
}

/** A section or a part of it, by UTF-16 offsets into the section text. */
export interface SectionPiece {
  alias: string;
  start: number;
  end: number;
  part: number;
  parts: number;
}

export function renderSections(e: CaseEvidence, pieces?: readonly SectionPiece[]): string {
  const byAlias = new Map(e.sections.map((s) => [s.alias, s]));
  const list = pieces ?? e.sections.map((s) => ({ alias: s.alias, start: 0, end: s.text.length, part: 1, parts: 1 }));
  const body = list.map((p) => {
    const s = byAlias.get(p.alias);
    if (!s) throw new Error(`unknown section ${p.alias}`);
    return `${sectionOpen(s, p)}\n${untrustedText(s.text.slice(p.start, p.end))}\n</section>`;
  });
  return ['<sections>', ...(body.length > 0 ? body : ['(no narrative sections)']), '</sections>'].join('\n');
}

/** The complete case as one judge input block. */
export function renderCase(e: CaseEvidence, pieces?: readonly SectionPiece[]): string {
  return ['<case>', renderHeader(e), renderSections(e, pieces), renderRows(e), '</case>'].join('\n');
}

/** The delivered passages of one case (bundle answerability). */
export function renderBundleCase(e: Pick<CaseEvidence, 'ntsbNo' | 'event' | 'aircraft'>, passages: readonly DeliveredPassage[]): string {
  const body = passages.map((p, i) => {
    const scope = p.scope === 'aircraft' ? `scope="aircraft" aircraft="${p.aircraftKey}"` : 'scope="event"';
    return `<passage id="P${i + 1}" kind="${attr(SECTION_LABEL[p.kind])}" ${scope}>\n${untrustedText(p.text)}\n</passage>`;
  });
  return ['<case>', renderHeader(e), '<passages>', ...(body.length > 0 ? body : ['(no passages)']), '</passages>', '</case>'].join('\n');
}

// ---------------------------------------------------------------------------
// Long cases

export interface ChunkPlan {
  /** Chunks in order; a single chunk holds the whole case. */
  chunks: SectionPiece[][];
  /** `cl100k_base` tokens of the whole rendered case. */
  tokens: number;
  /** Null when every section is covered; otherwise why the case cannot be covered. */
  uncovered: string | null;
}

const BOUNDARIES: readonly RegExp[] = [/\n\s*\n/g, /\n/g, /(?<=[.!?])\s+/g, /\s+/g];

/**
 * Split `[start, end)` of `text` into consecutive spans of at most `room` tokens, cutting
 * at the coarsest boundary that works (paragraph, line, sentence, word) and filling each
 * span greedily; null when a single word is longer than the room. Spans cover the range
 * exactly: nothing is dropped.
 */
export function splitText(text: string, start: number, end: number, room: number, level = 0): [number, number][] | null {
  if (countTokens(text.slice(start, end)) <= room) return [[start, end]];
  const re = BOUNDARIES[level];
  if (!re) return null;
  const cuts: number[] = [];
  for (const m of text.slice(start, end).matchAll(re)) {
    const cut = start + (m.index as number) + m[0].length;
    if (cut > start && cut < end) cuts.push(cut);
  }
  if (cuts.length === 0) return splitText(text, start, end, room, level + 1);
  const units: [number, number][] = [];
  let from = start;
  for (const cut of [...cuts, end]) {
    if (cut > from) units.push([from, cut]);
    from = cut;
  }
  const out: [number, number][] = [];
  let span: [number, number] | null = null;
  for (const [a, b] of units) {
    if (span && countTokens(text.slice(span[0], b)) <= room) {
      span = [span[0], b];
      continue;
    }
    if (span) out.push(span);
    span = null;
    if (countTokens(text.slice(a, b)) <= room) {
      span = [a, b];
      continue;
    }
    const finer = splitText(text, a, b, room, level + 1);
    if (!finer) return null;
    out.push(...finer);
  }
  if (span) out.push(span);
  return out;
}

/** Chunks of a case under `budget` (module comment). */
export function planChunks(e: CaseEvidence, budget = CASE_TOKEN_BUDGET): ChunkPlan {
  const tokens = countTokens(renderCase(e));
  if (tokens <= budget) return { chunks: [e.sections.map((s) => ({ alias: s.alias, start: 0, end: s.text.length, part: 1, parts: 1 }))], tokens, uncovered: null };
  // Every chunk repeats the header and the rows; what is left is the room for section text.
  const fixed = countTokens(renderCase({ ...e, sections: [] })) + 40;
  const room = budget - fixed;
  if (room < 500) return { chunks: [], tokens, uncovered: `the header, findings and occurrences alone take ${fixed} of the ${budget}-token budget` };
  const perSection: SectionPiece[][] = [];
  for (const s of e.sections) {
    const spans = splitText(s.text, 0, s.text.length, room - 30);
    if (!spans) return { chunks: [], tokens, uncovered: `${s.alias} cannot be split within the budget` };
    perSection.push(spans.map(([start, end], i) => ({ alias: s.alias, start, end, part: i + 1, parts: spans.length })));
  }
  const chunks: SectionPiece[][] = [];
  let current: SectionPiece[] = [];
  let used = 0;
  const cost = (p: SectionPiece) => countTokens((e.sections.find((s) => s.alias === p.alias) as EvidenceSection).text.slice(p.start, p.end)) + 30;
  for (const piece of perSection.flat()) {
    const c = cost(piece);
    if (current.length > 0 && used + c > room) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(piece);
    used += c;
  }
  if (current.length > 0) chunks.push(current);
  return { chunks, tokens, uncovered: null };
}

/** Every character of every section lies in exactly one piece, in order (a plan invariant; tests use it). */
export function coversEverySection(e: CaseEvidence, chunks: readonly (readonly SectionPiece[])[]): boolean {
  const pieces = chunks.flat();
  for (const s of e.sections) {
    const mine = pieces.filter((p) => p.alias === s.alias);
    let at = 0;
    for (const p of mine) {
      if (p.start !== at || p.end <= p.start) return false;
      at = p.end;
    }
    if (at !== s.text.length) return false;
  }
  return pieces.every((p) => e.sections.some((s) => s.alias === p.alias));
}
