import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CODE_LABELS,
  FLAG_VOCABULARY,
  NOT_REPORTED_LABEL,
  PHASE_GROUPS,
  PHASE_LABEL,
  codeLabel,
  decodeFlag,
  phaseGroupOf,
  resolveCodeLabels,
  type PhaseGroup,
} from '../../shared/codes.js';

describe('phaseGroupOf', () => {
  it('maps the brief examples', () => {
    expect(phaseGroupOf(453)).toBe('maneuvering');
    expect(phaseGroupOf(601)).toBe('emergency_descent');
    expect(phaseGroupOf(990)).toBe('unknown');
  });

  it('maps every documented range boundary', () => {
    const cases: [number, PhaseGroup][] = [
      [100, 'prior_to_flight'],
      [150, 'standing'], [154, 'standing'],
      [200, 'pushback'], [203, 'pushback'],
      [250, 'taxi'], [253, 'taxi'],
      [300, 'takeoff'], [301, 'takeoff'],
      [350, 'initial_climb'],
      [400, 'en_route'], [405, 'en_route'],
      [450, 'maneuvering'], [453, 'maneuvering'],
      [500, 'approach'], [509, 'approach'],
      [550, 'landing'], [553, 'landing'],
      [600, 'emergency_descent'], [601, 'emergency_descent'],
      [650, 'uncontrolled_descent'],
      [700, 'post_impact'],
      [750, 'after_landing'],
      [800, 'other'],
      [990, 'unknown'],
    ];
    for (const [code, group] of cases) expect(phaseGroupOf(code), String(code)).toBe(group);
  });

  it('maps codes outside the ranges, and non-integers, to unknown', () => {
    for (const code of [0, 99, 101, 149, 155, 204, 254, 302, 351, 406, 454, 510, 554, 602, 651, 701, 751, 801, 999, -100]) {
      expect(phaseGroupOf(code), String(code)).toBe('unknown');
    }
    expect(phaseGroupOf(Number.NaN)).toBe('unknown');
    expect(phaseGroupOf(450.5)).toBe('unknown');
  });
});

describe('phase groups and labels', () => {
  it('lists the groups in flight order with unknown last', () => {
    expect(PHASE_GROUPS).toEqual([
      'prior_to_flight', 'standing', 'pushback', 'taxi', 'takeoff', 'initial_climb', 'en_route',
      'maneuvering', 'approach', 'landing', 'emergency_descent', 'uncontrolled_descent',
      'post_impact', 'after_landing', 'other', 'unknown',
    ]);
  });

  it('labels every group', () => {
    expect(PHASE_LABEL.en_route).toBe('En route');
    expect(PHASE_LABEL.maneuvering).toBe('Maneuvering');
    expect(Object.keys(PHASE_LABEL).sort()).toEqual([...PHASE_GROUPS].sort());
    for (const g of PHASE_GROUPS) expect(PHASE_LABEL[g].length).toBeGreaterThan(0);
  });
});

describe('flag vocabulary', () => {
  it('decodes defining_ev 0/1', () => {
    expect(decodeFlag('defining_ev', '1')).toEqual({ ok: true, value: true });
    expect(decodeFlag('defining_ev', '0')).toEqual({ ok: true, value: false });
    expect(decodeFlag('defining_ev', '')).toEqual({ ok: true, value: null });
  });

  it('decodes afm_hrs_since Y/N', () => {
    expect(decodeFlag('afm_hrs_since', 'Y')).toEqual({ ok: true, value: true });
    expect(decodeFlag('afm_hrs_since', 'N')).toEqual({ ok: true, value: false });
    expect(decodeFlag('afm_hrs_since', '')).toEqual({ ok: true, value: null });
  });

  it('decodes cm_inpc T/F/blank', () => {
    expect(decodeFlag('cm_inpc', 'T')).toEqual({ ok: true, value: true });
    expect(decodeFlag('cm_inpc', 'F')).toEqual({ ok: true, value: false });
    expect(decodeFlag('cm_inpc', '')).toEqual({ ok: true, value: null });
    expect(decodeFlag('cm_inpc', '   ')).toEqual({ ok: true, value: null });
  });

  it('decodes homebuilt Y/N/U', () => {
    expect(decodeFlag('homebuilt', 'Y')).toEqual({ ok: true, value: true });
    expect(decodeFlag('homebuilt', 'N')).toEqual({ ok: true, value: false });
    expect(decodeFlag('homebuilt', 'U')).toEqual({ ok: true, value: null });
  });

  it('never uses truthiness: other spellings are rejected, not coerced', () => {
    // '0' and 'F' are truthy strings; 'false', 'TRUE', 'y', 't' and '1' for a Y/N flag are outside the vocabulary.
    for (const [column, raw] of [
      ['defining_ev', 'Y'], ['defining_ev', 'true'], ['defining_ev', '2'], ['defining_ev', '01'],
      ['cm_inpc', 'TRUE'], ['cm_inpc', 't'], ['cm_inpc', '1'], ['cm_inpc', 'X'],
      ['afm_hrs_since', 'y'], ['afm_hrs_since', '1'], ['afm_hrs_since', 'INSP'],
      ['homebuilt', 'false'],
      ['cm_inpc', 'constructor'], ['cm_inpc', '__proto__'],
    ] as const) {
      expect(decodeFlag(column, raw), `${column}=${raw}`).toEqual({ ok: false, raw });
    }
  });

  it('documents exactly the observed vocabularies', () => {
    expect(Object.keys(FLAG_VOCABULARY.defining_ev).sort()).toEqual(['0', '1']);
    expect(Object.keys(FLAG_VOCABULARY.afm_hrs_since).sort()).toEqual(['N', 'Y']);
    expect(Object.keys(FLAG_VOCABULARY.cm_inpc).sort()).toEqual(['F', 'T']);
  });
});

describe('code labels', () => {
  it('labels injury codes, with blank as not reported', () => {
    expect(codeLabel('ev_highest_injury', 'FATL')).toBe('Fatal');
    expect(codeLabel('ev_highest_injury', 'SERS')).toBe('Serious');
    expect(codeLabel('ev_highest_injury', 'MINR')).toBe('Minor');
    expect(codeLabel('ev_highest_injury', 'NONE')).toBe('None');
    expect(codeLabel('ev_highest_injury', null)).toBe(NOT_REPORTED_LABEL);
    expect(NOT_REPORTED_LABEL).toBe('Not reported');
  });

  it('labels light conditions using the observed codes', () => {
    expect(Object.keys(DEFAULT_CODE_LABELS.light_cond).sort()).toEqual(
      ['DAWN', 'DAYL', 'DUSK', 'NBRT', 'NDRK', 'NITE', 'NR'].sort(),
    );
    expect(codeLabel('light_cond', 'DAYL')).toBe('Day');
    expect(codeLabel('light_cond', 'NDRK')).toBe('Night, dark');
    expect(codeLabel('light_cond', null)).toBe(NOT_REPORTED_LABEL);
  });

  it('labels basic weather; the source spells unknown as Unk', () => {
    expect(codeLabel('wx_cond_basic', 'VMC')).toBe('VMC');
    expect(codeLabel('wx_cond_basic', 'IMC')).toBe('IMC');
    expect(codeLabel('wx_cond_basic', 'UNK')).toBe('Unknown');
    expect(codeLabel('wx_cond_basic', 'Unk')).toBe('Unknown');
  });

  it('falls back to the raw code for an unmapped value', () => {
    expect(codeLabel('light_cond', 'ZZZ')).toBe('ZZZ');
  });

  it('adds dictionary meanings for codes the fixed map lacks and reports them', () => {
    const dictionary = [
      { table: 'events', column: 'light_cond', code_iaids: 'DAYL', meaning: 'Day' },
      { table: 'events', column: 'light_cond', code_iaids: 'TWIL', meaning: 'Twilight' },
      { table: 'events', column: 'wx_cond_basic', code_iaids: 'VMC', meaning: 'Visual Meteorological Cond' },
      { table: 'aircraft', column: 'light_cond', code_iaids: 'XX', meaning: 'ignored: other table' },
    ];
    const resolved = resolveCodeLabels(dictionary);
    expect(resolved.labels.light_cond.TWIL).toBe('Twilight');
    expect(resolved.labels.light_cond.DAYL).toBe('Day');
    // The fixed, product-facing label wins over the truncated dictionary meaning.
    expect(resolved.labels.wx_cond_basic.VMC).toBe('VMC');
    expect(resolved.labels.light_cond.XX).toBeUndefined();
    expect(resolved.addedFromDictionary).toEqual([{ column: 'light_cond', code: 'TWIL', meaning: 'Twilight' }]);
    expect(resolved.source).toBe('fixed+dictionary');
  });

  it('uses the fixed map when no dictionary is available', () => {
    const resolved = resolveCodeLabels(undefined);
    expect(resolved.source).toBe('fixed');
    expect(resolved.labels).toEqual(DEFAULT_CODE_LABELS);
  });
});
