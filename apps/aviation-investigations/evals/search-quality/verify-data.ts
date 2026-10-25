/** Independent full-gold checks using the existing Track C derivation and canonical rows. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CodedQuestionSpecSchema, indexCorpus, deriveQuestion, type CodedCorpus } from '../retrieval/coded/coded.js';
import { BriefFiltersSchema, QuestionSchema } from '../../shared/contracts/briefs.js';
import { eligibleEmittedStates } from '../../shared/state-eligibility.js';
import type { ABDataset, FieldDataset, FieldQuestion } from './types.js';

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
export function verifyData(directory: string, snapshot: string, exclusionsPath: string) {
  const read = (name: string) => JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
  const ab = read('confirmation.json') as ABDataset;
  const fields = read('fields.json') as FieldDataset;
  const raw = JSON.parse(readFileSync(snapshot, 'utf8'));
  const exclusions = JSON.parse(readFileSync(exclusionsPath, 'utf8')) as { cases: string[]; findingFamilies: string[]; eventCodes: string[] };
  const bad = new Set(exclusions.cases);
  const corpus: CodedCorpus = {
    cases: raw.cases.map((r: any) => ({ ntsbNo: r.ntsb_no, evYear: r.ev_year, state: r.state })),
    aircraft: raw.aircraft.map((r: any) => ({ ntsbNo: r.ntsb_no, aircraftKey: r.aircraft_key, category: r.category, definingPhaseGroup: r.defining_phase_group })),
    findings: raw.findings.map((r: any) => ({ ntsbNo: r.ntsb_no, aircraftKey: r.aircraft_key, code: r.code, description: r.description, inProbableCause: r.in_probable_cause })),
    sequence: raw.sequence.map((r: any) => ({ ntsbNo: r.ntsb_no, aircraftKey: r.aircraft_key, eventCode: r.event_code, description: r.description })),
  };
  assert.deepEqual(ab.source, raw.source);
  assert.deepEqual(fields.source, raw.source);
  const index = indexCorpus(corpus);
  const groups = new Map<string, { ids: string[]; cases: Set<string>; family: string; class: string; area: string }>();
  const owners = new Map<string, string>();
  assert.equal(ab.questions.length, 48);
  assert.equal(new Set(ab.questions.map(q => q.id)).size, 48);
  for (const q of ab.questions) {
    const spec = CodedQuestionSpecSchema.parse({ id: q.id, question: q.question, area: q.area, class: q.class,
      filters: q.filters, codeSet: q.codeSet, wording: [q.topic], note: 'New code family, complete coded membership, fresh-case predicate.' });
    const derived = deriveQuestion(index, spec);
    assert.deepEqual(q.relevant, derived.relevant, q.id);
    assert.equal(q.relevant.some(n => bad.has(n)), false, q.id);
    assert.deepEqual(q.executionFilters, {});
    assert(q.relevant.length >= (q.class === 'narrow' ? 1 : 21) && q.relevant.length <= (q.class === 'narrow' ? 20 : 100));
    assert(!exclusions.findingFamilies.includes(q.family) && !exclusions.eventCodes.includes(q.family.slice(2)));
    const group = groups.get(q.group) ?? { ids: [], cases: new Set<string>(), family: q.family, class: q.class, area: q.area };
    assert.equal(group.family, q.family);
    group.ids.push(q.id);
    for (const n of q.relevant) {
      assert(!owners.has(n) || owners.get(n) === q.group, `case connects separate groups: ${q.id}`);
      owners.set(n, q.group); group.cases.add(n);
    }
    groups.set(q.group, group);
  }
  assert.equal(groups.size, 24);
  assert.equal(new Set([...groups.values()].map(g => g.family)).size, 24);
  for (const cls of ['narrow', 'broad']) {
    assert.equal([...groups.values()].filter(g => g.class === cls).length, 12);
    for (const area of ['environment', 'aircraft_systems', 'personnel', 'occurrence']) {
      assert.equal(ab.questions.filter(q => q.class === cls && q.area === area).length, 6);
    }
  }
  const cases = new Map<string, any>(raw.cases.map((r: any) => [r.ntsb_no, r]));
  const used = new Set<string>();
  const qset = new Set<string>();
  const guardGold = { appliedPositive: 0, abstainedPositive: 0, controlsWouldApply: 0 };
  assert.equal(fields.questions.length, 1040);
  for (const q of fields.questions) {
    QuestionSchema.parse(q.question); BriefFiltersSchema.parse(q.gold);
    assert(!qset.has(q.question)); qset.add(q.question);
    for (const n of [q.seed.ntsb_no, ...(q.additionalSeed ? [q.additionalSeed] : [])]) {
      assert(!used.has(n) && !bad.has(n) && !owners.has(n), `field seed reused or exposed: ${q.id}`);
      used.add(n);
    }
    const c = cases.get(q.seed.ntsb_no);
    assert(c && c.source_revision === q.seed.source_revision);
    assert.deepEqual(q.seed, Object.fromEntries(Object.keys(q.seed).map(k => [k, c[k]])));
    const aa = raw.aircraft.filter((a: any) => a.ntsb_no === q.seed.ntsb_no);
    assert.deepEqual(q.aircraft, aa.map((a: any) => ({ aircraft_key: a.aircraft_key, category: a.category, defining_phase_group: a.defining_phase_group })));
    const fieldValue = (c: any, field: FieldQuestion['field']): string => {
      if (field === 'category' || field === 'phase') {
        const a = raw.aircraft.filter((a: any) => a.ntsb_no === c.ntsb_no);
        assert.equal(a.length, 1);
        return a[0][field === 'category' ? 'category' : 'defining_phase_group'];
      }
      return c[({ state: 'state', injury: 'highest_injury', conditions: 'wx_cond_basic', light: 'light_cond' } as Record<string, string>)[field]!];
    };
    if (q.role === 'control') {
      assert.deepEqual(q.gold, {}); assert(q.critical);
    } else if (q.field === 'yearRange') {
      assert(c.ev_year >= (q.gold.yearFrom ?? 1900) && c.ev_year <= (q.gold.yearTo ?? 2100));
    } else {
      const values = [fieldValue(c, q.field)];
      if (q.additionalSeed) {
        const extra = cases.get(q.additionalSeed);
        assert.equal(extra.source_revision, q.additionalSeedRevision);
        const v = fieldValue(extra, q.field);
        assert.equal(v, q.additionalSeedValue); values.push(v);
      }
      assert.deepEqual(q.gold[q.field], [...new Set(values)].sort(), q.id);
    }
    if (q.field === 'state') {
      // This is construction validation with exact gold, not a model score or a tuned output.
      const states = (q.gold.state ?? [q.seed.state]) as string[];
      const guarded = eligibleEmittedStates(q.question, states);
      if (q.role === 'positive') guardGold[guarded.states.length ? 'appliedPositive' : 'abstainedPositive']++;
      else guardGold.controlsWouldApply += Number(guarded.states.length > 0);
    }
  }
  for (const field of ['state', 'yearRange', 'category', 'phase', 'injury', 'conditions', 'light']) {
    for (const role of ['positive', 'control']) assert.equal(fields.questions.filter(q => q.field === field && q.role === role).length, field === 'state' ? 400 : 20);
  }
  const result = { version: 'task24-independent-gold-verification-v1', passed: true,
    hashes: { corpus: hash(snapshot), exclusions: hash(exclusionsPath), confirmation: hash(resolve(directory, 'confirmation.json')), fields: hash(resolve(directory, 'fields.json')) },
    abQuestions: 48, groups: 24, freshGoldCases: owners.size, fieldQuestions: 1040, fieldSeedCases: used.size,
    guardOnConstructedGold: guardGold,
    components: [...groups].map(([id, g]) => ({ id, ...g, cases: [...g.cases].sort() })) };
  writeFileSync(resolve(directory, 'gold-verification.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const { values } = parseArgs({ options: { directory: { type: 'string' }, corpus: { type: 'string' }, exclusions: { type: 'string' } } });
  const r = verifyData(values.directory ?? 'data/work/task24/constructed', values.corpus ?? 'data/work/task24/corpus.json', values.exclusions ?? 'data/work/task24/exclusions.json');
  console.log(JSON.stringify({ passed: r.passed, abQuestions: r.abQuestions, groups: r.groups, fieldQuestions: r.fieldQuestions, guardOnConstructedGold: r.guardOnConstructedGold }));
}
