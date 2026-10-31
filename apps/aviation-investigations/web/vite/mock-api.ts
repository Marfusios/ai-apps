import type { Plugin } from 'vite';

export const MOCK_API_MODULE = 'virtual:casebook-mock-api';
const RESOLVED = `\0${MOCK_API_MODULE}`;

/**
 * Provides `virtual:casebook-mock-api`, whose `startMockApi()` the entry awaits
 * before rendering. With the dev mock mode on (`WEB_MOCK_API=1`, dev server only)
 * it registers the MSW worker with the fixture handlers (Google sign-in mocked on,
 * an AI search's stages timed by `evidenceTiming`: 1 as live, 0 at once);
 * otherwise, and in every
 * production build, it is an empty function, so no mock code is bundled.
 */
export function mockApiEntry(enabled: boolean, { evidenceTiming = 1 }: { evidenceTiming?: number } = {}): Plugin {
  return {
    name: 'casebook:mock-api',
    resolveId(source) {
      return source === MOCK_API_MODULE ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      if (!enabled) return 'export async function startMockApi() {}\n';
      return [
        "import { setupWorker } from 'msw/browser';",
        "import { createHandlers } from '/src/mocks/handlers.ts';",
        'export async function startMockApi() {',
        `  const worker = setupWorker(...createHandlers({ latencyMs: 120, googleEnabled: true, evidenceTiming: ${JSON.stringify(evidenceTiming)} }));`,
        "  await worker.start({ onUnhandledFrame: 'bypass', quiet: true });",
        "  console.info('[casebook] Mock API: /api answers come from web/mock (NTSB fixture data).');",
        '}',
        '',
      ].join('\n');
    },
  };
}
