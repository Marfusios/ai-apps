/**
 * A stand-in for hybrid retrieval behind the brief pipeline's `EvidenceRetriever` port,
 * for scripting cases and failures. It returns the cases it is told to return, built
 * from the fixture generation's canonical `passages` rows (under the chunker of the
 * served index's passages contract, as `served` reports it, and reported to the
 * pipeline the same way) and their section text in PostgreSQL, the way packing builds a
 * bundle: each case reserves
 * its first analysis passage (its "best retrieved" passage, ranked) and every
 * probable-cause passage. So the pipeline's provenance and completeness checks and the
 * quote validation run on real fixture narratives (CRLF and all).
 *
 * It reports one query embedding through the callback, can fail, hang or tamper with
 * the bundle on request, and records every query and re-pack. A re-pack under a
 * smaller budget drops whole cases from the end, never a reserved passage.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../server/db/client.js';
import { caseSections, passages } from '../../server/db/schema/index.js';
import {
  RetrievalFailure,
  type EmbeddingUsage,
  type EvidenceBundle,
  type EvidenceCase,
  type EvidenceDataset,
  type EvidencePassage,
  type EvidenceQuery,
  type EvidenceRetriever,
  type RetrievedEvidence,
} from '../../server/briefs/evidence.js';
import type { PassagesContract } from '../../server/search/passages-contract.js';
import { DEFAULT_RETRIEVAL_VERSION, type RetrievalVersion } from '../../shared/contracts/retrieval.js';

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
  /** Fail after reporting the embedding (`afterEmbedding`) or before (`beforeEmbedding`). */
  fail?: { failure: RetrievalFailure; afterEmbedding: boolean };
  /** Wait for the abort signal, then fail with `timeout`. */
  hang?: boolean;
  /** What `available` answers (default true), or a function of the dataset asked about. */
  available?: boolean | ((dataset: { generationId: number; passagesIndex: string | null }) => boolean);
  embedding?: EmbeddingUsage | null;
  /** Change a bundle before it is returned (`repack`: true for re-packed bundles). */
  tamper?: (bundle: EvidenceBundle, repack: boolean) => EvidenceBundle;
  /**
   * The served index's passages contract, as hybrid retrieval's
   * `assertServablePassagesIndex` returns it (the harness asks the real check).
   */
  served: (dataset: EvidenceDataset) => Promise<Pick<PassagesContract, 'chunkerVersion'>>;
  /** The retrieval version it reports (default: the server's default). */
  version?: RetrievalVersion;
  /** The mapping counts it reports with a bundle (default none: a passage-level result). */
  mapping?: { mapped: number; unmapped: number } | null;
}

export class FakeRetriever implements EvidenceRetriever {
  readonly queries: EvidenceQuery[] = [];
  readonly repacks: number[] = [];

  constructor(
    private readonly db: Db,
    public options: FakeRetrieverOptions,
  ) {}

  get version(): RetrievalVersion {
    return this.options.version ?? DEFAULT_RETRIEVAL_VERSION;
  }

  async available(dataset: { generationId: number; passagesIndex: string | null }): Promise<boolean> {
    const a = this.options.available ?? true;
    return typeof a === 'function' ? a(dataset) : a;
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
    const tamper = o.tamper ?? ((b: EvidenceBundle) => b);
    const { chunkerVersion } = await o.served(query.dataset);
    const bundle = tamper(await this.bundle(query.dataset.generationId, chunkerVersion, numbers, Infinity), false);
    return {
      bundle,
      chunkerVersion,
      mapping: o.mapping ?? null,
      repack: async (maxEvidenceTokens: number) => {
        this.repacks.push(maxEvidenceTokens);
        return tamper(await this.bundle(query.dataset.generationId, chunkerVersion, numbers, maxEvidenceTokens), true);
      },
    };
  }

  /** The canonical passages of `numbers` (one chunker) as a packed bundle. */
  private async bundle(generationId: number, chunkerVersion: string, numbers: readonly string[], maxTokens: number): Promise<EvidenceBundle> {
    const rows =
      numbers.length === 0
        ? []
        : await this.db
            .select({
              passageId: passages.passageId,
              ntsbNo: passages.ntsbNo,
              sectionId: passages.sectionId,
              revisionId: passages.revisionId,
              sectionKind: passages.sectionKind,
              scope: passages.scope,
              aircraftKey: passages.aircraftKey,
              start: passages.start,
              end: passages.end,
              tokenCount: passages.tokenCount,
              sectionText: caseSections.text,
            })
            .from(passages)
            .innerJoin(
              caseSections,
              and(eq(caseSections.generationId, passages.generationId), eq(caseSections.sectionId, passages.sectionId), eq(caseSections.revisionId, passages.revisionId)),
            )
            .where(
              and(
                eq(passages.generationId, generationId),
                eq(passages.chunkerVersion, chunkerVersion),
                inArray(passages.ntsbNo, [...numbers]),
                inArray(passages.sectionKind, ['analysis', 'probable_cause']),
              ),
            )
            .orderBy(asc(passages.sectionId), asc(passages.start));
    const cases: EvidenceCase[] = [];
    let count = 0;
    let tokens = 0;
    let rank = 0;
    for (const [i, ntsbNo] of numbers.slice(0, 6).entries()) {
      const own = rows.filter((r) => r.ntsbNo === ntsbNo);
      const best = own.find((r) => r.sectionKind === 'analysis');
      const causes = own.filter((r) => r.sectionKind === 'probable_cause');
      if (!best || causes.length === 0) continue;
      const chosen = [best, ...causes];
      const weight = chosen.reduce((n, r) => n + r.tokenCount, 0);
      if (count + chosen.length > 12 || tokens + weight > maxTokens) continue;
      rank += 1;
      const passage = (r: (typeof own)[number], isBest: boolean): EvidencePassage => ({
        passageId: r.passageId,
        ntsbNo,
        sectionId: r.sectionId,
        revisionId: r.revisionId,
        sectionKind: r.sectionKind,
        scope: r.scope as 'aircraft' | 'event',
        aircraftKey: r.aircraftKey,
        start: r.start,
        end: r.end,
        text: r.sectionText.slice(r.start, r.end),
        role: isBest ? 'retrieved' : 'probable_cause',
        reserved: true,
        rank: isBest ? rank : null,
      });
      cases.push({ ntsbNo, rank: i + 1, passages: [passage(best, true), ...causes.map((r) => passage(r, false))] });
      count += chosen.length;
      tokens += weight;
    }
    return { cases, passages: count, evidenceTokens: tokens };
  }
}
