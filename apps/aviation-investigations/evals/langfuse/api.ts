/** The deployed v4 public API. No SDK auto-capture, admin keys, implicit host or provider access. */
import { datasetItem, datasetMetadata, opaqueId, SCORE_DEFINITIONS, stable, type EvaluationDataset, type ScoreName } from './data.js';

export class LangfuseError extends Error { override name = 'LangfuseError'; }
type Row = Record<string, any>;
export interface PublicApi { request(path: string, method?: 'GET' | 'POST', body?: unknown, allowMissing?: boolean): Promise<any> }
export class LangfuseApi implements PublicApi {
  constructor(private readonly base: string, private readonly auth: string) {}
  static fromEnvironment(env: NodeJS.ProcessEnv) {
    const { LANGFUSE_BASE_URL: base, LANGFUSE_PUBLIC_KEY: pub, LANGFUSE_SECRET_KEY: secret } = env;
    if (!base || !pub || !secret || new URL(base).protocol !== 'https:') throw new LangfuseError('Incomplete host Langfuse configuration');
    return new LangfuseApi(base.replace(/\/+$/, ''), `Basic ${Buffer.from(`${pub}:${secret}`).toString('base64')}`);
  }
  async request(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, allowMissing = false): Promise<any> {
    if (!path.startsWith('/api/public/') || path.startsWith('//')) throw new LangfuseError('Non-public Langfuse path refused');
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: this.auth, 'Content-Type': 'application/json',
          ...(path === '/api/public/otel/v1/traces' ? { 'x-langfuse-ingestion-version': '4' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new LangfuseError('Langfuse transport failed; details suppressed'); }
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok) { await response.body?.cancel(); throw new LangfuseError(`Langfuse API returned HTTP ${response.status}`); }
    try { return await response.json(); } catch { throw new LangfuseError('Langfuse returned invalid JSON'); }
  }
  async assertDevelopment() {
    const p = await this.request('/api/public/projects');
    if (p.data?.length !== 1 || p.data[0].name !== 'aviation-dev') throw new LangfuseError('Langfuse keys are not scoped to aviation-dev');
    return p.data[0] as { id: string; name: string };
  }
}
export async function paginated(api: PublicApi, path: string): Promise<Row[]> {
  const all: Row[] = [];
  for (let page = 1; page <= 100; page++) {
    const r = await api.request(`${path}${path.includes('?') ? '&' : '?'}page=${page}&limit=100`);
    if (!Array.isArray(r.data)) throw new LangfuseError('Invalid paginated API response');
    all.push(...r.data);
    if (page >= (r.meta?.totalPages ?? 1)) return all;
  }
  throw new LangfuseError('API pagination limit exceeded');
}
export async function cursorRows(api: PublicApi, path: string): Promise<Row[]> {
  const all: Row[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const r = await api.request(`${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!Array.isArray(r.data)) throw new LangfuseError('Invalid cursor API response');
    all.push(...r.data);
    const next = r.meta?.cursor ?? r.meta?.nextCursor ?? r.nextCursor;
    if (!next) return all;
    if (next === cursor) throw new LangfuseError('API cursor did not advance');
    cursor = next;
  }
  throw new LangfuseError('API cursor limit exceeded');
}
function same(actual: unknown, expected: unknown, label: string) {
  if (stable(actual) !== stable(expected)) throw new LangfuseError(`Existing ${label} conflicts with the frozen fixture; no overwrite allowed`);
}
export function assertDatasetItem(actual: Row, expected: ReturnType<typeof datasetItem>) {
  for (const key of ['id', 'datasetName', 'status', 'input', 'expectedOutput', 'metadata'] as const) same(actual[key], expected[key], 'dataset item');
  if (actual.sourceTraceId || actual.sourceObservationId) throw new LangfuseError('Dataset item unexpectedly sourced from a trace');
}
export async function syncDataset(api: PublicApi, d: EvaluationDataset) {
  const path = `/api/public/v2/datasets/${encodeURIComponent(d.name)}`;
  let remote = await api.request(path, 'GET', undefined, true);
  if (!remote) remote = await api.request('/api/public/v2/datasets', 'POST', { name: d.name,
    description: 'Synthetic public coded NTSB reference questions. Learning exercise; not a new release confirmation.', metadata: datasetMetadata(d) });
  same(remote.metadata, datasetMetadata(d), 'dataset metadata');
  const expected = d.questions.map(q => datasetItem(d, q));
  const existing = await paginated(api, `/api/public/dataset-items?datasetName=${encodeURIComponent(d.name)}`);
  if (existing.some(item => !expected.some(e => e.id === item.id))) throw new LangfuseError('Named dataset contains unexpected items');
  // Validate every existing item before creating any missing item.
  for (const item of existing) assertDatasetItem(item, expected.find(e => e.id === item.id)!);
  for (const item of expected) if (!existing.some(e => e.id === item.id)) {
    const byId = await api.request(`/api/public/dataset-items/${item.id}`, 'GET', undefined, true);
    if (byId) assertDatasetItem(byId, item);
    else assertDatasetItem(await api.request('/api/public/dataset-items', 'POST', item), item);
  }
  const verified = await paginated(api, `/api/public/dataset-items?datasetName=${encodeURIComponent(d.name)}`);
  if (verified.length !== expected.length) throw new LangfuseError('Dataset upload is incomplete');
  for (const item of expected) assertDatasetItem(verified.find(e => e.id === item.id) ?? {}, item);
  return { id: remote.id as string, items: verified, createdItems: expected.length - existing.length };
}
export async function syncScoreConfigs(api: PublicApi) {
  const configs = await paginated(api, '/api/public/score-configs');
  const out = {} as Record<ScoreName, string>;
  for (const spec of SCORE_DEFINITIONS) {
    const expected = { ...spec, dataType: 'NUMERIC', minValue: 0, maxValue: 1 };
    const found = configs.filter(c => c.name === spec.name);
    if (found.length > 1) throw new LangfuseError('Ambiguous score configurations');
    const config = found[0] ?? await api.request('/api/public/score-configs', 'POST', expected);
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) same(config[key], expected[key], 'score configuration');
    if (config.isArchived) throw new LangfuseError('Score configuration is archived');
    out[spec.name] = config.id;
  }
  return out;
}
export interface ScorePayload {
  id: string; name: ScoreName; value: number; dataType: 'NUMERIC'; configId: string; timestamp: string;
  traceId?: string; observationId?: string; datasetRunId?: string;
  environment: 'dev'; comment: string;
}
export function scorePayload(name: ScoreName, value: number, configId: string, timestamp: string,
  target: { traceId: string; observationId: string } | { datasetRunId: string }): ScorePayload {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new LangfuseError('Invalid numeric score');
  return { id: opaqueId('task25-score', stable(target), name), name, value, configId, dataType: 'NUMERIC', timestamp, ...target,
    environment: 'dev', comment: 'Deterministic Task 24 coded-reference metric; not a model or human safety judgment.' };
}
export async function publishScores(api: PublicApi, scores: ScorePayload[]) {
  const missing: ScorePayload[] = [];
  for (const s of scores) {
    const r = await api.request(`/api/public/v3/scores?id=${s.id}&fields=details,subject`);
    if (!r.data?.length) { missing.push(s); continue; }
    if (r.data.length !== 1) throw new LangfuseError('Duplicate score identity');
    const v = r.data[0];
    for (const key of ['name', 'value', 'configId', 'dataType'] as const) same(v[key], s[key], 'score');
    if (s.traceId) {
      same(v.subject?.kind, 'observation', 'score subject');
      same(v.subject?.traceId, s.traceId, 'score trace'); same(v.subject?.id, s.observationId, 'score observation');
    } else { same(v.subject?.kind, 'experiment', 'score subject'); same(v.subject?.id, s.datasetRunId, 'score experiment'); }
  }
  if (missing.length) {
    const r = await api.request('/api/public/scores', 'POST', missing);
    if (r.errors?.length || r.rejected) throw new LangfuseError('Some scores were rejected');
  }
}
