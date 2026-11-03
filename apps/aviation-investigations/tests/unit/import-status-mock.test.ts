import { describe, expect, it } from 'vitest';
import { AdminOverviewSchema } from '../../shared/contracts/admin.js';
import { mockAdminOverview } from '../../web/mock/admin.js';
import { MOCK_EVIDENCE_RELEASE } from '../../web/mock/evidence.js';
import { mockImports, MOCK_IMPORT_STATES, parseMockImportState } from '../../web/mock/imports.js';
const NOW = new Date('2026-11-01T07:15:00.000Z');
const time = (iso:string) => new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/Prague',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso));
describe('automatic importer mock states', () => {
  it.each(MOCK_IMPORT_STATES)('%s is deterministic, contract-valid and ordered', state => {
    const options = { now:NOW, evidence:MOCK_EVIDENCE_RELEASE, ratings:{useful:0,notUseful:0}, admin:{name:'Alex Example',email:'alex@example.com'}, imports:state };
    const o = AdminOverviewSchema.parse(mockAdminOverview(options));
    expect(mockAdminOverview(options)).toEqual(o);
    const x=o.system.imports;
    expect(x.recentRuns.map(r=>r.checkedAt)).toEqual(x.recentRuns.map(r=>r.checkedAt).sort().reverse());
    for(const r of x.recentRuns) expect(time(r.checkedAt)).toBe('05:30');
    expect(x.alert?.level??(x.enabled?'working':'off')).toBe(x.status);
    if(x.serving) expect(o.system.dataset?.generationId).toBe(x.serving.generationId);
  });
  it.each(['2026-07-05T08:00:00Z','2026-11-01T07:15:00Z'])('schedule follows summer and winter time: %s',iso=>{
    const x=mockImports('healthy',new Date(iso)).imports;
    expect(time(x.schedule!.nextCheckAt!)).toBe('05:30');
    expect(Date.parse(x.schedule!.nextCheckAt!)).toBeGreaterThan(Date.parse(iso));
    expect(time(x.lastStartedAt!)).toBe('05:30');
  });
  it('off never alerts, overdue uses run start, and restored has checked restoration metadata',()=>{
    expect(mockImports('disabled',NOW).imports.alert).toBeNull();
    const overdue=mockImports('overdue',NOW).imports;
    expect(overdue.alert?.since).toBe(overdue.lastStartedAt);
    expect(NOW.getTime()-Date.parse(overdue.lastStartedAt!)).toBeGreaterThan(36*3600000);
    const restored=mockImports('restored',NOW).imports;
    expect(restored.serving?.restoredAt).toBe(restored.alert?.details?.restoration?.restoredAt);
  });
  it('accepts known states only',()=>{
    expect(parseMockImportState('schema')).toBe('schema');
    for(const value of [null,undefined,'__proto__','needs_review','<script>'])expect(parseMockImportState(value)).toBe('healthy');
  });
});
