import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { msw } from 'msw/vite';
import { defineConfig } from 'vite';
import { CSP_SCRIPT_HASHES } from './web/src/csp-hashes.js';
import { mockApiEntry } from './web/vite/mock-api.js';
import { cspHashGuard, fontLicenses, preloadFont } from './web/vite/plugins.js';

// Dev-server settings come from the process environment. They are deliberately not
// VITE_-prefixed, so Vite never exposes them to browser code.
const apiTarget = process.env.WEB_DEV_API_URL || 'http://localhost:3000';
const devPort = Number(process.env.WEB_DEV_PORT) || 5173;
// WEB_MOCK_API=1 answers /api in the browser from the fixture mocks (dev server only).
const mockApiRequested = process.env.WEB_MOCK_API === '1';

export default defineConfig(({ command }) => {
  const mockApi = command === 'serve' && mockApiRequested;
  return {
    root: 'web',
    // No .env files are read for the client; it has no build-time configuration.
    envDir: false,
    plugins: [
      react(),
      tailwindcss(),
      mockApiEntry(mockApi),
      ...(mockApi ? [msw({ mode: 'worker-only' })] : []),
      cspHashGuard(CSP_SCRIPT_HASHES),
      preloadFont(/b612-latin-400-normal-[\w-]+\.woff2$/),
      fontLicenses(['@fontsource/b612', '@fontsource/b612-mono', '@fontsource-variable/source-serif-4']),
    ],
    build: {
      outDir: '../dist/web',
      emptyOutDir: true,
    },
    server: {
      port: devPort,
      strictPort: mockApi,
      proxy: mockApi ? undefined : { '/api': { target: apiTarget } },
    },
    preview: {
      port: devPort,
      proxy: {
        '/api': { target: apiTarget },
      },
    },
  };
});
