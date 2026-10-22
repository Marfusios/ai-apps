import { describe, expect, it } from 'vitest';
import { storable } from '../../server/briefs/store.js';

describe('storable: diagnostics jsonb accepts', () => {
  it('replaces NUL and unpaired surrogates in strings and keys, keeps everything else', () => {
    const input = {
      summary: 'Power\u0000lost [[case:DFW08TA066]].',
      pairs: 'A whole emoji 😀 stays.',
      lone: ['high \uD800 alone', 'low \uDC00 alone', 'reversed \uDE00\uD83D'],
      ['key\u0000']: { nested: ['\u0000', 1, true, null, 2.5] },
      count: 3,
    };
    expect(storable(input)).toEqual({
      summary: 'Power�lost [[case:DFW08TA066]].',
      pairs: 'A whole emoji 😀 stays.',
      lone: ['high � alone', 'low � alone', 'reversed ��'],
      ['key�']: { nested: ['�', 1, true, null, 2.5] },
      count: 3,
    });
    // The result survives a JSON round trip without any escape jsonb refuses.
    expect(JSON.stringify(storable(input))).not.toMatch(/\\u0000|\\ud[89a-f][0-9a-f]{2}/i);
    // The input is not changed.
    expect(input.summary).toContain('\u0000');
  });
});
