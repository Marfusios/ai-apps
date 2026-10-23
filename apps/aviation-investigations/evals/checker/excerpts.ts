/**
 * `pnpm eval:checker excerpts [--write]` (Task 16e; free and offline): the excerpt-context
 * policy's false omissions and catches (`excerpt-context-v1`, server/briefs/excerpts.ts) on
 * two corpora of real NTSB excerpts.
 *
 * 1. **Calibration quotes** (a tuning corpus): every distinct quote of the attribution
 *    claims of dataset v2 (16c and 16d items, both splits), with the speaker its claim
 *    gives. The policy was written against them. A quote labelled a context loss
 *    (`quote_context_loss`) or a misleading excerpt (`misleading_excerpt`) needs context;
 *    every other quote is standalone (a wrong speaker does not make words depend on their
 *    surroundings), except the reviewed disputes below, reported both ways.
 * 2. **The development sentence sample** (`excerpt-sentences.ts`): 200 whole sentences
 *    drawn at random from the development passages and labelled before a draft of the
 *    policy ran on them; the policy was then revised against it, so it is development
 *    material, not a blind measurement.
 * 3. **The blind sample** (the measurement, `excerpt-sentences-16e.ts`): the 200 sentences
 *    of a fixed draw from the 16e evidence (`excerpt-sample.ts`), labelled and committed
 *    before the frozen policy ran on any of them, read as the investigators' words.
 *
 * A **false omission** is a standalone excerpt the policy omits; a **catch** is an excerpt
 * that needs context and is omitted; a **miss** is one that needs context and is kept (the
 * evidence checker is then the only line). Rates come with Wilson 95% intervals; the result
 * file holds counts, item ids and problem codes only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXCERPT_CONTEXT_VERSION, EXCERPT_PROBLEMS, excerptProblems, type ExcerptProblem } from '../../server/briefs/excerpts.js';
import { SPEAKER_CLAIM } from '../../server/briefs/render.js';
import { matchQuote } from '../../server/briefs/validate.js';
import { APP_DIR } from '../../worker/config.js';
import { DATASET_V2_PATH, EVIDENCE_PATH, EVIDENCE_V2_PATH, EVIDENCE_V3_PATH, readDatasetV2 } from './build.js';
import { EXCERPT_SENTENCES, type ExcerptSentence } from './excerpt-sentences.js';
import { EXCERPT_SENTENCES_16E } from './excerpt-sentences-16e.js';
import { EvidenceFileSchema, EvidenceV2FileSchema, EvidenceV3FileSchema } from './evidence.js';
import { rate, type Rate } from './metrics.js';

export const EXCERPTS_RESULT_PATH = resolve(APP_DIR, 'evals/checker/results/16e-excerpts.json');

type ContextLabel = 'standalone' | 'needs_context';

/**
 * Calibration quotes whose dataset label (supported) this review disputes for the excerpt
 * rule: the label judged the claim, not whether the words stand alone.
 */
export const QUOTE_DISPUTES: readonly { speaker?: 'investigators' | 'pilot' | 'witness'; startsWith: string; label: ContextLabel; reason: string }[] = [
  {
    startsWith: 'The most recent engine maintenance was performed 6 days and 1 flight hour before the accident by the same mechanic.',
    label: 'needs_context',
    reason: '"the same mechanic": the same as whom is in the sentence before it (16d held-out throttle bundle, ERA13LA342)',
  },
  {
    speaker: 'investigators',
    startsWith: 'the accident flight was the first flight in the airplane since its annual inspection',
    label: 'needs_context',
    reason: 'the excerpt drops "The pilot reported that": given as the investigators\' own words it loses its source (16c dev.ff, ANC21LA096)',
  },
  {
    speaker: 'investigators',
    startsWith: "Fuel line 'T' fitting disconnected from engine fuel pump fitting elbow",
    label: 'needs_context',
    reason: 'the excerpt drops "the pilot stated": given as the investigators\' own words it loses its source (16c holdout.fuel)',
  },
];

export interface CorpusItem {
  id: string;
  corpus: 'quotes' | 'sentences';
  stratum: string;
  label: ContextLabel;
  /** The label before a dispute (quotes only). */
  original?: ContextLabel;
  problems: ExcerptProblem[];
}

const speakerOf = (text: string): 'investigators' | 'pilot' | 'witness' =>
  text.startsWith(SPEAKER_CLAIM.pilot) ? 'pilot' : text.startsWith(SPEAKER_CLAIM.witness) ? 'witness' : 'investigators';

/** The calibration quotes of dataset v2, each once per speaker and text. */
export function quoteCorpus(): CorpusItem[] {
  const dataset = readDatasetV2(DATASET_V2_PATH);
  const out = new Map<string, CorpusItem>();
  for (const b of dataset.batches) {
    if (b.maxSize) continue;
    b.input.claims.forEach((c, i) => {
      if (c.kind !== 'attribution') return;
      const l = b.labels[i]!;
      const quote = /“([\s\S]*)”\s*$/.exec(c.text)?.[1];
      const p = b.input.passages.find((x) => x.passageId === c.passageIds[0]);
      if (!quote || !p) throw new Error(`${b.id}/${c.id}: not an attribution claim with its passage`);
      const speaker = speakerOf(c.text);
      const key = `${speaker}|${quote}`;
      const multiAircraft = /· \d+ aircraft/.test(b.input.cases.find((x) => x.ntsbNo === c.ntsbNo)?.header ?? '');
      const m = matchQuote(p.text, quote, 1_000);
      if (!m.ok) throw new Error(`${b.id}/${c.id}: the quote is not in its passage`);
      const contextual = l.label === 'not_supported' && (l.mutation === 'quote_context_loss' || l.mutation === 'misleading_excerpt');
      const prior = out.get(key);
      if (prior) {
        // A quote labelled a context loss anywhere needs context.
        if (contextual) prior.label = prior.original = 'needs_context';
        return;
      }
      const original: ContextLabel = contextual ? 'needs_context' : 'standalone';
      out.set(key, {
        id: `${b.id}/${c.id}`,
        corpus: 'quotes',
        stratum: b.id.startsWith('holdout16d') ? '16d' : b.id.startsWith('dev16d') ? '16d-dev' : '16c',
        label: original,
        original,
        problems: excerptProblems({ passage: p.text, span: m.span, speaker, multiAircraft }),
      });
      for (const d of QUOTE_DISPUTES) if (quote.startsWith(d.startsWith) && (d.speaker ?? speaker) === speaker) out.get(key)!.label = d.label;
    });
  }
  return [...out.values()];
}

/** The labelled sentence sample, located in its passages. */
/** The development sentence sample, through the policy. */
export function sentenceCorpus(): CorpusItem[] {
  const v1 = EvidenceFileSchema.parse(JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')));
  const v2 = EvidenceV2FileSchema.parse(JSON.parse(readFileSync(EVIDENCE_V2_PATH, 'utf8')));
  return labelledCorpus(EXCERPT_SENTENCES, [...v1.bundles, ...v2.bundles]);
}

/** The blind sample (16e evidence), through the policy. */
export function blindCorpus16e(): CorpusItem[] {
  const v3 = EvidenceV3FileSchema.parse(JSON.parse(readFileSync(EVIDENCE_V3_PATH, 'utf8')));
  return labelledCorpus(EXCERPT_SENTENCES_16E, v3.bundles);
}

function labelledCorpus(sentences: readonly ExcerptSentence[], bundles: readonly { cases: readonly { ntsbNo: string; aircraft: readonly unknown[]; passages: readonly { passageId: string; text: string }[] }[] }[]): CorpusItem[] {
  const passages = new Map<string, string>();
  const aircraft = new Map<string, number>();
  for (const b of bundles) {
    for (const c of b.cases) {
      aircraft.set(c.ntsbNo, c.aircraft.length);
      for (const p of c.passages) passages.set(p.passageId, p.text);
    }
  }
  return sentences.map((s) => {
    const text = passages.get(s.passageId);
    if (text === undefined) throw new Error(`${s.id}: no passage ${s.passageId.slice(0, 12)}`);
    const start = text.indexOf(s.text);
    if (start < 0) throw new Error(`${s.id}: the sentence is not in its passage`);
    return {
      id: s.id,
      corpus: 'sentences' as const,
      stratum: s.section,
      label: s.label,
      problems: excerptProblems({ passage: text, span: { start, end: start + s.text.length }, speaker: 'investigators', multiAircraft: (aircraft.get(s.ntsbNo) ?? 1) > 1 }),
    };
  });
}

export interface CorpusFigures {
  items: number;
  standalone: number;
  needsContext: number;
  /** Standalone excerpts omitted. */
  falseOmissions: Rate;
  /** Excerpts needing context that were omitted. */
  catches: Rate;
  falseOmissionIds: { id: string; problems: ExcerptProblem[] }[];
  missIds: string[];
  /** Problems among omitted excerpts. */
  problems: Record<string, number>;
}

export function figures(items: readonly CorpusItem[], labelOf: (i: CorpusItem) => ContextLabel = (i) => i.label): CorpusFigures {
  const standalone = items.filter((i) => labelOf(i) === 'standalone');
  const contextual = items.filter((i) => labelOf(i) === 'needs_context');
  const omitted = (i: CorpusItem) => i.problems.length > 0;
  const problems: Record<string, number> = {};
  for (const i of items) for (const p of i.problems) problems[p] = (problems[p] ?? 0) + 1;
  return {
    items: items.length,
    standalone: standalone.length,
    needsContext: contextual.length,
    falseOmissions: rate(standalone.filter(omitted).length, standalone.length),
    catches: rate(contextual.filter(omitted).length, contextual.length),
    falseOmissionIds: standalone.filter(omitted).map((i) => ({ id: i.id, problems: i.problems })),
    missIds: contextual.filter((i) => !omitted(i)).map((i) => i.id),
    problems: Object.fromEntries(EXCERPT_PROBLEMS.filter((p) => problems[p]).map((p) => [p, problems[p]!])),
  };
}

export function excerptReport() {
  const quotes = quoteCorpus();
  const sentences = sentenceCorpus();
  const blind = blindCorpus16e();
  const strata = (items: readonly CorpusItem[]) => Object.fromEntries([...new Set(items.map((i) => i.stratum))].sort().map((s) => [s, figures(items.filter((i) => i.stratum === s))]));
  return {
    rules: EXCERPT_CONTEXT_VERSION,
    note: 'Task 16e: the excerpt-context policy on real NTSB excerpts. blind16e: the measurement, 200 sentences of a fixed draw from the 16e evidence (passages in no earlier evidence file), labelled and committed before the frozen policy ran on them. sentences: 200 sentences of the development passages, labelled before a draft of the policy ran; the policy was then revised against them (development, not blind). quotes: the calibration quotes of dataset v2 (a tuning corpus). A false omission is a standalone excerpt omitted; a catch is an excerpt that needs context omitted. Counts, ids and problem codes only.',
    blind16e: { all: figures(blind), bySection: strata(blind) },
    sentences: { all: figures(sentences), bySection: strata(sentences) },
    quotes: {
      all: figures(quotes),
      originalLabels: figures(quotes, (i) => i.original ?? i.label),
      disputes: QUOTE_DISPUTES.map((d) => d.reason),
      byOrigin: strata(quotes),
    },
  };
}

const pct = (r: Rate) => (r.rate === null ? 'n/a' : `${r.k}/${r.n} (${(100 * r.rate).toFixed(1)}%; 95% CI ${(100 * r.low!).toFixed(1)}–${(100 * r.high!).toFixed(1)}%)`);

export function excerptsCommand(opts: { write: boolean; log: (m: string) => void }): number {
  const r = excerptReport();
  const lines = (name: string, f: CorpusFigures) => [
    `${name}: ${f.items} excerpts (${f.standalone} standalone, ${f.needsContext} need context)`,
    `  false omissions ${pct(f.falseOmissions)}${f.falseOmissionIds.length ? `: ${f.falseOmissionIds.map((x) => `${x.id} [${x.problems.join(',')}]`).join('; ')}` : ''}`,
    `  catches ${pct(f.catches)}${f.missIds.length ? `; misses: ${f.missIds.join(', ')}` : ''}`,
  ];
  for (const l of [
    ...lines('blind sample, 16e evidence (measurement)', r.blind16e.all),
    ...Object.entries(r.blind16e.bySection).flatMap(([s, f]) => lines(`  ${s}`, f)),
    ...lines('development sentence sample (tuned against)', r.sentences.all),
    ...Object.entries(r.sentences.bySection).flatMap(([s, f]) => lines(`  ${s}`, f)),
    ...lines('calibration quotes (tuning)', r.quotes.all),
    ...lines('calibration quotes, labels before the disputes', r.quotes.originalLabels),
  ]) {
    opts.log(l);
  }
  if (opts.write) {
    writeFileSync(EXCERPTS_RESULT_PATH, `${JSON.stringify(r, null, 2)}\n`);
    opts.log(`wrote ${EXCERPTS_RESULT_PATH}`);
  }
  return 0;
}
