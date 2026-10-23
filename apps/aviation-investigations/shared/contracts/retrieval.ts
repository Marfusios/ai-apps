/**
 * Retrieval versions (task 10e): the names of the frozen retrieval configurations the
 * server can run (server/search/retrieval-config.ts), chosen by the operator setting
 * `AVIATION_RETRIEVAL_VERSION`. The version a brief step ran under is recorded in its
 * `meta.retrievalVersion` and on its `brief.retrieve` span (`retrievalVersion`), and every
 * evaluation report names the version it measured.
 *
 * - `retrieval.v1`: passage BM25 and passage kNN, 50 passages each, passage-level
 *   reciprocal rank fusion. The behaviour before task 10e, kept as the rollback.
 * - `retrieval.v2`: the default. Case-level fusion of passage BM25, passage kNN and a
 *   BM25 channel over the cases index's narratives (`N`), 200 hits each.
 * - `retrieval.v2-nf`: experimental. As `retrieval.v2`, with the cases channel also
 *   searching `findings_text` (`NF`). Operators may select it on `dev` for evaluation;
 *   `live` refuses it.
 */
import { z } from 'zod';

export const RETRIEVAL_VERSIONS = ['retrieval.v1', 'retrieval.v2', 'retrieval.v2-nf'] as const;
export type RetrievalVersion = (typeof RETRIEVAL_VERSIONS)[number];
export const RetrievalVersionSchema = z.enum(RETRIEVAL_VERSIONS);

/** What the server runs when `AVIATION_RETRIEVAL_VERSION` is not set. */
export const DEFAULT_RETRIEVAL_VERSION: RetrievalVersion = 'retrieval.v2';

/** Versions for evaluation only: never served on `live`. */
export const EXPERIMENTAL_RETRIEVAL_VERSIONS: readonly RetrievalVersion[] = ['retrieval.v2-nf'];

export const isExperimentalRetrieval = (v: RetrievalVersion): boolean => EXPERIMENTAL_RETRIEVAL_VERSIONS.includes(v);
