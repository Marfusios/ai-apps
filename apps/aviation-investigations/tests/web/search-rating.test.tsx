/**
 * Rating a search (UI_DESIGN §4.11, Task 25): "Was this search useful?" on the results sheet, two
 * chips with accessible names that send `POST /api/evidence/:id/feedback` (contract
 * `EvidenceFeedbackRequestSchema`); "Thanks — noted." and the choice shown as chosen once the
 * server has it; a change of mind, the latest counting; a plain failure with Try again, and a
 * search that is gone; kept per search in memory only (unrated after a reload, forgotten with the
 * visitor); never printed.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateEvidenceResponseSchema, EVIDENCE_HEADING, EvidenceFeedbackRequestSchema, type EvidencePage } from '../../shared/contracts/evidence';
import { MOCK_EVIDENCE_QUESTIONS } from '../../web/mock/evidence';
import { resetUnsettledForTests } from '../../web/src/features/ai/unsettled';
import { forgetVisitor } from '../../web/src/features/auth/visitor';
import { forgetRatings, ratingOf } from '../../web/src/features/evidence/ratings';
import { RATING_FAILED, RATING_GONE, RATING_QUESTION, RATING_SAVING, RATING_THANKS } from '../../web/src/features/evidence/SearchRating';
import { createHandlers } from '../../web/src/mocks/handlers';
import { renderApp, setupMockApi } from './render-app';

const server = setupMockApi();
const SLOW = { timeout: 5000 };
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

afterEach(() => {
  resetUnsettledForTests();
  server.events.removeAllListeners();
});

/** A search made through the mock API (page 1 of it). */
async function makeSearch(question: string): Promise<EvidencePage> {
  const response = await fetch(new URL('/api/evidence', window.location.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'question', question, idempotencyKey: crypto.randomUUID(), turnstileToken: TOKEN }),
  });
  return CreateEvidenceResponseSchema.parse(await response.json()).search;
}

async function openSearch(question: string = MOCK_EVIDENCE_QUESTIONS.seed) {
  server.use(...createHandlers());
  const search = await makeSearch(question);
  const app = renderApp(`/ai/${search.id}`);
  await screen.findByRole('heading', { level: 2, name: EVIDENCE_HEADING }, SLOW);
  return { ...app, search };
}

/** Every rating the server got, with the search it was for. */
function recordRatings(): { id: string; body: unknown }[] {
  const sent: { id: string; body: unknown }[] = [];
  server.events.on('request:start', ({ request }) => {
    const m = /\/api\/evidence\/([^/]+)\/feedback$/.exec(new URL(request.url).pathname);
    if (request.method === 'POST' && m) void request.clone().json().then((body: unknown) => sent.push({ id: m[1] as string, body }));
  });
  return sent;
}

const control = (): HTMLElement => document.querySelector('[data-search-rating]') as HTMLElement;
const chip = (name: 'Useful' | 'Not useful'): HTMLElement => within(control()).getByRole('button', { name: new RegExp(`^${name}$`) });
const status = (): string => control().querySelector('[data-rating-status]')?.textContent ?? '';

describe('Was this search useful?', { timeout: 20_000 }, () => {
  it('two named chips under the results, not printed; a click sends the rating and, once kept, says thanks with the choice chosen', async () => {
    const { search } = await openSearch();
    const sent = recordRatings();
    const box = control();
    expect(within(box).getByRole('group', { name: RATING_QUESTION })).toBeTruthy();
    expect(box.getAttribute('data-print')).toBe('hide');
    // After the results and the line saying when the search is deleted.
    const results = screen.getByRole('heading', { level: 2, name: EVIDENCE_HEADING }).closest('section') as HTMLElement;
    expect(results.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chip('Useful').getAttribute('aria-pressed')).toBe('false');
    expect(chip('Not useful').getAttribute('aria-pressed')).toBe('false');
    expect(status()).toBe('');
    fireEvent.click(chip('Useful'));
    await waitFor(() => expect(status()).toBe(RATING_THANKS), SLOW);
    expect(chip('Useful').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Not useful').getAttribute('aria-pressed')).toBe('false');
    expect(sent).toEqual([{ id: search.id, body: { rating: 'useful' } }]);
    expect(EvidenceFeedbackRequestSchema.safeParse(sent[0]?.body).success).toBe(true);
    expect(control().querySelector('[data-rating-status]')?.getAttribute('aria-live')).toBe('polite');
  });

  it('the visitor can change it, the latest counting; the chosen one again sends nothing', async () => {
    await openSearch();
    const sent = recordRatings();
    fireEvent.click(chip('Not useful'));
    await waitFor(() => expect(chip('Not useful').getAttribute('aria-pressed')).toBe('true'), SLOW);
    fireEvent.click(chip('Useful'));
    await waitFor(() => expect(chip('Useful').getAttribute('aria-pressed')).toBe('true'), SLOW);
    expect(chip('Not useful').getAttribute('aria-pressed')).toBe('false');
    expect(status()).toBe(RATING_THANKS);
    fireEvent.click(chip('Useful'));
    await act(() => delay(150));
    expect(sent.map((s) => s.body)).toEqual([{ rating: 'not_useful' }, { rating: 'useful' }]);
  });

  it('“Saving…” while it is on its way; a rating that did not save says so plainly, keeps what the server has, and Try again sends it again', async () => {
    const { search } = await openSearch();
    fireEvent.click(chip('Useful'));
    await waitFor(() => expect(status()).toBe(RATING_THANKS), SLOW);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let posts = 0;
    server.use(
      http.post(`*/api/evidence/${search.id}/feedback`, async () => {
        posts += 1;
        if (posts === 1) {
          await held;
          return HttpResponse.json({ error: 'unavailable', message: 'Try again.' }, { status: 503 });
        }
        return new HttpResponse(null, { status: 204 });
      }),
    );
    fireEvent.click(chip('Not useful'));
    await waitFor(() => expect(status()).toBe(RATING_SAVING), SLOW);
    expect(chip('Not useful').getAttribute('aria-disabled')).toBe('true');
    act(() => release());
    await waitFor(() => expect(status()).toBe(RATING_FAILED), SLOW);
    // The server still has "useful".
    expect(chip('Useful').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(control()).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(status()).toBe(RATING_THANKS), SLOW);
    expect(chip('Not useful').getAttribute('aria-pressed')).toBe('true');
    expect(posts).toBe(2);
    expect(within(control()).queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('the mock’s “rating fails” fails the first rating, as the end-to-end tests see it', async () => {
    await openSearch('Engine power loss, rating fails');
    fireEvent.click(chip('Useful'));
    await waitFor(() => expect(status()).toBe(RATING_FAILED), SLOW);
    fireEvent.click(within(control()).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(status()).toBe(RATING_THANKS), SLOW);
  });

  it('a search that is gone cannot be rated: it says so, with no Try again', async () => {
    const { search } = await openSearch();
    server.use(http.post(`*/api/evidence/${search.id}/feedback`, () => HttpResponse.json({ error: 'not_found', message: 'Not found.' }, { status: 404 })));
    fireEvent.click(chip('Not useful'));
    await waitFor(() => expect(status()).toBe(RATING_GONE), SLOW);
    expect(within(control()).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(chip('Useful').getAttribute('aria-disabled')).toBe('true');
  });

  it('kept per search in memory: there when the page opens again, unrated after a reload, forgotten with the visitor', async () => {
    const { search, client, unmount } = await openSearch();
    fireEvent.click(chip('Useful'));
    await waitFor(() => expect(status()).toBe(RATING_THANKS), SLOW);
    unmount();
    renderApp(`/ai/${search.id}`);
    await screen.findByRole('heading', { level: 2, name: EVIDENCE_HEADING }, SLOW);
    expect(chip('Useful').getAttribute('aria-pressed')).toBe('true');
    expect(status()).toBe(RATING_THANKS);
    // A reload starts with nothing in memory: the server never sends a rating back.
    act(() => forgetRatings());
    expect(chip('Useful').getAttribute('aria-pressed')).toBe('false');
    expect(status()).toBe('');
    fireEvent.click(chip('Useful'));
    await waitFor(() => expect(ratingOf(search.id)).toBe('useful'), SLOW);
    await act(() => forgetVisitor(client, { announce: false }));
    expect(ratingOf(search.id)).toBeNull();
  });
});
