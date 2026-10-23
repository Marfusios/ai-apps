/**
 * The blind measurement sample of the excerpt-context policy (Task 16e): whole sentences
 * drawn by a fixed rule from the 16e evidence (`evidence-16e.json`, retrieved after the
 * policy was frozen), so that the sample cannot have shaped the policy. The draw is
 * deterministic: every sentence of at least five words that ends like a sentence (a full
 * stop, a question or exclamation mark, a closing quotation mark or parenthesis), of a 16e
 * passage that is in no earlier evidence file (the development passages the policy was
 * tuned on), that is not a quote of a 16e held-out item (those were chosen to pass the
 * policy), by section, ordered by the sha256 of `seed:passageId:start`, the first
 * `SAMPLE_16E` of each section. `excerpt-sentences-16e.ts` labels exactly this draw (a unit test holds it to
 * the draw), and was committed before the policy ran on it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { passageSentences } from '../../server/briefs/excerpts.js';
import { EVIDENCE_PATH, EVIDENCE_V2_PATH, EVIDENCE_V3_PATH } from './build.js';
import { EvidenceFileSchema, EvidenceV2FileSchema, EvidenceV3FileSchema } from './evidence.js';
import { V3_BRIEFS, V3_CLAIM_BATCHES } from './items/index.js';

export const SAMPLE_16E = { seed: 1616, probable_cause: 60, analysis: 70, factual: 70 } as const;

export interface DrawnSentence {
  id: string;
  ntsbNo: string;
  passageId: string;
  section: 'factual' | 'analysis' | 'probable_cause';
  /** Whether the event had more than one aircraft (the policy reads it). */
  multiAircraft: boolean;
  text: string;
}

const QUOTE_IN_CLAIM = /“(.*)”$/s;

/** The quotes of the 16e held-out items (brief quotes and quote claims), to leave out of the draw. */
function itemQuotes(): Set<string> {
  const out = new Set<string>();
  for (const b of V3_BRIEFS) {
    for (const k of b.composition.cases) for (const q of k.quotes) out.add(q.quote.replace(/\s+/g, ' ').trim());
  }
  for (const b of V3_CLAIM_BATCHES) {
    for (const c of b.claims) {
      const m = c.kind === 'attribution' ? QUOTE_IN_CLAIM.exec(c.text) : null;
      if (m) out.add(m[1]!.replace(/\s+/g, ' ').trim());
    }
  }
  return out;
}

const ENDS_LIKE_A_SENTENCE = /[.!?]["”’')\]]*$/;

/** The deterministic draw (module comment). */
export function drawBlindSample16e(): DrawnSentence[] {
  const file = EvidenceV3FileSchema.parse(JSON.parse(readFileSync(EVIDENCE_V3_PATH, 'utf8')));
  const quotes = itemQuotes();
  const earlier = [
    ...EvidenceFileSchema.parse(JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8'))).bundles,
    ...EvidenceV2FileSchema.parse(JSON.parse(readFileSync(EVIDENCE_V2_PATH, 'utf8'))).bundles,
  ].flatMap((b) => b.cases.flatMap((c) => c.passages.map((p) => p.passageId)));
  const seen = new Set<string>(earlier);
  const candidates: (DrawnSentence & { key: string })[] = [];
  for (const b of file.bundles) {
    for (const c of b.cases) {
      for (const p of c.passages) {
        if (seen.has(p.passageId)) continue;
        seen.add(p.passageId);
        const section = p.sectionKind as DrawnSentence['section'];
        if (section !== 'factual' && section !== 'analysis' && section !== 'probable_cause') continue;
        for (const s of passageSentences(p.text)) {
          const text = p.text.slice(s.start, s.end).trim();
          const flat = text.replace(/\s+/g, ' ');
          if (flat.split(' ').length < 5 || !ENDS_LIKE_A_SENTENCE.test(flat)) continue;
          if ([...quotes].some((q) => q.includes(flat) || flat.includes(q))) continue;
          const key = createHash('sha256').update(`${SAMPLE_16E.seed}:${p.passageId}:${s.start}`).digest('hex');
          candidates.push({ id: '', key, ntsbNo: c.ntsbNo, passageId: p.passageId, section, multiAircraft: c.aircraft.length > 1, text });
        }
      }
    }
  }
  const prefix = { probable_cause: 'pc', analysis: 'an', factual: 'fa' } as const;
  return (['probable_cause', 'analysis', 'factual'] as const).flatMap((section) =>
    candidates
      .filter((x) => x.section === section)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, SAMPLE_16E[section])
      .map(({ key: _key, ...x }, i) => ({ ...x, id: `${prefix[section]}${String(i + 1).padStart(2, '0')}` })),
  );
}
