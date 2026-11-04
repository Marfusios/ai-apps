/**
 * Task 30's frozen attribution probes: a development family and an unseen confirmation family,
 * each in its own file, validated strictly before any call. `forced` is what a scope could emit
 * for the question (the scripted scope returns it as is); `gold` is what a careful reader would
 * apply automatically. Neither is ever shown to a model.
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { FACET_VALUES } from '../../shared/contracts/search.js';
import { US_STATE_CODES } from '../../shared/vocab.js';
import { sha } from '../search-quality/frozen.js';
import { EvaluationError } from '../search-quality/money.js';

export const PROBE_VERSION = 'task30-probes-v1';
export const PROBE_DIR = 'evals/auto-filters/frozen';
export const PROBE_QUESTION_MAX = 300;
export const PROBE_FAMILIES = {
  dev: { path: `${PROBE_DIR}/probes-dev.json`, sources: ['writer-a', 'writer-b', 'review-24', 'codex', 'controller'] },
  confirm: { path: `${PROBE_DIR}/probes-confirm.json`, sources: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] },
} as const;
export type ProbeFamily = keyof typeof PROBE_FAMILIES;
export const PROBE_SOURCES = [...PROBE_FAMILIES.dev.sources, ...PROBE_FAMILIES.confirm.sources] as const;
export const PROBE_FIELDS = ['state', 'years', 'category', 'mixed'] as const;
export const PROBE_KINDS = ['trap', 'positive', 'mixed'] as const;

const listed = (values: readonly string[]) => z.array(z.enum(values as [string, ...string[]])).min(1).max(values.length)
  .refine(v => new Set(v).size === v.length, 'repeated value');
const Year = z.number().int().min(1900).max(2100);
/** Any four-digit number the question writes ("1500 hours" is a trap); outside 1900-2100 a scope's answer carrying it is invalid. */
const ForcedYear = z.number().int().min(1000).max(9999);
const ordered = (f: { yearFrom?: number; yearTo?: number }) => f.yearFrom === undefined || f.yearTo === undefined || f.yearFrom <= f.yearTo;
/**
 * What a naive scope might emit: state and category codes from the scope's vocabulary (without `blank`),
 * years as written. A value the scope schema cannot carry makes the scripted answer invalid, so the
 * pipeline falls back exactly as it would for a real scope's (reported as `scope:invalid_output`).
 */
export const ProbeForcedSchema = z.strictObject({
  state: listed(FACET_VALUES.state.filter(v => v !== 'blank')).optional(),
  yearFrom: ForcedYear.optional(), yearTo: ForcedYear.optional(),
  category: listed(FACET_VALUES.category.filter(v => v !== 'blank')).optional(),
}).refine(ordered, 'yearFrom after yearTo').refine(f => Object.keys(f).length > 0, 'forced names no field');
/** What may be applied automatically: US states and DC, a year range, aircraft categories (never UNK). */
export const ProbeGoldSchema = z.strictObject({
  state: listed(US_STATE_CODES).optional(),
  yearFrom: Year.optional(), yearTo: Year.optional(),
  category: listed(FACET_VALUES.category.filter(v => v !== 'blank' && v !== 'UNK')).optional(),
}).refine(ordered, 'yearFrom after yearTo');
export const ProbeSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/),
  question: z.string().min(1).max(PROBE_QUESTION_MAX).regex(/\S/, 'empty question'),
  forced: ProbeForcedSchema,
  gold: ProbeGoldSchema,
  field: z.enum(PROBE_FIELDS),
  kind: z.enum(PROBE_KINDS),
  pattern: z.string().min(1).max(80).regex(/^[^\p{Cc}\p{Cf}]+$/u, 'control characters'),
  source: z.enum(PROBE_SOURCES),
}).refine(p => p.field === 'mixed' || (p.field === 'years'
  ? p.forced.yearFrom !== undefined || p.forced.yearTo !== undefined : p.forced[p.field] !== undefined), 'forced lacks the probe field');
export type Probe = z.infer<typeof ProbeSchema>;
export const ProbeFileSchema = z.strictObject({ version: z.literal(PROBE_VERSION), probes: z.array(ProbeSchema).min(1) });
export type ProbeFile = z.infer<typeof ProbeFileSchema>;

const normalQuestion = (q: string) => q.replace(/\s+/gu, ' ').trim().toLowerCase();

/** Schema, family sources, unique ids and unique (whitespace- and case-normalised) questions; every problem at once. */
export function validateProbes(value: unknown, family: ProbeFamily): ProbeFile {
  const parsed = ProbeFileSchema.safeParse(value);
  if (!parsed.success) {
    const lines = parsed.error.issues.slice(0, 20).map(i => `${i.path.join('.') || '(file)'}: ${i.message}`);
    throw new EvaluationError(`Invalid ${family} probe file (${parsed.error.issues.length} problems): ${lines.join('; ')}`);
  }
  const problems: string[] = [];
  const allowed = PROBE_FAMILIES[family].sources as readonly string[];
  const ids = new Set<string>(), questions = new Map<string, string>();
  for (const p of parsed.data.probes) {
    if (!allowed.includes(p.source)) problems.push(`${p.id}: source ${p.source} is not a ${family} source`);
    if (ids.has(p.id)) problems.push(`${p.id}: repeated id`);
    ids.add(p.id);
    const q = normalQuestion(p.question);
    if (questions.has(q)) problems.push(`${p.id}: same question as ${questions.get(q)}`);
    else questions.set(q, p.id);
  }
  if (problems.length) throw new EvaluationError(`Invalid ${family} probe file (${problems.length} problems): ${problems.slice(0, 20).join('; ')}`);
  return parsed.data;
}

export interface LoadedProbes { family: ProbeFamily; path: string; sha256: string; file: ProbeFile }
/** The frozen file's bytes, sha256 and validated content; null when the controller has not frozen it yet. */
export function loadProbes(family: ProbeFamily, path: string = PROBE_FAMILIES[family].path): LoadedProbes | null {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new EvaluationError(`The ${family} probe file is not JSON`); }
  return { family, path, sha256: sha(bytes), file: validateProbes(value, family) };
}

/**
 * Labelling diagnostics that do not invalidate the file: a probe's `kind` disagreeing with its main
 * field's forced-versus-gold relation, or gold naming a field that `forced` does not (it can never be
 * applied in a forced run). Reported by the preflight; scoring never uses `kind`.
 */
export function probeWarnings(file: ProbeFile) {
  const key = (f: Probe['forced'] | Probe['gold'], field: 'state' | 'years' | 'category') => field === 'years'
    ? (f.yearFrom === undefined && f.yearTo === undefined ? null : `${f.yearFrom ?? ''}..${f.yearTo ?? ''}`)
    : (f[field] ? [...f[field]!].sort().join(',') : null);
  const out = { kindMismatch: [] as string[], goldNotForced: [] as string[] };
  for (const p of file.probes) {
    for (const field of ['state', 'years', 'category'] as const) {
      if (key(p.gold, field) !== null && key(p.forced, field) === null) out.goldNotForced.push(`${p.id}:${field}`);
    }
    if (p.field === 'mixed' || p.kind === 'mixed') continue;
    const positive = key(p.forced, p.field) === key(p.gold, p.field);
    if ((p.kind === 'positive') !== positive) out.kindMismatch.push(p.id);
  }
  return out;
}
