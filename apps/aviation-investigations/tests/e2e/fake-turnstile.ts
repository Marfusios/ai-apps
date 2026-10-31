/**
 * A local stand-in for Cloudflare's Turnstile, installed before the app loads (the app then
 * never fetches Cloudflare's script, and the mock's service worker would hide that request from
 * routing anyway), so the AI tests make no network requests. It records each widget's
 * parameters (`window.__turnstile`) and every fetch the page makes (`window.__reads`, with the
 * body of each one that sends text), and
 * answers with the dummy token of Cloudflare's always-passing test keys after
 * `window.__checkDelay` ms (700 by default).
 */
export const FAKE_TURNSTILE = `
window.__turnstile = { renders: [], removed: 0 };
window.__reads = [];
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    window.__reads.push({ method: (init && init.method) || (input instanceof Request ? input.method : 'GET'), path: url.pathname, search: url.search, body: init && typeof init.body === 'string' ? init.body : null });
  } catch {}
  return realFetch(input, init);
};
window.turnstile = {
  _n: 0,
  _widgets: {},
  render(host, params) {
    const id = 'w' + (++this._n);
    window.__turnstile.renders.push({ sitekey: params.sitekey, action: params.action, appearance: params.appearance, theme: params.theme });
    const box = document.createElement('div');
    box.textContent = 'Verifying…';
    box.style.cssText = 'border:1px solid #c9c4b4;border-radius:4px;padding:9px 12px;background:#fafafa;color:#1E2A36;font:12px sans-serif;width:250px';
    if (params.appearance === 'interaction-only') box.style.display = 'none';
    host.appendChild(box);
    this._widgets[id] = box;
    setTimeout(() => {
      if (!this._widgets[id]) return;
      box.textContent = 'Success!';
      params.callback('XXXX.DUMMY.TOKEN.XXXX');
    }, window.__checkDelay ?? 700);
    return id;
  },
  remove(id) {
    const box = this._widgets[id];
    if (box) box.remove();
    delete this._widgets[id];
    window.__turnstile.removed += 1;
  },
};
`;

/** Cloudflare's documented always-passing test site key, which the mock's `/api/config` offers. */
export const TEST_SITE_KEY = '1x00000000000000000000AA';
