/**
 * `pnpm eval:checker simulate [--write]` (Tasks 16d and 16e; free and offline): the recorded
 * check outputs of the 16c and 16d calibration runs re-read through the production code as it
 * is now: judged by `judgeCheck` (`check-judgement-v2`: a `supported` verdict resting on an
 * uncited passage removes that claim, no longer the whole output), projected by
 * `projectDisplay` (`display-deps-v2`, with the static abstentions of `excerpt-context-v1`
 * and `ordinal-evidence-v2`) over display plans the production code rebuilds for the frozen
 * inputs (`v1Plans`, `v2Plans`, which first prove they render exactly the frozen claims), and
 * counted by `checker-metrics-v3`. Every figure is a **server-projection metric**.
 *
 * For each recorded run, with each label set (labels v2; labels v3 with the errata overlay;
 * for the 16d recordings also labels v3 with the disputed labels read as `unknown`, since
 * every disputed label is in a 16d item):
 * - the verdict figures (`rawReport`: semantic detection from actual verdicts only, blocked
 *   output apart, production withholding from the projection);
 * - the display figures (`displayReport`, `claims` mode: answer retention against the static
 *   floor, displayed retention, the static rules' abstentions, M3–M5 and the exposure);
 * - the same projection in `whole` mode (the production default).
 * The 16c held-out recordings and the 16d held-out pilot are diagnostics of development
 * material now (the 16d pilot became development material with the 16d verdict). The
 * committed result (`results/16e-simulation.json`) holds counts only.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STAGE_TIMEOUTS } from '../../server/briefs/pipeline.js';
import { APP_DIR } from '../../worker/config.js';
import { readDataset, readDatasetV2, v1LabelsV2, v1LabelsV3, v1Plans, v2LabelsV3, v2Plans, type CalibrationDataset } from './build.js';
import { displayLines, displayReport, disputedAsUnknown, rawLines, rawReport, type Trial } from './metrics.js';

export const SIMULATION_PATH = resolve(APP_DIR, 'evals/checker/results/16e-simulation.json');
export const DEFAULT_RECORDINGS = { '16c': resolve(APP_DIR, 'data/work/checker16c'), '16d': resolve(APP_DIR, 'data/work/checker16d') } as const;

interface RunFile {
  name: string;
  task: '16c' | '16d';
  split: 'dev' | 'holdout';
  trials: Trial[];
}

const trialsOf = (path: string) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Trial);

/** The 16c runs recorded in `dir`: each summary with its trials file. */
export function recorded16c(dir: string): RunFile[] {
  if (!existsSync(dir)) throw new Error(`no 16c recordings in ${dir}`);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.summary.json'))
    .sort()
    .map((f) => {
      const s = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as { config: string; checkPrompt: string; split: 'dev' | 'holdout' };
      return { name: `16c ${s.config}-${s.split}-${s.checkPrompt}`, task: '16c' as const, split: s.split, trials: trialsOf(resolve(dir, f.replace(/\.summary\.json$/, '.jsonl'))) };
    });
}

/** The 16d runs recorded in `dir`: each manifest's summary with its trials file. */
export function recorded16d(dir: string): RunFile[] {
  if (!existsSync(dir)) throw new Error(`no 16d recordings in ${dir}`);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.summary.json'))
    .sort()
    .map((f) => {
      const s = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as { candidate: string; split: 'dev' | 'holdout'; manifest: string };
      return { name: `16d ${s.candidate}-${s.split}`, task: '16d' as const, split: s.split, trials: trialsOf(resolve(dir, f.replace(/\.summary\.json$/, '.jsonl'))) };
    });
}

export function simulate(dirs: { '16c': string; '16d': string } = DEFAULT_RECORDINGS) {
  const v1 = readDataset();
  const v1p = v1Plans(v1);
  const v2 = readDatasetV2();
  const v2p = v2Plans(v2);
  // The 16c recordings under labels v2 (the 16d corrections; the 16d simulation also shows labels v1) and labels v3.
  const sets16c: [string, CalibrationDataset][] = [
    ['labels v2', v1LabelsV2(v1)],
    ['labels v3', v1LabelsV3(v1)],
  ];
  const v3of2 = v2LabelsV3(v2);
  const sets16d: [string, CalibrationDataset][] = [
    ['labels v2', v2],
    ['labels v3', v3of2],
    ['labels v3, disputed as unknown', { ...v3of2, batches: disputedAsUnknown(v3of2.batches) }],
  ];
  const runs = [...recorded16c(dirs['16c']), ...recorded16d(dirs['16d'])].map((r) => {
    const plans = r.task === '16c' ? v1p.plans : v2p.plans;
    // Maximum-size inputs (16d) are latency and structure inputs, outside the accuracy figures, as pre-registered.
    const forLabels = (d: CalibrationDataset) => {
      const batches = d.batches.filter((b) => b.split === r.split && !b.maxSize);
      const ids = new Set(batches.map((b) => b.id));
      const trials = r.trials.filter((t) => ids.has(t.batch));
      const whole = displayReport(batches, trials, { mode: 'whole', plans });
      return {
        raw: rawReport(batches, trials, STAGE_TIMEOUTS.check, { plans }),
        display: displayReport(batches, trials, { mode: 'claims', plans }),
        // Whole mode (the production default): its headline figures.
        whole: { m2Displayed: whole.m2Displayed, m3: whole.m3.all, m4: whole.m4, e2: whole.e2, critical: whole.critical, withheld: whole.withheld },
      };
    };
    const sets = r.task === '16c' ? sets16c : sets16d;
    return {
      name: r.name,
      task: r.task,
      split: r.split,
      role: r.task === '16c' && r.split === 'holdout' ? 'diagnostic (the 16c held-out split had been seen)' : r.split === 'holdout' ? 'development material (the 16d held-out pilot)' : 'development',
      calls: r.trials.length,
      labels: Object.fromEntries(sets.map(([name, d]) => [name, forLabels(d)])),
    };
  });
  return {
    note: 'Task 16e offline simulation: the 16c and 16d check recordings judged by judgeCheck (check-judgement-v2) and projected by projectDisplay (display-deps-v2, static abstentions of excerpt-context-v1 and ordinal-evidence-v2) over display plans the production code rebuilt for the frozen inputs, counted by checker-metrics-v3. Server-projection metrics. Counts only.',
    timeoutMs: STAGE_TIMEOUTS.check,
    criterionTextsChanged: { '16c': v1p.textChanged, '16d': v2p.textChanged },
    runs,
  };
}

export function simulateCommand(opts: { dirs?: { '16c': string; '16d': string }; write: boolean; log: (m: string) => void }): number {
  const result = simulate(opts.dirs);
  for (const r of result.runs) {
    opts.log(`######## ${r.name} (${r.role}, ${r.calls} calls)`);
    for (const [labels, x] of Object.entries(r.labels)) {
      for (const line of [...rawLines(`${r.name} ${labels}`, x.raw), ...displayLines(`${r.name} ${labels}`, x.display)]) opts.log(line);
      opts.log(`whole mode (production default) through the projection: shown ${x.whole.m2Displayed.k}/${x.whole.m2Displayed.n} wholly supported trials`);
    }
  }
  if (opts.write) {
    writeFileSync(SIMULATION_PATH, `${JSON.stringify(result, null, 2)}\n`);
    opts.log(`wrote ${SIMULATION_PATH}`);
  }
  return 0;
}
