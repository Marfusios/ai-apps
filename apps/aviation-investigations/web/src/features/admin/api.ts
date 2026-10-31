/**
 * The admin page's data (UI_DESIGN §4.12, Task 25): `GET /api/admin/overview` (contract
 * `AdminOverviewSchema`, shared/contracts/admin.ts), only for a signed-in admin; everyone else gets
 * a 404, like a page that does not exist. Private (`admin`, forgotten with the visitor) and read
 * through `privateRead`. Loads with the admin page only.
 */
import { queryOptions } from '@tanstack/react-query';
import { AdminOverviewSchema } from '../../../../shared/contracts/admin';
import { READ_TIMEOUT_MS, getJson, retry } from '../../api';
import { privateRead } from '../auth/visitor';

export const adminOverviewQuery = () =>
  queryOptions({
    queryKey: ['admin', 'overview'] as const,
    queryFn: ({ signal }) =>
      privateRead(() => getJson('/api/admin/overview', AdminOverviewSchema, signal, { timeoutMs: READ_TIMEOUT_MS })),
    staleTime: 60_000,
    retry,
  });
