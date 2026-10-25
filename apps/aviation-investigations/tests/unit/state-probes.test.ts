/** Mutation-test the actual guard; a removed unsafe alternative must change its identity. */
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { eligibleEmittedStates } from '../../shared/state-eligibility.js';
import { US_STATE, US_STATE_CODES } from '../../shared/vocab.js';
import { stateGuardFingerprint } from '../../server/evidence/auto-filter-probes.js';

const source = readFileSync(new URL('../../shared/state-eligibility.ts', import.meta.url), 'utf8');
const declaration = /^const unsafe = \/(.+)\/i;$/m.exec(source)!;
if (!declaration) throw new Error('state guard unsafe declaration changed; update the mutation test');
const pattern = declaration[1]!;
const mutations = [...pattern.matchAll(/\(\?:([^()]*)\)/g)].flatMap(group => {
  const alternatives = group[1]!.split('|');
  return alternatives.length < 2 ? [] : alternatives.map((alternative, i) => ({
    alternative,
    pattern: pattern.slice(0, group.index!) + '(?:' + alternatives.filter((_, j) => j !== i).join('|') + ')' +
      pattern.slice(group.index! + group[0].length),
  }));
});

// Only trusted repository code is evaluated, offline in Node; nothing from a question
// or a provider becomes code. Keep production's guard, imports and exports untouched.
function loadGuard(text: string): typeof eligibleEmittedStates {
  const js = stripTypeScriptTypes(text.replace(/^import .* from '\.\/vocab\.js';\n/m, '')).replace(/^export /gm, '');
  return runInNewContext(js + '\neligibleEmittedStates;', { US_STATE, US_STATE_CODES }, { timeout: 1000 });
}

describe('state-probes unsafe-context coverage', () => {
  const baseline = stateGuardFingerprint();
  it('reproduces the production fingerprint before mutating the regex', () => {
    expect(mutations.length).toBeGreaterThan(50);
    expect(stateGuardFingerprint(loadGuard(source))).toBe(baseline);
  });
  it.each(mutations)('removing $alternative changes the fingerprint', mutation => {
    const mutated = source.replace(declaration[0], `const unsafe = /${mutation.pattern}/i;`);
    expect(stateGuardFingerprint(loadGuard(mutated))).not.toBe(baseline);
  });
});
