import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../lib/cx';

export type ButtonVariant = 'search' | 'ai' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * `search`: free keyword actions, a blue outline pill.
   * `ai`: anything that runs the AI, a filled magenta pill.
   * `ghost`: quiet blue text actions such as Cancel or Show them.
   */
  variant: ButtonVariant;
  /** Suffix after a middle dot, e.g. "3 free" for "Ask AI · 3 free". */
  counter?: ReactNode;
  size?: 'sm' | 'md';
}

const VARIANT: Record<ButtonVariant, string> = {
  search:
    'border-[1.5px] border-blue text-blue hover:bg-blue-wash disabled:border-hairline disabled:text-muted disabled:hover:bg-transparent',
  ai: 'border-[1.5px] border-magenta bg-magenta text-on-magenta hover:shadow-[0_0_0_3px_var(--magenta-soft)] disabled:border-tint disabled:bg-tint disabled:text-muted disabled:shadow-none',
  ghost: 'border-[1.5px] border-transparent text-blue hover:bg-blue-wash disabled:text-muted disabled:hover:bg-transparent',
};

const SIZE = {
  sm: 'px-[11px] py-[3px] text-meta',
  md: 'px-3.5 py-[5px] text-ui font-bold',
} as const;

export function Button({ variant, counter, size = 'md', type = 'button', className, children, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-full whitespace-nowrap',
        'transition-[background-color,box-shadow] duration-150 disabled:cursor-not-allowed',
        'pointer-coarse:min-h-11',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {children}
      {counter !== undefined && counter !== null && (
        <span className="font-normal">
          {' · '}
          {counter}
        </span>
      )}
    </button>
  );
}
