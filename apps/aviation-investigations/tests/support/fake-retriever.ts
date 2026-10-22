/**
 * A stand-in for Task 10's hybrid retrieval behind the brief pipeline's
 * `EvidenceRetriever` port: it returns the analysis and probable-cause sections of the
 * cases it is told to return, read from the fixture generation in PostgreSQL, as whole
 * passages. Passage text is exactly the stored citation text, so the pipeline's
 * provenance check and quote validation run on real fixture narratives (CRLF and all).
 *
 * It reports one query embedding through the callback, can fail or hang on request,
 * and records every query and re-pack.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../server/db/client.js';
import { caseSections } from '../../server/db/schema/index.js';
import {
  RetrievalFailure,
  type EmbeddingUsage,
  type EvidenceBundle,
  type EvidenceCase,
  type EvidencePassage,
  type EvidenceQuery,
  type EvidenceRetriever,
  type RetrievedEvidence,
} from '../../server/briefs/evidence.js';

export const FAKE_EMBEDDING: Readonly<EmbeddingUsage> = Object.freeze({
  provider: 'openai',
  model: 'text-embedding-3-small',
  tokens: 40,
  usd: 0.0000008,
  billing: 'reported',
});

export interface FakeRetrieverOptions {
  /** Event numbers to return, in rank order (a function of the query, or a list). */
  cases: readonly string[] | ((q: EvidenceQuery) => readonly string[]);
  /** Section kinds per case (default analysis and probable cause). */
  kinds?: readonly ('factual' | 'analysis' | 'probable_cause')[];
  /** Fail after reporting the embedding (`afterEmbedding`) or before (`beforeEmbedding`). */
  fail?: { failure: RetrievalFailure; afterEmbedding: boolean };
  /** Wait for the abort signal, then fail with `timeout`. */
  hang?: boolean;
  /** What `available` answers (default true). */
  available?: boolean;
  embedding?: EmbeddingUsage | null;
}

export const passageIdOf = (revisionId: string, start: number, end: number) =>
  createHash('sha256').update(`${revisionId}:${start}:${end}`).digest('hex');

export class FakeRetriever implements EvidenceRetriever {
  readonly queries: EvidenceQuery[] = [];
  readonly repacks: number[] = [];

  constructor(
    private readonly db: Db,
    public options: FakeRetrieverOptions,
  ) {}

  async available(): Promise<boolean> {
    return this.options.available ?? true;
  }

  async retrieve(query: EvidenceQuery, signal: AbortSignal, onEmbeddingUsage: (u: EmbeddingUsage) => void): Promise<RetrievedEvidence> {
    this.queries.push(query);
    const o = this.options;
    if (o.fail && !o.fail.afterEmbedding) throw o.fail.failure;
    const embedding = o.embedding === undefined ? FAKE_EMBEDDING : o.embedding;
    if (embedding) onEmbeddingUsage({ ...embedding });
    if (o.fail) throw o.fail.failure;
    if (o.hang) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new RetrievalFailure('timeout', 'none');
    }
    const numbers = typeof o.cases === 'function' ? o.cases(query) : o.cases;
    const bundle = await this.bundle(query.dataset.generationId, numbers, Infinity);
    return {
      bundle,
      repack: async (maxEvidenceTokens: number) => {
        this.repacks.push(maxEvidenceTokens);
        return this.bundle(query.dataset.generationId, numbers, maxEvidenceTokens);
      },
    };
  }

  private async bundle(generationId: number, numbers: readonly string[], maxTokens: number): Promise<EvidenceBundle> {
    const kinds = this.options.kinds ?? ['analysis', 'probable_cause'];
    const rows =
      numbers.length === 0
        ? []
        : await this.db
            .select({
              ntsbNo: caseSections.ntsbNo,
              sectionId: caseSections.sectionId,
              revisionId: caseSections.revisionId,
              kind: caseSections.kind,
              scope: caseSections.scope,
              aircraftKey: caseSections.aircraftKey,
              text: caseSections.text,
            })
            .from(caseSections)
            .where(and(eq(caseSections.generationId, generationId), inArray(caseSections.ntsbNo, [...numbers])));
    const order = { factual: 0, analysis: 1, probable_cause: 2 } as const;
    const cases: EvidenceCase[] = [];
    let passages = 0;
    let tokens = 0;
    let rank = 0;
    for (const [i, ntsbNo] of numbers.slice(0, 6).entries()) {
      const own = rows
        .filter((r) => r.ntsbNo === ntsbNo && kinds.includes(r.kind))
        .sort((a, b) => order[a.kind] - order[b.kind] || a.sectionId.localeCompare(b.sectionId));
      const chosen: EvidencePassage[] = [];
      for (const r of own) {
        const t = Math.ceil(r.text.length / 4);
        // Under a smaller budget keep the cause and drop the other sections first.
        if (r.kind !== 'probable_cause' && tokens + t > maxTokens) continue;
        if (passages >= 12) break;
        rank += 1;
        chosen.push({
          passageId: passageIdOf(r.revisionId, 0, r.text.length),
          ntsbNo,
          sectionId: r.sectionId,
          revisionId: r.revisionId,
          sectionKind: r.kind,
          scope: r.scope as 'aircraft' | 'event',
          aircraftKey: r.aircraftKey,
          start: 0,
          end: r.text.length,
          text: r.text,
          role: r.kind === 'probable_cause' ? 'probable_cause' : 'retrieved',
          rank: r.kind === 'probable_cause' ? null : rank,
        });
        passages += 1;
        tokens += t;
      }
      if (chosen.length > 0) cases.push({ ntsbNo, rank: i + 1, passages: chosen });
    }
    return { cases, passages, evidenceTokens: tokens };
  }
}
