import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { z } from 'zod';
import { readDotenvAllowlisted } from './env-files.js';

function str(): z.ZodOptional<z.ZodString>;
function str(def: string): z.ZodDefault<z.ZodString>;
function str(def?: string) {
  return def === undefined ? z.string().optional() : z.string().default(def);
}
const num = (def: number) => z.coerce.number().default(def);
const listOf = (v: string): string[] => v.split(',').map((s) => s.trim()).filter(Boolean);
/** An IPv4 or IPv6 network in CIDR notation. */
export function isCidr(value: string): boolean {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(value);
  if (!m) return false;
  const family = isIP(m[1]!);
  const bits = Number(m[2]);
  return (family === 4 && bits <= 32) || (family === 6 && bits <= 128);
}
const int = (def: number) => z.coerce.number().int().default(def);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['dev', 'live']).default('dev'),
  APP_URL: str('http://localhost:3000'),
  TRUSTED_PROXY_CIDRS: z
    .string()
    .default('')
    .refine((v) => listOf(v).every(isCidr), 'expected comma-separated CIDRs')
    .transform(listOf),
  PORT: int(3000).pipe(z.number().min(0).max(65535)),
  DATABASE_URL: str(),
  DATABASE_MIGRATOR_URL: str(),
  DATABASE_INGEST_URL: str(),
  POSTGRES_PORT: int(55432),
  ELASTICSEARCH_PORT: int(59200),
  ELASTICSEARCH_URL: str('http://localhost:59200'),
  ELASTICSEARCH_API_KEY: str(),
  ELASTICSEARCH_READ_API_KEY: str(),
  ELASTICSEARCH_WRITE_API_KEY: str(),
  ELASTICSEARCH_CA_FILE: str(),
  ELASTICSEARCH_INDEX_PREFIX: str('ai-aviation-dev'),
  AI_LLM_PROVIDER: z.enum(['anthropic', 'openai', 'fake']).default('anthropic'),
  ANTHROPIC_API_KEY: str(),
  ANTHROPIC_SCOPE_MODEL: str('claude-haiku-5-5'),
  ANTHROPIC_ANSWER_MODEL: str('claude-opus-5-5'),
  ANTHROPIC_CHECK_MODEL: str('claude-haiku-5-5'),
  OPENAI_API_KEY: str(),
  OPENAI_EMBEDDING_MODEL: str('text-embedding-3-small'),
  OPENAI_EMBEDDING_DIMENSIONS: int(1536),
  OPENAI_SCOPE_MODEL: str('gpt-5.6-luna'),
  OPENAI_ANSWER_MODEL: str('gpt-5.4-mini-2026-03-17'),
  OPENAI_CHECK_MODEL: str('gpt-5.6-luna'),
  AVIATION_TRACING_ENABLED: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  LANGFUSE_BASE_URL: str(),
  LANGFUSE_PUBLIC_KEY: str(),
  LANGFUSE_SECRET_KEY: str(),
  BETTER_AUTH_SECRET: str(),
  GOOGLE_CLIENT_ID: str(),
  GOOGLE_CLIENT_SECRET: str(),
  TURNSTILE_SECRET_KEY: str(),
  TURNSTILE_SITE_KEY: str(),
  IP_HMAC_SECRET: str(),
  IDENTITY_HMAC_SECRET: str(),
  AI_MONTHLY_BUDGET_USD: num(100),
  AI_INTERACTIVE_MONTHLY_BUDGET_USD: num(80),
  AI_INTERACTIVE_DAILY_BUDGET_USD: num(3),
  AI_INGESTION_MONTHLY_BUDGET_USD: num(20),
  AI_ANONYMOUS_TRIAL_REQUESTS: int(3),
  AI_ANONYMOUS_BUDGET_SHARE: z.coerce.number().min(0).max(1).default(0.25),
  AI_NEW_ACCOUNT_DAILY_REQUESTS: int(5),
  AI_NEW_ACCOUNT_DAYS: int(3),
  AI_USER_DAILY_REQUESTS: int(20),
  AI_USER_MONTHLY_REQUESTS: int(150),
  AI_GLOBAL_CONCURRENCY: int(2),
  NTSB_API_KEY: str(),
  AVIATION_VERIFY_DIR: str(),
});

type Env = z.infer<typeof envSchema>;

/** Names read from process env and dotenv files; everything else is ignored. */
export const CONFIG_ENV_NAMES = Object.keys(envSchema.shape) as readonly string[];

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  /** Deployment environment (dev or live): Compose project, database, index prefix. */
  appEnv: Env['APP_ENV'];
  appUrl: string;
  /**
   * Networks whose peers are trusted proxies (the tunnel connector's edge subnet).
   * Proxy headers such as CF-Connecting-IP are honoured only from these peers; when
   * the list is set (tunnel mode), requests from any other peer are rejected.
   */
  trustedProxyCidrs: string[];
  port: number;
  databaseUrl?: string;
  databaseMigratorUrl?: string;
  databaseIngestUrl?: string;
  postgresPort: number;
  elasticsearch: {
    url: string;
    port: number;
    apiKey?: string;
    readApiKey?: string;
    writeApiKey?: string;
    caFile?: string;
    indexPrefix: string;
  };
  ai: {
    llmProvider: Env['AI_LLM_PROVIDER'];
    anthropic: { apiKey?: string; scopeModel: string; answerModel: string; checkModel: string };
    openai: {
      apiKey?: string;
      embeddingModel: string;
      embeddingDimensions: number;
      scopeModel: string;
      answerModel: string;
      checkModel: string;
    };
    budgets: {
      monthlyUsd: number;
      interactiveMonthlyUsd: number;
      interactiveDailyUsd: number;
      ingestionMonthlyUsd: number;
      anonymousShare: number;
    };
    limits: {
      anonymousTrialRequests: number;
      newAccountDailyRequests: number;
      newAccountDays: number;
      userDailyRequests: number;
      userMonthlyRequests: number;
      globalConcurrency: number;
    };
  };
  auth: {
    secret?: string;
    googleClientId?: string;
    googleClientSecret?: string;
    ipHmacSecret?: string;
    identityHmacSecret?: string;
  };
  turnstile: { secretKey?: string; siteKey?: string };
  tracing: { enabled: boolean; baseUrl?: string; publicKey?: string; secretKey?: string };
  ntsbApiKey?: string;
  /** Directory for verification reports; default `data/work` in the checkout. */
  verifyDir?: string;
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Explicit dotenv files in priority order; defaults to AVIATION_ENV_FILES. */
  files?: string[];
}

function nonEmpty(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of CONFIG_ENV_NAMES) {
    const v = env[name];
    if (v !== undefined && v !== '') out[name] = v;
  }
  return out;
}

export function loadConfig(opts: LoadConfigOptions = {}): AppConfig {
  const env = opts.env ?? process.env;
  const files =
    opts.files ??
    (env.AVIATION_ENV_FILES ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean)
      .map((f) => resolve(f));

  const merged: Record<string, string> = {};
  for (const f of [...files].reverse()) {
    Object.assign(merged, readDotenvAllowlisted(f, CONFIG_ENV_NAMES));
  }
  Object.assign(merged, nonEmpty(env));

  const parsed = envSchema.safeParse(merged);
  if (!parsed.success) {
    // Report names and messages only; never echo input values.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration: ${problems.join('; ')}`);
  }
  const e = parsed.data;
  if (e.AI_LLM_PROVIDER === 'fake' && e.NODE_ENV !== 'test') {
    throw new Error("Invalid configuration: AI_LLM_PROVIDER 'fake' is allowed only when NODE_ENV=test");
  }

  return {
    nodeEnv: e.NODE_ENV,
    appEnv: e.APP_ENV,
    appUrl: e.APP_URL,
    trustedProxyCidrs: e.TRUSTED_PROXY_CIDRS,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    databaseMigratorUrl: e.DATABASE_MIGRATOR_URL,
    databaseIngestUrl: e.DATABASE_INGEST_URL,
    postgresPort: e.POSTGRES_PORT,
    elasticsearch: {
      url: e.ELASTICSEARCH_URL,
      port: e.ELASTICSEARCH_PORT,
      apiKey: e.ELASTICSEARCH_API_KEY,
      readApiKey: e.ELASTICSEARCH_READ_API_KEY,
      writeApiKey: e.ELASTICSEARCH_WRITE_API_KEY,
      caFile: e.ELASTICSEARCH_CA_FILE,
      indexPrefix: e.ELASTICSEARCH_INDEX_PREFIX,
    },
    ai: {
      llmProvider: e.AI_LLM_PROVIDER,
      anthropic: {
        apiKey: e.ANTHROPIC_API_KEY,
        scopeModel: e.ANTHROPIC_SCOPE_MODEL,
        answerModel: e.ANTHROPIC_ANSWER_MODEL,
        checkModel: e.ANTHROPIC_CHECK_MODEL,
      },
      openai: {
        apiKey: e.OPENAI_API_KEY,
        embeddingModel: e.OPENAI_EMBEDDING_MODEL,
        embeddingDimensions: e.OPENAI_EMBEDDING_DIMENSIONS,
        scopeModel: e.OPENAI_SCOPE_MODEL,
        answerModel: e.OPENAI_ANSWER_MODEL,
        checkModel: e.OPENAI_CHECK_MODEL,
      },
      budgets: {
        monthlyUsd: e.AI_MONTHLY_BUDGET_USD,
        interactiveMonthlyUsd: e.AI_INTERACTIVE_MONTHLY_BUDGET_USD,
        interactiveDailyUsd: e.AI_INTERACTIVE_DAILY_BUDGET_USD,
        ingestionMonthlyUsd: e.AI_INGESTION_MONTHLY_BUDGET_USD,
        anonymousShare: e.AI_ANONYMOUS_BUDGET_SHARE,
      },
      limits: {
        anonymousTrialRequests: e.AI_ANONYMOUS_TRIAL_REQUESTS,
        newAccountDailyRequests: e.AI_NEW_ACCOUNT_DAILY_REQUESTS,
        newAccountDays: e.AI_NEW_ACCOUNT_DAYS,
        userDailyRequests: e.AI_USER_DAILY_REQUESTS,
        userMonthlyRequests: e.AI_USER_MONTHLY_REQUESTS,
        globalConcurrency: e.AI_GLOBAL_CONCURRENCY,
      },
    },
    auth: {
      secret: e.BETTER_AUTH_SECRET,
      googleClientId: e.GOOGLE_CLIENT_ID,
      googleClientSecret: e.GOOGLE_CLIENT_SECRET,
      ipHmacSecret: e.IP_HMAC_SECRET,
      identityHmacSecret: e.IDENTITY_HMAC_SECRET,
    },
    turnstile: { secretKey: e.TURNSTILE_SECRET_KEY, siteKey: e.TURNSTILE_SITE_KEY },
    tracing: {
      enabled: e.AVIATION_TRACING_ENABLED,
      baseUrl: e.LANGFUSE_BASE_URL,
      publicKey: e.LANGFUSE_PUBLIC_KEY,
      secretKey: e.LANGFUSE_SECRET_KEY,
    },
    ntsbApiKey: e.NTSB_API_KEY,
    verifyDir: e.AVIATION_VERIFY_DIR,
  };
}
