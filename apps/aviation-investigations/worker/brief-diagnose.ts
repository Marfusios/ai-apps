/**
 * `pnpm worker brief-diagnose <brief-id> [--step <n>]`: why a withheld step's summary
 * was withheld, for a developer. It prints the step's content-free reasons from its
 * `meta` (validation codes with their paths, failed criteria, check problems, the
 * failure category) next to the text they point at, from the step's server-side
 * `diagnostics`: the offending summary sentence as the validator split it, the `why`
 * line, quote or note, the checker's claim. A withheld composition is model output about
 * public NTSB passages (it may restate the reader's question); this command prints it to
 * the operator's terminal and nowhere else.
 *
 * Read-only, as aviation_app (DATABASE_URL: aviation_ingest cannot read briefs). Only an
 * operator runs it, by hand; no job or route does. A brief's diagnostics are pruned with
 * the brief (`prune_controls()`, 24 hours after it was created).
 */
import type { Db } from '../server/db/client.js';
import { readStepDiagnostics, type StepDiagnostics, type StepRow } from '../server/briefs/store.js';

const CLIP = 600;

const clip = (s: string) => (s.length > CLIP ? `${s.slice(0, CLIP)}… (${s.length} characters)` : s);

/** A value for the terminal: strings JSON-quoted, so whitespace and markers show exactly. */
function show(v: unknown): string {
  if (v === undefined) return '(nothing at this path)';
  return typeof v === 'string' ? JSON.stringify(clip(v)) : clip(JSON.stringify(v) ?? String(v));
}

/** The value at a dotted path (`cases.1.why`, `groups.0.caseNumbers.2`) of a parsed JSON value. */
export function valueAt(root: unknown, path: string): unknown {
  let v: unknown = root;
  for (const seg of path.split('.')) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, seg)) return undefined;
    v = (v as Record<string, unknown>)[seg];
  }
  return v;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A passage alias with the canonical id it stands for. */
function passage(alias: unknown, d: StepDiagnostics): string {
  if (typeof alias !== 'string') return show(alias);
  const id = Object.hasOwn(d.aliases, alias) ? d.aliases[alias] : undefined;
  return id ? `${alias} = ${id}` : `${JSON.stringify(alias)} (not an alias of the bundle)`;
}

/** What a validation reason's path points at: the summary sentence, a text field or a passage alias. */
function offending(path: string, d: StepDiagnostics): string[] {
  const sentence = /^summary\.(\d+)$/.exec(path);
  if (sentence) return [`sentence ${sentence[1]}: ${show(d.summarySentences[Number(sentence[1])])}`];
  const provenance = /^passages\.(.+)$/.exec(path);
  if (provenance) return [`passage ${passage(provenance[1], d)}`];
  if (path === '(root)') return [`composition: ${show(d.composition)}`];
  const v = valueAt(d.composition, path);
  // An id field (`passageId`, `evidencePassageIds.1`, `gaps.0.passageIds.0`) holds an alias.
  const lines = [/passageids?(\.\d+)?$/i.test(path) && typeof v === 'string' ? `passage ${passage(v, d)}` : show(v)];
  // A quote is located in the passage it cites.
  const quote = /^(cases\.\d+\.quotes\.\d+)\.quote$/.exec(path);
  if (quote) lines.push(`cites passage ${passage(valueAt(d.composition, `${quote[1]}.passageId`), d)}`);
  return lines;
}

/** The report for one step: its outcome, then each reason with the text it points at. */
export function formatDiagnosis(step: StepRow, d: StepDiagnostics | null): string[] {
  const meta = step.meta;
  const result = step.result;
  const reason = result?.kind === 'withheld' ? result.reason : null;
  const out = [`brief ${step.briefId}, step ${step.n}: ${step.status}${reason ? ` (${reason})` : ''}`];
  const failure = meta.failure;
  if (isRecord(failure)) out.push(`failure: ${String(failure.stage)} ${String(failure.category)}${failure.reason ? ` (${String(failure.reason)})` : ''}`);
  if (isRecord(meta.stopReasons)) out.push(`stop reasons: ${Object.entries(meta.stopReasons).map(([k, v]) => `${k}=${String(v)}`).join(', ')}`);
  if (isRecord(meta.warnings)) out.push(`warnings: ${Object.entries(meta.warnings).map(([k, v]) => `${k}=${asArray(v).join('+')}`).join(', ')}`);
  if (!d) {
    out.push(
      step.status === 'withheld'
        ? 'no diagnostics: the summary was withheld before a composition existed (compose_failed), or the step predates them'
        : 'no diagnostics: only a withheld summary keeps them',
    );
    return out;
  }

  const validation = isRecord(meta.validation) ? meta.validation : {};
  if (d.reason === 'citation_check') {
    const reasons = asArray(validation.reasons).filter(isRecord);
    out.push(`validation (${String(validation.ruleVersion)}): ${reasons.length} reason(s), summary split into ${d.summarySentences.length} sentence(s)`);
    for (const r of reasons) {
      out.push(`  ${String(r.code)} at ${String(r.path)}`);
      for (const line of offending(String(r.path), d)) out.push(`    ${line}`);
    }
  } else if (d.reason === 'criteria_check') {
    const failed = asArray(meta.criteria).filter(isRecord).filter((c) => c.decision === 'does_not_match');
    out.push(`criteria: ${failed.length} decision(s) outside the reader's criteria`);
    const cases = asArray(valueAt(d.composition, 'cases')).filter(isRecord);
    for (const c of failed) {
      out.push(`  ${String(c.ntsbNo)} ${String(c.criterion)}: does_not_match`);
      const k = cases.find((x) => x.ntsbNo === c.ntsbNo);
      out.push(`    why: ${show(k?.why)}`);
      if (k?.chronology !== undefined) out.push(`    chronology: ${show(k.chronology)}`);
      if (k?.symptom !== undefined) out.push(`    symptom: ${show(k.symptom)}`);
    }
  } else {
    const check = isRecord(meta.check) ? meta.check : null;
    const claims = d.claims ?? [];
    if (!check) out.push(`check: no verdict (see the failure above); ${claims.length} claim(s) prepared`);
    else {
      const problems = asArray(check.problems).filter(isRecord);
      out.push(`check: supported=${String(check.supported)}, ${problems.length} problem(s) over ${claims.length} claim(s)`);
      for (const p of problems) {
        const i = typeof p.claimIndex === 'number' ? p.claimIndex : -1;
        const claim = claims[i];
        out.push(`  ${String(p.reason)} at claim ${i} (${String(p.kind)}${claim?.ntsbNo ? `, ${claim.ntsbNo}` : ''})`);
        out.push(`    claim: ${show(claim?.text)}`);
        if (claim) out.push(`    passages: ${claim.passageIds.map((a) => passage(a, d)).join('; ')}`);
      }
    }
  }
  out.push(`summary as the validator split it (${d.summarySentences.length}):`);
  d.summarySentences.forEach((s, i) => out.push(`  ${i}: ${show(s)}`));
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A brief id (a UUID) and, optionally, a step number (1 to 4). */
export function validDiagnoseArgs(briefId: string, n?: number): boolean {
  return UUID.test(briefId) && (n === undefined || (Number.isInteger(n) && n >= 1 && n <= 4));
}

/** The report for step `n` of a brief (its latest step without `n`), or null when there is no such step. */
export async function diagnoseBrief(db: Db, briefId: string, n?: number): Promise<string[] | null> {
  if (!validDiagnoseArgs(briefId, n)) throw new Error('brief-diagnose takes a brief id (a UUID) and a step from 1 to 4');
  const found = await readStepDiagnostics(db, briefId, n);
  return found ? formatDiagnosis(found.step, found.diagnostics) : null;
}
