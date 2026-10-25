/** Read-only target/gold preflight. No query embeddings or search results are requested. */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import type { Db } from '../../server/db/client.js';
import type { Client } from '@elastic/elasticsearch';
import { DatasetResolver } from '../../server/dataset.js';
import { readIndexMeta } from '../../server/search/index-meta.js';
import { loadCodedCorpus } from '../retrieval/coded/build-coded.js';
import { indexCorpus, deriveQuestion, CodedQuestionSpecSchema, CodedDatasetSchema } from '../retrieval/coded/coded.js';
import { fileSha, FROZEN_DIR } from './frozen.js';
import { EvaluationError } from './money.js';
import type { ABDataset } from './types.js';

export async function verifyRankingTarget(db: Db, es: Client) {
  if (fileSha('evals/retrieval/coded/dataset.json') !== '5d1746bd04af8602c18babf2ae6cca6b3e1fd2760f6d72852df86ba240b8b3a4') throw new EvaluationError('Track C selection set changed');
  const old = CodedDatasetSchema.parse(JSON.parse(readFileSync('evals/retrieval/coded/dataset.json', 'utf8')));
  const fresh = JSON.parse(readFileSync(`${FROZEN_DIR}/confirmation.json`, 'utf8')) as ABDataset;
  const pinned = await new DatasetResolver(db, es, { embedding: { model: 'text-embedding-3-small', dims: 1536 }, manifestTtlMs: 0 }).current();
  if (!pinned.passages?.servable || !pinned.manifest.passagesIndex) throw new EvaluationError('Development evidence indices unavailable');
  const client = await db.$client.connect();
  let loaded;
  try {
    if ((await client.query('select current_database() as name')).rows[0]?.name !== 'aviation_dev') throw new EvaluationError('Wrong target database');
    loaded = await loadCodedCorpus(client, pinned.manifest.generationId);
  } finally { client.release(); }
  for (const field of ['generationId', 'archiveSha256', 'mappingVersion', 'fieldNormalizationVersion', 'citationTextVersion'] as const) {
    assert.equal(loaded.source[field], fresh.source[field]); assert.equal(loaded.source[field], old.source[field]);
  }
  const corpus = indexCorpus(loaded.corpus);
  const selection = old.questions.filter(q => q.split === 'dev');
  if (selection.length !== 21 || fresh.questions.length !== 48) throw new EvaluationError('Unexpected A/B strata');
  for (const q of [...selection, ...fresh.questions]) {
    const spec = CodedQuestionSpecSchema.parse({ id: q.id, question: q.question, area: q.area, class: q.class,
      filters: q.filters, codeSet: q.codeSet, wording: ['coded predicate'], note: 'Frozen Task 24 label verification.' });
    assert.deepEqual(deriveQuestion(corpus, spec).relevant, q.relevant, q.id);
  }
  const cases = await readIndexMeta(es, pinned.manifest.casesIndex, { timeoutMs: 5_000 });
  const passages = await readIndexMeta(es, pinned.manifest.passagesIndex, { timeoutMs: 5_000 });
  if (!cases.fingerprint || !passages.fingerprint || cases.generationId !== loaded.source.generationId || passages.generationId !== loaded.source.generationId) throw new EvaluationError('Unpinned index identity');
  return { pinned, selection, fresh, identity: { source: loaded.source, cases, passages,
    dataset: pinned.dataset, indexVersion: pinned.indexVersion, fieldNormalizationVersion: pinned.fieldNormalizationVersion,
    eligibleCases: loaded.corpus.cases.length, selectionGoldVerified: selection.length, confirmationGoldVerified: fresh.questions.length } };
}
