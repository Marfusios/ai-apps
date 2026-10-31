import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { forgetRatings } from '../../web/src/features/evidence/ratings';
import { forgetUndos } from '../../web/src/features/evidence/undo';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  // What the tab remembers of evidence searches' free undos and ratings (memory, keyed by the mock's reused ids).
  forgetUndos();
  forgetRatings();
  document.documentElement.removeAttribute('data-theme');
});
