/**
 * Questions asked from this page, held in memory only (UI_DESIGN §5 "Brief expired"):
 * when a brief has expired, [Ask again] can refill the box from here. Nothing is written
 * to browser storage, and a reload forgets everything.
 */
const asked = new Map<string, string>();

export function rememberQuestion(briefId: string, question: string): void {
  asked.set(briefId, question);
}

export function rememberedQuestion(briefId: string): string | null {
  return asked.get(briefId) ?? null;
}
