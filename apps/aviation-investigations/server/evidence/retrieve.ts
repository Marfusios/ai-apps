/** evidence.v2 delivers a pinned, paged ranking, not the old six-case answer bundle. */
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { and, eq, inArray } from 'drizzle-orm';
import type { Client } from '@elastic/elasticsearch';
import type { EvidenceCase } from '../../shared/contracts/evidence.js';
import { EVIDENCE_CANDIDATE_CEILING } from '../../shared/contracts/evidence.js';
import { stageSpan } from '../observability/tracing.js';
import { fitQueryText } from '../briefs/retriever.js';
import { embeddingCostUsd, embeddingWorstCaseUsd } from '../ai/pricing.js';
import { QueryEmbeddingError, type QueryEmbedder, type Embedder } from '../ai/embeddings.js';
import type { PinnedDataset } from '../dataset.js';
import type { Db } from '../db/client.js';
import { readCaseRecords } from '../db/queries/case-records.js';
import { readCaseRows, reportLink } from '../db/queries/case-views.js';
import { passages, reportLinks } from '../db/schema/index.js';
import { retrieveCaseCandidates } from '../search/case-retrieval.js';
import { assertServableCasesIndex } from '../search/cases-channel.js';
import { assertServablePassagesIndex, type QueryEmbeddingUsage } from '../search/hybrid.js';
import { RETRIEVAL_V2 } from '../search/retrieval-config.js';
import { projectCase, type RankedEvidenceCase } from './project.js';
import { evidenceSnapshot } from './snapshot.js';

/** Ranking and cutoff unchanged; mapping extends over the 100 frozen candidates, without re-embedding. */
export const EVIDENCE_RETRIEVAL = Object.freeze({ ...RETRIEVAL_V2,
  params: Object.freeze({ ...RETRIEVAL_V2.params, packCandidates: EVIDENCE_CANDIDATE_CEILING }),
});
export interface EvidenceRetrievalResult { ranking: RankedEvidenceCase[]; cases: EvidenceCase[] }
/** Only server-owned question/user edits may populate this plan. */
export interface EvidenceSearchPlan { text: string; filters: BriefFilters }
export interface EvidenceRetriever {
  available(pinned: PinnedDataset): Promise<boolean>;
  search(pinned: PinnedDataset, plan: EvidenceSearchPlan, signal: AbortSignal,
    onEmbedding: (usage: QueryEmbeddingUsage) => void, highlightTerms: string): Promise<EvidenceRetrievalResult>;
}

export function createEvidenceRetriever(db: Db, es: Client, embedder: QueryEmbedder | Embedder): EvidenceRetriever {
  return {
    async available(pinned) {
      const dataset = { generationId: pinned.manifest.generationId, passagesIndex: pinned.manifest.passagesIndex };
      try {
        if (!pinned.passages?.servable || !dataset.passagesIndex) return false;
        await Promise.all([
          assertServablePassagesIndex(es, dataset, embedder, { timeoutMs: 2000 }),
          assertServableCasesIndex(es, pinned.manifest.casesIndex, dataset.generationId,
            { timeoutMs: 2000, versions: RETRIEVAL_V2.channels.cases!.indexVersions }),
        ]);
        return true;
      } catch { return false; }
    },
    async search(pinned, plan, signal, onEmbedding, highlightTerms) {
      const generation = pinned.manifest.generationId;
      // Unknown failures after dispatch cannot silently lose an embedding charge.
      const safeEmbedder: QueryEmbedder = { ...embedder,
        model: embedder.model, dims: embedder.dims, usdPerMillionTokens: embedder.usdPerMillionTokens,
        embed: (texts) => embedder.embed(texts),
        async embedWithSignal(texts, requestSignal) {
          return stageSpan('evidence.embed', { stage: 'embed', provider: 'openai', model: embedder.model }, async (span) => {
            try {
              const result = 'embedWithSignal' in embedder ? await embedder.embedWithSignal(texts, requestSignal) : await embedder.embed(texts);
              span.setAttrs({ inputTokens: result.tokens, usd: result.usageUncertain ? embeddingWorstCaseUsd(embedder.model) : embeddingCostUsd(embedder.model, result.tokens) });
              return result;
            } catch (error) {
              if (requestSignal?.aborted) span.markStopped();
              if (error instanceof QueryEmbeddingError) throw error;
              throw new QueryEmbeddingError('embedding failed', { kind: 'other' }, 'uncertain');
            }
          });
        },
      };
      const result = await retrieveCaseCandidates(es, safeEmbedder, EVIDENCE_RETRIEVAL, {
        dataset: { generationId: generation, passagesIndex: pinned.manifest.passagesIndex }, casesIndex: pinned.manifest.casesIndex,
        text: fitQueryText(plan.text), keywordText: plan.text, filters: plan.filters, signal, onQueryEmbedding: onEmbedding,
      });
      signal.throwIfAborted();
      const ranking: RankedEvidenceCase[] = result.cases.slice(0, EVIDENCE_CANDIDATE_CEILING).map((c) => ({
        ntsbNo: c.ntsbNo, seeds: c.passages.map((p) => p.item), channels: [
          ...(result.channelCases.keyword.includes(c.ntsbNo) ? ['keyword' as const] : []),
          ...(result.channelCases.vector.includes(c.ntsbNo) ? ['similarity' as const] : []),
          ...(result.channelCases.cases.includes(c.ntsbNo) ? ['narrative' as const] : []),
        ],
      }));
      if (new Set(ranking.map((c) => c.ntsbNo)).size !== ranking.length) throw new Error('duplicate evidence candidate');
      if (ranking.length === 0) return { ranking, cases: [] };
      const projected = await evidenceSnapshot(db, signal, async (tx) => {
        const numbers = ranking.map((c) => c.ntsbNo);
        const records = new Map((await readCaseRecords(tx, generation, numbers)).map((c) => [c.ntsbNo, c]));
        const rows = await readCaseRows(tx, generation, numbers, { mappingVerified: pinned.manifest.mappingVerified });
        const links = await tx.select({ ntsbNo: reportLinks.ntsbNo, reportId: reportLinks.reportId, retrievedAt: reportLinks.retrievedAt })
          .from(reportLinks).where(inArray(reportLinks.ntsbNo, numbers));
        const ids = ranking.flatMap((c) => c.seeds.map((s) => s.id));
        const stored = ids.length ? await tx.select().from(passages)
          .where(and(eq(passages.generationId, generation), inArray(passages.passageId, ids))) : [];
        const byId = new Map(stored.map((p) => [p.passageId, p]));
        for (const c of ranking) for (const seed of c.seeds) {
          const p = byId.get(seed.id);
          if (!p || p.ntsbNo !== c.ntsbNo || p.sectionId !== seed.sectionId || p.revisionId !== seed.revisionId ||
              p.start !== seed.start || p.end !== seed.end || p.scope !== seed.scope || p.aircraftKey !== seed.aircraftKey ||
              p.sectionKind !== seed.sectionKind || p.chunkerVersion !== result.chunkerVersion) throw new Error('noncanonical retrieval seed');
        }
        return ranking.map((c, i) => {
          const record = records.get(c.ntsbNo), row = rows.get(c.ntsbNo);
          if (!record || !row) throw new Error('missing evidence case');
          return projectCase(record, row, reportLink(links.filter((l) => l.ntsbNo === c.ntsbNo)), c, i + 1, plan.filters, highlightTerms);
        });
      });
      signal.throwIfAborted();
      return { ranking, cases: projected };
    },
  };
}

/** Track every admitted request through shutdown, including before it acquires its reservation. */
export function createEvidenceServices(retriever: EvidenceRetriever) {
  const controller = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const runs = new Map<string, { controller: AbortController }>();
  return { retriever, runs, shutdown: controller.signal, beginShutdown: () => controller.abort(),
    track<T>(run: () => Promise<T>): Promise<T> {
      const p = run(); pending.add(p);
      const done = () => { pending.delete(p); }; p.then(done, done); return p;
    },
    async settled(): Promise<void> { while (pending.size) await Promise.allSettled([...pending]); },
  };
}
export type EvidenceServices = ReturnType<typeof createEvidenceServices>;
