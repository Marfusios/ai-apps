/** Mutation-test the actual guard; a removed unsafe alternative must change its identity. */
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { eligibleEmittedStates } from '../../shared/state-eligibility.js';
import { US_STATE, US_STATE_CODES } from '../../shared/vocab.js';
import { STATE_GUARD_PROBES, stateGuardFingerprint } from '../../server/evidence/auto-filter-probes.js';

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
const quotes = /\/(\[[^\]]+\])(\|[^\n]+)\/u\.test\(text\)/.exec(source);
const controls = /\/(\[[^\]]+\])\/u\.test\(question\)/.exec(source);
if (!quotes || !controls) throw new Error('state guard inline checks changed; update the mutation test');
const controlAtoms = controls[1]!.slice(1, -1).match(/\\u[0-9a-f]{4}(?:-\\u[0-9a-f]{4})?/gi)!;
const inlineMutations = [
  ...[...quotes[1]!.slice(1, -1)].map(character => ({
    name: `quote U+${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    source: source.replace(quotes[0], () => `/${quotes[1]!.replace(character, '')}${quotes[2]}/u.test(text)`),
  })),
  { name: 'apostrophe-quoted form', source: source.replace(quotes[0], () => `/${quotes[1]}/u.test(text)`) },
  ...controlAtoms.map(range => ({ name: `control/bidi ${range}`,
    source: source.replace(controls[0], () => `/${controls[1]!.replace(range, '')}/u.test(question)`),
  })),
];

const otherDeclaration = /^const otherEvent = \/(.+)\/i;$/m.exec(source);
if (!otherDeclaration) throw new Error('state guard other-event declaration changed; update the mutation test');
// Find alternatives at each group depth, including the root OR. A flat regex
// would miss the noun group because it contains crash(?:es)?. Skip escaped
// characters and character classes so their contents cannot become separators.
function alternativesAtEveryDepth(pattern: string) {
  const groups = [{ start: 0, end: pattern.length, pipes: [] as number[] }];
  const stack = [groups[0]!];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') { i++; continue; }
    if (char === '[') { inClass = true; continue; }
    if (char === ']') { inClass = false; continue; }
    if (inClass) continue;
    if (char === '(') {
      if (!pattern.startsWith('(?:', i)) throw new Error('unexpected capturing group in state rule');
      const group = { start: i + 3, end: -1, pipes: [] as number[] };
      groups.push(group); stack.push(group); i += 2;
    } else if (char === ')') stack.pop()!.end = i;
    else if (char === '|') stack.at(-1)!.pipes.push(i);
  }
  return groups.filter(group => group.pipes.length).flatMap(group => {
    const edges = [group.start - 1, ...group.pipes, group.end];
    const alternatives = edges.slice(0, -1).map((start, i) => pattern.slice(start + 1, edges[i + 1]));
    return alternatives.map((alternative, i) => ({ alternative,
      pattern: pattern.slice(0, group.start) + alternatives.filter((_, j) => j !== i).join('|') + pattern.slice(group.end),
    }));
  });
}
const otherMutations = alternativesAtEveryDepth(otherDeclaration[1]!);

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
  it.each(inlineMutations)('removing $name changes the fingerprint', mutation => {
    expect(stateGuardFingerprint(loadGuard(mutation.source))).not.toBe(baseline);
  });
});

describe('v1.2 other-event probe coverage and subset', () => {
  it('covers both branches, every reference, every event noun and both title alternatives', () => {
    expect(otherMutations).toHaveLength(23); // 2 root + 11 references + 8 nouns + 2 title alternatives
  });
  it.each(otherMutations)('removing $alternative changes the fingerprint', mutation => {
    const mutated = source.replace(otherDeclaration[0], () => `const otherEvent = /${mutation.pattern}/i;`);
    expect(stateGuardFingerprint(loadGuard(mutated))).not.toBe(stateGuardFingerprint());
  });
  it('only removes applications from the frozen v1.1 guard across probes and varied emitted sets', () => {
    // Exact source from c59b556, kept as a test fixture rather than loaded from git
    // or reconstructed from the changed implementation. Existing v1/v1.1 tests stay intact.
    const prior = loadGuard(readFileSync(new URL('../fixtures/state-eligibility-v1.1.ts.txt', import.meta.url), 'utf8'));
    const samples = [...STATE_GUARD_PROBES, ...US_STATE_CODES.flatMap(code => [
      `Find events in the state of ${US_STATE[code]}.`,
      `Find events in the state of ${US_STATE[code]} City.`,
      `Find investigations about another accident in the state of ${US_STATE[code]}.`,
      `Find events in the state of ${US_STATE[code]} involving other aircraft.`,
    ].map(question => ({ question, states: [code] })))];
    let retained = 0, removed = 0;
    for (const sample of samples) {
      for (const emitted of [sample.states, [], [...sample.states, ...sample.states], ['AK'], [...sample.states, 'CA'], ['PR']]) {
        const before = prior(sample.question, emitted), after = eligibleEmittedStates(sample.question, emitted);
        if (after.states.length) { expect(after.states).toEqual(before.states); retained++; }
        if (before.states.length && !after.states.length) removed++;
      }
    }
    expect(retained).toBeGreaterThan(50);
    expect(removed).toBeGreaterThan(20); // strictly smaller, not an all-empty or equal-set test
  });
});
