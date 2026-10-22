import { vi } from 'vitest';

/** The block of declarations for an exact selector list, e.g. `[data-theme="night"]`. */
export function cssBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`No CSS block for ${selector}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`Unclosed CSS block for ${selector}`);
}

/** Value of a custom property declared in a CSS block. */
export function cssVar(block: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[\\s;{])--${name}:\\s*([^;]+);`).exec(block);
  return match?.[1]?.trim();
}

/** jsdom has no matchMedia; this stub reports `dark` and can flip it. */
export function stubColorScheme(dark: boolean): { set(dark: boolean): void } {
  let matches = dark;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === '(prefers-color-scheme: dark)' ? matches : false;
    },
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    set(next: boolean) {
      matches = next;
      for (const listener of listeners) listener();
    },
  };
}
