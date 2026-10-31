/** Bounded process-local checklist. No question, text, cookies or upstream messages. */
import type { EvidenceProgress } from '../../shared/contracts/evidence.js';
import type { RankingObserver } from './pipeline.js';

const TTL = 5 * 60_000;
interface Entry { searchId: string; owner: { hash: string; kind: string }; expires: number; progress: EvidenceProgress }
export class EvidenceProgressStore {
  private entries = new Map<string, Entry>();
  constructor(private now = Date.now, private max = 1000) {}
  private trim() {
    for (const [key, entry] of this.entries) if (entry.expires <= this.now()) this.entries.delete(key);
    while (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
  }
  start(principal: string, key: string, searchId: string, skipScope: boolean, rerank: boolean, owner: Entry['owner']) {
    this.trim();
    const id = `${principal}:${key}`;
    const entry: Entry = { searchId, owner, expires: this.now() + TTL, progress: {
      state: 'running', startedAt: new Date(this.now()).toISOString(),
      question: { status: skipScope ? 'skipped' : 'pending', result: null },
      search: { status: 'pending', cases: null },
      order: { status: rerank ? 'pending' : 'skipped', result: rerank ? null : 'match' },
    } };
    this.entries.set(id, entry);
    const observer: RankingObserver = {
      onStage: stage => {
        const target = stage === 'scope' ? entry.progress.question : stage === 'retrieval' ? entry.progress.search : entry.progress.order;
        if (target.status !== 'skipped') target.status = 'running';
      },
      onQuestion: (result, failed) => {
        if (entry.progress.question.status !== 'skipped') entry.progress.question = { status: failed ? 'failed' : 'done', result };
      },
      onRetrieved: cases => { entry.progress.search = { status: 'done', cases }; },
      onOrdered: (applied, skipped) => { entry.progress.order = { status: skipped ? 'skipped' : applied ? 'done' : 'failed', result: applied ? 'ai_relevance' : 'match' }; },
    };
    return { observer, finish: (ok: boolean) => {
      entry.progress.state = ok ? 'done' : 'failed'; entry.expires = this.now() + TTL;
      for (const stage of [entry.progress.question, entry.progress.search, entry.progress.order]) if (stage.status === 'running') stage.status = 'failed';
    } };
  }
  read(principal: string, key: string): Pick<Entry, 'searchId' | 'owner' | 'progress'> | null {
    const id = `${principal}:${key}`, entry = this.entries.get(id);
    if (!entry || entry.expires <= this.now()) { this.entries.delete(id); return null; }
    this.entries.delete(id); this.entries.set(id, entry);
    return { searchId: entry.searchId, owner: { ...entry.owner }, progress: structuredClone(entry.progress) };
  }
}
