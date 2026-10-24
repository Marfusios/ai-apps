/**
 * compose.yaml settings that must agree with the code (ops review O5, O8). Read as text: the
 * unit tests run without Docker.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_DIR = resolve(import.meta.dirname, '../..');
const compose = readFileSync(resolve(APP_DIR, 'compose.yaml'), 'utf8');

/** The service block `name:` (two-space indent) up to the next service or top-level key. */
function service(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`compose.yaml has no service ${name}`);
  const rest = compose.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n|\n[a-z]/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

const seconds = (value: string): number => {
  const m = /^(\d+)s$/.exec(value);
  if (!m) throw new Error(`unexpected duration ${value}`);
  return Number(m[1]);
};

describe('compose.yaml', () => {
  it('gives the app longer to stop than its own forced exit, so Docker never kills a shutdown in progress', () => {
    const main = readFileSync(resolve(APP_DIR, 'server/main.ts'), 'utf8');
    const forced = /setTimeout\(\(\) => process\.exit\(1\), ([\d_]+)\)/.exec(main)?.[1];
    expect(forced).toBeDefined();
    const forcedMs = Number(forced!.replaceAll('_', ''));
    const grace = /\n {4}stop_grace_period: (\S+)\n/.exec(service('aviation-app'))?.[1];
    expect(grace, 'aviation-app needs stop_grace_period').toBeDefined();
    // Docker's default is 10 s, the same as the forced exit: SIGKILL could end a step settling at the deadline.
    expect(seconds(grace!) * 1000).toBeGreaterThanOrEqual(forcedMs + 5000);
  });

  it('does not pass AI_PARTIAL_DISPLAY to the app until gate G6 clears claim-level display (RUNBOOK, "Enabling partial display")', () => {
    expect(service('aviation-app')).not.toContain('AI_PARTIAL_DISPLAY');
    const runbook = readFileSync(resolve(APP_DIR, 'docs/RUNBOOK.md'), 'utf8');
    expect(runbook).toMatch(/compose\.yaml\s+does not pass `AI_PARTIAL_DISPLAY`/);
  });
});
