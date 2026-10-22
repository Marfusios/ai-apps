import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeSwitch } from '../../web/src/components/ThemeSwitch';
import { THEME_STORAGE_KEY, initTheme, readStoredTheme, resetThemeChoiceForTests } from '../../web/src/theme';
import { stubColorScheme } from './helpers';

let stopFollowing: () => void = () => {};

beforeEach(() => resetThemeChoiceForTests());
afterEach(() => stopFollowing());

describe('theme persistence', () => {
  it('ThemeSwitch stores the choice in localStorage', () => {
    stubColorScheme(false);
    stopFollowing = initTheme();
    render(<ThemeSwitch />);
    fireEvent.click(screen.getByRole('button', { name: 'Night' }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('night');
    expect(readStoredTheme()).toBe('night');
  });

  it('a stored choice wins over the device setting', () => {
    stubColorScheme(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'night');
    stopFollowing = initTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('night');
  });

  it('ignores a stored value that is not a theme', () => {
    stubColorScheme(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    stopFollowing = initTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('night');
  });

  it('follows prefers-color-scheme until the user chooses', () => {
    const scheme = stubColorScheme(false);
    stopFollowing = initTheme();
    render(<ThemeSwitch />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('day');

    act(() => scheme.set(true));
    expect(document.documentElement.getAttribute('data-theme')).toBe('night');
    expect(screen.getByRole('button', { name: 'Night' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    act(() => scheme.set(false));
    act(() => scheme.set(true));
    expect(document.documentElement.getAttribute('data-theme')).toBe('day');
  });

  it('works when localStorage throws on read and write', () => {
    stubColorScheme(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(() => {
      stopFollowing = initTheme();
    }).not.toThrow();
    expect(readStoredTheme()).toBeNull();
    expect(document.documentElement.getAttribute('data-theme')).toBe('night');

    render(<ThemeSwitch />);
    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'day');
    expect(document.documentElement.getAttribute('data-theme')).toBe('day');
  });

  it('defaults to day without matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined);
    stopFollowing = initTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('day');
  });
});
