/**
 * Home's static import graph stays free of the AI briefs' and the evidence view's contracts and
 * copy: they load with the first AI request or the evidence page, never with the home page
 * (index.html would otherwise preload their chunks). A walk over the source's value imports,
 * as the bundler follows them; type-only imports and dynamic `import()` are left out.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The module a relative import names, as Vite resolves it (`.ts`, `.tsx`, `.js` → `.ts`, or an index). */
function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec.replace(/\.js$/, ''));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      try {
        readFileSync(candidate, 'utf8');
        return candidate;
      } catch {
        // a directory
      }
    }
  }
  return null;
}

/** The value imports and re-exports of a module (each `import type`, and any import naming only types, left out). */
function valueImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of source.matchAll(/^(?:import|export)\s+([\s\S]*?)\s+from\s+'([^']+)';?$/gm)) {
    const clause = (m[1] ?? '').trim();
    const spec = m[2] ?? '';
    if (clause.startsWith('type ')) continue;
    const braces = /\{([\s\S]*)\}/.exec(clause);
    const outside = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim();
    if (braces && outside === '') {
      const names = (braces[1] ?? '').split(',').map((n) => n.trim()).filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue;
    }
    out.push(spec);
  }
  for (const m of source.matchAll(/^import\s+'([^']+)';?$/gm)) out.push(m[1] ?? '');
  return out;
}

function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const todo = [entry];
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of valueImports(file)) {
      const next = resolveImport(file, spec);
      if (next && !seen.has(next)) todo.push(next);
    }
  }
  return seen;
}

describe('the home page loads no AI contract or copy', () => {
  it('Home’s value imports reach neither the briefs’ nor the evidence view’s contracts, nor the evidence copy', () => {
    const graph = [...reachable(join(APP, 'web/src/pages/Home.tsx'))].map((f) => relative(APP, f));
    expect(graph).toContain('web/src/features/evidence/useEvidenceSearch.ts');
    for (const kept of ['shared/contracts/briefs.ts', 'shared/contracts/evidence.ts', 'web/src/features/evidence/display.ts', 'web/src/features/evidence/api.ts']) {
      expect(graph, kept).not.toContain(kept);
    }
  });
});
