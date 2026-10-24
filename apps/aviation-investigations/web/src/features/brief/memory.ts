/**
 * Questions asked from this page, held in memory only (UI_DESIGN §5 "Brief expired"):
 * when a brief has expired, [Ask again] can refill the box from here, and "Try again"
 * after a failed first step asks with the same filters. Likewise the changes this page
 * sent as refinements, by brief and step: "Try again" after a failed refinement sends the
 * same change (an edited reading's value is not in the step the server returns). Nothing
 * is written to browser storage, and a reload forgets everything, as does signing out
 * (`forgetQuestions`).
 */
import type { BriefFilters, RefinementChange } from '../../../../shared/contracts/briefs';

interface Asked {
  question: string;
  /** The reader's own filters; `undefined` when the question was asked without any. */
  filters: BriefFilters | undefined;
}

const asked = new Map<string, Asked>();
/** Refinements this page sent, by `briefId:step` of the step they started. */
const changes = new Map<string, RefinementChange>();

export function rememberQuestion(briefId: string, question: string, filters?: BriefFilters): void {
  asked.set(briefId, { question, filters });
}

/** The change that started step `step` of a brief, sent from this page. */
export function rememberChange(briefId: string, step: number, change: RefinementChange): void {
  changes.set(`${briefId}:${step}`, change);
}

/** What started step `step` of a brief, if this page sent it; null after a reload or a link. */
export function rememberedChange(briefId: string, step: number): RefinementChange | null {
  return changes.get(`${briefId}:${step}`) ?? null;
}

/** Forget every question and change (the visitor changed: web/src/features/auth/visitor.ts). */
export function forgetQuestions(): void {
  asked.clear();
  changes.clear();
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
