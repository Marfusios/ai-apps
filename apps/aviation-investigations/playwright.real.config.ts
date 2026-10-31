import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the real API server (`pnpm test:e2e:real`): the fixture
 * corpus is loaded into the local `test` environment (local services, aviation_test)
 * and served with the production web build on one origin (tests/e2e-real/server.ts),
 * with AI evidence search on through offline fakes (nothing leaves the machine).
 * E2E_REAL_PORT picks the port (default 5181). Signing in and out runs against a second
 * server with Google sign-in and a stand-in for Google on another site
 * (tests/e2e-real/auth-server.ts, ports E2E_AUTH_PORT and E2E_GOOGLE_PORT, default 5182
 * and 5183). The same process serves a second app with the evidence.v3 policies the evaluation
 * may pick on E2E_REAL_V3_PORT (default E2E_REAL_PORT + 3) for tests/e2e-real/evidence-v3.spec.ts,
 * and a third with what live runs, Google sign-in through the same stand-in and an admin, on
 * E2E_REAL_LIVE_PORT (default E2E_REAL_PORT + 4) for the search checklist, ratings and the admin
 * page (tests/e2e-real/search-checklist.spec.ts, admin.spec.ts). The admin tests sign in over the
 * same auth tables as tests/e2e-real/sign-in-out.spec.ts, which counts every session, so they run
 * after the rest (project `chromium-real-admin`).
 * The mock-mode tests are playwright.config.ts (`pnpm test:e2e`).
 */
const port = Number(process.env.E2E_REAL_PORT) || 5181;
const v3Port = Number(process.env.E2E_REAL_V3_PORT) || port + 3;
// The workers read it too (tests/e2e-real/evidence-v3.spec.ts).
process.env.E2E_REAL_V3_PORT = String(v3Port);
const livePort = Number(process.env.E2E_REAL_LIVE_PORT) || port + 4;
// Read by the workers (tests/e2e-real/search-checklist.spec.ts, admin.spec.ts) and both servers.
process.env.E2E_REAL_LIVE_PORT = String(livePort);
const authPort = Number(process.env.E2E_AUTH_PORT) || 5182;
const googlePort = Number(process.env.E2E_GOOGLE_PORT) || 5183;
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
  projects: [
    { name: 'chromium-real-server', use: { ...devices['Desktop Chrome'] }, testIgnore: /admin\.spec\.ts$/ },
    // Signing in on the live-configuration app adds sessions that sign-in-out.spec.ts would count: after the rest.
    { name: 'chromium-real-admin', use: { ...devices['Desktop Chrome'] }, testMatch: /admin\.spec\.ts$/, dependencies: ['chromium-real-server'] },
  ],
  webServer: [
    {
      command: 'pnpm build:web && tsx tests/e2e-real/server.ts',
      url: `http://127.0.0.1:${port}/api/health`,
      reuseExistingServer: false,
      timeout: 240_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
      env: { ...env, E2E_REAL_PORT: String(port), E2E_REAL_V3_PORT: String(v3Port), E2E_REAL_LIVE_PORT: String(livePort), E2E_GOOGLE_PORT: String(googlePort) },
    },
    {
      command: 'tsx tests/e2e-real/auth-server.ts',
      url: `http://localhost:${googlePort}/control/ready`,
      reuseExistingServer: false,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
      env: { ...env, NODE_ENV: 'test', E2E_AUTH_PORT: String(authPort), E2E_GOOGLE_PORT: String(googlePort), E2E_REAL_LIVE_PORT: String(livePort) },
    },
  ],
});
