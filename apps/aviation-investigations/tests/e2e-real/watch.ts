/** What a real-server test watches a page for: CSP violations, console errors and page errors. */
import type { Page } from '@playwright/test';

/**
 * A search's progress read while the server has not registered it yet: the search checklist reads
 * through these 404s by design (UI_DESIGN §4.10), from the moment the request leaves until the
 * server has checked and admitted it.
 */
const PROGRESS_NOT_FOUND = /^Failed to load resource: the server responded with a status of 404 \(Not Found\): \/api\/evidence\/progress\/[^/]+$/;

/** Collects CSP violations and page errors from the moment the page starts. */
export async function watchPage(page: Page): Promise<string[]> {
  const problems: string[] = [];
  await page.addInitScript(
    "document.addEventListener('securitypolicyviolation', (e) => console.error('CSP violation: ' + e.violatedDirective + ' ' + e.blockedURI));",
  );
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // A resource that failed says which one (a 404 page's document and its API read are expected).
    const url = m.location().url;
    const problem = m.text().startsWith('Failed to load resource') && url ? `${m.text()}: ${new URL(url).pathname}` : m.text();
    if (!PROGRESS_NOT_FOUND.test(problem)) problems.push(problem);
  });
  page.on('pageerror', (e) => problems.push(e.message));
  return problems;
}

/** `problems` without the 404s a test expects: a not-found page's own document, a missing case's API read. */
export function unexpected(problems: readonly string[], notFound: readonly string[]): string[] {
  const expected = new Set(notFound.map((path) => `Failed to load resource: the server responded with a status of 404 (Not Found): ${path}`));
  return problems.filter((p) => !expected.has(p));
}
