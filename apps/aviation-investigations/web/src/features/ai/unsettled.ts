/**
 * Idempotency keys of AI requests whose outcome is not known yet (on their way) or never
 * became known (the answer never arrived), kept for this tab so that the same request, sent
 * again from any Ask AI or Refine control, from any page and after a reload, replays the
 * key instead of paying a second time (DESIGN §8).
 *
 * - **Write-ahead** (Task 22 review W-2): a key is remembered right before its request
 *   leaves, not after it failed. The server answers a paid request only once its scope
 *   stage is done (seconds), and a reload or Back in that window must not lose a key the
 *   server may already have admitted. Closing the tab does lose it: the key lives in the
 *   tab's session storage, which goes with the tab.
 * - **The same request** is the normalised request the server hashes for idempotency
 *   (server/briefs/intent.ts `createRequestHash` and `refineRequestHash`): a create's
 *   question and canonical filters, or a refinement's brief and change.
 * - **Storage** is `sessionStorage` (this tab only, gone when it closes), under a hash of
 *   that normalised request, so no question text is stored. Every access is wrapped:
 *   when storage is unavailable or refuses a write, the entry lives in memory instead.
 * - **Lifetime:** an entry is cleared once the page has taken over from a 2xx
 *   (`settleOnArrival`, `arrived`: for a new brief when the brief page, a lazy route that may
 *   still be loading after the answer, is on screen for it; for a refinement when the page
 *   shows the step it started; until then a reload or a second ask replays the key), by the
 *   409 swap (the earlier attempt never completed) and by a known refusal of its first send
 *   (nothing was admitted); it expires with the server's idempotency record, 24 hours after it
 *   was first remembered (server/quota/policy.ts `IDEMPOTENCY_TTL_MS`). Signing out or
 *   deleting the account clears them all (`forgetAllUnsettled`).
 */
import type { BriefFilterFacet, BriefFilters, RefinementChange } from '../../../../shared/contracts/briefs';
import { FACET_VALUES } from '../../../../shared/contracts/search';

/**
 * `BRIEF_FILTER_FACETS`, in its order. Listed here so the home page does not load the brief
 * contracts (they arrive with the first AI request); a test holds the two lists together.
 */
export const FILTER_FACETS = ['phase', 'injury', 'conditions', 'light', 'category', 'engine', 'far_part', 'purpose', 'state'] as const satisfies readonly BriefFilterFacet[];

/** The server keeps an idempotency record this long (server/quota/policy.ts `IDEMPOTENCY_TTL_MS`). */
export const UNSETTLED_TTL_MS = 24 * 60 * 60_000;

const PREFIX = 'casebook-ai-unsettled:';
const KEY_SHAPE = /^[A-Za-z0-9_-]{8,128}$/;

export type AiRequestShape =
  | { kind: 'create'; question: string; filters?: BriefFilters | undefined }
  | { kind: 'refine'; briefId: string; change: RefinementChange };

/**
 * Filters as the server hashes them (server/briefs/intent.ts `canonicalFilters`): facets in
 * a fixed order, values in vocabulary order, empty facets dropped, years kept.
 */
export function canonicalFilters(f: BriefFilters): BriefFilters {
  const out: Record<string, unknown> = {};
  for (const facet of FILTER_FACETS) {
    const values = f[facet] as readonly string[] | undefined;
    if (!values || values.length === 0) continue;
    out[facet] = (FACET_VALUES[facet] as readonly string[]).filter((v) => values.includes(v));
  }
  if (f.yearFrom !== undefined) out.yearFrom = f.yearFrom;
  if (f.yearTo !== undefined) out.yearTo = f.yearTo;
  return out as BriefFilters;
}

/** What makes two requests the same for the server's idempotency check. */
export function normalisedRequest(r: AiRequestShape): unknown {
  if (r.kind === 'create') return { op: 'brief.create', question: r.question, filters: canonicalFilters(r.filters ?? {}) };
  const change = r.change.kind === 'filters' ? { ...r.change, filters: canonicalFilters(r.change.filters) } : r.change;
  return { op: 'brief.refine', briefId: r.briefId, change };
}

/** JSON with object keys sorted, so equal requests give equal text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** FNV-1a, 64 bits: only where Web Crypto is missing (a page served over plain HTTP). */
function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** The storage id of a request: a hash of its normalised form, never the question itself. */
export async function unsettledId(r: AiRequestShape): Promise<string> {
  const text = canonicalJson(normalisedRequest(r));
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fnv1a64(text);
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return fnv1a64(text);
  }
}

interface Entry {
  key: string;
  /** When the key was first remembered (ms since the epoch). */
  at: number;
}

/** The fallback when sessionStorage is unavailable or refuses a write. */
const memory = new Map<string, Entry>();

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): Entry | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<Entry>;
    return typeof v.key === 'string' && KEY_SHAPE.test(v.key) && typeof v.at === 'number' && Number.isFinite(v.at) ? { key: v.key, at: v.at } : null;
  } catch {
    return null;
  }
}

function read(id: string): Entry | null {
  try {
    const stored = parse(session()?.getItem(PREFIX + id) ?? null);
    if (stored) return stored;
  } catch {
    // Unavailable: memory below.
  }
  return memory.get(id) ?? null;
}

function write(id: string, entry: Entry): void {
  memory.set(id, entry);
  try {
    session()?.setItem(PREFIX + id, JSON.stringify(entry));
  } catch {
    // Kept in memory for this page.
  }
}

function remove(id: string): void {
  memory.delete(id);
  try {
    session()?.removeItem(PREFIX + id);
  } catch {
    // Nothing stored there.
  }
}

/** Drops expired entries (both places). */
function prune(now: number): void {
  for (const [id, e] of memory) if (now - e.at >= UNSETTLED_TTL_MS) memory.delete(id);
  try {
    const store = session();
    if (!store) return;
    const ids: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const name = store.key(i);
      if (name?.startsWith(PREFIX)) ids.push(name.slice(PREFIX.length));
    }
    for (const id of ids) {
      const e = parse(store.getItem(PREFIX + id));
      if (!e || now - e.at >= UNSETTLED_TTL_MS) store.removeItem(PREFIX + id);
    }
  } catch {
    // Unavailable.
  }
}

/** The key to replay for this request, if its outcome is still unknown and not expired. */
export function unsettledKey(id: string, now: number = Date.now()): string | null {
  const e = read(id);
  if (!e) return null;
  if (now - e.at >= UNSETTLED_TTL_MS || e.at > now + 60_000) {
    remove(id);
    return null;
  }
  return e.key;
}

/**
 * Remembers a key whose outcome is not known: right before its request is sent, and again
 * when no answer came back. A key remembered again keeps its first time.
 */
export function rememberUnsettled(id: string, key: string, now: number = Date.now()): void {
  const earlier = read(id);
  write(id, { key, at: earlier && earlier.key === key ? earlier.at : now });
  prune(now);
}

/**
 * Settled: a 2xx, the 409 swap (the earlier attempt never completed), or a known refusal of
 * a first send. With `key`, only that key's entry goes: another control may have sent the
 * same request under its own key meanwhile, and its entry stays.
 */
export function forgetUnsettled(id: string, key?: string): void {
  if (key !== undefined && read(id)?.key !== key) return;
  remove(id);
}

/**
 * Keys whose request was answered with a 2xx, waiting for the page to take over, by brief
 * (memory only: after a reload the entry stays in storage, and the next same request
 * replays it). `step`: `'page'` for a new brief (the brief page, a lazy route that may still
 * be loading after the answer, is on screen for it), or the step a refinement started (the
 * page shows that step).
 */
const arriving = new Map<string, { id: string; key: string; step: number | 'page' }[]>();

/** What the brief page shows now (`arrived`, `departed`): a 2xx for what is already on screen settles at once. */
let onScreen: { briefId: string; step: number | null } | null = null;

/**
 * A 2xx answered a request for brief `briefId`: its key is settled when the page takes over
 * (`arrived`), not before, so a second ask in that gap replays the key rather than start
 * (and pay for) another. A 2xx for what the page already shows (a replay answered with the
 * step on screen, after a lost response and a reload) settles at once: nothing more will
 * arrive for it (re-review F-1).
 */
export function settleOnArrival(briefId: string, step: number | 'page', id: string, key: string): void {
  if (onScreen?.briefId === briefId && (step === 'page' || onScreen.step === step)) {
    forgetUnsettled(id, key);
    return;
  }
  arriving.set(briefId, [...(arriving.get(briefId) ?? []), { id, key, step }]);
}

/** The brief page no longer shows step `step` of brief `briefId` (it moved on, or left). */
export function departed(briefId: string, step: number | null): void {
  if (onScreen?.briefId === briefId && onScreen.step === step) onScreen = null;
}

/**
 * The brief page is on screen for brief `briefId`, showing step `step` once read: keys
 * waiting for that are settled (each under its own key only).
 */
export function arrived(briefId: string, step: number | null): void {
  onScreen = { briefId, step };
  const waiting = arriving.get(briefId);
  if (!waiting) return;
  const rest = waiting.filter((w) => {
    if (w.step !== 'page' && w.step !== step) return true;
    forgetUnsettled(w.id, w.key);
    return false;
  });
  if (rest.length > 0) arriving.set(briefId, rest);
  else arriving.delete(briefId);
}

/** Test hook: forget every entry, in memory and in this tab's storage. */
export function resetUnsettledForTests(): void {
  forgetAllUnsettled();
}

/** Test hook: what a reload does here: memory goes (the fallback, the 2xx waiting for their step), this tab's storage stays. */
export function forgetUnsettledMemoryForTests(): void {
  memory.clear();
  arriving.clear();
  onScreen = null;
}

/** Forget every entry, in memory and in this tab's storage (the visitor changed: web/src/features/auth/visitor.ts). */
export function forgetAllUnsettled(): void {
  memory.clear();
  arriving.clear();
  try {
    const store = session();
    if (!store) return;
    const names: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const name = store.key(i);
      if (name?.startsWith(PREFIX)) names.push(name);
    }
    for (const name of names) store.removeItem(name);
  } catch {
    // Unavailable.
  }
}
