/**
 * Starts a built web client (the output of `vite build`) in jsdom, inside this bare Node
 * process, and prints what happened as one line of JSON. `Function` is wrapped first, so the
 * output says whether the bundle tried to compile code at run time: the server's CSP has no
 * 'unsafe-eval', and a browser reports such an attempt even when the caller catches the error.
 * Used by tests/unit/web-bundle-eval.test.ts, in a child process so that nothing it changes
 * (globals, `Function`) reaches the test runner.
 *
 * usage: node boot-web-bundle.mjs <build directory> <app directory>
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [buildDir, appDir] = process.argv.slice(2);
const html = readFileSync(join(buildDir, 'index.html'), 'utf8');
const entry = /<script type="module"[^>]*\ssrc="\/([^"]+)"/.exec(html)?.[1];
if (!entry) throw new Error('the built index.html has no module script');

// The page the browser would have, without running its scripts: the bundle is started below.
const { JSDOM, VirtualConsole } = createRequire(join(appDir, 'package.json'))('jsdom');
const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
const w = dom.window;
w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
w.scrollTo = () => {};
for (const key of Object.getOwnPropertyNames(w)) {
  if (!(key in globalThis)) Object.defineProperty(globalThis, key, { configurable: true, get: () => w[key] });
}
for (const key of ['window', 'self']) Object.defineProperty(globalThis, key, { configurable: true, value: w });
// Offline: the app's reads fail and it shows its error states; this only needs it to start.
globalThis.fetch = () => Promise.reject(new TypeError('offline'));
process.on('unhandledRejection', () => {});

const calls = [];
const record = (args) => calls.push(String(args[args.length - 1] ?? '').slice(0, 60));
globalThis.Function = new Proxy(Function, {
  construct(target, args, newTarget) {
    record(args);
    return Reflect.construct(target, args, newTarget);
  },
  apply(target, thisArg, args) {
    record(args);
    return Reflect.apply(target, thisArg, args);
  },
});

let failure = null;
try {
  await import(pathToFileURL(join(buildDir, entry)).href);
} catch (error) {
  failure = String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ');
}
// The entry renders once the mock-API promise settles; wait for the header.
const root = w.document.getElementById('root');
for (let waited = 0; waited < 4000 && !root?.querySelector('header a'); waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));

process.stdout.write(
  JSON.stringify({
    calls,
    failure,
    jitless: globalThis.__zod_globalConfig?.jitless === true,
    wordmark: root?.querySelector('header a')?.textContent ?? null,
  }),
);
process.exit(0);
