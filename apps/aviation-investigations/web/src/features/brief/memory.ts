/**
 * Questions asked from this page, held in memory only (UI_DESIGN §5 "Brief expired"):
 * when a brief has expired, [Ask again] can refill the box from here, and "Try again"
 * after a failed first step asks with the same filters. Nothing is written to browser
 * storage, and a reload forgets everything.
 */
import type { BriefFilters } from '../../../../shared/contracts/briefs';

interface Asked {
  question: string;
  /** The reader's own filters; `undefined` when the question was asked without any. */
  filters: BriefFilters | undefined;
}

const asked = new Map<string, Asked>();

export function rememberQuestion(briefId: string, question: string, filters?: BriefFilters): void {
  asked.set(briefId, { question, filters });
}

export function rememberedQuestion(briefId: string): string | null {
  return asked.get(briefId)?.question ?? null;
}

/**
 * What this page asked the brief with, or null when it did not ask it (a reload, a link).
 * A brief asked without filters is remembered as that, which is not the same as not
 * remembering it: only the second leaves the reader's filters unknown.
 */
export function rememberedAsk(briefId: string): Asked | null {
  return asked.get(briefId) ?? null;
}
