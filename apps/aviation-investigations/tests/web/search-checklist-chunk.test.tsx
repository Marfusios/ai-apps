/**
 * The search checklist's own chunk failing to load (UI_DESIGN §4.10; Task 25b, review Minor 3): the
 * search goes on without a card, the page never fails for it, and the control that asked keeps its
 * plain busy state, "Starting…", never "Searching…" for a card that is not there. Its own file: the
 * checklist module fails to load for the whole file.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiStatusResponse } from '../../shared/contracts/ai';
import { EVIDENCE_HEADING } from '../../shared/contracts/evidence';
import { MOCK_EVIDENCE_QUESTIONS } from '../../web/mock/evidence';
import type { TurnstileApi } from '../../web/src/features/ai/TurnstileGate';
import { resetUnsettledForTests } from '../../web/src/features/ai/unsettled';
import { SEARCH_CHECKLIST_TITLE } from '../../web/src/features/evidence/checklist';
import { createHandlers } from '../../web/src/mocks/handlers';
import { evidenceAnswer } from './evidence-answer';
import { currentUrl, renderApp, setupMockApi } from './render-app';

vi.mock('../../web/src/features/evidence/SearchChecklist', () => {
  throw new Error('the checklist did not load');
});

const server = setupMockApi();
const SLOW = { timeout: 8000 };
/** A trial that has started: the check runs invisibly. */
const STARTED: AiStatusResponse = { state: 'available', remaining: { kind: 'trial', left: 10, limit: 10, started: true } };

afterEach(() => {
  delete window.turnstile;
  resetUnsettledForTests();
});

describe('a checklist that cannot load', () => {
  it('leaves the search going, with no card, and the control busy as “Starting…”, never “Searching…”', async () => {
    server.use(...createHandlers({ aiStatus: STARTED }));
    const turnstile: TurnstileApi = {
      render(host, params) {
        host.appendChild(document.createElement('div'));
        setTimeout(() => params.callback('XXXX.DUMMY.TOKEN.XXXX'), 5);
        return 'w1';
      },
      remove() {},
    };
    window.turnstile = turnstile;
    let release = (): void => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let posts = 0;
    server.use(
      http.post('*/api/evidence', async () => {
        posts += 1;
        await released;
        return HttpResponse.json(evidenceAnswer('00000000-0000-4000-8000-0000000000ee'), { status: 201 });
      }),
    );
    const app = renderApp('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search NTSB investigations' }), { target: { value: MOCK_EVIDENCE_QUESTIONS.carb } });
    fireEvent.click(await screen.findByRole('button', { name: /^Ask AI\s*·/ }));
    await waitFor(() => expect(posts).toBe(1), SLOW);
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 300)));
    const control = within(screen.getByRole('search')).getByRole('button', { name: 'Starting…' });
    expect(control.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Searching…' })).toBeNull();
    expect(screen.queryByRole('region', { name: SEARCH_CHECKLIST_TITLE })).toBeNull();
    // The search goes on and opens its results.
    act(() => release());
    await waitFor(() => expect(currentUrl(app.router)).toBe('/ai/00000000-0000-4000-8000-0000000000ee'), SLOW);
    await screen.findByRole('heading', { level: 2, name: EVIDENCE_HEADING }, SLOW);
  });
});
