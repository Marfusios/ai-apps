/**
 * SHA-256 hashes of the inline scripts in `web/index.html`, for the server's
 * Content-Security-Policy `script-src`. Quote each one in the header:
 * `script-src 'self' 'sha256-…'`.
 *
 * The only inline script sets `data-theme` before first paint (UI_DESIGN §2.8).
 * The web build fails if an inline script is missing from this list, and
 * `tests/web/csp-hash.test.ts` recomputes the value from the HTML.
 */
export const THEME_SCRIPT_HASH = 'sha256-1sUAFJKLUhnnDdPSShed2VEyipXQMeo5ITAyw18y1Rw=';

export const CSP_SCRIPT_HASHES: readonly string[] = [THEME_SCRIPT_HASH];
