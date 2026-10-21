import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { CSP_SCRIPT_HASHES } from './web/src/csp-hashes.js';
import { cspHashGuard, fontLicenses, preloadFont } from './web/vite/plugins.js';

// Dev-server settings come from the process environment. They are deliberately not
// VITE_-prefixed, so Vite never exposes them to browser code.
const apiTarget = process.env.WEB_DEV_API_URL || 'http://localhost:3000';
const devPort = Number(process.env.WEB_DEV_PORT) || 5173;

export default defineConfig({
  root: 'web',
  // No .env files are read for the client; it has no build-time configuration.
  envDir: false,
  plugins: [
    react(),
    tailwindcss(),
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
    proxy: {
      '/api': { target: apiTarget },
    },
  },
  preview: {
    port: devPort,
    proxy: {
      '/api': { target: apiTarget },
    },
  },
});
