import { afterEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../web/index.html?raw';
import { CSP_SCRIPT_HASHES, THEME_SCRIPT_HASH } from '../../web/src/csp-hashes';
import { THEME_STORAGE_KEY } from '../../web/src/theme';
import { stubColorScheme } from './helpers';

const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
const inlineScripts = [...indexHtml.matchAll(INLINE_SCRIPT)].map((m) => m[1] ?? '');

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return `sha256-${btoa(String.fromCharCode(...digest))}`;
}

/** Runs the pre-paint script the way the browser would. */
function runThemeScript(): string | null {
  new Function(inlineScripts[0] ?? '')();
  return document.documentElement.getAttribute('data-theme');
}

afterEach(() => vi.restoreAllMocks());

describe('CSP hash for the pre-paint theme script', () => {
  it('index.html has exactly one inline script', () => {
    expect(inlineScripts).toHaveLength(1);
  });

  it('hash matches the script content', async () => {
    const hash = await sha256(inlineScripts[0]!);
    expect(hash, `update web/src/csp-hashes.ts to ${hash}`).toBe(THEME_SCRIPT_HASH);
    expect(CSP_SCRIPT_HASHES).toEqual([THEME_SCRIPT_HASH]);
  });

  it('uses the same storage key and values as theme.ts', () => {
    expect(inlineScripts[0]).toContain(`"${THEME_STORAGE_KEY}"`);
    expect(inlineScripts[0]).toContain('"(prefers-color-scheme: dark)"');
  });

  it('applies a stored choice, else the device setting, before first paint', () => {
    stubColorScheme(true);
    expect(runThemeScript()).toBe('night');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'day');
    expect(runThemeScript()).toBe('day');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'bogus');
    expect(runThemeScript()).toBe('night');
  });

  it('falls back to day when storage and matchMedia both throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.stubGlobal('matchMedia', () => {
      throw new Error('unsupported');
    });
    expect(runThemeScript()).toBe('day');
  });
});
