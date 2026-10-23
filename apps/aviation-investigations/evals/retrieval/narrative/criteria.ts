/**
 * The frozen calibration pass criteria of Track N (task 10c protocol v4, section 3; the
 * gate's ruling on D3). They are part of the calibration's experiment identity, so a
 * judgment file made under other criteria is refused by `report`.
 *
 * **Procedure.** Configurations (judge models, settings, prompts) are selected on the
 * dev split only; the holdout split runs once for the selected, frozen configuration
 * and is evaluated against these criteria. If the holdout fails and a larger model is
 * chosen, that choice was made after seeing the holdout, so it needs a fresh holdout set
 * (new controls, a new calibration version) for confirmation; `judge --set calibration
 * --split holdout` refuses a second configuration on the same holdout.
 *
 * **Calculations** (`calibrationReport`, `calibrationVerdict`), per split, set and
 * control family:
 * - expected: the frozen items; a missing record counts as wrong.
 * - accuracy: final labels equal to the constructed label over expected (unknown and
 *   missing are wrong), with a Wilson 95% interval; each judge's accuracy likewise, its
 *   unjudgeable, failed, uncovered and missing outcomes counted as wrong.
 * - coverage: known final labels over expected; a judge's failure rate: its unjudgeable,
 *   failed, uncovered and missing outcomes over expected.
 * - conditional accuracy (a separately named diagnostic, never a criterion): correct
 *   over known labels (or a judge's valid grades).
 *
 * **Verdict** on the holdout: `incomplete` (cannot pass) when an item has no finished
 * record (missing, incomplete, or its escalation stopped by the budget); otherwise
 * `pass` only when every criterion below holds, else `fail`.
 */
import { canonicalJson, sha256 } from './spec.js';

export const CALIBRATION_CRITERIA = Object.freeze({
  version: 'track-n-calibration-criteria-v1',
  split: 'holdout' as const,
  overall: Object.freeze({
    /** Wilson 95% lower bound of the final labels' accuracy (correct over expected). */
    finalAccuracyLower: 0.75,
    /** Wilson 95% lower bound of each judge's accuracy (correct over expected). */
    judgeAccuracyLower: 0.65,
    /** Each judge's unjudgeable, failed and uncovered outcomes over expected, at most. */
    judgeFailureRate: 0.05,
  }),
  perFamily: Object.freeze({
    /** Every control family, and the code-reading set, has at least this many holdout items. */
    minItems: 8,
    /** In every family: the final labels' accuracy at least (5 of 8), and each judge's (4 of 8). */
    finalAccuracy: 0.625,
    judgeAccuracy: 0.5,
  }),
});

export const CRITERIA_SHA256 = sha256(canonicalJson(CALIBRATION_CRITERIA));
