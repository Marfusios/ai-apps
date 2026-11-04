/**
 * MSW handlers for the public API, answered from the fixture-built mock files in
 * `web/mock/` (scripts/build-mock-api.ts). Used by the dev mock mode
 * (`WEB_MOCK_API=1`), the component tests and the end-to-end tests. Never part of
 * a production bundle.
 *
 * AI evidence searches (`/api/evidence*`) are answered by an in-memory `MockEvidence` per
 * handler set (web/mock/evidence.ts), standing in for one ranking configuration and
 * automatic-filter policy (`evidence`; by default the one this tab's session storage names
 * under `MOCK_EVIDENCE_CONFIG_KEY`, else the server's defaults), and AI briefs (`/api/briefs*`),
 * which the interface no longer starts but still shows, by a `MockBriefs` (web/mock/briefs.ts):
 * request bodies are validated with the real contracts, and a running brief step moves one
 * checklist row per poll. The AI status is kept per handler set too, like the server's gate: an
 * anonymous request needs a Turnstile token, a search that returns results (or a started brief)
 * uses one of the visitor's searches, a static scope reply uses none, and the trial is `started`
 * after the first accepted request. An evidence search's one free undo uses none either, and is
 * let through when the visitor's own searches are used up (a trial's, or an account's day or
 * month), as a replay is; every other pause still refuses it. `/api/config` offers Cloudflare's
 * documented test site key, the AI limits (`MOCK_AI_LIMITS`) and the fields the evidence policy
 * applies on its own (`aiAutomaticFilters`, the policy's fields in shared/evidence-auto-filter-fields.ts:
 * `['state']` when the mock applies states alone, `['state', 'years', 'category']` with the
 * attributed policy, else none).
 *
 * Task 25: an evidence search's stages are timed like live's (web/mock/evidence-progress.ts, scaled
 * by `evidenceTiming`, or this tab's session storage `MOCK_EVIDENCE_TIMING_KEY`), its POST answered
 * once they are over and its progress read under its idempotency key; the owner can rate a search
 * (`POST /api/evidence/:id/feedback`); and the signed-in mock account can be an admin (`admin`, or
 * session storage `MOCK_ADMIN_KEY`), for whom alone `GET /api/admin/overview` answers
 * (web/mock/admin.ts). Task 26: the overview's automatic importer is in one of five synthetic
 * states (`imports`, or session storage `MOCK_ADMIN_IMPORTS_KEY`; web/mock/imports.ts).
 */
import { delay, http, HttpResponse } from 'msw';
import type { AiStatusResponse } from '../../../shared/contracts/ai';
import type { CaseDetail } from '../../../shared/contracts/cases';
import { CreateBriefRequestSchema, RefinementRequestSchema } from '../../../shared/contracts/briefs';
import type { ConfigResponse } from '../../../shared/contracts/config';
import { CreateEvidenceRequestSchema, EvidenceFeedbackRequestSchema } from '../../../shared/contracts/evidence';
import {
  DELETE_REAUTH_PATH,
  DeleteAccountRequestSchema,
  DeleteStartRequestSchema,
  SignInRequestSchema,
  type AccountResponse,
  type DeleteStartResponse,
} from '../../../shared/contracts/account';
import type { ErrorResponse } from '../../../shared/contracts/common';
import { SearchRequestSchema, paramsToQuery } from '../../../shared/contracts/search';
import cases from '../../mock/cases.json';
import config from '../../mock/config.json';
import dashboardAll from '../../mock/dashboard-all.json';
import dashboardDefault from '../../mock/dashboard-default.json';
import index from '../../mock/search-index.json';
import { AI_STATUS_SAMPLES, MOCK_AI_LIMITS } from '../../mock/ai-status';
import { MockBriefs, type MockReader, type MockReply } from '../../mock/briefs';
import { mockAdminOverview } from '../../mock/admin';
import { parseMockImportState, type MockImportState } from '../../mock/imports';
import { MOCK_EVIDENCE_CONFIG_KEY, MockEvidence, automaticFieldsOf, parseMockEvidenceConfig, type MockEvidenceConfig, type MockEvidenceReply } from '../../mock/evidence';
import { MockEvidenceProgress } from '../../mock/evidence-progress';
import { searchCorpus, type MockCorpus } from '../../mock/engine';

export const mockCorpus: MockCorpus = {
  dataset: index.dataset,
  docs: index.docs as unknown as MockCorpus['docs'],
  cases: cases as unknown as Record<string, CaseDetail>,
};

function error(status: number, body: ErrorResponse): Response {
  return HttpResponse.json(body, { status });
}

export interface HandlerOptions {
  /** Simulated server time per request, so loading states are visible in dev. */
  latencyMs?: number;
  /** What `GET /api/ai/status` answers (default: a fresh anonymous visitor). */
  aiStatus?: AiStatusResponse;
  /** Polls of a running brief step until it is done (default 4: one per checklist row). */
  briefPolls?: number;
  /** The Turnstile site key `/api/config` offers (default: Cloudflare's always-passing test key). */
  turnstileSiteKey?: string | null;
  /** Offer Google sign-in (default false, as the fixture config says). */
  googleEnabled?: boolean;
  /** The AI limits `/api/config` reports (default `MOCK_AI_LIMITS`); null: a server that does not report them. */
  aiLimits?: ConfigResponse['aiLimits'] | null;
  /**
   * Deleting the account asks to confirm with Google first, as for a session older than 5
   * minutes (default false: as right after signing in, it asks only once more).
   */
  deletionNeedsReauth?: boolean;
  /** Signed in, the server asks for a Turnstile check before every AI request (the step-up, DESIGN §8). */
  accountCheck?: boolean;
  /**
   * The evidence ranking configuration and automatic-filter policy the mock stands in for
   * (default: the one this tab's session storage names, else the server's defaults).
   */
  evidence?: MockEvidenceConfig;
  /**
   * What `/api/config` reports as `aiAutomaticFilters` (default: the evidence policy's fields,
   * `['state']` with `state-explicit.v1.3`, `['state', 'years', 'category']` with `attributed.v1`,
   * else none); `null` leaves the field out, as a server that does not report it.
   */
  aiAutomaticFilters?: ConfigResponse['aiAutomaticFilters'] | null;
  /**
   * Scale of the simulated stage times of an AI search (web/mock/evidence-progress.ts): 1 is as long
   * as live takes, 0 answers at once (default 0). This tab's session storage overrides it under
   * `MOCK_EVIDENCE_TIMING_KEY`.
   */
  evidenceTiming?: number;
  /** The signed-in mock account is an admin (`isAdmin`, the admin overview); default: this tab's session storage says so. */
  admin?: boolean;
  /** The automatic importer's state in the admin overview (web/mock/imports.ts); default: this tab's session storage, else `healthy`. */
  imports?: MockImportState;
}

/** The mock's Google account: synthetic, with a fixed application id (`user.id`, the identity the page compares). */
export const MOCK_USER = { id: '0f6e3c1a-7b2d-4e5f-9a8b-1c2d3e4f5a6b', name: 'Alex Example', email: 'alex@example.com' } as const;

/** This tab's mock sign-in: kept across the reload that coming back from "Google" causes. */
const MOCK_ACCOUNT_KEY = 'casebook-mock-account';

/** Set in this tab's session storage (end-to-end tests): deleting asks to confirm with Google first. */
export const MOCK_DELETION_REAUTH_KEY = 'casebook-mock-deletion-reauth';

/**
 * This tab's session storage (dev mock mode, end-to-end tests): the scale of an AI search's simulated
 * stage times, a number (1: as live, 0: at once), over the handlers' own `evidenceTiming`.
 */
export const MOCK_EVIDENCE_TIMING_KEY = 'casebook-mock-evidence-timing';

/** This tab's session storage: `1` makes the signed-in mock account an admin. */
export const MOCK_ADMIN_KEY = 'casebook-mock-admin';

/**
 * This tab's session storage (dev mock mode, end-to-end tests): the automatic importer's state in
 * the admin overview, one of `MOCK_IMPORT_STATES` (`healthy`, `published`, `needs_review`, `overdue`,
 * `disabled`).
 */
export const MOCK_ADMIN_IMPORTS_KEY = 'casebook-mock-admin-imports';

interface MockAccountState {
  signedIn: boolean;
  /** The account exists (its next sign-in is not a first one). */
  registered: boolean;
  /** Until when this tab's session may delete the account (kept across the reload back from "Google"). */
  confirmedUntil?: string | null;
}

function loadAccountState(): MockAccountState {
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(MOCK_ACCOUNT_KEY) ?? 'null') as Partial<MockAccountState> | null;
    return {
      signedIn: raw?.signedIn === true,
      registered: raw?.registered === true,
      confirmedUntil: typeof raw?.confirmedUntil === 'string' ? raw.confirmedUntil : null,
    };
  } catch {
    return { signedIn: false, registered: false };
  }
}

function deletionReauthFlag(): boolean {
  try {
    return window.sessionStorage.getItem(MOCK_DELETION_REAUTH_KEY) === '1';
  } catch {
    return false;
  }
}

/** The stage-time scale this tab's session storage names, or null (none, or not a number from 0 to 10). */
export function evidenceTimingFlag(): number | null {
  try {
    const raw = window.sessionStorage.getItem(MOCK_EVIDENCE_TIMING_KEY);
    const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 10 ? n : null;
  } catch {
    return null;
  }
}

function adminFlag(): boolean {
  try {
    return window.sessionStorage.getItem(MOCK_ADMIN_KEY) === '1';
  } catch {
    return false;
  }
}

function importsFlag(): MockImportState {
  try {
    return parseMockImportState(window.sessionStorage.getItem(MOCK_ADMIN_IMPORTS_KEY));
  } catch {
    return 'healthy';
  }
}

/** The evidence configuration this tab's session storage names (end-to-end tests, the dev mock mode), else the baseline. */
function evidenceConfigFlag(): MockEvidenceConfig {
  try {
    return parseMockEvidenceConfig(window.sessionStorage.getItem(MOCK_EVIDENCE_CONFIG_KEY));
  } catch {
    return parseMockEvidenceConfig(null);
  }
}

function saveAccountState(state: MockAccountState): void {
  try {
    window.sessionStorage.setItem(MOCK_ACCOUNT_KEY, JSON.stringify(state));
  } catch {
    // Kept for this page only.
  }
}

/**
 * Cloudflare's documented Turnstile test site key that always passes (a visible widget).
 * Public and for development and tests only; the real key comes from the server's config.
 */
export const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';

const NO_STORE = { 'cache-control': 'private, no-store' };

function briefReply<T>(r: MockReply<T>): Response {
  if (r.status === 204) return new HttpResponse(null, { status: 204, headers: NO_STORE });
  return HttpResponse.json(r.body as Record<string, unknown>, { status: r.status, headers: NO_STORE });
}

function badRequest(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Response {
  return HttpResponse.json(
    {
      error: 'bad_request',
      message: 'The request is not valid.',
      issues: issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join('.') || '(body)', message: i.message })),
    } satisfies ErrorResponse,
    { status: 400, headers: NO_STORE },
  );
}

export function createHandlers({
  latencyMs = 0,
  aiStatus = AI_STATUS_SAMPLES.fresh,
  briefPolls,
  turnstileSiteKey = TURNSTILE_TEST_SITE_KEY,
  googleEnabled = false,
  aiLimits = MOCK_AI_LIMITS,
  deletionNeedsReauth = deletionReauthFlag(),
  accountCheck = false,
  evidence: evidenceConfig = evidenceConfigFlag(),
  aiAutomaticFilters = automaticFieldsOf(evidenceConfig.autoFilters),
  evidenceTiming = 0,
  admin = adminFlag(),
  imports = importsFlag(),
}: HandlerOptions = {}) {
  const wait = async (): Promise<void> => {
    if (latencyMs > 0) await delay(latencyMs);
  };
  let signIn: MockAccountState = googleEnabled ? loadAccountState() : { signedIn: false, registered: false };
  /** Until when this tab's session may delete the account (a recent sign-in's confirmation). */
  let confirmedUntil: string | null = signIn.confirmedUntil ?? null;
  const confirmNow = (): string => {
    confirmedUntil = new Date(Date.now() + 5 * 60_000).toISOString();
    setSignIn({ ...signIn, confirmedUntil });
    return confirmedUntil;
  };
  // Briefs are read by their owner: the account while signed in, else this browser's trial.
  const reader = (): MockReader => (signIn.signedIn ? 'account' : 'trial');
  const briefs = new MockBriefs({ ...(briefPolls === undefined ? {} : { pollsToFinish: briefPolls }), visitor: reader });
  // Evidence searches are read by their owner, like briefs; so is their progress, timed like live's.
  const evidence = new MockEvidence({ visitor: reader, config: evidenceConfig });
  const progress = new MockEvidenceProgress({ visitor: reader, ranking: evidenceConfig.ranking, timing: evidenceTimingFlag() ?? evidenceTiming });
  const accountStatus = (): AiStatusResponse => (accountCheck ? AI_STATUS_SAMPLES.checkedAccount : AI_STATUS_SAMPLES.newAccount);
  let status: AiStatusResponse = signIn.signedIn ? accountStatus() : aiStatus;
  const notFound = () => HttpResponse.json({ error: 'not_found', message: 'Not found.' } satisfies ErrorResponse, { status: 404, headers: NO_STORE });
  function setSignIn(next: MockAccountState): void {
    signIn = next;
    saveAccountState(next);
  }

  /**
   * The anonymous gate and admission, before any work (server/identity/gate.ts, DESIGN §8).
   * `exempt`: an evidence search's one free undo (or a replay), which the visitor's own used-up
   * searches do not stop; a pause for everyone, sign-in-only modes and Turnstile still do.
   */
  const refuse = (token: string | null | undefined, exempt = false): Response | null => {
    const deny = (code: number, err: ErrorResponse['error'], message: string) =>
      HttpResponse.json({ error: err, message } satisfies ErrorResponse, { status: code, headers: NO_STORE });
    const ownCap = status.state === 'paused' && (status.reason === 'daily_cap' || status.reason === 'monthly_cap');
    if (status.state === 'paused' && !(exempt && ownCap)) return deny(503, 'ai_paused', 'AI search is paused.');
    if (status.state === 'signed_in_only' && status.remaining?.kind !== 'account') {
      if (status.reason === 'trial_used' && !exempt) return deny(429, 'trial_used', 'Your free AI searches are used up.');
      if (status.reason === 'login_required') return deny(403, 'sign_in_required', 'Sign in to use the AI.');
      if (status.reason !== 'trial_used') return deny(429, 'free_searches_paused', "Today's free AI searches are used up.");
    }
    if (status.remaining?.kind === 'trial' && !token) return deny(403, 'challenge_required', 'Take the check, then try again.');
    // A signed-in request the server flags takes a check too (the step-up).
    if (status.remaining?.kind === 'account' && status.remaining.check && !token) return deny(403, 'challenge_required', 'Take the check, then try again.');
    return null;
  };
  /** An accepted request: the trial has started; a running search uses one. */
  const admitted = (started: boolean): void => {
    const r = status.remaining;
    if (r?.kind === 'trial') {
      const remaining = { ...r, left: started ? Math.max(0, r.left - 1) : r.left, started: true };
      // Today's free searches used: they return at the next 00:00 UTC, as the server says.
      const now = new Date();
      const retryAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
      status = remaining.left === 0 ? { state: 'signed_in_only', reason: 'trial_used', retryAt, remaining } : { state: 'available', remaining };
    } else if (r?.kind === 'account' && started) {
      const remaining = { ...r, leftToday: Math.max(0, r.leftToday - 1), leftThisMonth: Math.max(0, r.leftThisMonth - 1) };
      // An account's own searches used up: paused for it until they return, as the server says.
      const now = new Date();
      if (remaining.leftThisMonth === 0) {
        status = { state: 'paused', reason: 'monthly_cap', retryAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(), remaining };
      } else if (remaining.leftToday === 0) {
        status = { state: 'paused', reason: 'daily_cap', retryAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString(), remaining };
      } else {
        status = { state: 'available', remaining };
      }
    }
  };
  const admit = <T,>(reply: MockReply<T> & Pick<MockEvidenceReply, 'quotaExempt'>): Response => {
    // A started brief (202) or an evidence search (201: always results) uses one, unless it is a
    // search's one free undo; a brief's static reply (200) does not.
    if (reply.status < 300 && !reply.replayed) admitted(reply.status === 202 || (reply.status === 201 && reply.quotaExempt !== true));
    // The server may have acted, but the answer never arrives.
    if (reply.lost) return HttpResponse.error();
    return briefReply(reply);
  };
  return [
    http.get('*/api/config', async () => {
      await wait();
      const { aiAutomaticFilters: _generated, ...generated } = config;
      return HttpResponse.json({ ...generated, turnstileSiteKey, googleEnabled, ...(aiAutomaticFilters ? { aiAutomaticFilters } : {}), ...(aiLimits ? { aiLimits } : {}) });
    }),
    http.get('*/api/account', async () => {
      await wait();
      const live = confirmedUntil !== null && Date.parse(confirmedUntil) > Date.now() ? { deletionConfirmedUntil: confirmedUntil } : {};
      const body: AccountResponse = signIn.signedIn ? { signedIn: true, user: { ...MOCK_USER }, ...live, ...(admin ? { isAdmin: true } : {}) } : { signedIn: false };
      return HttpResponse.json(body, { headers: NO_STORE });
    }),
    http.post('*/api/auth/sign-in/social', async ({ request }) => {
      await wait();
      if (!googleEnabled) return notFound();
      const parsed = SignInRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return badRequest(parsed.error.issues);
      // Confirming a deletion with Google: the same account signs in again and is confirmed.
      if (parsed.data.callbackURL === DELETE_REAUTH_PATH && signIn.signedIn) {
        confirmNow();
        return HttpResponse.json({ url: parsed.data.callbackURL, redirect: false }, { headers: NO_STORE });
      }
      // As if Google sent the browser straight back: a new account gets the welcome, and a
      // sign-in from a brief or an evidence search takes it over.
      const url = signIn.registered ? parsed.data.callbackURL : parsed.data.newUserCallbackURL;
      const fromBrief = /^\/briefs\/([0-9a-f-]{36})(?:\?|$)/.exec(parsed.data.callbackURL)?.[1];
      if (fromBrief) briefs.handOver(fromBrief);
      const fromSearch = /^\/ai\/([0-9a-f-]{36})(?:\?|$)/.exec(parsed.data.callbackURL)?.[1];
      if (fromSearch) evidence.handOver(fromSearch);
      setSignIn({ signedIn: true, registered: true });
      status = accountStatus();
      return HttpResponse.json({ url, redirect: false }, { headers: NO_STORE });
    }),
    http.post('*/api/auth/sign-out', async () => {
      await wait();
      if (!googleEnabled) return notFound();
      confirmedUntil = null;
      setSignIn({ ...signIn, signedIn: false, confirmedUntil: null });
      status = aiStatus;
      return HttpResponse.json({ success: true }, { headers: NO_STORE });
    }),
    http.post('*/api/account/delete/start', async ({ request }) => {
      await wait();
      if (!googleEnabled) return notFound();
      const parsed = DeleteStartRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return badRequest(parsed.error.issues);
      if (!signIn.signedIn) return HttpResponse.json({ error: 'sign_in_required', message: 'Sign in to delete your account.' } satisfies ErrorResponse, { status: 403, headers: NO_STORE });
      const body: DeleteStartResponse = deletionNeedsReauth ? { next: 'reauthenticate' } : { next: 'confirm', until: confirmNow() };
      return HttpResponse.json(body, { headers: NO_STORE });
    }),
    http.post('*/api/account/delete', async ({ request }) => {
      await wait();
      if (!googleEnabled) return notFound();
      const parsed = DeleteAccountRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return badRequest(parsed.error.issues);
      if (!signIn.signedIn) return HttpResponse.json({ error: 'sign_in_required', message: 'Sign in to delete your account.' } satisfies ErrorResponse, { status: 403, headers: NO_STORE });
      if (confirmedUntil === null || Date.parse(confirmedUntil) <= Date.now()) {
        return HttpResponse.json({ error: 'reauth_required', message: "Confirm with Google that it's you, then delete your account." } satisfies ErrorResponse, { status: 403, headers: NO_STORE });
      }
      briefs.dropAccountBriefs();
      evidence.dropAccountSearches();
      confirmedUntil = null;
      setSignIn({ signedIn: false, registered: false, confirmedUntil: null });
      status = aiStatus;
      return HttpResponse.json({ deleted: true }, { headers: NO_STORE });
    }),
    http.get('*/api/search', async ({ request }) => {
      await wait();
      const parsed = SearchRequestSchema.safeParse(paramsToQuery(new URL(request.url).searchParams));
      if (!parsed.success) {
        return error(400, {
          error: 'bad_request',
          message: 'The search parameters are not valid.',
          issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return HttpResponse.json(searchCorpus(mockCorpus, parsed.data));
    }),
    http.get('*/api/cases/:ntsbNo', async ({ params }) => {
      await wait();
      const ntsbNo = String(params.ntsbNo ?? '');
      const detail = Object.hasOwn(mockCorpus.cases, ntsbNo) ? mockCorpus.cases[ntsbNo] : undefined;
      if (!detail) return error(404, { error: 'not_found', message: 'No investigation has that number.' });
      return HttpResponse.json(detail);
    }),
    http.get('*/api/dashboard', async ({ request }) => {
      await wait();
      const cohort = new URL(request.url).searchParams.get('cohort');
      return HttpResponse.json(cohort === 'all' ? dashboardAll : dashboardDefault);
    }),
    http.get('*/api/ai/status', async () => {
      await wait();
      return HttpResponse.json(status, { headers: { 'cache-control': 'no-store' } });
    }),
    http.post('*/api/evidence', async ({ request }) => {
      await wait();
      const parsed = CreateEvidenceRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return badRequest(parsed.error.issues);
      const refused = refuse(parsed.data.turnstileToken, evidence.quotaExempt(parsed.data));
      if (refused) return refused;
      const reply = evidence.create(parsed.data);
      // Admitted and counted at the start, as the server does; then the answer waits for the stages.
      const response = admit(reply);
      const ms = reply.progress ? progress.start(parsed.data, reply.progress) : 0;
      if (ms > 0) await delay(ms);
      return response;
    }),
    // Before `/api/evidence/:id`: a key, not a search id.
    http.get('*/api/evidence/progress/:key', async ({ params }) => {
      await wait();
      return briefReply(progress.read(String(params.key)));
    }),
    http.post('*/api/evidence/:id/feedback', async ({ request, params }) => {
      await wait();
      const parsed = EvidenceFeedbackRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return badRequest(parsed.error.issues);
      return briefReply(evidence.rate(String(params.id), parsed.data.rating));
    }),
    http.get('*/api/admin/overview', async () => {
      await wait();
      // Only the signed-in admin; everyone else gets the same 404 as a route that does not exist.
      if (!signIn.signedIn || !admin) return notFound();
      return HttpResponse.json(mockAdminOverview({ now: new Date(), evidence: evidenceConfig, ratings: evidence.ratingCounts(), admin: MOCK_USER, imports }), { headers: NO_STORE });
    }),
    http.get('*/api/evidence/:id/cases/:ntsbNo', async ({ params }) => {
      await wait();
      return briefReply(evidence.caseOf(String(params.id), String(params.ntsbNo)));
    }),
    http.get('*/api/evidence/:id', async ({ request, params }) => {
      await wait();
      const page = new URL(request.url).searchParams.get('page');
      return briefReply(evidence.read(String(params.id), page === null ? 1 : Number(page)));
    }),
    http.post('*/api/briefs', async ({ request }) => {
      await wait();
      // Briefs off (the server's AI_BRIEFS_ENABLED): creating or refining one is a 404; reading one still works.
      if (aiLimits?.briefsEnabled === false) return notFound();
      const parsed = CreateBriefRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return badRequest(parsed.error.issues);
      return refuse(parsed.data.turnstileToken) ?? admit(briefs.create(parsed.data));
    }),
    http.post('*/api/briefs/:id/refine', async ({ request, params }) => {
      await wait();
      if (aiLimits?.briefsEnabled === false) return notFound();
      const parsed = RefinementRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return badRequest(parsed.error.issues);
      return refuse(parsed.data.turnstileToken) ?? admit(briefs.refine(String(params.id), parsed.data));
    }),
    http.post('*/api/briefs/:id/cancel', async ({ params }) => {
      await wait();
      return briefReply(briefs.cancel(String(params.id)));
    }),
    http.get('*/api/briefs/:id/steps/:n/cases/:ntsbNo', async ({ params }) => {
      await wait();
      return briefReply(briefs.context(String(params.id), Number(params.n), String(params.ntsbNo)));
    }),
    http.get('*/api/briefs/:id', async ({ request, params }) => {
      await wait();
      const step = new URL(request.url).searchParams.get('step');
      return briefReply(briefs.read(String(params.id), step === null ? undefined : Number(step)));
    }),
  ];
}
