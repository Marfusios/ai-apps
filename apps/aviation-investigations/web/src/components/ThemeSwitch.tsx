import { cx } from '../lib/cx';
import { THEMES, useTheme } from '../theme';

/**
 * The "DAY | NIGHT" segmented switch (UI_DESIGN §2.8). Until it is used, the
 * theme follows the device; a choice is remembered on this device only.
 */
export function ThemeSwitch({ className }: { className?: string }) {
  const [theme, setTheme] = useTheme();
  return (
    <div
      role="group"
      aria-label="Colour theme"
      className={cx(
        'inline-flex shrink-0 rounded-full border border-hairline p-0.5 text-micro font-bold tracking-caps',
        className,
      )}
    >
      {THEMES.map((option) => {
        const on = theme === option;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={on}
            onClick={() => setTheme(option)}
            className={cx(
              'cursor-pointer rounded-full px-2 py-0.5 uppercase pointer-coarse:min-h-11 pointer-coarse:px-3',
              on ? 'bg-blue text-on-blue' : 'text-muted hover:text-ink',
            )}
          >
            {option === 'day' ? 'Day' : 'Night'}
          </button>
        );
      })}
    </div>
  );
}
