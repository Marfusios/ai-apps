import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the real API server (`pnpm test:e2e:real`): the fixture
 * corpus is loaded into the local `test` environment (local services, aviation_test)
 * and served with the production web build on one origin (tests/e2e-real/server.ts).
 * E2E_REAL_PORT picks the port (default 5181). The mock-mode tests are
 * playwright.config.ts (`pnpm test:e2e`).
 */
const port = Number(process.env.E2E_REAL_PORT) || 5181;
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;

export default defineConfig({
  testDir: 'tests/e2e-real',
  // One server, one dataset: the specs only read.
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/real',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium-real-server', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm build:web && tsx tests/e2e-real/server.ts',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    env: { ...env, E2E_REAL_PORT: String(port) },
  },
});
