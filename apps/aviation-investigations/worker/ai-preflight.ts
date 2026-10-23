/**
 * `pnpm worker ai-preflight`: a free check that every language-model request of a brief
 * fits its hard cap (`STAGE_CAPS`, DESIGN §9) with the configured provider and models.
 * Run it before paid tests and deployments (docs/RUNBOOK.md): a cap below a stage's
 * fixed request size refuses every brief at that stage (the first paid end-to-end test
 * stopped at scope this way).
 *
 * It only counts tokens with the provider's own counter (Anthropic `messages.countTokens`,
 * which is free); its client refuses generation. For each stage it counts:
 * - the fixed request: the system prompt and structured-output schema with a minimal input;
 * - a synthetic worst case at the input bounds the server enforces: the longest question
 *   and refinement, every filter, and a full bundle (6 cases, 12 passages of the chunker's
 *   largest size within the retrieval evidence budget, 400-character headers) with the
 *   longest claims the composition schema allows;
 * - the visible output at the output schema's bounds, counted as text: for the answer
 *   and check stages against the output cap less `THINKING_ALLOWANCE` and
 *   `CHECK_THINKING_ALLOWANCE` (thinking shares the cap);
 * - the frozen prefix the stage caches (system prompt and schema: the fixed request less
 *   its user turn counted alone) against `CACHED_PREFIX_MAX`, the size the reservation's
 *   cache-write premium assumes.
 *
 * The synthetic text is investigation-style prose written for this check (Latin script;
 * the scope stage also counts a dense non-Latin question at the query-embedding cap).
 * `preflightRequests` is pure, so the offline unit test sizes the same requests with the
 * local tokenizer (tests/unit/ai-preflight.test.ts).
 */
import { createHash } from 'node:crypto';
import { MAX_BRIEF_CASES, MAX_BRIEF_PASSAGES, QUESTION_MAX_CHARS, type ComposeOutput } from '../shared/contracts/briefs.js';
import { PHASE_GROUPS } from '../shared/codes.js';
import { MAX_QUERY_INPUT_TOKENS } from '../server/ai/embeddings.js';
import { CACHED_PREFIX_MAX, STAGE_CAPS } from '../server/ai/pricing.js';
import { renderCheckUser } from '../server/ai/prompts/check.v8.js';
import { renderComposeUser } from '../server/ai/prompts/compose.v7.js';
import { renderScopeUser } from '../server/ai/prompts/scope.v2.js';
import {
  AIRCRAFT_CATEGORY_CODES,
  CHECK_QUOTE_MAX,
  INJURY_CODES,
  MAX_CHECK_CLAIMS,
  MAX_CHECK_QUOTES,
  MAX_VERDICT_PASSAGES,
  LIGHT_CODES,
  WEATHER_CODES,
  stageCtx,
  type CheckInput,
  type ComposeInput,
  type LlmProvider,
  type LlmStage,
  type ScopeInput,
  type StageModels,
} from '../server/ai/provider.js';
import { countTokens } from '../server/ai/tokens.js';
import { checkForModel, composeForModel, passageAliases } from '../server/briefs/aliases.js';
import { evaluateCase } from '../server/briefs/criteria.js';
import { caseEvidence, checkInput, type VerifiedCase } from '../server/briefs/render.js';
import type { ResolvedCitation } from '../server/briefs/validate.js';
import { RETRIEVAL_DEFAULTS } from '../server/search/hybrid.js';
import { DEFAULT_CHUNK_OPTIONS } from './index/chunk.js';

/**
 * Output tokens left for thinking under the answer stage's output cap: Opus cannot turn
 * thinking off, and effort `low` bounds it. Check it against `usage.output_tokens` once
 * paid runs exist.
 */
export const THINKING_ALLOWANCE = 1_500;

/**
 * Output tokens left for thinking under the check stage's output cap, for the checker
 * configuration (Haiku 5.5, adaptive thinking at effort `low`). Measured in Task 16c (163
 * calls of 1 to 44 claims): at most 5,545 thinking tokens (held out; 4,915 in development),
 * at most about 146 a claim on checks of 30 claims or more and 222 on a 17-claim batch; at
 * the 60-claim bound (`MAX_CHECK_CLAIMS`) that is at most 13,320 → 15,000. Task 16d
 * re-measured it with the production caps (168 development calls, `check.v7` and `check.v8`):
 * at most 8,178 thinking tokens, on a 60-claim check (6,730 on the 123 held-out calls of at
 * most 44 claims).
 */
export const CHECK_THINKING_ALLOWANCE = 15_000;

/**
 * Offline sizing (no provider call), for the unit test that keeps the caps honest
 * between preflights. Measured with Anthropic's counter on 2026-10-22 (claude-haiku-5-5
 * and claude-opus-5-5 count identically):
 * - a stage's fixed request (system prompt plus structured-output schema) is 1.84-1.95
 *   times the `cl100k_base` size of the prompt and its JSON schema (the structured-output
 *   format costs about 2.5 times its JSON size) → `OFFLINE_FIXED_FACTOR` 2.2;
 * - Latin-script text (real NTSB passages: median 1.59, 90th percentile 1.68, maximum 1.89
 *   on single passages, 1.62 over a 12-passage bundle; English prompts about 1.5) →
 *   `OFFLINE_TEXT_FACTOR` 1.8 over a whole request. Dense scripts are counted by the
 *   provider preflight only (Japanese counts fewer Claude tokens than `cl100k` ones).
 */
export const OFFLINE_FIXED_FACTOR = 2.2;
export const OFFLINE_TEXT_FACTOR = 1.8;

/** Investigation-style sentences, written for this check (no real report text). */
const SENTENCES = [
  'The pilot reported that about 3 minutes after takeoff from runway 27, at about 800 ft above ground level, the engine lost partial power and began to run rough.',
  'He switched fuel tanks, applied carburetor heat and turned the auxiliary fuel pump on, but the engine did not regain full power, so he performed a forced landing in a soybean field.',
  'During the landing roll the nose landing gear collapsed and the airplane nosed over, which resulted in substantial damage to the fuselage, the right wing and the vertical stabilizer.',
  'Examination of the engine by an FAA airworthiness inspector revealed that the B-nut on the fuel inlet line to the carburetor (P/N 12-345-6) was finger tight and fuel stains were present.',
  'Maintenance records showed that the carburetor had been overhauled and reinstalled during an annual inspection completed 12.4 flight hours and 37 days before the accident.',
  'The mechanic who performed the work stated that he torqued the fitting to 135 in-lbs but did not apply a torque seal, and the work order did not include a duplicate inspection.',
  'Fuel samples taken from both wing tanks and the gascolator were blue, consistent with 100LL aviation fuel, and contained no water or visible contamination.',
  'The magnetos were removed and bench tested at 2,450 rpm; both produced spark at all leads, and the ignition timing was set at 25 degrees before top dead center.',
];

function sentencesUpTo(maxTokens: number, offset = 0): string {
  let text = '';
  for (let i = 0; ; i++) {
    const next = text ? `${text} ${SENTENCES[(i + offset) % SENTENCES.length]}` : SENTENCES[(i + offset) % SENTENCES.length]!;
    if (countTokens(next) > maxTokens) return text;
    text = next;
  }
}

function charsUpTo(maxChars: number, offset = 0): string {
  let text = '';
  for (let i = 0; ; i++) {
    const next = text ? `${text} ${SENTENCES[(i + offset) % SENTENCES.length]}` : SENTENCES[(i + offset) % SENTENCES.length]!;
    if (next.length > maxChars) return text || next.slice(0, maxChars);
    text = next;
  }
}

/** Text of exactly `n` characters (sentences, cut at the end). */
const exactly = (n: number, offset = 0) => charsUpTo(n * 2, offset).slice(0, n);

/** Japanese text (dense for `cl100k_base`) of at most `maxTokens` tokens and `maxChars` characters. */
function denseUpTo(maxTokens: number, maxChars: number): string {
  const unit = '整備直後に発動機の出力が低下し、操縦士は農地に不時着した。';
  let text = '';
  while (countTokens(text + unit) <= maxTokens && (text + unit).length <= maxChars) text += unit;
  return text;
}

const id = (n: number) => createHash('sha256').update(`ai-preflight-passage-${n}`).digest('hex');
const caseNo = (i: number) => `CEN19FA${String(10 + i).padStart(3, '0')}`;

export interface PreflightRequests {
  fixed: { scope: ScopeInput; compose: ComposeInput; check: CheckInput };
  worst: {
    /** `latin`: sized offline with `OFFLINE_TEXT_FACTOR` too; dense text only by the provider. */
    scope: { label: string; latin: boolean; input: ScopeInput }[];
    compose: ComposeInput;
    check: CheckInput;
  };
  /** The visible output at each output schema's bounds, as the model would write it. */
  outputs: { scope: string; compose: string; check: string };
  /** Facts about the synthetic worst case, for the report. */
  facts: { passages: number; evidenceTokens: number; claims: number };
}

/** The synthetic requests (pure; canonical ids are mapped to the aliases the model reads). */
export function preflightRequests(): PreflightRequests {
  // A full bundle: 6 cases of 2 passages, each passage at the chunker's largest size, within the evidence budget.
  const perPassage = Math.min(DEFAULT_CHUNK_OPTIONS.maxTokens, Math.floor(RETRIEVAL_DEFAULTS.maxEvidenceTokens / MAX_BRIEF_PASSAGES));
  const perCase = MAX_BRIEF_PASSAGES / MAX_BRIEF_CASES;
  const header = exactly(400, 3);
  const aircraft = exactly(120, 5);
  const cases = Array.from({ length: MAX_BRIEF_CASES }, (_, c) => ({
    ntsbNo: caseNo(c),
    passages: Array.from({ length: perCase }, (_, k) => {
      const n = c * perCase + k;
      return { passageId: id(n), kind: k === perCase - 1 ? ('probable_cause' as const) : ('analysis' as const), text: sentencesUpTo(perPassage, n) };
    }),
  }));
  const verified = cases.map((c, ci) => ({
    ntsbNo: c.ntsbNo,
    rank: ci + 1,
    // Only the fields `checkInput` reads: the aircraft label of aircraft-scoped passages, and the header.
    summary: { row: { aircraft: [{ aircraftKey: 1, make: aircraft, model: null }] }, report: {}, aircraftNumbers: [] },
    header,
    checkHeader: header,
    passages: c.passages.map((p, pi) => ({
      passageId: p.passageId,
      role: pi === 0 ? 'retrieved' : 'probable_cause',
      reserved: true,
      rank: pi === 0 ? ci + 1 : null,
      sectionKind: p.kind,
      allowed: {
        ntsbNo: c.ntsbNo,
        text: p.text,
        sha: '0'.repeat(64),
        sectionId: `${c.ntsbNo}:${p.kind}`,
        revisionId: '0'.repeat(64),
        sectionKind: p.kind,
        sectionStart: 0,
        scope: 'aircraft',
        aircraftKey: 1,
      },
    })),
  })) as unknown as VerifiedCase[];
  const aliases = passageAliases(cases);

  const question = charsUpTo(QUESTION_MAX_CHARS, 0);
  const refinement = charsUpTo(QUESTION_MAX_CHARS, 4);
  const interpretations = [0, 1, 2, 3].map((i) => exactly(200, i));
  const compose: ComposeInput = composeForModel(
    {
      question,
      refinement,
      mechanicalCause: true,
      interpretations,
      cases: cases.map((c) => ({
        ntsbNo: c.ntsbNo,
        header,
        passages: c.passages.map((p) => ({
          passageId: p.passageId,
          section: p.kind === 'probable_cause' ? 'Probable cause' : 'Analysis',
          scope: 'aircraft' as const,
          aircraft,
          text: p.text,
        })),
      })),
    },
    aliases,
  );

  // A composition at the bounds of its schema: what the answer model may write, and what the checker then judges.
  const quoteOf = (text: string, k: number) => {
    const sentences = text.split(/(?<=\.)\s+/);
    let q = '';
    for (const s of sentences.slice(k)) {
      if ((q ? `${q} ${s}` : s).length > 600) break;
      q = q ? `${q} ${s}` : s;
    }
    return q || text.slice(0, 600);
  };
  const composition: ComposeOutput = {
    outcome: 'answer',
    summary: [0, 1, 2, 3, 4]
      .map((i) => `${exactly(255, i)} [[case:${caseNo(i)}]] [[case:${caseNo(i + 1)}]].`)
      .join(' ')
      .slice(0, 1_500),
    groups: [
      { kind: 'causal', caseNumbers: [caseNo(0), caseNo(1)] },
      { kind: 'defect_not_causal', caseNumbers: [caseNo(2), caseNo(3)] },
      { kind: 'no_fault', caseNumbers: [caseNo(4)] },
      { kind: 'insufficient', caseNumbers: [caseNo(5)] },
    ],
    cases: cases.map((c, ci) => {
      const ids = c.passages.map((p) => p.passageId);
      return {
        ntsbNo: c.ntsbNo,
        why: exactly(300, ci),
        quotes: [0, 1, 2].map((q) => ({ passageId: ids[q % ids.length]!, quote: quoteOf(c.passages[q % ids.length]!.text, q), speaker: 'investigators' as const })),
        evidencePassageIds: ids,
        maintenance: { relation: 'investigator_attributed' as const, passageIds: ids },
        symptom: { value: 'partial_power_loss' as const, passageIds: ids },
        // Four facts at their longest: each measured from another anchor named in 80 characters.
        chronology: {
          maintenance: exactly(80, ci),
          facts: [0, 1, 2, 3].map((f) => ({
            anchor: 'other' as const,
            other: exactly(80, ci + f + 1),
            relation: 'intervening_flights' as const,
            value: 99_999,
            bound: 'at_least' as const,
            passageIds: ids,
          })),
        },
      };
    }),
    gaps: [0, 1].map((g) => ({ ntsbNo: caseNo(g), note: exactly(300, g), passageIds: cases[g]!.passages.map((p) => p.passageId) })),
  };
  const citations: ResolvedCitation[] = composition.cases.flatMap((k, ci) =>
    k.quotes.map((q, qi) => ({
      ntsbNo: k.ntsbNo,
      caseIndex: ci,
      quoteIndex: qi,
      passageId: q.passageId,
      sectionId: `${k.ntsbNo}:analysis`,
      revisionId: '0'.repeat(64),
      sectionSha: '0'.repeat(64),
      text: q.quote,
      passageSpan: { start: 0, end: q.quote.length },
      sectionSpan: { start: 0, end: q.quote.length },
      matches: 1,
      occurrence: 'first' as const,
    })),
  );
  // The checker's worst case: every fact a timing claim from the relevant maintenance (the
  // longest template), and every criterion in effect unsettled, so each decision cites
  // every passage of its case and names the maintenance.
  const checked: ComposeOutput = {
    ...composition,
    cases: composition.cases.map((k) => ({
      ...k,
      chronology: k.chronology && {
        maintenance: k.chronology.maintenance,
        facts: k.chronology.facts.map((f) => ({ anchor: 'relevant_maintenance' as const, relation: f.relation, value: f.value, bound: f.bound, passageIds: f.passageIds })),
      },
    })),
  };
  const readings = {
    timingWindow: { value: { days: 30, flightHours: 10 }, pinned: false },
    firstFlightOnly: { value: true, pinned: true },
    failureType: { value: 'total_power_loss' as const, pinned: true },
  };
  const byCase = new Map(verified.map((v) => [v.ntsbNo, v]));
  const criterionChecks = new Map(
    checked.cases.map((k) => [
      k.ntsbNo,
      evaluateCase(readings, { ...k, chronology: k.chronology && { maintenance: k.chronology.maintenance, facts: [] } }, false, caseEvidence(byCase.get(k.ntsbNo))),
    ]),
  );
  const built = checkInput(checked, citations, byCase, { mechanicalCause: true, criterionChecks });
  const check = checkForModel(built.input, aliases);

  // Scope: the longest refinement step, in English and in dense text at the query-embedding cap.
  const allFilters = {
    phase: [...PHASE_GROUPS],
    injury: [...INJURY_CODES],
    conditions: [...WEATHER_CODES],
    light: [...LIGHT_CODES],
    category: [...AIRCRAFT_CATEGORY_CODES],
    state: ['AK', 'AZ', 'CA', 'CO', 'FL', 'NM', 'NV', 'OR', 'TX', 'WA'],
    yearFrom: 2008,
    yearTo: 2024,
  };
  const prior = (q: string, r: string): NonNullable<ScopeInput['prior']> => ({
    question: q,
    refinement: r,
    intent: 'case_search',
    filters: allFilters,
    readings: [
      { type: 'timing_window', value: '30d_or_10h', pinned: true },
      { type: 'failure_type', value: 'total_power_loss', pinned: false },
    ],
    caseNumbers: cases.map((c) => c.ntsbNo),
  });
  // The query-embedding cap bounds the question with the refinement in effect, so the
  // densest step pairs a one-word question with refinements at that cap.
  const dense = denseUpTo(MAX_QUERY_INPUT_TOKENS - 20, QUESTION_MAX_CHARS);
  const scopeWorst = [
    { label: 'longest refinement (English)', latin: true, input: { question: refinement, prior: prior(question, refinement) } },
    { label: 'refinement at the embedding cap (dense text)', latin: false, input: { question: dense, prior: prior('Power loss', dense) } },
  ];

  // Scope's output at its schema bounds.
  const scopeOutput = {
    intent: 'case_search',
    mechanicalCause: true,
    filters: allFilters,
    keywordText: exactly(200, 1).replace(/[^\p{L}\p{N} '\-./]/gu, ' '),
    ambiguity: { type: 'timing_window', values: ['30d_or_10h', '7d', 'first_flight'] },
    caseNumbers: cases.slice(0, 4).map((c) => c.ntsbNo),
  };
  // The checker's output at its bounds: a verdict for each of the most claims, each naming
  // the most passages, and the most contradiction quotes at their longest.
  const checkOutput = {
    verdicts: Array.from({ length: MAX_CHECK_CLAIMS }, (_, i) => ({
      claim: `C${i + 1}`,
      verdict: 'not_established',
      passages: Array.from({ length: MAX_VERDICT_PASSAGES }, (_, p) => `P${MAX_BRIEF_PASSAGES - p}`),
    })),
    quotes: Array.from({ length: MAX_CHECK_QUOTES }, (_, i) => ({ claim: `C${MAX_CHECK_CLAIMS - i}`, passage: `P${MAX_BRIEF_PASSAGES}`, text: exactly(CHECK_QUOTE_MAX, i) })),
  };
  const modelComposition = JSON.stringify({
    ...composition,
    cases: composition.cases.map((k) => ({
      ...k,
      quotes: k.quotes.map((q) => ({ ...q, passageId: aliases.toModel.get(q.passageId) })),
      evidencePassageIds: k.evidencePassageIds.map((x) => aliases.toModel.get(x)),
      maintenance: k.maintenance && { ...k.maintenance, passageIds: k.maintenance.passageIds.map((x) => aliases.toModel.get(x)) },
      symptom: k.symptom && { ...k.symptom, passageIds: k.symptom.passageIds.map((x) => aliases.toModel.get(x)) },
      chronology: k.chronology && { ...k.chronology, facts: k.chronology.facts.map((f) => ({ ...f, passageIds: f.passageIds.map((x) => aliases.toModel.get(x)) })) },
    })),
    gaps: composition.gaps.map((g) => ({ ...g, passageIds: g.passageIds.map((x) => aliases.toModel.get(x)) })),
  });

  const minimalPassage = { passageId: 'P1', section: 'Analysis', scope: 'event' as const, text: 'Engine power was lost.' };
  return {
    fixed: {
      scope: { question: 'Engine power loss' },
      compose: { question: 'Engine power loss', mechanicalCause: true, interpretations: [], cases: [{ ntsbNo: caseNo(0), header: 'Airplane', passages: [minimalPassage] }] },
      check: {
        cases: [{ ntsbNo: caseNo(0), header: 'Airplane' }],
        passages: [{ ...minimalPassage, ntsbNo: caseNo(0) }],
        claims: [{ id: 'C1', kind: 'why', ntsbNo: caseNo(0), text: 'Engine power was lost.', passageIds: ['P1'], absence: false }],
      },
    },
    worst: { scope: scopeWorst, compose, check },
    outputs: { scope: JSON.stringify(scopeOutput), compose: modelComposition, check: JSON.stringify(checkOutput) },
    facts: {
      passages: cases.reduce((n, c) => n + c.passages.length, 0),
      evidenceTokens: cases.reduce((n, c) => n + c.passages.reduce((m, p) => m + countTokens(p.text), 0), 0),
      claims: check.claims.length,
    },
  };
}

/** The provider's token counter for a plain user message (an output counted as text). */
export type TextCounter = (model: string, text: string) => Promise<number>;

export interface PreflightRow {
  stage: 'scope' | 'answer' | 'check';
  model: string;
  request: string;
  tokens: number;
  limit: number;
  ok: boolean;
}

/** Count every request and output against its cap. `countText` counts a plain user message. */
export async function runAiPreflight(provider: LlmProvider, countText: TextCounter, models: StageModels): Promise<PreflightRow[]> {
  const r = preflightRequests();
  const rows: PreflightRow[] = [];
  const ctx = (stage: LlmStage) => stageCtx(stage, AbortSignal.timeout(30_000), 30_000);
  const add = (stage: PreflightRow['stage'], request: string, tokens: number, limit: number) =>
    rows.push({ stage, model: models[stage], request, tokens, limit, ok: tokens <= limit });
  const output = async (model: string, text: string) => (await countText(model, text)) - (await countText(model, '.')) + 1;

  // The cached prefix: the fixed request less its (minimal) user turn counted on its own.
  const prefix = async (model: string, fixed: number, userTurn: string) => fixed - (await countText(model, userTurn));

  const scopeFixed = await provider.countInputTokens('scope', r.fixed.scope, ctx('scope'));
  add('scope', 'fixed (system prompt + schema)', scopeFixed, STAGE_CAPS.scope.input);
  add('scope', 'cached prefix (system prompt + schema)', await prefix(models.scope, scopeFixed, renderScopeUser(r.fixed.scope)), CACHED_PREFIX_MAX);
  for (const w of r.worst.scope) add('scope', w.label, await provider.countInputTokens('scope', w.input, ctx('scope')), STAGE_CAPS.scope.input);
  add('scope', 'output at its schema bounds', await output(models.scope, r.outputs.scope), STAGE_CAPS.scope.output);
  const composeFixed = await provider.countInputTokens('compose', r.fixed.compose, ctx('compose'));
  add('answer', 'fixed (system prompt + schema)', composeFixed, STAGE_CAPS.answer.input);
  add('answer', 'cached prefix (system prompt + schema)', await prefix(models.answer, composeFixed, renderComposeUser(r.fixed.compose)), CACHED_PREFIX_MAX);
  add(
    'answer',
    `full bundle (${r.facts.passages} passages, ${r.facts.evidenceTokens} cl100k evidence tokens)`,
    await provider.countInputTokens('compose', r.worst.compose, ctx('compose')),
    STAGE_CAPS.answer.input,
  );
  add('answer', `output at its schema bounds (+${THINKING_ALLOWANCE} thinking)`, (await output(models.answer, r.outputs.compose)) + THINKING_ALLOWANCE, STAGE_CAPS.answer.output);
  const checkFixed = await provider.countInputTokens('check', r.fixed.check, ctx('check'));
  add('check', 'fixed (system prompt + schema)', checkFixed, STAGE_CAPS.check.input);
  add('check', 'cached prefix (system prompt + schema)', await prefix(models.check, checkFixed, renderCheckUser(r.fixed.check)), CACHED_PREFIX_MAX);
  add('check', `full bundle, ${r.facts.claims} claims`, await provider.countInputTokens('check', r.worst.check, ctx('check')), STAGE_CAPS.check.input);
  add('check', `output at its schema bounds (+${CHECK_THINKING_ALLOWANCE} thinking)`, (await output(models.check, r.outputs.check)) + CHECK_THINKING_ALLOWANCE, STAGE_CAPS.check.output);
  return rows;
}

/** The report table. */
export function formatPreflight(rows: readonly PreflightRow[]): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const lines = rows.map((r) => {
    const room = `${Math.round((1 - r.tokens / r.limit) * 100)}%`;
    return `${r.ok ? 'ok  ' : 'OVER'}  ${r.stage.padEnd(6)} ${r.model.padEnd(18)} ${n(r.tokens).padStart(7)} / ${n(r.limit).padStart(7)}  ${room.padStart(4)} room  ${r.request}`;
  });
  return [`      stage  model              tokens /     cap`, ...lines].join('\n');
}
