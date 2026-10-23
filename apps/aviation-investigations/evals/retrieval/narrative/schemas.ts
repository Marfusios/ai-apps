/**
 * Structured outputs of the Track N judges (task 10c protocol v4, sections 2 and 3).
 *
 * - `VerdictSchema`: a grade of the case under the rubric (`relevant` 2, `partial` 1,
 *   `not_relevant` 0; `abstain` only in an adjudicator's final decision), the evidence
 *   it rests on (quotes from sections or passages by their label, coded rows by their
 *   label), whether it rests on something absent from the complete input, and a short
 *   rationale. The relevance judges, the adjudicator (both steps) and the consolidation
 *   of a long case share it, so their cached prompt prefixes match.
 * - `ChunkVerdictSchema`: one part of a long case: a provisional grade for what the
 *   part shows, its evidence and the notes carried forward to the next part.
 * - `AnswerabilitySchema`: the same shape as a verdict, about the delivered passages.
 *
 * The model-facing JSON schema has no length or count limits (OpenAI's strict mode does
 * not take them all); the limits below are checked on the parsed output instead, and an
 * output that breaks them is invalid (one retry, then unjudgeable).
 */
import { z } from 'zod';
import type { Grade } from './spec.js';

export const GRADE_LABELS = ['relevant', 'partial', 'not_relevant'] as const;
export type GradeLabel = (typeof GRADE_LABELS)[number];
export const DECISION_LABELS = [...GRADE_LABELS, 'abstain'] as const;
export type DecisionLabel = (typeof DECISION_LABELS)[number];

export const GRADE_OF: Readonly<Record<GradeLabel, Grade>> = { relevant: 2, partial: 1, not_relevant: 0 };
export const LABEL_OF: Readonly<Record<Grade, GradeLabel>> = { 2: 'relevant', 1: 'partial', 0: 'not_relevant' };

/** Limits checked on the parsed output. */
export const OUTPUT_LIMITS = Object.freeze({ evidence: 8, quoteChars: 400, rationaleChars: 600, absentChars: 400, notesChars: 1_200 });

const EvidenceItem = z.strictObject({
  /** A section (S1..), passage (P1..), finding (F1..) or occurrence (O1..) label. */
  source: z.string(),
  /** Exact text copied from the section or passage; null for a coded row. */
  quote: z.string().nullable(),
});

export const VerdictSchema = z.strictObject({
  grade: z.enum(DECISION_LABELS),
  evidence: z.array(EvidenceItem),
  /** The grade rests on something the complete input does not contain. */
  absent_from_record: z.boolean(),
  /** What is absent, when `absent_from_record`. */
  absent: z.string().nullable(),
  rationale: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const ChunkVerdictSchema = z.strictObject({
  /** What this part, with the carried notes, supports so far. */
  grade: z.enum(GRADE_LABELS),
  evidence: z.array(EvidenceItem),
  /** What the next part needs to know: each rubric condition seen so far and where. */
  notes: z.string(),
});
export type ChunkVerdict = z.infer<typeof ChunkVerdictSchema>;

export const AnswerabilitySchema = z.strictObject({
  /** `abstain` only in an adjudicator's final decision. */
  grade: z.enum(DECISION_LABELS),
  evidence: z.array(EvidenceItem),
  /** The grade rests on something the shown passages do not contain. */
  absent_from_passages: z.boolean(),
  absent: z.string().nullable(),
  rationale: z.string(),
});
export type Answerability = z.infer<typeof AnswerabilitySchema>;

type Json = Record<string, unknown>;
const isNode = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const DROPPED = new Set(['$schema', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format', 'default']);

/**
 * A JSON schema for OpenAI's strict structured outputs: every object closed and every
 * property required (nullable ones are `anyOf` with null), without length or count
 * keywords. Pure; a test checks the shape.
 */
export function strictJsonSchema(schema: z.ZodType): Json {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isNode(node)) return node;
    const out: Json = {};
    for (const [k, v] of Object.entries(node)) {
      if (DROPPED.has(k)) continue;
      out[k] = k === 'properties' && isNode(v) ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, walk(s)])) : walk(v);
    }
    if (out.type === 'object' || isNode(out.properties)) {
      out.additionalProperties = false;
      out.required = Object.keys((out.properties as Json | undefined) ?? {});
    }
    return out;
  };
  return walk(z.toJSONSchema(schema)) as Json;
}
