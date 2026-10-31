import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the Vite dev server in mock mode (WEB_MOCK_API=1):
 * /api is answered in the browser by MSW from the fixture-built `web/mock` files.
 * AI searches answer at once (WEB_MOCK_EVIDENCE_TIMING=0); a test that watches the search
 * checklist times the stages in its tab's session storage (`casebook-mock-evidence-timing`).
 * E2E_PORT picks the port (default 5180). Browsers come from `pnpm exec playwright install chromium`.
 */
const port = Number(process.env.E2E_PORT) || 5180;
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev:web',
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { ...env, WEB_MOCK_API: '1', WEB_MOCK_EVIDENCE_TIMING: '0', WEB_DEV_PORT: String(port) },
  },
});
