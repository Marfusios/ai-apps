import { fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { AdminOverviewSchema, type AdminOverview } from '../../shared/contracts/admin';
import { mockAdminOverview } from '../../web/mock/admin';
import { MOCK_EVIDENCE_RELEASE } from '../../web/mock/evidence';
import { MOCK_IMPORT_STATES, type MockImportState } from '../../web/mock/imports';
import { formatDateTime, viewerTimeZone } from '../../web/src/features/admin/format';
import { alertDetails, sourceDay } from '../../web/src/features/admin/imports';
import { MOCK_USER, createHandlers } from '../../web/src/mocks/handlers';
import { ADMIN_COPY } from '../../web/src/pages/Admin';
import { renderApp, setupMockApi } from './render-app';
const server=setupMockApi();
const NOW=new Date('2026-11-01T07:15:00Z');
function serve(state:MockImportState,change:(o:AdminOverview)=>AdminOverview=o=>o):AdminOverview {
  window.sessionStorage.setItem('casebook-mock-account',JSON.stringify({signedIn:true,registered:true}));
  server.use(...createHandlers({googleEnabled:true,admin:true,evidence:MOCK_EVIDENCE_RELEASE,imports:state}));
  const o=AdminOverviewSchema.parse(change(mockAdminOverview({now:NOW,evidence:MOCK_EVIDENCE_RELEASE,ratings:{useful:0,notUseful:0},admin:MOCK_USER,imports:state})));
  server.use(http.get('*/api/admin/overview',()=>HttpResponse.json(o,{headers:{'cache-control':'private, no-store'}})));
  return o;
}
async function open() {
  renderApp('/admin');
  await screen.findByRole('heading',{level:1,name:ADMIN_COPY.title}, {timeout:5000});
  const system=await screen.findByRole('region',{name:ADMIN_COPY.system},{timeout:5000});
  return system.querySelector('[data-imports]') as HTMLElement;
}
const fact=(block:HTMLElement,label:string)=>block.querySelector(`[data-fact="${label}"] dd`)?.textContent??'';
describe('automatic import alerts and facts',{timeout:20000},()=>{
  it.each(MOCK_IMPORT_STATES)('%s shows server severity and no review controls',async state=>{
    const o=serve(state);const block=await open();const a=o.system.imports.alert;
    const alert=document.querySelector('[data-import-alert]');
    expect(Boolean(alert)).toBe(Boolean(a));
    if(a){
      expect(alert!.getAttribute('data-import-alert')).toBe(a.level);
      expect(alert!.classList.contains(a.level==='fix'?'border-l-magenta':'border-l-ink')).toBe(true);
      expect(alert!.compareDocumentPosition(block)&Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      expect(within(alert as HTMLElement).getByRole('button',{name:'Copy details'})).not.toBeNull();
      expect(alert!.querySelector('code')?.textContent).toBe(alertDetails(o.system.imports,viewerTimeZone(),true));
    }
    const copy=document.querySelector('main')!.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[data-import-details]').forEach(x=>x.remove());
    expect(copy.textContent).not.toMatch(/needs_review|source_unavailable|pnpm importer|rebaseline|approve|acknowledge-preartifact/);
    expect(within(block).getByRole('list',{name:'Recent import runs'})).not.toBeNull();
  });
  it('shows new, updated and removed counts and import cost, without generation IDs in the outcome',async()=>{
    serve('published');const block=await open();
    expect(block.textContent).toContain('152 new cases, 501 updated, 2 removed');
    expect(within(block).getByRole('list').textContent).toContain('$0.19');
    expect(fact(block,'Data on the site')).toContain('31 Oct 2026');
    expect(fact(block,'Next check')).toContain('Every day at 05:30, Europe/Prague');
  });
  it('copies technical diagnostics and exposes clipboard failure accessibly',async()=>{
    const o=serve('schema');await open();
    const writeText=vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
    fireEvent.click(screen.getByRole('button',{name:'Copy details'}));
    await screen.findByText('Details copied.');
    expect(writeText).toHaveBeenCalledWith(alertDetails(o.system.imports,viewerTimeZone()));
    writeText.mockRejectedValueOnce(new Error('unavailable'));
    fireEvent.click(screen.getByRole('button',{name:'Copy details'}));
    const failed=await screen.findByText('Copy did not work. Select the details above.');
    expect(failed.getAttribute('aria-live')).toBe('polite');
  });
  it('overdue names the actual last start, while source dates never shift timezone',async()=>{
    const o=serve('overdue');await open();
    expect(document.querySelector('[data-import-alert]')?.textContent).toContain(`No import check has run since ${formatDateTime(o.system.imports.lastStartedAt!,viewerTimeZone())}`);
    expect(sourceDay('2026-11-01T00:00:00')).toBe('1 Nov 2026');
  });
  it('explains dev holding live, and a successful import with a separate later incident',async()=>{
    serve('dev_failed',o=>({...o,system:{...o.system,appEnv:'live'}}));await open();
    expect(document.querySelector('[data-import-alert]')?.textContent).toContain('Live was not touched');
  });
  it('keeps a post-success import done and shows the incident separately',async()=>{
    serve('post_success_storage');const block=await open();
    expect(document.querySelector('[data-import-alert]')?.textContent).toContain('The import finished');
    expect(within(block).getByRole('list').textContent).toContain('Imported the');
    expect(fact(block,'Data on the site')).toContain('Imported');
  });
});
