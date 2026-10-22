import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { createHandlers } from '../../web/src/mocks/handlers';
import { routes } from '../../web/src/routes';

/** MSW over the fixture mock API for component tests; call once per test file. */
export function setupMockApi(): ReturnType<typeof setupServer> {
  const server = setupServer(...createHandlers());
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return server;
}

/** Renders the whole app at `path` with a fresh query cache. */
export function renderApp(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, client };
}

/** Current location of the memory router as `pathname?search`. */
export function currentUrl(router: ReturnType<typeof createMemoryRouter>): string {
  return `${router.state.location.pathname}${router.state.location.search}`;
}
