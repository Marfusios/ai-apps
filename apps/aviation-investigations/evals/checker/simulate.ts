/**
 * `pnpm eval:checker simulate [--dir <dir>]` (Task 16d, free and offline): the 16c check
 * recordings re-read through the production display projection.
 *
 * Every 16c run (the `*.summary.json` and `*.jsonl` pairs in `--dir`, the 16c work
 * directory's files) is judged by the production `judgeCheck` and projected by the
 * production `projectDisplay` over display plans the production code rebuilds for the 16c
 * briefs (`v1Plans`, which first proves it renders exactly the frozen claims). For each run:
 * - the corrected interpretation of its 16c figures (`rawReport`: semantic detection with
 *   failed calls apart, beside production-faithful withholding), with the v1 labels and with
 *   labels v2;
 * - the claim-level display figures M1–M5 and the exposure (`displayReport`, `claims`
 *   mode), with both label sets;
 * - the same projection in `whole` mode (16c's rule), as a cross-check of the 16c figures.
 * Held-out runs are diagnostics only (that split has been seen). The committed result
 * (`results/16d-simulation.json`) holds counts only; the 16c results stay as they are.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STAGE_TIMEOUTS } from '../../server/briefs/pipeline.js';
import { APP_DIR } from '../../worker/config.js';
import { readDataset, v1LabelsV2, v1Plans, type CalibrationDataset } from './build.js';
import { displayLines, displayReport, rawLines, rawReport, type Trial } from './metrics.js';

export const SIMULATION_PATH = resolve(APP_DIR, 'evals/checker/results/16d-simulation.json');
export const DEFAULT_RECORDINGS = resolve(APP_DIR, 'data/work/checker16c');

interface RunFile {
  name: string;
  config: string;
  checkPrompt: string;
  split: 'dev' | 'holdout';
  trials: Trial[];
}

/** The 16c runs recorded in `dir`: each summary with its trials file. */
export function recordedRuns(dir: string): RunFile[] {
  if (!existsSync(dir)) throw new Error(`no recordings in ${dir}`);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.summary.json'))
    .sort()
    .map((f) => {
      const s = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as { config: string; checkPrompt: string; split: 'dev' | 'holdout' };
      const trialsFile = resolve(dir, f.replace(/\.summary\.json$/, '.jsonl'));
      const trials = readFileSync(trialsFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Trial);
      return { name: `${s.config}-${s.split}-${s.checkPrompt}`, config: s.config, checkPrompt: s.checkPrompt, split: s.split, trials };
    });
}

export function simulate(dir: string) {
  const v1 = readDataset();
  const { plans, textChanged } = v1Plans(v1);
  const v2: CalibrationDataset = v1LabelsV2(v1);
  const split = (d: CalibrationDataset, s: 'dev' | 'holdout') => d.batches.filter((b) => b.split === s);
  const runs = recordedRuns(dir).map((r) => {
    const forLabels = (d: CalibrationDataset) => ({
      raw: rawReport(split(d, r.split), r.trials, STAGE_TIMEOUTS.check),
      display: displayReport(split(d, r.split), r.trials, { mode: 'claims', plans }),
      whole: displayReport(split(d, r.split), r.trials, { mode: 'whole', plans }),
    });
    return { name: r.name, config: r.config, checkPrompt: r.checkPrompt, split: r.split, role: r.split === 'dev' ? 'development' : 'diagnostic (seen held-out split)', calls: r.trials.length, v1Labels: forLabels(v1), v2Labels: forLabels(v2) };
  });
  return {
    note: 'Task 16d offline simulation: the 16c check recordings judged by judgeCheck and projected by projectDisplay (display-deps-v1) over display plans rebuilt by the production code. Counts only. Held-out runs are diagnostics.',
    timeoutMs: STAGE_TIMEOUTS.check,
    labels: { v1: v1.labels, v2: v2.labels },
    criterionTextsChanged: textChanged,
    runs,
  };
}

export function simulateCommand(opts: { dir: string; write: boolean; log: (m: string) => void }): number {
  const result = simulate(opts.dir);
  for (const r of result.runs) {
    opts.log(`######## ${r.name} (${r.role}, ${r.calls} calls)`);
    for (const [labels, x] of [
      ['labels v1', r.v1Labels],
      ['labels v2', r.v2Labels],
    ] as const) {
      for (const line of [...rawLines(`${r.name} ${labels}`, x.raw), ...displayLines(`${r.name} ${labels}`, x.display)]) opts.log(line);
      opts.log(`whole mode (16c rule) through the projection: shown ${x.whole.m2.k}/${x.whole.m2.n} wholly supported trials`);
    }
  }
  if (opts.write) {
    writeFileSync(SIMULATION_PATH, `${JSON.stringify(result, null, 2)}\n`);
    opts.log(`wrote ${SIMULATION_PATH}`);
  }
  return 0;
}
