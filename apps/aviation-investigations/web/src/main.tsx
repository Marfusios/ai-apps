import './csp-nonce';
import './styles/fonts.css';
import './styles/index.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { startMockApi } from 'virtual:casebook-mock-api';
import { routes } from './routes';
import { initTheme } from './theme';

initTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

const router = createBrowserRouter(routes);

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

function render(): void {
  createRoot(container as HTMLElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

// A no-op unless the dev server runs in mock mode (WEB_MOCK_API=1).
startMockApi().then(render, (err: unknown) => {
  console.error('Mock API failed to start', err);
  render();
});
