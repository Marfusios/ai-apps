/**
 * Explore's view state lives in the URL (UI_DESIGN §3): the query, filters and
 * page (the search keys of `SearchRequest`), the open case (`case`) and the
 * compare selection (`cases`). `brief` and `step` are reserved for briefs and
 * passed through untouched.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams, type SetURLSearchParams } from 'react-router';
import { NtsbNoSchema } from '../../../../shared/contracts/common';
import { searchRequestToParams, type SearchRequest } from '../../../../shared/contracts/search';
import { CASES_PARAM, COMPARE_LIMIT, SEARCH_KEYS, readCompare, readSearchRequest } from '../../../../shared/page-params';

// The readers the server shares (it titles Explore and Compare as this client does).
export { CASES_PARAM, COMPARE_LIMIT, readCompare, readSearchRequest } from '../../../../shared/page-params';

export const CASE_PARAM = 'case';

/** `params` with the search keys replaced by the canonical form of `request`. */
export function withSearchRequest(params: URLSearchParams, request: SearchRequest): URLSearchParams {
  const next = searchRequestToParams(request);
  for (const [key, value] of params) {
    if (!SEARCH_KEYS.has(key)) next.append(key, value);
  }
  return next;
}

export function withCompare(params: URLSearchParams, list: readonly string[]): URLSearchParams {
  const next = new URLSearchParams(params);
  if (list.length === 0) next.delete(CASES_PARAM);
  else next.set(CASES_PARAM, list.join(','));
  return next;
}

export function readOpenCase(params: URLSearchParams): string | null {
  const value = (params.get(CASE_PARAM) ?? '').trim().toUpperCase();
  return NtsbNoSchema.safeParse(value).success ? value : null;
}

/** `/compare?cases=…` (plus `brief` and `step` when the cases came from a brief). */
export function compareHref(list: readonly string[], extra?: Readonly<Record<string, string>>): string {
  const rest = extra ? new URLSearchParams(extra as Record<string, string>).toString() : '';
  return `/compare?${CASES_PARAM}=${list.join(',')}${rest ? `&${rest}` : ''}`;
}

export type ToggleResult = 'added' | 'removed' | 'full';

/** The compare selection in the current URL. */
export function useCompareSelection(): {
  selected: string[];
  toggle: (ntsbNo: string) => ToggleResult;
  remove: (ntsbNo: string) => void;
  clear: () => void;
} {
  const [params, setParams] = useSearchParams();
  const selected = useMemo(() => readCompare(params), [params]);
  const update = useCallback(
    (list: string[]) => setParams((current) => withCompare(current, list), { replace: true, preventScrollReset: true }),
    [setParams],
  );
  const toggle = useCallback(
    (ntsbNo: string): ToggleResult => {
      if (selected.includes(ntsbNo)) {
        update(selected.filter((n) => n !== ntsbNo));
        return 'removed';
      }
      if (selected.length >= COMPARE_LIMIT) return 'full';
      update([...selected, ntsbNo]);
      return 'added';
    },
    [selected, update],
  );
  const remove = useCallback((ntsbNo: string) => update(selected.filter((n) => n !== ntsbNo)), [selected, update]);
  const clear = useCallback(() => update([]), [update]);
  return { selected, toggle, remove, clear };
}

/** Explore's search request and the setters that keep it in the URL. */
export function useExploreRequest(): {
  request: SearchRequest;
  params: URLSearchParams;
  setParams: SetURLSearchParams;
  /** Applies a change; anything but a page change goes back to page 1. */
  update: (change: Partial<SearchRequest>, options?: { replace?: boolean }) => void;
} {
  const [params, setParams] = useSearchParams();
  const request = useMemo(() => readSearchRequest(params), [params]);
  const update = useCallback(
    (change: Partial<SearchRequest>, options: { replace?: boolean } = {}) => {
      setParams(
        (current) => {
          const base = readSearchRequest(current);
          const merged = { ...base, ...change } as SearchRequest;
          if (!('page' in change)) merged.page = 1;
          for (const key of ['yearFrom', 'yearTo'] as const) {
            if (key in change && change[key] === undefined) delete merged[key];
          }
          return withSearchRequest(current, merged);
        },
        { replace: options.replace ?? false, preventScrollReset: true },
      );
    },
    [setParams],
  );
  return { request, params, setParams, update };
}
