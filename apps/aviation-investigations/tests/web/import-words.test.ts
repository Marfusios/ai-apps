import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS, alertSentences, reasonWords } from '../../web/src/features/admin/imports';
import { IMPORT_CAP_MICROS } from '../../worker/importer/contracts';
import { mockImports, MOCK_IMPORT_STATES } from '../../web/mock/imports';

describe('automatic importer words and limits',()=>{
  it('names the actual per-file cap and execution deadline',()=>{
    expect(IMPORT_LIMITS.capUsd*1_000_000).toBe(IMPORT_CAP_MICROS);
    expect(IMPORT_LIMITS.capUsd).toBe(2);
    expect(readFileSync('worker/importer/host.ts','utf8')).toContain(`export const IMPORT_DEADLINE_MS = ${IMPORT_LIMITS.deadlineHours} * 3_600_000`);
    expect(IMPORT_LIMITS).toMatchObject({overdueHours:36,delayedDays:3,fixDays:7});
  });
  it.each(MOCK_IMPORT_STATES)('%s has fixed, plain explanations without commands',state=>{
    const x=mockImports(state,new Date('2026-11-01T07:15:00Z')).imports;
    const words=alertSentences(x,'live','UTC').join(' ');
    expect(words).not.toMatch(/\b[a-z]+_[a-z_]+\b|pnpm|approve|rebaseline|acknowledge/);
    if(x.alert) expect(words.length).toBeGreaterThan(50);
    if(x.alert?.siteState==='uncertain')expect(words).not.toContain('The site checks passed');
  });
  it('does not promise nothing to do after a disk failure following a successful import',()=>{
    const x=mockImports('post_success_storage',new Date()).imports;
    const words=alertSentences(x,'live','UTC').join(' ');
    expect(words).toContain('disk space'); expect(words).not.toContain('Nothing for you to do');
    expect(reasonWords('shrunk')).toContain('more than a tenth');
  });
});
