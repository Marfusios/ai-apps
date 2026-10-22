/**
 * The server's CSP allows `<style>` elements only with the page's nonce
 * (server/http/security-headers.ts), which it also sets as the `nonce` attribute of
 * `<meta property="csp-nonce">`. The dialogs' scroll lock (Radix → react-remove-scroll →
 * react-style-singleton) inserts such an element and takes its nonce from `get-nonce`.
 * Browsers hide nonce attributes from `getAttribute`; the `nonce` property keeps the
 * value. Without the meta tag (the Vite dev server, tests) nothing is set and no CSP
 * applies.
 */
import { setNonce } from 'get-nonce';

const nonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce;
if (nonce) setNonce(nonce);
