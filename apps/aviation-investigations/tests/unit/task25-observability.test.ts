import { afterEach, expect, it, vi } from 'vitest';
import { InMemorySpanExporter, type SpanExporter } from '@opentelemetry/sdk-trace';
import { loadConfig } from '../../shared/config.js';
import { EvidenceProgressStore } from '../../server/evidence/progress.js';
import { observableExporter, stageSpan, startTracing, tracingExportWarning, tracingHealth } from '../../server/observability/tracing.js';
import { genAiAttributes, resetTracingStats, tracingStats } from '../../server/observability/attributes.js';
import { langfuseApi, LangfuseApiError } from '../../server/observability/langfuse.js';
import { MIRRORED_PROMPTS, syncLangfusePrompts } from '../../worker/langfuse-prompts.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); resetTracingStats(); });
it('production export warnings are one content-free operational JSON line', () => {
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const exporter = observableExporter({
    export() { throw new Error('PRIVATE_UPSTREAM'); }, async shutdown() {},
  }, { warn: tracingExportWarning });
  exporter.export([], () => {});
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]?.[0]).toBe(JSON.stringify({
    level: 40, msg: 'tracing export failed', category: 'tracing_export_failed', failedExports: 1,
  }) + '\n');
});
it('flush and shutdown errors stay internal and do not count as failed exports', async () => {
  const warn = vi.fn();
  const exporter = observableExporter({
    export(_spans, callback) { callback({ code: 0 }); },
    async shutdown() { throw new Error('PRIVATE_SHUTDOWN'); },
    async forceFlush() { throw new Error('PRIVATE_FLUSH'); },
  }, { warn });
  exporter.export([], () => {});
  await exporter.forceFlush?.();
  await exporter.shutdown();
  expect(tracingHealth().failedExports).toBe(0);
  expect(tracingStats.internalErrors).toBe(2);
  expect(warn).not.toHaveBeenCalled();
});
it('attribute preparation errors do not count as transport failures or change a request result', async () => {
  const cfg = loadConfig({ files: [], env: {
    AVIATION_TRACING_ENABLED: 'true', LANGFUSE_BASE_URL: 'https://traces.example',
    LANGFUSE_PUBLIC_KEY: 'test-public', LANGFUSE_SECRET_KEY: 'test-secret',
  } });
  const handle = startTracing(cfg, { exporter: new InMemorySpanExporter() });
  try {
    const attrs = { get model(): string { throw new Error('PRIVATE_ATTRIBUTE'); } };
    expect(await stageSpan('evidence.scope', attrs, () => 42)).toBe(42);
    expect(tracingStats.internalErrors).toBe(1);
    expect(tracingHealth().failedExports).toBe(0);
  } finally { await handle.shutdown(); }
  expect(tracingHealth().failedExports).toBe(0);
});
it('export failures are counted, warnings are throttled and contain no upstream errors; recovery sets the last success', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
  const warn = vi.fn(), done = vi.fn();
  let behavior = 'failure';
  const inner: SpanExporter = { export(_spans, callback) {
    if (behavior === 'throw') throw new Error('SECRET_URL_AND_KEY');
    if (behavior !== 'stall') callback(behavior === 'ok' ? {code:0} : {code:1,error:new Error('SECRET_URL_AND_KEY')});
  }, shutdown: async () => {} };
  const exporter = observableExporter(inner,{warn,exportTimeoutMillis:100});
  exporter.export([],done); behavior = 'throw'; exporter.export([],done);
  expect(tracingHealth().failedExports).toBe(2); expect(warn).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(300_000); behavior='stall'; exporter.export([],done);
  await vi.advanceTimersByTimeAsync(101);
  expect(tracingHealth().failedExports).toBe(3); expect(warn).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
  expect(done.mock.calls.every(args => args[0].code === 0)).toBe(true);
  behavior='ok'; exporter.export([],done);
  expect(tracingHealth().lastExportOkAt).toBe(new Date().toISOString());
});
it('only approved model and frozen prompt attributes are linked', () => {
  expect(genAiAttributes({ model:'test-model',promptVersion:'scope.e3' })).toMatchObject({
    'langfuse.observation.model.name':'test-model', 'langfuse.observation.type':'generation',
    'langfuse.observation.prompt.name':'aircase-scope.e3','langfuse.observation.prompt.version':1,
  });
  expect(genAiAttributes({ model:'test-model',promptVersion:'attr.a2' })).toMatchObject({
    'langfuse.observation.prompt.name':'aircase-attr.a2','langfuse.observation.prompt.version':1,
  });
  expect(genAiAttributes({model:'test',promptVersion:'attacker'})).not.toHaveProperty('langfuse.observation.prompt.name');
});
it('progress is per principal, bounded, immutable to readers and expires five minutes after finishing', () => {
  let now=0; const store=new EvidenceProgressStore(()=>now,2);
  const first=store.start('account:A','key','search',false,true,{hash:'A',kind:'account'});
  first.observer.onStage?.('scope');
  expect(store.read('account:B','key')).toBeNull();
  const view=store.read('account:A','key')!; view.progress.question.status='done';
  expect(store.read('account:A','key')!.progress.question.status).toBe('running');
  first.observer.onQuestion?.('suggestions',false); first.observer.onStage?.('retrieval');
  first.observer.onRetrieved?.(10); first.observer.onStage?.('rerank'); first.observer.onOrdered?.(false,false);
  first.finish(true);
  expect(store.read('account:A','key')!.progress).toMatchObject({state:'done',search:{cases:10,status:'done'},order:{result:'match',status:'failed'}});
  now=300_001; expect(store.read('account:A','key')).toBeNull();
  store.start('A','1','x',true,false,{hash:'A',kind:'account'});
  store.start('A','2','y',true,false,{hash:'A',kind:'account'});
  store.start('A','3','z',true,false,{hash:'A',kind:'account'});
  expect(store.read('A','1')).toBeNull();
  expect(store.read('A','3')!.progress.question.status).toBe('skipped');
});
it('prompt sync is idempotent, refuses drift/version changes and never overwrites a mirror', async () => {
  const cfg=loadConfig({env:{},files:[]}); const saved=new Map<string,object>();
  const api=vi.fn(async (path:string,body?:object) => {
    if(body) { const value={...body,version:1}; saved.set((body as {name:string}).name,value); return value; }
    const name=path.split('/').pop()!.split('?')[0]!;
    if (!saved.has(name)) throw new LangfuseApiError(404);
    return saved.get(name);
  });
  expect((await syncLangfusePrompts(cfg,api)).every(p=>p.created)).toBe(true);
  expect((await syncLangfusePrompts(cfg,api)).every(p=>!p.created)).toBe(true);
  expect(api.mock.calls.filter(c=>c[1])).toHaveLength(3);
  expect(MIRRORED_PROMPTS.map(p=>p.name)).toEqual(['aircase-scope.e3','aircase-rerank.r1','aircase-attr.a2']);
  saved.set(MIRRORED_PROMPTS[0]!.name,{...MIRRORED_PROMPTS[0],version:2});
  await expect(syncLangfusePrompts(cfg,api)).rejects.toThrow('mirror mismatch');
  expect(api.mock.calls.filter(c=>c[1])).toHaveLength(3);
});
it('project APIs use bounded requests, reject redirects, sanitize failures, and never follow an untrusted origin', async () => {
  const cfg=loadConfig({env:{LANGFUSE_BASE_URL:'https://traces.example',LANGFUSE_PUBLIC_KEY:'pk',LANGFUSE_SECRET_KEY:'secret'},files:[]});
  const fetcher=vi.fn(async(_input: string | URL | Request, _init?: RequestInit)=>{throw new Error('SECRET');});
  await expect(langfuseApi(cfg,fetcher)('scores',{})).rejects.toMatchObject({message:'Langfuse project API unavailable',status:null});
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({redirect:'error',signal:expect.any(AbortSignal)});
});
it('admin emails default to nobody, normalize whitespace/case and reject malformed lists', () => {
  expect(loadConfig({env:{},files:[]}).adminEmails).toEqual([]);
  expect(loadConfig({env:{AIRCASE_ADMIN_EMAILS:' Admin@Example.com , admin@example.com, two@example.com '},files:[]}).adminEmails).toEqual(['admin@example.com','two@example.com']);
  expect(()=>loadConfig({env:{AIRCASE_ADMIN_EMAILS:'not an email'},files:[]})).toThrow();
});

it('feedback export is asynchronous, serial, latest-value and content-free even when the first score is slow', async () => {
  const {feedbackExporter}=await import('../../server/evidence/feedback.js');
  let entered!:()=>void, release!:()=>void;
  const began=new Promise<void>(r=>{entered=r;}), held=new Promise<void>(r=>{release=r;});
  let current={traceId:'a'.repeat(32),rating:'useful',createdAt:new Date('2026-10-31T12:00:00Z'),question:'PRIVATE QUESTION',email:'PRIVATE EMAIL'};
  const db={select:()=>({from:()=>({where:async()=>[structuredClone(current)]})})} as unknown as Parameters<typeof feedbackExporter>[0];
  const calls: object[]=[];
  const api=vi.fn(async(path:string,body:object)=>{expect(path).toBe('scores');calls.push(body);if(calls.length===1){entered();await held;}return {};});
  const warn=vi.fn(), queue=feedbackExporter(db,api,'dev',warn);
  queue.enqueue('private-search-id'); await began;
  current={...current,rating:'not_useful'}; queue.enqueue('private-search-id');
  // A rating request does not wait for the slow export; the last value is read next.
  expect(calls).toHaveLength(1); release(); await queue.settled();
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({name:'visitor_feedback',value:1});
  expect(calls[1]).toMatchObject({id:`visitor-feedback-${'a'.repeat(32)}`,traceId:'a'.repeat(32),value:0,timestamp:'2026-10-31T12:00:00.000Z'});
  expect(JSON.stringify(calls)).not.toMatch(/PRIVATE|private-search-id|question|email/);
  expect(warn).not.toHaveBeenCalled();
});
