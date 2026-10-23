import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { TURNSTILE_ACTION } from '../../../../shared/contracts/ai';
import { configQuery } from '../../api';
import { onVisitorChange } from '../auth/visitor';
import { Button } from '../../components/Button';
import { cx } from '../../lib/cx';
import { useTheme } from '../../theme';

/**
 * Cloudflare Turnstile for AI requests (UI_DESIGN §5, DESIGN §8). Every anonymous AI
 * request, refinements and retries included, needs a fresh single-use token, and so does a
 * signed-in one the server asks to check (its AI status says `check: true`, or it refuses
 * with `challenge_required`: "Extra check, signed in"). Each check renders a new widget and
 * removes it as soon as its token is taken:
 *
 * - The first request of a trial identity (AI status `started: false`) opens the panel
 *   "Quick check before your first AI search" with the explanation and a visible widget.
 * - Later requests run the widget invisibly (`interaction-only`) at click time while the
 *   button reads "Checking…"; only if Cloudflare asks for interaction does the panel
 *   appear, titled "Quick check before this AI search".
 * - Each request holds a session (`useAiCheck().session()`). Sessions take turns: a second
 *   control waits ("Checking…") until the first request is over, and ending a session
 *   only ever removes its own widget. After any refusal the session is released and the
 *   next request starts from a new widget.
 *
 * The site key comes from `/api/config` (`turnstileSiteKey`); the mock API answers with
 * Cloudflare's documented test key. The script is loaded only when an AI request needs it.
 */

export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
export const FIRST_CHECK_TITLE = 'Quick check before your first AI search';
export const FIRST_CHECK_TEXT = 'Up to three free AI searches, subject to daily availability. Search, cases and comparisons never need this.';
export const LATER_CHECK_TITLE = 'Quick check before this AI search';
export const LATER_CHECK_TEXT = 'Search, cases and comparisons never need this.';
/** An invisible check that has not finished by then is shown, so nobody waits on nothing. */
const SHOW_SLOW_CHECK_MS = 8_000;

interface TurnstileParams {
  sitekey: string;
  action: string;
  theme: 'light' | 'dark';
  appearance: 'always' | 'interaction-only';
  /** `compact` (150×140) keeps the widget inside the panel on narrow phones. */
  size: 'normal' | 'compact';
  callback: (token: string) => void;
  'error-callback': () => boolean;
  'expired-callback': () => void;
  'timeout-callback': () => void;
  'unsupported-callback': () => void;
  'before-interactive-callback': () => void;
}

export interface TurnstileApi {
  render(container: HTMLElement, params: TurnstileParams): string | null | undefined;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** Loads Cloudflare's script once (explicit rendering). A page may provide `window.turnstile` itself. */
export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new AiCheckError('unavailable')));
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new AiCheckError('unavailable'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export type AiCheckFailure = 'unavailable' | 'failed' | 'cancelled';

export class AiCheckError extends Error {
  readonly reason: AiCheckFailure;
  constructor(reason: AiCheckFailure) {
    super(`AI check ${reason}`);
    this.name = 'AiCheckError';
    this.reason = reason;
  }
}

export interface TokenOptions {
  /** The trial identity has not passed a check yet: show the first-check explanation. */
  first: boolean;
  /** Show the widget in the panel from the start (a retry after a refused token). */
  visible?: boolean;
}

/** One AI request's use of the gate. */
export interface AiCheckSession {
  /**
   * A fresh single-use token. Waits first while another request holds the gate. Rejects
   * with `AiCheckError` (`cancelled` when the reader cancels or the session ended).
   */
  token(options: TokenOptions): Promise<string>;
  /** Ends this session: removes its widget, cancels its pending check, lets the next one in. */
  release(): void;
}

export interface AiCheck {
  session(): AiCheckSession;
}

const AiCheckContext = createContext<AiCheck | null>(null);

export function useAiCheck(): AiCheck {
  const check = useContext(AiCheckContext);
  if (!check) throw new Error('useAiCheck needs a <TurnstileGate>');
  return check;
}

type Mode = null | 'first' | 'later';

interface Pending {
  owner: object;
  resolve: (token: string) => void;
  reject: (err: AiCheckError) => void;
}

export function TurnstileGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const config = useQuery(configQuery());
  const [theme] = useTheme();
  const [mode, setMode] = useState<Mode>(null);
  const panel = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const widget = useRef<{ id: string; host: HTMLElement; owner: object } | null>(null);
  const pending = useRef<Pending | null>(null);
  const slowTimer = useRef<number | undefined>(undefined);
  const opener = useRef<HTMLElement | null>(null);
  // Sessions take turns: each waits for the one before it to be released.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef({ config: config.data, theme });
  latest.current = { config: config.data, theme };
  const titleId = useId();

  /** Removes `owner`'s widget (any widget when `owner` is null). */
  const removeWidget = useCallback((owner: object | null) => {
    const w = widget.current;
    if (!w || (owner !== null && w.owner !== owner)) return;
    window.clearTimeout(slowTimer.current);
    widget.current = null;
    try {
      window.turnstile?.remove(w.id);
    } catch {
      // Already gone.
    }
    w.host.remove();
  }, []);

  /** Settles `owner`'s pending check (any pending check when `owner` is null). */
  const settle = useCallback((owner: object | null, outcome: { token: string } | { error: AiCheckError }) => {
    const p = pending.current;
    if (!p || (owner !== null && p.owner !== owner)) return;
    pending.current = null;
    setMode(null);
    window.clearTimeout(slowTimer.current);
    if ('token' in outcome) p.resolve(outcome.token);
    else p.reject(outcome.error);
  }, []);

  /** The reader cancelled the check in the panel (Cancel or Esc). */
  const cancelCurrent = useCallback(() => {
    const owner = pending.current?.owner ?? widget.current?.owner ?? null;
    if (owner === null) {
      setMode(null);
      return;
    }
    settle(owner, { error: new AiCheckError('cancelled') });
    removeWidget(owner);
  }, [removeWidget, settle]);

  const render = useCallback(
    async (owner: object, { first, visible = false }: TokenOptions): Promise<string> => {
      const siteKey = (latest.current.config ?? (await queryClient.fetchQuery(configQuery()))).turnstileSiteKey;
      if (!siteKey) throw new AiCheckError('unavailable');
      const api = await loadTurnstile();
      removeWidget(owner);
      const host = document.createElement('div');
      container.current?.appendChild(host);
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body && !panel.current?.contains(active) ? active : null;
      const shown = first || visible;
      if (shown) setMode(first ? 'first' : 'later');
      return new Promise<string>((resolve, reject) => {
        pending.current = { owner, resolve, reject };
        const fail = (reason: AiCheckFailure) => () => {
          settle(owner, { error: new AiCheckError(reason) });
          removeWidget(owner);
        };
        try {
          const id = api.render(host, {
            sitekey: siteKey,
            action: TURNSTILE_ACTION,
            theme: latest.current.theme === 'night' ? 'dark' : 'light',
            appearance: shown ? 'always' : 'interaction-only',
            size: window.innerWidth < 380 ? 'compact' : 'normal',
            callback: (t) => {
              settle(owner, { token: t });
              // The token is taken: this widget has done its one job.
              removeWidget(owner);
            },
            'error-callback': () => {
              fail('failed')();
              return true;
            },
            'expired-callback': fail('failed'),
            'timeout-callback': fail('failed'),
            'unsupported-callback': fail('unavailable'),
            'before-interactive-callback': () => setMode((m) => m ?? 'later'),
          });
          if (!id) throw new Error('no widget');
          widget.current = { id, host, owner };
        } catch {
          host.remove();
          settle(owner, { error: new AiCheckError('unavailable') });
          return;
        }
        if (!shown) slowTimer.current = window.setTimeout(() => setMode((m) => m ?? 'later'), SHOW_SLOW_CHECK_MS);
      });
    },
    [queryClient, removeWidget, settle],
  );

  const session = useCallback((): AiCheckSession => {
    const owner = {};
    let unlock: (() => void) | null = null;
    let turn: Promise<void> | null = null;
    let ended = false;
    // Released while still waiting: stop waiting at once.
    let markEnded: () => void = () => {};
    const endedSignal = new Promise<void>((resolve) => {
      markEnded = resolve;
    });
    /** Joins the queue once: our turn comes when the session before us is released. */
    const take = (): Promise<void> => {
      if (!turn) {
        let done: () => void = () => {};
        const mine = new Promise<void>((resolve) => {
          done = resolve;
        });
        const before = queue.current;
        // Whoever comes next waits for the session before us and for us.
        queue.current = before.then(() => mine);
        unlock = done;
        turn = before;
      }
      return turn;
    };
    return {
      async token(options) {
        await Promise.race([take(), endedSignal]);
        if (ended) throw new AiCheckError('cancelled');
        return render(owner, options);
      },
      release() {
        if (ended) return;
        ended = true;
        markEnded();
        settle(owner, { error: new AiCheckError('cancelled') });
        removeWidget(owner);
        unlock?.();
      },
    };
  }, [removeWidget, render, settle]);

  // Focus moves to the panel when it opens and returns to the control that asked.
  useEffect(() => {
    if (mode) {
      heading.current?.focus();
      return;
    }
    const active = document.activeElement;
    const inPanel = active instanceof HTMLElement && panel.current?.contains(active) === true;
    if (!inPanel && active !== document.body && active !== null) return;
    const back = opener.current;
    if (back?.isConnected) back.focus();
    // Nothing to return to: never leave focus inside the hidden panel.
    else if (inPanel) active.blur();
  }, [mode]);

  useEffect(() => () => removeWidget(null), [removeWidget]);

  // A check still open when the visitor changes (signed out or deleted, here or in another
  // tab) was for the previous visitor: it is cancelled, and its request sends nothing.
  useEffect(() => onVisitorChange(cancelCurrent), [cancelCurrent]);

  const value = useMemo<AiCheck>(() => ({ session }), [session]);
  const open = mode !== null;

  return (
    <AiCheckContext.Provider value={value}>
      {children}
      <div
        ref={panel}
        data-print="hide"
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-hidden={!open}
        inert={!open}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) cancelCurrent();
        }}
        className={cx(
          open
            ? 'card fixed inset-x-4 bottom-4 z-[60] mx-auto max-w-[420px] border-l-4 border-l-blue px-4 py-3.5 shadow-sheet sm:bottom-8'
            : 'pointer-events-none fixed top-0 -left-[10000px] w-[320px] opacity-0',
        )}
      >
        <h2 ref={heading} id={titleId} tabIndex={-1} className="font-serif text-[18px] leading-tight font-semibold outline-none">
          {mode === 'first' ? FIRST_CHECK_TITLE : LATER_CHECK_TITLE}
        </h2>
        <p className="mt-1 text-ui">{mode === 'first' ? FIRST_CHECK_TEXT : LATER_CHECK_TEXT}</p>
        <div ref={container} className="mt-2.5 min-h-[65px]" />
        <div className="mt-1 flex justify-end">
          <Button variant="ghost" size="sm" onClick={cancelCurrent}>
            Cancel
          </Button>
        </div>
      </div>
    </AiCheckContext.Provider>
  );
}
