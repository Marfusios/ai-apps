import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { TURNSTILE_ACTION } from '../../../../shared/contracts/ai';
import { configQuery } from '../../api';
import { Button } from '../../components/Button';
import { cx } from '../../lib/cx';
import { useTheme } from '../../theme';

/**
 * Cloudflare Turnstile for anonymous AI requests (UI_DESIGN §5, DESIGN §8). Every
 * anonymous AI request, refinements and retries included, needs a fresh single-use
 * token, so each request renders a new widget and removes it afterwards:
 *
 * - The first request of a trial identity (AI status `started: false`) opens the panel
 *   "Quick check before your first AI search" with the explanation and a visible widget.
 * - Later requests run the widget invisibly (`interaction-only`) at click time while the
 *   button reads "Checking…"; only if Cloudflare asks for interaction does the panel
 *   appear, titled "Quick check before this AI search".
 * - After every request, and always after a refusal of any kind, `reset()` removes the
 *   widget, so no token is ever offered twice.
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

export interface AiCheck {
  /** A fresh single-use token for one anonymous AI request. Rejects with `AiCheckError`. */
  token(options: TokenOptions): Promise<string>;
  /** Removes the widget and any pending check. Call after every request. */
  reset(): void;
}

const AiCheckContext = createContext<AiCheck | null>(null);

export function useAiCheck(): AiCheck {
  const check = useContext(AiCheckContext);
  if (!check) throw new Error('useAiCheck needs a <TurnstileGate>');
  return check;
}

type Mode = null | 'first' | 'later';

interface Pending {
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
  const widget = useRef<{ id: string; host: HTMLElement } | null>(null);
  const pending = useRef<Pending | null>(null);
  const slowTimer = useRef<number | undefined>(undefined);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const removeWidget = useCallback(() => {
    window.clearTimeout(slowTimer.current);
    const w = widget.current;
    widget.current = null;
    if (!w) return;
    try {
      window.turnstile?.remove(w.id);
    } catch {
      // Already gone.
    }
    w.host.remove();
  }, []);

  const settle = useCallback(
    (outcome: { token: string } | { error: AiCheckError }) => {
      const p = pending.current;
      pending.current = null;
      setMode(null);
      window.clearTimeout(slowTimer.current);
      if (!p) return;
      if ('token' in outcome) p.resolve(outcome.token);
      else p.reject(outcome.error);
    },
    [],
  );

  const reset = useCallback(() => {
    if (pending.current) settle({ error: new AiCheckError('cancelled') });
    removeWidget();
    setMode(null);
  }, [removeWidget, settle]);

  const token = useCallback(
    async ({ first, visible = false }: TokenOptions): Promise<string> => {
      reset();
      const siteKey = (config.data ?? (await queryClient.fetchQuery(configQuery()))).turnstileSiteKey;
      if (!siteKey) throw new AiCheckError('unavailable');
      const api = await loadTurnstile();
      const host = document.createElement('div');
      container.current?.appendChild(host);
      opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      const shown = first || visible;
      if (shown) setMode(first ? 'first' : 'later');
      return new Promise<string>((resolve, reject) => {
        pending.current = { resolve, reject };
        const fail = (reason: AiCheckFailure) => () => {
          settle({ error: new AiCheckError(reason) });
          removeWidget();
        };
        try {
          const id = api.render(host, {
            sitekey: siteKey,
            action: TURNSTILE_ACTION,
            theme: theme === 'night' ? 'dark' : 'light',
            appearance: shown ? 'always' : 'interaction-only',
            size: window.innerWidth < 380 ? 'compact' : 'normal',
            callback: (t) => settle({ token: t }),
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
          widget.current = { id, host };
        } catch {
          host.remove();
          settle({ error: new AiCheckError('unavailable') });
          return;
        }
        if (!shown) slowTimer.current = window.setTimeout(() => setMode((m) => m ?? 'later'), SHOW_SLOW_CHECK_MS);
      });
    },
    [config.data, queryClient, removeWidget, reset, settle, theme],
  );

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

  useEffect(() => () => removeWidget(), [removeWidget]);

  const value = useMemo<AiCheck>(() => ({ token, reset }), [token, reset]);
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
          if (event.key === 'Escape' && open) reset();
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
          <Button variant="ghost" size="sm" onClick={reset}>
            Cancel
          </Button>
        </div>
      </div>
    </AiCheckContext.Provider>
  );
}
