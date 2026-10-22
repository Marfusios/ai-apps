/**
 * Response security headers for every response (pages, assets, API and errors).
 *
 * The Content-Security-Policy allows scripts only from this origin plus the hashed
 * inline theme script of `web/index.html` (web/src/csp-hashes.ts; the web build fails
 * if that hash is stale). Styles are `'self'` (the build's stylesheet files); React
 * sets style properties through the CSSOM, which CSP does not restrict. The one
 * exception is the dialog scroll lock (Radix → react-remove-scroll), which inserts a
 * `<style>` element with computed values that no hash can cover: each HTML page gets
 * a fresh random nonce in its CSP (`style-src 'self' 'nonce-…'`) and as the `nonce`
 * of `<meta property="csp-nonce">`, which the client hands to that library
 * (web/src/csp-nonce.ts).
 * Scripts never accept the nonce.
 *
 * When anonymous AI is configured, the page loads Cloudflare Turnstile. Cloudflare's CSP
 * reference (developers.cloudflare.com/turnstile/reference/content-security-policy/)
 * offers a nonce on the `api.js` tag or, without nonces, `https://challenges.cloudflare.com`
 * in `script-src` and `frame-src`; scripts here take no nonce, so the policy adds exactly
 * that origin to those two directives (`connect-src 'self'`, which its pre-clearance mode
 * needs, is already there). Without Turnstile neither appears.
 */
import { CSP_SCRIPT_HASHES } from '../../web/src/csp-hashes.js';

/** True when the public origin is HTTPS: the URL's parsed scheme, so `HTTPS://` counts and a malformed URL does not. */
export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Turnstile's origin: its `api.js` script and its challenge iframe. */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

export interface SecurityHeaderOptions {
  /** Send Strict-Transport-Security: the public origin is HTTPS (APP_URL). */
  hsts: boolean;
  scriptHashes?: readonly string[];
  /** Allow Cloudflare Turnstile's script and frame (anonymous AI is configured). */
  turnstile?: boolean;
}

export interface CspOptions {
  scriptHashes?: readonly string[];
  /** Nonce for `<style>` elements of one HTML page (base64). */
  styleNonce?: string;
  /** Allow Cloudflare Turnstile's script and frame (anonymous AI is configured). */
  turnstile?: boolean;
}

export function contentSecurityPolicy(opts: CspOptions = {}): string {
  const scriptHashes = opts.scriptHashes ?? CSP_SCRIPT_HASHES;
  for (const hash of scriptHashes) {
    if (!/^sha(256|384|512)-[A-Za-z0-9+/]+=*$/.test(hash)) throw new Error(`invalid CSP hash ${JSON.stringify(hash)}`);
  }
  if (opts.styleNonce !== undefined && !/^[A-Za-z0-9+/]{16,}=*$/.test(opts.styleNonce)) throw new Error('invalid CSP nonce');
  const turnstile = opts.turnstile === true;
  return [
    "default-src 'self'",
    [`script-src 'self'`, ...scriptHashes.map((h) => `'${h}'`), ...(turnstile ? [TURNSTILE_ORIGIN] : [])].join(' '),
    opts.styleNonce ? `style-src 'self' 'nonce-${opts.styleNonce}'` : "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    ...(turnstile ? [`frame-src ${TURNSTILE_ORIGIN}`] : []),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export const PERMISSIONS_POLICY =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), browsing-topics=()';

/** The header set, computed once per app. */
export function securityHeaders(opts: SecurityHeaderOptions): Readonly<Record<string, string>> {
  return {
    'content-security-policy': contentSecurityPolicy({
      ...(opts.scriptHashes ? { scriptHashes: opts.scriptHashes } : {}),
      ...(opts.turnstile ? { turnstile: true } : {}),
    }),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'permissions-policy': PERMISSIONS_POLICY,
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    ...(opts.hsts ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  };
}
