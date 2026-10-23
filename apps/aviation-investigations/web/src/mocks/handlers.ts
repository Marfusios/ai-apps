/**
 * MSW handlers for the public API, answered from the fixture-built mock files in
 * `web/mock/` (scripts/build-mock-api.ts). Used by the dev mock mode
 * (`WEB_MOCK_API=1`), the component tests and the end-to-end tests. Never part of
 * a production bundle.
 *
 * AI briefs (`/api/briefs*`) are answered by an in-memory `MockBriefs` per handler set
 * (web/mock/briefs.ts): request bodies are validated with the real contracts, and a
 * running step moves one checklist row per poll. The AI status is kept per handler set
 * too, like the server's gate: an anonymous request needs a Turnstile token, a started
 * search uses one of the visitor's searches, and the trial is `started` after the first
 * accepted request. `/api/config` offers Cloudflare's documented test site key.
 */
import { delay, http, HttpResponse } from 'msw';
import type { AiStatusResponse } from '../../../shared/contracts/ai';
import type { CaseDetail } from '../../../shared/contracts/cases';
import { CreateBriefRequestSchema, RefinementRequestSchema } from '../../../shared/contracts/briefs';
import { DeleteAccountRequestSchema, SignInRequestSchema, type AccountResponse } from '../../../shared/contracts/account';
import type { ErrorResponse } from '../../../shared/contracts/common';
import { SearchRequestSchema, paramsToQuery } from '../../../shared/contracts/search';
import cases from '../../mock/cases.json';
import config from '../../mock/config.json';
import dashboardAll from '../../mock/dashboard-all.json';
import dashboardDefault from '../../mock/dashboard-default.json';
import index from '../../mock/search-index.json';
import { AI_STATUS_SAMPLES } from '../../mock/ai-status';
import { MockBriefs, type MockReply } from '../../mock/briefs';
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
}

/** The mock's Google account: synthetic. */
export const MOCK_USER = { name: 'Alex Example', email: 'alex@example.com' } as const;

/** This tab's mock sign-in: kept across the reload that coming back from "Google" causes. */
const MOCK_ACCOUNT_KEY = 'casebook-mock-account';

interface MockAccountState {
  signedIn: boolean;
  /** The account exists (its next sign-in is not a first one). */
  registered: boolean;
}

function loadAccountState(): MockAccountState {
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(MOCK_ACCOUNT_KEY) ?? 'null') as Partial<MockAccountState> | null;
    return { signedIn: raw?.signedIn === true, registered: raw?.registered === true };
  } catch {
    return { signedIn: false, registered: false };
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
}: HandlerOptions = {}) {
  const wait = async (): Promise<void> => {
    if (latencyMs > 0) await delay(latencyMs);
  };
  const briefs = new MockBriefs(briefPolls === undefined ? {} : { pollsToFinish: briefPolls });
  let signIn: MockAccountState = googleEnabled ? loadAccountState() : { signedIn: false, registered: false };
  let status: AiStatusResponse = signIn.signedIn ? AI_STATUS_SAMPLES.newAccount : aiStatus;
  const notFound = () => HttpResponse.json({ error: 'not_found', message: 'Not found.' } satisfies ErrorResponse, { status: 404, headers: NO_STORE });
  const setSignIn = (next: MockAccountState): void => {
    signIn = next;
    saveAccountState(next);
  };

  /** The anonymous gate and admission, before any work (server/identity/gate.ts, DESIGN §8). */
  const refuse = (token: string | null | undefined): Response | null => {
    const deny = (code: number, err: ErrorResponse['error'], message: string) =>
      HttpResponse.json({ error: err, message } satisfies ErrorResponse, { status: code, headers: NO_STORE });
    if (status.state === 'paused') return deny(503, 'ai_paused', 'AI search is paused.');
    if (status.state === 'signed_in_only' && status.remaining?.kind !== 'account') {
      if (status.reason === 'trial_used') return deny(429, 'trial_used', 'Your free AI searches are used up.');
      if (status.reason === 'login_required') return deny(403, 'sign_in_required', 'Sign in to use the AI.');
      return deny(429, 'free_searches_paused', "Today's free AI searches are used up.");
    }
    if (status.remaining?.kind === 'trial' && !token) return deny(403, 'challenge_required', 'Take the check, then try again.');
    return null;
  };
  /** An accepted request: the trial has started; a running search uses one. */
  const admitted = (started: boolean): void => {
    const r = status.remaining;
    if (r?.kind === 'trial') {
      const remaining = { ...r, left: started ? Math.max(0, r.left - 1) : r.left, started: true };
      status = remaining.left === 0 ? { state: 'signed_in_only', reason: 'trial_used', remaining } : { state: 'available', remaining };
    } else if (r?.kind === 'account' && started) {
      status = { state: 'available', remaining: { ...r, leftToday: Math.max(0, r.leftToday - 1), leftThisMonth: Math.max(0, r.leftThisMonth - 1) } };
    }
  };
  const admit = <T,>(reply: MockReply<T>): Response => {
    if (reply.status < 300 && !reply.replayed) admitted(reply.status === 202);
    // The server may have acted, but the answer never arrives.
    if (reply.lost) return HttpResponse.error();
    return briefReply(reply);
  };
  return [
    http.get('*/api/config', async () => {
      await wait();
      return HttpResponse.json({ ...config, turnstileSiteKey, googleEnabled });
    }),
    http.get('*/api/account', async () => {
      await wait();
      const body: AccountResponse = signIn.signedIn ? { signedIn: true, user: { ...MOCK_USER } } : { signedIn: false };
      return HttpResponse.json(body, { headers: NO_STORE });
    }),
    http.post('*/api/auth/sign-in/social', async ({ request }) => {
      await wait();
      if (!googleEnabled) return notFound();
      const parsed = SignInRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return badRequest(parsed.error.issues);
      // As if Google sent the browser straight back: a new account gets the welcome.
      const url = signIn.registered ? parsed.data.callbackURL : parsed.data.newUserCallbackURL;
      setSignIn({ signedIn: true, registered: true });
      status = AI_STATUS_SAMPLES.newAccount;
      return HttpResponse.json({ url, redirect: false }, { headers: NO_STORE });
    }),
    http.post('*/api/auth/sign-out', async () => {
      await wait();
      if (!googleEnabled) return notFound();
      setSignIn({ ...signIn, signedIn: false });
      status = aiStatus;
      return HttpResponse.json({ success: true }, { headers: NO_STORE });
    }),
    http.post('*/api/account/delete', async ({ request }) => {
      await wait();
      if (!googleEnabled) return notFound();
      const parsed = DeleteAccountRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return badRequest(parsed.error.issues);
      if (!signIn.signedIn) return HttpResponse.json({ error: 'sign_in_required', message: 'Sign in to delete your account.' } satisfies ErrorResponse, { status: 403, headers: NO_STORE });
      setSignIn({ signedIn: false, registered: false });
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
    http.post('*/api/briefs', async ({ request }) => {
      await wait();
      const parsed = CreateBriefRequestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return badRequest(parsed.error.issues);
      return refuse(parsed.data.turnstileToken) ?? admit(briefs.create(parsed.data));
    }),
    http.post('*/api/briefs/:id/refine', async ({ request, params }) => {
      await wait();
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
