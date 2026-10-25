/**
 * Searches this tab has just asked for and is opening (Ask AI, Search again, Apply). Once such a
 * search's page is on screen it announces its results and, when focus was lost on the way (the
 * control that asked is gone), moves focus to the results heading (UI_DESIGN §4.9), as a brief's
 * finished step does. A page opened any other way (a link, a reload, Back) leaves focus alone.
 * Memory only: nothing here outlives the tab's page.
 */
const opening = new Set<string>();

/** The search `id` is about to open because this tab asked for it. */
export function expectArrival(id: string): void {
  opening.add(id);
}

/** True once, when the search `id` was opened because this tab asked for it. */
export function takeArrival(id: string): boolean {
  return opening.delete(id);
}
