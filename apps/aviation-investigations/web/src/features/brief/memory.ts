/**
 * Questions asked from this page, held in memory only (UI_DESIGN §5 "Brief expired"):
 * when a brief has expired, [Ask again] can refill the box from here, and "Try again"
 * after a failed first step asks with the same filters. Nothing is written to browser
 * storage, and a reload forgets everything.
 */
import type { BriefFilters } from '../../../../shared/contracts/briefs';

const asked = new Map<string, { question: string; filters: BriefFilters | undefined }>();

export function rememberQuestion(briefId: string, question: string, filters?: BriefFilters): void {
  asked.set(briefId, { question, filters });
}

export function rememberedQuestion(briefId: string): string | null {
  return asked.get(briefId)?.question ?? null;
}

/** The filters the brief was asked with from this page, if it was. */
export function rememberedFilters(briefId: string): BriefFilters | undefined {
  return asked.get(briefId)?.filters;
}
