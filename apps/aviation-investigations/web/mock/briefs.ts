/**
 * Mock AI briefs (shared/contracts/briefs.ts) for the MSW handlers, the component tests
 * and the end-to-end tests of the AI interface. Hand-written readings of the four seed
 * cases (DESIGN §3), over the fixture texts in `cases.json`: every quote is located in
 * its section text at load time, so spans and offsets are real, and every static reply
 * and reading label comes from the server's own templates.
 *
 * `MockBriefs` is a small in-memory server: a question becomes a brief whose step moves
 * through the checklist one stage per poll (`pollsToFinish` polls), and some questions
 * get the other outcomes:
 * - containing "withheld": the summary is withheld (cards only);
 * - "poem", "recipe", "stock" or "bitcoin": out of scope;
 * - "what should i do", "right now" or "should i fly": operational advice;
 * - "how many", "how often" or "trend": counting (statistics);
 * - "compare" with case numbers: a comparison reply;
 * - "soon after": a clarification with two readings;
 * - "no match": the answer model's explicit abstention (no retrieved case supports the question);
 * - "midair": an "Examples found" answer about two-aircraft events (SEA08LA057, WPR15FA010),
 *   whose evidence is event-scoped, with two adjacent case citations in the summary;
 * - "nothing": no results.
 *
 * Once the scope row is done, a running step's checklist carries the step's readings and
 * filters (`checklist.interpretation`), as the finished result does.
 */
import {
  type BriefFilters,
  type BriefQuote,
  type BriefResult,
  type BriefStepResponse,
  type CaseCard,
  type CaseContextResponse,
  type Checklist,
  type CreateBriefRequest,
  type InterpretationChip,
  type RefinementChange,
  type RefinementRequest,
  type ScopeReply,
  type StartBriefResponse,
  MAX_BRIEF_STEPS,
} from '../../shared/contracts/briefs.js';
import type { CaseDetail } from '../../shared/contracts/cases.js';
import type { ErrorResponse } from '../../shared/contracts/common.js';
import type { CaseRow } from '../../shared/contracts/search.js';
import { clarificationReadings, timingWindowLabel } from '../../server/briefs/clarify.js';
import { readingLines } from '../../server/briefs/context.js';
import {
  NO_MATCH_LINES,
  clarificationReply,
  comparisonReply,
  operationalReply,
  outOfScopeReply,
  statisticsReply,
} from '../../server/briefs/static-replies.js';
import casesJson from './cases.json' with { type: 'json' };
import indexJson from './search-index.json' with { type: 'json' };

const CASES = casesJson as unknown as Record<string, CaseDetail>;
const ROWS = new Map(
  (indexJson.docs as unknown as { row: Omit<CaseRow, 'snippet'> }[]).map((d) => [d.row.ntsbNo, d.row] as const),
);

export const MOCK_SEED_QUESTION = 'Engine power loss shortly after maintenance';

// ---------------------------------------------------------------------------
// Passages and quotes from the fixture texts

function section(ntsbNo: string, kind: 'analysis' | 'probable_cause') {
  const s = CASES[ntsbNo]?.sections.find((x) => x.kind === kind);
  if (!s) throw new Error(`mock briefs: ${ntsbNo} has no ${kind} section`);
  return s;
}

const passageId = (ntsbNo: string, kind: string) => `mock-${ntsbNo}-${kind}`;

/** A quote located in the section text (the mock passages are whole sections). */
function quote(ntsbNo: string, kind: 'analysis' | 'probable_cause', text: string, speaker: BriefQuote['speaker'] = 'investigators'): BriefQuote {
  const s = section(ntsbNo, kind);
  const start = s.text.indexOf(text);
  if (start < 0) throw new Error(`mock briefs: quote not found in ${ntsbNo} ${kind}`);
  const span = { start, end: start + text.length };
  return {
    passageId: passageId(ntsbNo, kind),
    section: kind,
    scope: s.scope,
    aircraftKey: s.aircraftKey,
    sectionId: `${ntsbNo}:${s.key}`,
    // The mock has no revision ids; the section's text hash stands in for both.
    revisionId: s.revision,
    sectionRevision: s.revision,
    text,
    span,
    sectionSpan: span,
    speaker,
  };
}

function plainCard(ntsbNo: string): CaseCard {
  const row = ROWS.get(ntsbNo);
  const detail = CASES[ntsbNo];
  if (!row || !detail) throw new Error(`mock briefs: no fixture case ${ntsbNo}`);
  const s = section(ntsbNo, 'analysis');
  const cut = s.text.length > 600 ? s.text.slice(0, s.text.lastIndexOf(' ', 600)) : s.text;
  return {
    case: row,
    report: detail.report,
    excerpt: { passageId: passageId(ntsbNo, 'analysis'), section: 'analysis', text: cut.trim(), truncatedStart: false, truncatedEnd: cut.length < s.text.length },
    reading: null,
  };
}

const INTERPRETATIONS: InterpretationChip[] = [
  { field: 'timing_window', value: { days: 30, flightHours: 10 }, label: timingWindowLabel({ days: 30, flightHours: 10 }), pinned: false },
];

// ---------------------------------------------------------------------------
// The seed brief

const SEED_CASES = ['DFW08TA066', 'MIA08LA156', 'DEN08LA103'] as const;

const analysisId = (n: string) => passageId(n, 'analysis');
const causeId = (n: string) => passageId(n, 'probable_cause');

/** The seed readings' DESIGN §3 dimensions, each with its own passages (the drawer's lines). */
const SEED_DIMENSIONS: Readonly<Record<string, Parameters<typeof readingLines>[1]>> = {
  DFW08TA066: {
    ntsbNo: 'DFW08TA066',
    evidencePassageIds: [analysisId('DFW08TA066'), causeId('DFW08TA066')],
    maintenance: { relation: 'investigator_attributed', passageIds: [causeId('DFW08TA066')] },
    symptom: { value: 'total_power_loss', passageIds: [analysisId('DFW08TA066')] },
    timing: [{ basis: 'flight_hours', passageIds: [analysisId('DFW08TA066')] }],
    criteria: [{ criterion: 'timing_window', decision: 'matches', passageIds: [analysisId('DFW08TA066')] }],
  },
  MIA08LA156: {
    ntsbNo: 'MIA08LA156',
    evidencePassageIds: [analysisId('MIA08LA156')],
    maintenance: { relation: 'preceding_not_established', passageIds: [analysisId('MIA08LA156')] },
    symptom: { value: 'partial_power_loss', passageIds: [analysisId('MIA08LA156'), causeId('MIA08LA156')] },
    timing: [{ basis: 'first_flight', passageIds: [analysisId('MIA08LA156')] }],
    // Unconfirmed: the claim was checked on every supplied passage of the case.
    criteria: [{ criterion: 'timing_window', decision: 'unconfirmed', passageIds: [analysisId('MIA08LA156'), causeId('MIA08LA156')] }],
  },
  DEN08LA103: {
    ntsbNo: 'DEN08LA103',
    evidencePassageIds: [analysisId('DEN08LA103'), causeId('DEN08LA103')],
    maintenance: { relation: 'preceding_not_established', passageIds: [analysisId('DEN08LA103')] },
    symptom: { value: 'partial_power_loss', passageIds: [analysisId('DEN08LA103')] },
    timing: [{ basis: 'subsequent_flight', passageIds: [analysisId('DEN08LA103')] }],
    criteria: [{ criterion: 'timing_window', decision: 'unconfirmed', passageIds: [analysisId('DEN08LA103'), causeId('DEN08LA103')] }],
  },
};

function seedCards(): CaseCard[] {
  return [
    {
      ...plainCard('DFW08TA066'),
      reading: {
        glyph: 'causal',
        why: 'The engine stopped producing power 5.1 hours after a contract facility replaced it.',
        timing: [{ basis: 'flight_hours', value: 5.1, bound: 'exact', label: '5.1 FH' }],
        quotes: [
          quote(
            'DFW08TA066',
            'analysis',
            'Further examination of the engine revealed that a castellated nut used to secure the governor lever control rod to the idler bell crank had come completely loose, and the cotter pin that secured the nut was missing.',
          ),
          quote('DFW08TA066', 'analysis', 'The engine had  been replaced 5.1 hours prior to the accident by a contract maintenance facility.'),
        ],
        evidence: { scope: 'aircraft', aircraftKey: 1 },
        criteria: [{ criterion: 'timing_window', decision: 'matches' }],
      },
    },
    {
      ...plainCard('MIA08LA156'),
      reading: {
        glyph: 'defect_not_causal',
        why: 'Power was lost on the test flight after maintenance, and a fuel-system defect was found without a causal link.',
        timing: [{ basis: 'first_flight', value: null, bound: 'exact', label: '1ST FLIGHT' }],
        quotes: [
          quote(
            'MIA08LA156',
            'analysis',
            'The examination discovered that a check valve from the engine mechanical fuel pump return hose line back to the fuel tank was installed incorrectly (backwards).',
          ),
          quote('MIA08LA156', 'analysis', 'During both test phases, the engine accelerated normally without any hesitation or interruption in power.'),
        ],
        evidence: { scope: 'aircraft', aircraftKey: 1 },
        criteria: [{ criterion: 'timing_window', decision: 'unconfirmed' }],
      },
    },
    {
      ...plainCard('DEN08LA103'),
      reading: {
        glyph: 'no_fault',
        why: 'The engine lost power days after maintenance and test flights, and the reason was never determined.',
        timing: [{ basis: 'subsequent_flight', value: null, bound: 'exact', label: 'LATER FLIGHT' }],
        quotes: [
          quote('DEN08LA103', 'analysis', 'The reason for the loss of engine power was not determined.'),
          quote('DEN08LA103', 'analysis', 'The pilot stated, "I am now sure the engine was trying to seize up and I was again forced to land."', 'pilot'),
        ],
        evidence: { scope: 'aircraft', aircraftKey: 1 },
        criteria: [{ criterion: 'timing_window', decision: 'unconfirmed' }],
      },
    },
  ];
}

/** The answer to `MOCK_SEED_QUESTION`, as the server would render it. */
export function seedAnswer(filters: BriefFilters = {}): Extract<BriefResult, { kind: 'answer' }> {
  return {
    kind: 'answer',
    interpretations: INTERPRETATIONS,
    filters,
    grouping: 'mechanical',
    summary: [
      { kind: 'text', text: 'In one investigation, a mechanic left a control-rod nut unsecured after an engine change, and investigators found that it caused the power loss ' },
      { kind: 'case', ntsbNo: 'DFW08TA066', unconfirmed: false },
      { kind: 'text', text: '. In another, a fuel-system check valve was installed backwards, but engine runs with it either way were normal, so no causal link was established ' },
      { kind: 'case', ntsbNo: 'MIA08LA156', unconfirmed: true },
      { kind: 'text', text: '. In the third, the reason for the power loss was never determined ' },
      { kind: 'case', ntsbNo: 'DEN08LA103', unconfirmed: true },
      { kind: 'text', text: '.' },
    ],
    groups: [
      { kind: 'causal', caseNumbers: ['DFW08TA066'] },
      { kind: 'defect_not_causal', caseNumbers: ['MIA08LA156'] },
      { kind: 'no_fault', caseNumbers: ['DEN08LA103'] },
      { kind: 'insufficient', caseNumbers: [] },
    ],
    cases: seedCards(),
    gaps: [NYC_GAP],
  };
}

const NYC_GAP = {
  ntsbNo: 'NYC08LA106',
  text: 'Just outside the window: the supplied passages put the fuel pump installation about two months and 12 hours before the power loss.',
  passageIds: [analysisId('NYC08LA106')],
};

/**
 * The explicit abstention: no retrieved case supports the question as asked (the
 * server's copy says so about the retrieved cases only); the retrieved cases as plain cards.
 */
export function seedNoMatch(filters: BriefFilters = {}): Extract<BriefResult, { kind: 'no_match' }> {
  return {
    kind: 'no_match',
    interpretations: INTERPRETATIONS,
    filters,
    lines: [...NO_MATCH_LINES],
    cases: [...SEED_CASES, 'NYC08LA106'].map(plainCard),
    gaps: [NYC_GAP],
  };
}

// ---------------------------------------------------------------------------
// Two-aircraft events: every narrative is event-scoped, so the evidence is the event's and
// no glyph is assigned (UI_DESIGN §4.3 "Multi-aircraft events").

export const MOCK_MIDAIR_QUESTION = 'Midair collisions after departing from a fly-in';

export function midairAnswer(filters: BriefFilters = {}): Extract<BriefResult, { kind: 'answer' }> {
  const card = (ntsbNo: string, why: string, quotes: readonly string[]): CaseCard => ({
    ...plainCard(ntsbNo),
    reading: {
      glyph: null,
      why,
      timing: [],
      quotes: quotes.map((q) => quote(ntsbNo, 'analysis', q)),
      evidence: { scope: 'event', multiAircraft: true },
      criteria: [],
    },
  });
  return {
    kind: 'answer',
    interpretations: [],
    filters,
    grouping: 'examples',
    summary: [
      { kind: 'text', text: 'In both events one airplane departed from a fly-in while another was in the traffic pattern, and the airplanes collided ' },
      { kind: 'case', ntsbNo: 'SEA08LA057', unconfirmed: false },
      { kind: 'case', ntsbNo: 'WPR15FA010', unconfirmed: false },
      { kind: 'text', text: '. In one, a witness had warned the departing pilot that an airplane was landing ' },
      { kind: 'case', ntsbNo: 'SEA08LA057', unconfirmed: false },
      { kind: 'text', text: '.' },
    ],
    groups: [{ kind: 'examples', caseNumbers: ['SEA08LA057', 'WPR15FA010'] }],
    cases: [
      card('SEA08LA057', 'A departing airplane took off into the path of an airplane landing at the same fly-in.', [
        'The witness was flying above the airport and advised the departing pilot that an airplane was landing.',
        'The airplanes collided shortly thereafter.',
      ]),
      card('WPR15FA010', 'Two airplanes departing a fly-in collided while one tried to join up with the other.', [
        "The evidence indicated that the Savannah pilot attempted a join-up maneuver without maintaining adequate awareness of the Cessna's position.",
      ]),
    ],
    gaps: [],
  };
}

/** The same brief with its summary withheld: the cards only. */
export function seedWithheld(filters: BriefFilters = {}): Extract<BriefResult, { kind: 'withheld' }> {
  return {
    kind: 'withheld',
    interpretations: INTERPRETATIONS,
    filters,
    reason: 'citation_check',
    cases: [...SEED_CASES, 'NYC08LA106'].map(plainCard),
  };
}

/** One sample of every static scope reply. */
export const SCOPE_REPLY_SAMPLES = {
  outOfScope: outOfScopeReply(),
  operational: operationalReply(),
  statistics: statisticsReply({ category: ['HELI'], yearFrom: 2015 }),
  comparison: comparisonReply(['DFW08TA066', 'NYC08LA106', 'XYZ99ZZ999'], new Set(['DFW08TA066', 'NYC08LA106'])),
  clarification: clarificationReply(clarificationReadings({ type: 'timing_window', values: ['30d_or_10h', '7d', 'first_flight'] }, {})),
} as const satisfies Record<string, ScopeReply>;

/** Results other than an answer, for component tests. */
export const RESULT_SAMPLES = {
  answer: seedAnswer(),
  withheld: seedWithheld(),
  noMatch: seedNoMatch(),
  midair: midairAnswer(),
  noResults: { kind: 'no_results', interpretations: INTERPRETATIONS, filters: { category: ['BALL'], injury: ['FATL'] } },
  failedCounted: { kind: 'failed', countedAsSearch: true },
  failedFree: { kind: 'failed', countedAsSearch: false },
  cancelled: { kind: 'cancelled' },
  scopeReply: { kind: 'scope_reply', reply: SCOPE_REPLY_SAMPLES.outOfScope },
} as const satisfies Record<string, BriefResult>;

// ---------------------------------------------------------------------------
// The in-memory server

type Variant = 'answer' | 'withheld' | 'no_match' | 'no_results' | 'midair';

interface MockStep {
  n: number;
  origin: BriefStepResponse['origin'];
  variant: Variant | null;
  /** Static replies end at once. */
  reply: ScopeReply | null;
  filters: BriefFilters;
  polls: number;
  cancelled: boolean;
  startedAt: Date;
}

interface MockBrief {
  id: string;
  question: string;
  createdAt: Date;
  steps: MockStep[];
  keys: Map<string, number>;
}

/** `replayed`: the idempotency key was seen before, so nothing new ran and nothing is spent. */
export type MockReply<T> = { status: number; body: T | ErrorResponse | null; replayed?: boolean };

const STAGES: Checklist[] = [
  { question: 'in_scope' },
  { question: 'in_scope', searched: { cases: 4, passages: 9 } },
  { question: 'in_scope', searched: { cases: 4, passages: 9 }, written: true },
];

function scopeOf(question: string, filters: BriefFilters): { reply: ScopeReply | null; variant: Variant | null } {
  const q = question.toLowerCase();
  if (/\b(poem|recipe|stock|bitcoin)\b/.test(q)) return { reply: SCOPE_REPLY_SAMPLES.outOfScope, variant: null };
  if (/what should i do|right now|should i fly/.test(q)) return { reply: SCOPE_REPLY_SAMPLES.operational, variant: null };
  if (/how many|how often|\btrend/.test(q)) return { reply: statisticsReply(filters), variant: null };
  const numbers = question.toUpperCase().match(/\b[A-Z]{3}\d{2}[A-Z]{2}\d{3}\b/g) ?? [];
  if (/\bcompare\b/.test(q) && numbers.length > 0) return { reply: comparisonReply(numbers, new Set(Object.keys(CASES))), variant: null };
  if (/soon after/.test(q)) return { reply: SCOPE_REPLY_SAMPLES.clarification, variant: null };
  if (/\bnothing\b/.test(q)) return { reply: null, variant: 'no_results' };
  if (/\bno match\b/.test(q)) return { reply: null, variant: 'no_match' };
  if (/\bmidair\b/.test(q)) return { reply: null, variant: 'midair' };
  return { reply: null, variant: /withheld/.test(q) ? 'withheld' : 'answer' };
}

const error = (status: number, code: ErrorResponse['error'], message: string): MockReply<never> => ({ status, body: { error: code, message } });
const NOT_FOUND = (): MockReply<never> => error(404, 'not_found', 'No AI search with that link is available. AI searches expire after 24 hours.');

export interface MockBriefsOptions {
  /** Polls of `GET` until a running step is done (default 4: one per checklist row). */
  pollsToFinish?: number;
  now?: () => Date;
}

export class MockBriefs {
  private readonly briefs = new Map<string, MockBrief>();
  /** Create requests by idempotency key: a retry with the same key and question replays (DESIGN §8). */
  private readonly created = new Map<string, string>();
  private seq = 0;
  private readonly pollsToFinish: number;
  private readonly now: () => Date;

  constructor(opts: MockBriefsOptions = {}) {
    this.pollsToFinish = Math.max(1, opts.pollsToFinish ?? 4);
    this.now = opts.now ?? (() => new Date());
  }

  private newId(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
  }

  private stepFor(n: number, question: string, origin: MockStep['origin'], filters: BriefFilters): MockStep {
    const { reply, variant } = scopeOf(origin.kind === 'text' ? `${question} ${origin.text}` : question, filters);
    return { n, origin, variant, reply, filters, polls: 0, cancelled: false, startedAt: this.now() };
  }

  private start(brief: MockBrief, step: MockStep): MockReply<StartBriefResponse> {
    if (step.reply) return { status: 200, body: { kind: 'scope_reply', briefId: brief.id, step: step.n, reply: step.reply } };
    return { status: 202, body: { kind: 'started', briefId: brief.id, step: step.n, stage: 'retrieve' } };
  }

  create(body: CreateBriefRequest): MockReply<StartBriefResponse> {
    const earlier = this.briefs.get(this.created.get(body.idempotencyKey) ?? '');
    if (earlier) {
      if (earlier.question !== body.question) return error(409, 'conflict', 'This request key was used for another question.');
      return { ...this.start(earlier, earlier.steps[0]!), replayed: true };
    }
    const brief: MockBrief = { id: this.newId(), question: body.question, createdAt: this.now(), steps: [], keys: new Map() };
    const step = this.stepFor(1, body.question, { kind: 'question' }, body.filters ?? {});
    brief.steps.push(step);
    brief.keys.set(body.idempotencyKey, 1);
    this.briefs.set(brief.id, brief);
    this.created.set(body.idempotencyKey, brief.id);
    return this.start(brief, step);
  }

  refine(id: string, body: RefinementRequest): MockReply<StartBriefResponse> {
    const brief = this.briefs.get(id);
    if (!brief) return NOT_FOUND();
    const replayed = brief.keys.get(body.idempotencyKey);
    if (replayed !== undefined) return { ...this.start(brief, brief.steps[replayed - 1]!), replayed: true };
    if (brief.steps.length >= MAX_BRIEF_STEPS) {
      return error(409, 'refinement_limit', 'This brief has used its three refinements. Start a new search to keep going.');
    }
    const last = brief.steps[brief.steps.length - 1]!;
    if (this.stageOf(last) !== 'done' && this.stageOf(last) !== 'failed') {
      return error(429, 'in_flight', 'An AI search is already running. Wait for it to finish.');
    }
    const change: RefinementChange =
      body.kind === 'text' ? { kind: 'text', text: body.text } : body.kind === 'filters' ? { kind: 'filters', filters: body.filters } : { kind: 'interpretation', field: body.field, value: body.value };
    const origin: MockStep['origin'] =
      change.kind === 'text'
        ? { kind: 'text', text: change.text }
        : change.kind === 'filters'
          ? { kind: 'filters', filters: change.filters }
          : { kind: 'interpretation', label: change.field === 'timing_window' && typeof change.value === 'object' ? timingWindowLabel(change.value) : 'Reading changed' };
    const filters = change.kind === 'filters' ? change.filters : last.filters;
    const step = this.stepFor(brief.steps.length + 1, brief.question, origin, filters);
    // A picked reading or changed filters always runs the search.
    if (change.kind !== 'text') {
      step.reply = null;
      step.variant ??= 'answer';
    }
    brief.steps.push(step);
    brief.keys.set(body.idempotencyKey, step.n);
    return this.start(brief, step);
  }

  private stageOf(s: MockStep): BriefStepResponse['stage'] {
    if (s.reply) return 'done';
    if (s.cancelled) return 'failed';
    if (s.polls >= this.pollsToFinish) return 'done';
    return (['retrieve', 'compose', 'validate'] as const)[Math.min(s.polls, 2)] ?? 'validate';
  }

  private resultOf(s: MockStep): BriefResult | undefined {
    if (s.reply) return { kind: 'scope_reply', reply: s.reply };
    if (s.cancelled) return { kind: 'cancelled' };
    if (this.stageOf(s) !== 'done') return undefined;
    if (s.variant === 'withheld') return seedWithheld(s.filters);
    if (s.variant === 'no_match') return seedNoMatch(s.filters);
    if (s.variant === 'no_results') return { kind: 'no_results', ...this.contextOf(s) };
    if (s.variant === 'midair') return midairAnswer(s.filters);
    return seedAnswer(s.filters);
  }

  /** The readings and filters of a search step, as its result and its checklist carry them. */
  private contextOf(s: MockStep): NonNullable<Checklist['interpretation']> {
    return { interpretations: s.variant === 'midair' ? [] : [...INTERPRETATIONS], filters: s.filters };
  }

  private checklistOf(s: MockStep): Checklist {
    if (s.reply) return {};
    const stage = this.stageOf(s);
    // The scope row is done from the first read on, so the chips can stay on top.
    const interpretation = this.contextOf(s);
    if (stage === 'done') {
      if (s.variant === 'no_results') return { question: 'in_scope', interpretation, searched: { cases: 0, passages: 0 } };
      return { ...STAGES[2]!, interpretation, verified: s.variant === 'withheld' ? 'withheld' : 'passed' };
    }
    return { ...STAGES[Math.min(s.polls, 2)]!, interpretation };
  }

  /** `GET /api/briefs/:id?step=n`: each poll of a running step moves it one stage on. */
  read(id: string, n?: number): MockReply<BriefStepResponse> {
    const brief = this.briefs.get(id);
    const step = brief ? (n === undefined ? brief.steps[brief.steps.length - 1] : brief.steps[n - 1]) : undefined;
    if (!brief || !step) return NOT_FOUND();
    const stage = this.stageOf(step);
    const finished = stage === 'done' || stage === 'failed';
    const body: BriefStepResponse = {
      briefId: brief.id,
      step: step.n,
      steps: brief.steps.length,
      refinementsLeft: Math.max(0, MAX_BRIEF_STEPS - brief.steps.length),
      question: brief.question,
      origin: step.origin,
      stage,
      checklist: this.checklistOf(step),
      startedAt: step.startedAt.toISOString(),
      finishedAt: finished ? this.now().toISOString() : null,
      expiresAt: new Date(brief.createdAt.getTime() + 24 * 60 * 60_000).toISOString(),
      ...(finished ? { result: this.resultOf(step)! } : {}),
    };
    if (!finished) step.polls += 1;
    return { status: 200, body };
  }

  cancel(id: string): MockReply<null> {
    const brief = this.briefs.get(id);
    if (!brief) return NOT_FOUND();
    const step = brief.steps[brief.steps.length - 1]!;
    if (this.stageOf(step) !== 'done') step.cancelled = true;
    return { status: 204, body: null };
  }

  /** `GET /api/briefs/:id/steps/:n/cases/:ntsbNo`. */
  context(id: string, n: number, ntsbNo: string): MockReply<CaseContextResponse> {
    const brief = this.briefs.get(id);
    const step = brief?.steps[n - 1];
    const result = step ? this.resultOf(step) : undefined;
    if (!brief || !step || !result || (result.kind !== 'answer' && result.kind !== 'withheld' && result.kind !== 'no_match')) return NOT_FOUND();
    const card = result.cases.find((c) => c.case.ntsbNo === ntsbNo);
    const gaps = result.kind === 'withheld' ? [] : result.gaps.filter((g) => g.ntsbNo === ntsbNo);
    if (!card && gaps.length === 0) return NOT_FOUND();
    const reading = result.kind === 'answer' ? (card?.reading ?? null) : null;
    const passages = (['analysis', 'probable_cause'] as const).map((kind) => {
      const s = section(ntsbNo, kind);
      return {
        passageId: passageId(ntsbNo, kind),
        section: kind,
        scope: s.scope,
        aircraftKey: s.aircraftKey,
        sectionId: `${ntsbNo}:${s.key}`,
        revisionId: s.revision,
        sectionRevision: s.revision,
        sectionStart: 0,
        text: s.text,
        highlights: (reading?.quotes ?? []).filter((q) => q.passageId === passageId(ntsbNo, kind)).map((q) => q.span),
      };
    });
    const lines = reading ? readingLines(reading, SEED_DIMENSIONS[ntsbNo]) : [];
    return { status: 200, body: { briefId: brief.id, step: n, ntsbNo, reading, lines, gaps, passages } };
  }
}
