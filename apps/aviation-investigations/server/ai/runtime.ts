/**
 * What the HTTP server needs to offer AI, built once at startup from configuration:
 *
 * - `startup`: the provider, pricing and reservation check (server/ai/pricing.ts);
 * - `policy`: the quota policy, which needs both HMAC secrets (server/quota/policy.ts);
 * - `trials`: trial cookies and identities (server/identity/trial.ts), available
 *   whenever the policy is;
 * - `gate`: the anonymous gate (server/identity/gate.ts), which also needs Turnstile.
 *
 * A missing part keeps the AI features that need it off (fail closed) and is listed in
 * `problems` (setting names only, never values) for the startup log. `GET /api/ai/status`
 * then reports `paused` with reason `dependency`.
 *
 * Turnstile configuration rules: both keys set; Cloudflare's test keys only outside
 * `APP_ENV=live`, and never mixed with real keys; APP_URL https in live (its hostname
 * is the hostname a challenge must have been solved on, and https makes the trial
 * cookie Secure).
 */
import type { AppConfig } from '../../shared/config.js';
import { TURNSTILE_ACTION } from '../../shared/contracts/ai.js';
import type { Db } from '../db/client.js';
import { AnonymousGate } from '../identity/gate.js';
import { TrialIdentities, type TrialCreationLimits } from '../identity/trial.js';
import { TurnstileVerifier, TURNSTILE_TEST_SECRET_KEYS, TURNSTILE_TEST_SITE_KEYS, type TurnstileVerifierOptions } from '../identity/turnstile.js';
import { isHttpsUrl } from '../http/security-headers.js';
import { QuotaConfigError, quotaPolicy, type QuotaPolicy } from '../quota/policy.js';
import { startupAiCheck, type AiStartupCheck } from './pricing.js';

export interface AiRuntime {
  startup: AiStartupCheck;
  policy: QuotaPolicy | null;
  trials: TrialIdentities | null;
  gate: AnonymousGate | null;
  now: () => Date;
  /** Why parts of AI are off: setting names and rules only. */
  problems: string[];
}

export type AiRuntimeConfig = Pick<AppConfig, 'nodeEnv' | 'appEnv' | 'appUrl' | 'ai' | 'auth' | 'turnstile'>;

export interface AiRuntimeDeps {
  /** PostgreSQL as aviation_app. */
  db: Db;
  /** Siteverify transport and timing (tests inject a fake fetch). */
  turnstile?: Pick<TurnstileVerifierOptions, 'fetch' | 'attemptTimeoutMs' | 'attempts' | 'retryDelayMs'>;
  trialLimits?: TrialCreationLimits;
  now?: () => Date;
}

/** The Turnstile setup problem, or null when the keys and APP_URL suit the environment. */
export function turnstileConfigProblem(config: Pick<AppConfig, 'appEnv' | 'appUrl' | 'turnstile'>): string | null {
  const { secretKey, siteKey } = config.turnstile;
  if (!secretKey || !siteKey) return 'TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY must be set for anonymous AI';
  const testSecret = TURNSTILE_TEST_SECRET_KEYS.includes(secretKey);
  const testSite = TURNSTILE_TEST_SITE_KEYS.includes(siteKey);
  if (testSecret !== testSite) return 'TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must both be Cloudflare test keys or both real keys';
  let url: URL;
  try {
    url = new URL(config.appUrl);
  } catch {
    return 'APP_URL is not a valid URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'APP_URL must be an http or https URL';
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(url.hostname)) return 'APP_URL must name a host (Turnstile reports the hostname a challenge was solved on)';
  if (config.appEnv === 'live') {
    if (testSecret) return 'Cloudflare Turnstile test keys are not allowed with APP_ENV=live';
    if (url.protocol !== 'https:') return 'APP_ENV=live requires an https APP_URL (Secure trial cookie)';
  }
  return null;
}

export function createAiRuntime(config: AiRuntimeConfig, deps: AiRuntimeDeps): AiRuntime {
  const now = deps.now ?? (() => new Date());
  const problems: string[] = [];
  const startup = startupAiCheck(config);
  if (!startup.enabled) problems.push(startup.reason ?? 'the AI startup check failed');

  let policy: QuotaPolicy | null = null;
  try {
    policy = quotaPolicy(config);
  } catch (err) {
    if (!(err instanceof QuotaConfigError)) throw err;
    problems.push(err.message);
  }

  const secure = isHttpsUrl(config.appUrl);
  const trials = policy ? new TrialIdentities({ db: deps.db, policy, secure, ...(deps.trialLimits ? { limits: deps.trialLimits } : {}) }) : null;

  let gate: AnonymousGate | null = null;
  const problem = turnstileConfigProblem(config);
  if (problem) problems.push(problem);
  if (policy && trials && !problem) {
    const turnstile = new TurnstileVerifier({
      secretKey: config.turnstile.secretKey!,
      expectedHostname: new URL(config.appUrl).hostname,
      expectedAction: TURNSTILE_ACTION,
      now,
      ...deps.turnstile,
    });
    gate = new AnonymousGate({
      db: deps.db,
      trials,
      turnstile,
      identitySecret: policy.secrets.identity,
      siteKey: config.turnstile.siteKey!,
      now,
    });
  }
  return { startup, policy, trials, gate, now, problems };
}
