/**
 * Query strings just under Node's 16 KB header limit, built to be expensive to read: the pages
 * that read them (Explore, Compare) are not rate limited (shared/page-params.ts).
 */
import { FACET_KEYS } from '../../shared/contracts/search.js';

const LIMIT = 15_500;

const repeated = (prefix: string, unit: string): string => prefix + unit.repeat(Math.floor((LIMIT - prefix.length) / unit.length));

function distinct(prefix: string, limit = LIMIT): string {
  let s = prefix;
  for (let i = 0; s.length < limit; i++) s += `b${i.toString(36)},`;
  return s;
}

function manyKeys(): string {
  let s = '';
  for (let i = 0; s.length < LIMIT; i++) s += `k${i.toString(36)}=&`;
  return s;
}

const share = Math.floor(LIMIT / FACET_KEYS.length);

/** Explore query strings. */
export const HOSTILE_SEARCHES: ReadonlyArray<readonly [string, string]> = [
  ['one facet, one bad item again and again', repeated('phase=', 'a,')],
  ['one facet, distinct bad items', distinct('phase=')],
  ['one facet, a valid item again and again', repeated('phase=', 'approach,')],
  ['one key repeated', repeated('', 'phase=a&')],
  ['every facet, bad items', FACET_KEYS.map((k) => `${k}=${'a,'.repeat(Math.floor(share / 2) - 8)}`).join('&')],
  ['every facet, distinct bad items', FACET_KEYS.map((k) => distinct(`${k}=`, share)).join('&')],
  ['every other key, bad values again and again', ['q', 'mentionedIn', 'yearFrom', 'yearTo', 'sort', 'page', 'pageSize'].map((k) => `${k}=${'zz,'.repeat(730)}`).join('&')],
  ['many distinct keys', manyKeys()],
];

/** Compare query strings. */
export const HOSTILE_COMPARES: ReadonlyArray<readonly [string, string]> = [
  ['one bad number again and again', repeated('cases=', 'a,')],
  ['distinct bad numbers', distinct('cases=')],
  ['long bad numbers', repeated('cases=', 'aaaaaaaaaaaaaaaaaaa!,')],
];
