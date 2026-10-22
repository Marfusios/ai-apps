/**
 * Day/Night theme (UI_DESIGN §2.8). The theme follows `prefers-color-scheme` until
 * the user chooses one; the choice is then kept in `localStorage` on this device.
 * Storage can be unavailable (privacy modes, blocked cookies), so every read and
 * write is wrapped in try/catch and a failed write still holds for this page.
 *
 * The inline script in web/index.html applies the same rule before first paint;
 * keep THEME_STORAGE_KEY and the values in step with it.
 */
import { useCallback, useSyncExternalStore } from 'react';

export type Theme = 'day' | 'night';

export const THEMES: readonly Theme[] = ['day', 'night'];
export const THEME_STORAGE_KEY = 'casebook-theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';
const listeners = new Set<() => void>();
let chosenThisPage = false;

function isTheme(value: unknown): value is Theme {
  return value === 'day' || value === 'night';
}

export function readStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Not persisted; the choice still applies until the page is closed.
  }
}

function darkQuery(): MediaQueryList | null {
  try {
    return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  return darkQuery()?.matches ? 'night' : 'day';
}

/** The theme currently on `<html>`. */
export function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'night' ? 'night' : 'day';
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  for (const listener of listeners) listener();
}

/** The user's explicit choice: applied now and remembered on this device. */
export function chooseTheme(theme: Theme): void {
  chosenThisPage = true;
  storeTheme(theme);
  applyTheme(theme);
}

/**
 * Applies the stored or system theme and follows system changes until the user
 * chooses. Returns a function that stops following.
 */
export function initTheme(): () => void {
  applyTheme(readStoredTheme() ?? systemTheme());
  const query = darkQuery();
  if (!query) return () => {};
  const onChange = (): void => {
    if (!chosenThisPage && readStoredTheme() === null) applyTheme(systemTheme());
  };
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current theme and a setter that records the user's choice. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => 'day' as const);
  const set = useCallback((next: Theme) => chooseTheme(next), []);
  return [theme, set];
}

/** Test hook: forget an in-page choice. */
export function resetThemeChoiceForTests(): void {
  chosenThisPage = false;
}
