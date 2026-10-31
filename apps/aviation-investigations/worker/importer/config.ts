import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { loadConfig, type AppConfig } from '../../shared/config.js';
import { readDotenvAllowlisted } from '../../shared/env-files.js';
import { ImportFailure } from './contracts.js';
import { IMPORT_LOCAL_TIME,IMPORT_TIME_ZONE } from '../../shared/import-schedule.js';

const path=z.string().max(4096).refine(isAbsolute);
const EnvironmentSchema=z.strictObject({
  envFiles:z.array(path).min(1).max(8),
  applicationUrl:z.url().refine(s=>{const u=new URL(s);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/';}),
  container:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
  image:z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export const ImporterConfigSchema=z.strictObject({
  version:z.literal('snapshot-importer.v1'),root:path,hostLock:path,maintenanceLock:path,
  /** This identity is checked against Git, rather than accepted as the worker's identity on trust. */
  code:z.string().regex(/^[0-9a-f]{40}$/),
  schedule:z.strictObject({enabled:z.boolean(),localTime:z.literal(IMPORT_LOCAL_TIME),timeZone:z.literal(IMPORT_TIME_ZONE)}),
  /** Controller's installation evidence, never manufactured by the runner. */
  installation:z.strictObject({backupMutexConfirmed:z.literal(true),headroomReportSha256:z.string().regex(/^[0-9a-f]{64}$/)}).nullable(),
  dev:EnvironmentSchema,live:EnvironmentSchema.optional(),
});
export type ImporterConfig=z.infer<typeof ImporterConfigSchema>;
export async function readImporterConfig(path:string):Promise<ImporterConfig> {
  try {
    const s=await lstat(path);
    if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0||s.size>65536)throw new ImportFailure('configuration');
    const c=ImporterConfigSchema.parse(JSON.parse(await readFile(path,'utf8')));
    const dirs=[c.root,c.hostLock,c.maintenanceLock].map(p=>resolve(p));
    if(new Set(dirs).size!==3 || dirs.slice(1).some(p=>p.startsWith(`${dirs[0]}/`)))throw new ImportFailure('configuration');
    return c;
  } catch {throw new ImportFailure('configuration');}
}
export const WORKER_VARS=['APP_ENV','AVIATION_IMPORTS_ENABLED','DATABASE_INGEST_URL','ELASTICSEARCH_URL',
  'ELASTICSEARCH_WRITE_API_KEY','ELASTICSEARCH_CA_FILE','ELASTICSEARCH_INDEX_PREFIX','OPENAI_EMBEDDING_MODEL',
  'OPENAI_EMBEDDING_DIMENSIONS','AI_MONTHLY_BUDGET_USD','AI_INTERACTIVE_MONTHLY_BUDGET_USD',
  'AI_INTERACTIVE_DAILY_BUDGET_USD','AI_ANONYMOUS_BUDGET_SHARE','AI_INGESTION_MONTHLY_BUDGET_USD'] as const;
function fileValues(files:string[],names:readonly string[]):Record<string,string> {
  const values:Record<string,string>={};
  for(const path of files)for(const [key,value] of Object.entries(readDotenvAllowlisted(path,names))){
    if(value&&!values[key])values[key]=value;
  }
  return values;
}
export function environmentConfig(config:ImporterConfig,environment:'dev'|'live',secondary=false):AppConfig {
  const source=config[environment];
  if(!source)throw new ImportFailure('configuration');
  // Load only worker inputs. Auth, visitor HMAC and Langfuse keys never enter this configuration.
  const values=fileValues(source.envFiles,WORKER_VARS);
  if(values.APP_ENV!==environment)throw new ImportFailure('configuration');
  if(!secondary)for(const name of WORKER_VARS){
    const value=process.env[name];if(!value)continue;
    // Preserve nonempty process inputs; refuse a mixed project instead of silently replacing its credentials.
    if((name==='APP_ENV'||name.startsWith('DATABASE_')||name.startsWith('ELASTICSEARCH_'))&&values[name]&&values[name]!==value) {
      throw new ImportFailure('configuration');
    }
    values[name]=value;
  }
  const app=loadConfig({files:[],env:{...values,AVIATION_TRACING_ENABLED:'false'}});
  if(app.imports.enabled!==config.schedule.enabled)throw new ImportFailure('configuration');
  const required=['AI_MONTHLY_BUDGET_USD','AI_INTERACTIVE_MONTHLY_BUDGET_USD','AI_INGESTION_MONTHLY_BUDGET_USD'];
  if([...required,'ELASTICSEARCH_URL','ELASTICSEARCH_INDEX_PREFIX'].some(name=>!values[name]))throw new ImportFailure('configuration');
  if(app.appEnv!==environment || !app.databaseIngestUrl || !app.elasticsearch.writeApiKey
    || app.ai.openai.embeddingModel!=='text-embedding-3-small' || app.ai.openai.embeddingDimensions!==1536) {
    throw new ImportFailure('configuration');
  }
  return app;
}
/** Called only after a nonzero miss plan has passed the cap; existing nonempty process keys win. */
export function providerKey(config:ImporterConfig,environment:'dev'|'live'):string {
  const value=process.env.OPENAI_API_KEY||fileValues(config[environment]!.envFiles,['OPENAI_API_KEY']).OPENAI_API_KEY;
  if(!value)throw new ImportFailure('configuration');return value;
}
