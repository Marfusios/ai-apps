/**
 * Reading a request target (server/http/request-target.ts): the one behaviour the server uses
 * to decide on API and page paths, trailing slashes and query strings.
 */
import { describe, expect, it } from 'vitest';
import { routerPath, targetQuery } from '../../server/http/request-target.js';

describe('routerPath: the path the router sees', () => {
  it.each([
    ['/explore', '/explore'],
    ['/explore/?q=carb#top', '/explore/'],
    ['/explore?q=a/b', '/explore'],
    ['/a/b#c?d', '/a/b'],
    ['', '/'],
    ['?q=x', '/'],
    ['explore', '/explore'],
    // Absolute form, as the router reads it: http and https in any letter case.
    ['http://evil.example/api/search?q=x', '/api/search'],
    ['HTTPS://evil.example:8443/about/', '/about/'],
    ['http://evil.example', '/'],
    ['http://evil.example?x=1', '/'],
    // Other schemes are not stripped (and match no route).
    ['ftp://evil.example/x', '/ftp://evil.example/x'],
    // Decoded, unless an escape is malformed.
    ['/%61pi/search', '/api/search'],
    ['/cases/%20DFW08TA066', '/cases/ DFW08TA066'],
    ['/%E0%A4%A', '/%E0%A4%A'],
  ])('%j → %j', (target, path) => {
    expect(routerPath(target)).toBe(path);
  });
});

describe('targetQuery: the query string', () => {
  it.each([
    ['/explore?q=carb&phase=approach', 'q=carb&phase=approach'],
    ['/explore?q=carb#top', 'q=carb'],
    ['http://evil.example/compare?cases=A,B', 'cases=A,B'],
    ['/explore', ''],
    ['/explore?', ''],
    ['/explore#q=x', ''],
    ['/a#b?c', ''],
  ])('%j → %j', (target, query) => {
    expect(targetQuery(target)).toBe(query);
  });
});
