/**
 * The brief pipeline's `EvidenceRetriever` port (server/briefs/evidence.ts) bound to
 * hybrid retrieval (Task 10, server/search/hybrid.ts) under one frozen retrieval
 * configuration (task 10e, server/search/retrieval-config.ts; `AVIATION_RETRIEVAL_VERSION`,
 * reported as the port's `version`). `retrieve` runs the two stages itself, stage 1 for
 * the version (`retrieveCandidatesWith`) then `fetchAndPack`, so that `repack` can pack
 * the same candidates again under a smaller evidence-token budget without a second
 * embedding or a second mapping.
 *
 * - **The cases index** (versions with the cases channel) is the one the manifest of the
 *   brief's generation pairs with the brief's pinned passages index (`casesIndexOf`,
 *   PostgreSQL), resolved before anything is embedded: none is `unavailable`
 *   (`no_cases_index`), and retrieval then checks it against the generation and a
 *   servable cases version before embedding too. The lookup is bounded: by
 *   `lookupTimeoutMs` and the request's signal in `retrieve` (a stalled pool or database
 *   fails the step as `timeout`, reason `cases_index_lookup`, or `aborted` on a cancel or
 *   deadline, with nothing embedded), and by `checkTimeoutMs` in `available`. The
 *   resolver gets the signal (`manifestCasesIndex` bounds acquisition and the statement
 *   and destroys an abandoned connection); the binding also stops waiting on its own, so
 *   a resolver that ignores the signal cannot hold a request.
 *
 * - **Texts.** The dense channel embeds the question (with the text refinement in
 *   effect) as the pipeline gives it, cut to the query embedder's token cap when it is
 *   longer (`fitQueryText`). The BM25 channel searches the scope stage's `keywordText`.
 * - **Query-embedding cost is settled exactly once**, from retrieval's
 *   `onQueryEmbedding` callback. Retrieval calls it as soon as the embedder returns,
 *   before any search, and the binding hands it on to the pipeline's
 *   `onEmbeddingUsage` once, with its `billing` (`uncertain` settles the step at the
 *   full reservation). Once `retrieve` has returned or thrown, a late callback is
 *   ignored: the step has already settled its embedding from the outcome. `RetrievalResult.queryEmbedding` (`CandidateResult` here) is
 *   never read, so an Elasticsearch, packing or provenance failure after the embedding
 *   neither loses nor repeats the line.
 * - **A failed embedding** (no callback) is settled from its `QueryEmbeddingError`
 *   billing: `none` charges nothing, `usage` hands on one `reported` line at the
 *   provider's billed tokens, and `uncertain` makes the failure `uncertain`. Any other
 *   error after the embedder was called is `uncertain` too; before it, nothing was sent.
 * - **Failures** become a `RetrievalFailure` with a fixed kind and reason and a fixed
 *   message. The underlying error is dropped: `RetrievalUnavailableError` quotes index
 *   names and contract values, and Elasticsearch errors carry response bodies, so none
 *   of it reaches a response, the step's record or a log.
 * - **The chunker** the pipeline checks the bundle under is the served index's contract's
 *   (`CandidateResult.chunkerVersion`, from `assertServablePassagesIndex`), never a
 *   constant: passages-v1 and passages-v2 indexes can both be served.
 * - **`available(dataset)`** checks the passages contract for this embedder's model
 *   and dimensions and, with the cases channel, the paired cases index (bounded; a
 *   passed check is remembered by retrieval). The routes ask it only after the dataset
 *   resolver reported the manifest's passages index servable
 *   (server/briefs/services.ts `servableEvidence`).
 */
import { errors, type Client } from '@elastic/elasticsearch';
import {
  MAX_QUERY_INPUT_TOKENS,
  QueryEmbeddingError,
  QueryTooLongError,
  embeddingUsd,
  type EmbedResult,
  type Embedder,
  type QueryEmbedder,
} from '../ai/embeddings.js';
import { countTokens } from '../ai/tokens.js';
import { BoundedReadTimeoutError, untilAborted } from '../db/bounded-read.js';
import { retrieveCandidatesWith, type StageOne } from '../search/case-retrieval.js';
import { assertServableCasesIndex } from '../search/cases-channel.js';
import {
  IncompleteSearchError,
  MalformedPassageError,
  RetrievalUnavailableError,
  assertServablePassagesIndex,
  fetchAndPack,
  retrievalParams,
  type PackedEvidence,
  type QueryEmbeddingUsage,
} from '../search/hybrid.js';
import type { RetrievalConfig } from '../search/retrieval-config.js';
import {
  RetrievalFailure,
  type EmbeddingUsage,
  type EvidenceBundle,
  type EvidenceDataset,
  type EvidenceRetriever,
  type RetrievalFailureKind,
  type RetrievalFailureReason,
} from './evidence.js';

export interface HybridRetrieverOptions {
  /** Elasticsearch with the read key. */
  es: Client;
  /** The query embedder (`createOpenAIQueryEmbedder`; tests: the fake embedder). */
  embedder: Embedder | QueryEmbedder;
  /** The frozen retrieval configuration (`retrievalConfig(config.retrieval.version)`). */
  retrieval: RetrievalConfig;
  /**
   * The cases index the manifest of `dataset.generationId` pairs with
   * `dataset.passagesIndex`, or null (`manifestCasesIndex`), ending its work when `signal`
   * aborts. Required by a version with the cases channel.
   */
  casesIndexOf?: (dataset: EvidenceDataset, signal: AbortSignal) => Promise<string | null>;
  /** Bound of `available`'s checks, the manifest lookup included (default 2 s). */
  checkTimeoutMs?: number;
  /** Bound of the manifest lookup in `retrieve` (default 2 s); the request's signal bounds it too. */
  lookupTimeoutMs?: number;
}

/** The manifest lookup outran its own bound (the request was still live). */
export class CasesIndexLookupTimeoutError extends Error {
  constructor(ms: number) {
    super(`the cases index lookup did not finish within ${ms} ms`);
    this.name = 'CasesIndexLookupTimeoutError';
  }
}

/**
 * The text the dense channel embeds: `text` itself when its query input fits
 * `MAX_QUERY_INPUT_TOKENS`, otherwise its longest whitespace-collapsed prefix that
 * fits, cut at a word boundary when one is near. A question and a text refinement
 * (1,500 characters each) only exceed the cap in unusual scripts; cutting keeps the
 * step from failing after its scope stage was paid for. The BM25 text is never cut.
 */
export function fitQueryText(text: string): string {
  const input = text.replace(/\s+/gu, ' ').trim();
  if (input === '' || countTokens(input) <= MAX_QUERY_INPUT_TOKENS) return text;
  const chars = Array.from(input);
  const fits = (n: number) => countTokens(chars.slice(0, n).join('').trimEnd()) <= MAX_QUERY_INPUT_TOKENS;
  // Largest prefix length that fits (token counts grow with the prefix, up to merges at the cut).
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  while (lo > 0 && !fits(lo)) lo -= 1;
  let cut = chars.slice(0, lo).join('');
  const space = cut.lastIndexOf(' ');
  if (space > cut.length * 0.8) cut = cut.slice(0, space);
  return cut.trim();
}

const toUsage = (u: Pick<QueryEmbeddingUsage, 'model' | 'tokens' | 'usd' | 'billing'>): EmbeddingUsage => ({
  provider: 'openai',
  model: u.model,
  tokens: u.tokens,
  usd: u.usd,
  billing: u.billing,
});

/** The pipeline's bundle: cases in rank order, passages in reading order. */
export function toEvidenceBundle(p: PackedEvidence): EvidenceBundle {
  return {
    cases: p.cases.map((c) => ({
      ntsbNo: c.ntsbNo,
      rank: c.caseRank,
      passages: c.passages.map((x) => ({
        passageId: x.id,
        ntsbNo: x.ntsbNo,
        sectionId: x.sectionId,
        revisionId: x.revisionId,
        sectionKind: x.sectionKind,
        scope: x.scope,
        aircraftKey: x.aircraftKey,
        start: x.start,
        end: x.end,
        text: x.text,
        role: x.role,
        reserved: x.reserved,
        rank: x.fusedRank,
      })),
    })),
    passages: p.passages,
    evidenceTokens: p.tokens,
  };
}

/** A fixed reason for an error retrieval threw; never its message. */
function reasonOf(err: unknown): RetrievalFailureReason {
  if (err instanceof RetrievalUnavailableError) return err.reason;
  if (err instanceof QueryTooLongError) return 'query_too_long';
  if (err instanceof QueryEmbeddingError) return 'embedding';
  if (err instanceof IncompleteSearchError) return 'incomplete_search';
  if (err instanceof MalformedPassageError) return 'malformed_passage';
  if (err instanceof errors.ElasticsearchClientError) return 'search';
  return 'other';
}

/**
 * The port's failure for an error of retrieval: `unavailable` when the dataset cannot
 * serve evidence, `timeout` when the stage's signal (cancel or deadline) aborted it,
 * `failed` otherwise. The message is fixed; `embedding` says how a failed embedding is
 * settled.
 */
export function retrievalFailureOf(err: unknown, signal: AbortSignal | undefined, embedding: 'none' | 'uncertain'): RetrievalFailure {
  if (err instanceof RetrievalFailure) return err;
  const reason: RetrievalFailureReason = signal?.aborted ? 'aborted' : reasonOf(err);
  const kind: RetrievalFailureKind = signal?.aborted ? 'timeout' : err instanceof RetrievalUnavailableError ? 'unavailable' : 'failed';
  return new RetrievalFailure(kind, embedding, `retrieval failed: ${kind} (${reason})`, reason);
}

/**
 * `embedder`, noting when it is called (an embedding may be billed from then on). An
 * already aborted signal stops the call before anything is sent, so it is not noted.
 */
function watched(embedder: Embedder | QueryEmbedder, onCall: () => void, signal: AbortSignal | undefined): Embedder | QueryEmbedder {
  const base = { model: embedder.model, dims: embedder.dims, usdPerMillionTokens: embedder.usdPerMillionTokens };
  const embed = async (texts: string[]): Promise<EmbedResult> => {
    signal?.throwIfAborted();
    onCall();
    return embedder.embed(texts);
  };
  if (!('embedWithSignal' in embedder)) return { ...base, embed };
  return {
    ...base,
    embed,
    embedWithSignal: async (texts: string[], callSignal?: AbortSignal) => {
      (callSignal ?? signal)?.throwIfAborted();
      onCall();
      return embedder.embedWithSignal(texts, callSignal);
    },
  };
}

export function createHybridRetriever(opts: HybridRetrieverOptions): EvidenceRetriever {
  const { es, embedder, retrieval: config } = opts;
  // Fail at startup, not on the first question, when the configuration is out of range or incomplete.
  retrievalParams(config.params);
  const casesIndexOf = opts.casesIndexOf;
  if (config.channels.cases && !casesIndexOf) throw new Error(`${config.version} searches the cases index: casesIndexOf is required`);
  const checkTimeoutMs = opts.checkTimeoutMs ?? 2_000;
  const lookupTimeoutMs = opts.lookupTimeoutMs ?? 2_000;

  /**
   * The manifest's cases index within `ms` and `outer` (module comment): the resolver is
   * told through the signal, and the wait ends with the bound whatever the resolver does.
   */
  const lookup = (resolve: NonNullable<HybridRetrieverOptions['casesIndexOf']>, dataset: EvidenceDataset, outer: AbortSignal, ms: number): Promise<string | null> => {
    const timer = AbortSignal.timeout(ms);
    const bound = AbortSignal.any([outer, timer]);
    const work = Promise.resolve().then(() => resolve(dataset, bound));
    return untilAborted(work, bound, (reason) => (outer.aborted ? reason : new CasesIndexLookupTimeoutError(ms)));
  };

  return {
    version: config.version,

    async available(dataset) {
      if (!dataset.passagesIndex) return false;
      try {
        const signal = AbortSignal.timeout(checkTimeoutMs);
        const pinned = { generationId: dataset.generationId, passagesIndex: dataset.passagesIndex };
        await assertServablePassagesIndex(es, pinned, embedder, { timeoutMs: checkTimeoutMs, signal });
        if (config.channels.cases && casesIndexOf) {
          const casesIndex = await lookup(casesIndexOf, pinned, signal, checkTimeoutMs);
          if (!casesIndex) return false;
          await assertServableCasesIndex(es, casesIndex, dataset.generationId, { timeoutMs: checkTimeoutMs, signal });
        }
        return true;
      } catch {
        // Why is never passed on: the dataset resolver logs fixed categories already.
        return false;
      }
    },

    async retrieve(query, signal, onEmbeddingUsage) {
      let settled = false;
      let open = true;
      let embedderCalled = false;
      const settleOnce = (usage: EmbeddingUsage) => {
        // After `retrieve` returned or threw, the step has settled from the outcome.
        if (settled || !open) return;
        settled = true;
        onEmbeddingUsage(usage);
      };
      try {
        // The pinned manifest's cases index, before anything is embedded.
        let casesIndex: string | null = null;
        if (config.channels.cases && casesIndexOf) {
          if (!query.dataset.passagesIndex) throw new RetrievalFailure('unavailable', 'none', 'retrieval failed: unavailable (no_passages_index)', 'no_passages_index');
          try {
            signal.throwIfAborted();
            casesIndex = await lookup(casesIndexOf, query.dataset, signal, lookupTimeoutMs);
          } catch (err) {
            // A cancel or the stage deadline: `timeout` (`aborted`). Nothing was embedded.
            if (signal.aborted) throw retrievalFailureOf(err, signal, 'none');
            const timedOut = err instanceof CasesIndexLookupTimeoutError || err instanceof BoundedReadTimeoutError;
            const kind = timedOut ? 'timeout' : 'failed';
            throw new RetrievalFailure(kind, 'none', `retrieval failed: ${kind} (cases_index_lookup)`, 'cases_index_lookup');
          }
          if (!casesIndex) throw new RetrievalFailure('unavailable', 'none', 'retrieval failed: unavailable (no_cases_index)', 'no_cases_index');
        }
        let candidates: StageOne;
        try {
          candidates = await retrieveCandidatesWith(es, watched(embedder, () => (embedderCalled = true), signal), config, {
            dataset: query.dataset,
            text: fitQueryText(query.text),
            keywordText: query.keywordText,
            filters: query.filters,
            signal,
            // The one source of the embedding's usage (module comment).
            onQueryEmbedding: (u) => settleOnce(toUsage(u)),
            ...(casesIndex ? { casesIndex } : {}),
          });
        } catch (err) {
          throw retrievalFailureOf(err, signal, settled ? 'none' : embeddingBilling(err, embedderCalled, settleOnce));
        }
        let bundle: EvidenceBundle;
        try {
          bundle = toEvidenceBundle(await fetchAndPack(es, candidates.index, candidates.filter, candidates.cases, candidates.params, signal));
        } catch (err) {
          // The embedding was reported before the searches ran.
          throw retrievalFailureOf(err, signal, 'none');
        }
        return {
          bundle,
          // The served index's own contract (v1 and v2 can both be servable).
          chunkerVersion: candidates.chunkerVersion,
          mapping: candidates.mapping,
          // The same candidates (mapped passages included): no embedding and no mapping again.
          async repack(maxEvidenceTokens: number, repackSignal: AbortSignal) {
            try {
              const smaller = retrievalParams({ ...candidates.params, maxEvidenceTokens });
              return toEvidenceBundle(await fetchAndPack(es, candidates.index, candidates.filter, candidates.cases, smaller, repackSignal));
            } catch (err) {
              throw retrievalFailureOf(err, repackSignal, 'none');
            }
          },
        };
      } finally {
        open = false;
      }
    },
  };

  /**
   * How an error before the usage callback is settled: nothing when the embedder was
   * never called (a contract refusal, a query over the cap), the error's own billing for
   * a `QueryEmbeddingError` (its billed usage handed on once), `uncertain` otherwise.
   */
  function embeddingBilling(err: unknown, called: boolean, settleOnce: (u: EmbeddingUsage) => void): 'none' | 'uncertain' {
    if (!called) return 'none';
    if (!(err instanceof QueryEmbeddingError)) return 'uncertain';
    if (err.billing === 'none') return 'none';
    if (err.billing === 'usage' && err.billedTokens !== null) {
      settleOnce({
        provider: 'openai',
        model: embedder.model,
        tokens: err.billedTokens,
        usd: embeddingUsd(err.billedTokens, embedder.usdPerMillionTokens),
        billing: 'reported',
      });
      return 'none';
    }
    return 'uncertain';
  }
}
