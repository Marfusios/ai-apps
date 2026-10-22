/**
 * Short passage aliases for the model-facing stage inputs. A canonical passage id is a
 * 64-character hex hash, which costs about 42 Claude tokens wherever a model reads or
 * writes it (measured with the provider's counter, Post-E2E fix): a full compose output
 * cites passages some 60 times and a full check input some 150. So the compose and check
 * stages see `P1`..`P12`, numbered in bundle order, and nothing else changes:
 *
 * - `composeForModel` / `checkForModel` replace every passage id the input carries;
 * - `compositionFromModel` maps every passage id the composition cites back to its
 *   canonical id before validation. An alias the bundle does not hold is left as it is,
 *   so validation refuses it (`unknown_passage`) as it refuses any unknown id.
 *
 * The check output names claims by index, so it needs no mapping.
 */
import { ComposeOutputSchema, type ComposeOutput } from '../../shared/contracts/briefs.js';
import type { CheckInput, ComposeInput } from '../ai/provider.js';

export interface PassageAliases {
  /** Canonical id → alias. */
  readonly toModel: ReadonlyMap<string, string>;
  /** Alias → canonical id. */
  readonly fromModel: ReadonlyMap<string, string>;
}

/** `P1`..`Pn` for the passages of a bundle, in bundle order (deterministic for the same bundle). */
export function passageAliases(cases: readonly { passages: readonly { passageId: string }[] }[]): PassageAliases {
  const toModel = new Map<string, string>();
  const fromModel = new Map<string, string>();
  for (const c of cases) {
    for (const p of c.passages) {
      if (toModel.has(p.passageId)) continue;
      const alias = `P${toModel.size + 1}`;
      toModel.set(p.passageId, alias);
      fromModel.set(alias, p.passageId);
    }
  }
  return { toModel, fromModel };
}

const to = (a: PassageAliases) => (id: string) => a.toModel.get(id) ?? id;
const from = (a: PassageAliases) => (id: string) => a.fromModel.get(id) ?? id;

/** The compose input as the model reads it. */
export function composeForModel(input: ComposeInput, a: PassageAliases): ComposeInput {
  const alias = to(a);
  return { ...input, cases: input.cases.map((c) => ({ ...c, passages: c.passages.map((p) => ({ ...p, passageId: alias(p.passageId) })) })) };
}

/** The check input as the model reads it. */
export function checkForModel(input: CheckInput, a: PassageAliases): CheckInput {
  const alias = to(a);
  return {
    ...input,
    passages: input.passages.map((p) => ({ ...p, passageId: alias(p.passageId) })),
    claims: input.claims.map((c) => ({ ...c, passageIds: c.passageIds.map(alias) })),
  };
}

/**
 * The composition with canonical passage ids, for validation and everything after it.
 * A composition outside its schema is returned unchanged: validation refuses it anyway.
 */
export function compositionFromModel(c: ComposeOutput, a: PassageAliases): ComposeOutput {
  if (!ComposeOutputSchema.safeParse(c).success) return c;
  const id = from(a);
  const ids = (xs: readonly string[]) => xs.map(id);
  return {
    ...c,
    cases: c.cases.map((k) => ({
      ...k,
      quotes: k.quotes.map((q) => ({ ...q, passageId: id(q.passageId) })),
      evidencePassageIds: ids(k.evidencePassageIds),
      ...(k.maintenance ? { maintenance: { ...k.maintenance, passageIds: ids(k.maintenance.passageIds) } } : {}),
      ...(k.symptom ? { symptom: { ...k.symptom, passageIds: ids(k.symptom.passageIds) } } : {}),
      ...(k.chronology
        ? {
            chronology: {
              ...(k.chronology.flightHours ? { flightHours: { ...k.chronology.flightHours, passageIds: ids(k.chronology.flightHours.passageIds) } } : {}),
              ...(k.chronology.calendarDays ? { calendarDays: { ...k.chronology.calendarDays, passageIds: ids(k.chronology.calendarDays.passageIds) } } : {}),
              ...(k.chronology.flight ? { flight: { ...k.chronology.flight, passageIds: ids(k.chronology.flight.passageIds) } } : {}),
              ...(k.chronology.qualitative ? { qualitative: { passageIds: ids(k.chronology.qualitative.passageIds) } } : {}),
            },
          }
        : {}),
    })),
    gaps: c.gaps.map((g) => ({ ...g, passageIds: ids(g.passageIds) })),
  };
}
