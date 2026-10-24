import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          // Some unit tests are CPU-heavy (the checker calibration recomputes its figures again
          // and again) or build the web client (web-bundle-eval); on a loaded machine the
          // default 5 s is too tight.
          testTimeout: 30_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['tests/web/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/web/setup.ts'],
          // Stylesheets are read as text (`?raw`) by the token and print tests.
          css: { include: [/\.css(\?|$)/] },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/integration/global-setup.ts'],
          // Test files share the aviation_test database and the aviation-test-* indices,
          // and some reset them between tests.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
