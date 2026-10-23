/**
 * The checker calibration's questions (Task 16c): each brings a real retrieval bundle
 * (hybrid retrieval over the served passages index, `pnpm eval:checker retrieve`), the
 * production shape of what the checker is given. `keywordText` stands in for the scope
 * stage's keyword text (the BM25 channel); the dense channel embeds the question, as the
 * pipeline does. A question's bundle is assigned to the development or the held-out split
 * with every case in it: no case appears in both splits.
 */
export interface CalibrationQuestion {
  id: string;
  split: 'dev' | 'holdout';
  question: string;
  keywordText: string;
}

export const QUESTIONS: readonly CalibrationQuestion[] = [
  {
    id: 'q-power-loss-maintenance',
    split: 'dev',
    question: 'Engine power loss shortly after maintenance',
    // The paid run's scope output (rerun at efe27ce).
    keywordText: 'engine power loss after maintenance mechanic fuel pump carburetor maintenance error',
  },
  {
    id: 'q-first-flight-annual',
    split: 'dev',
    question: 'Accidents on the first flight after an annual inspection',
    keywordText: 'first flight after annual inspection engine power loss accident',
  },
  {
    id: 'q-day-after-maintenance',
    split: 'dev',
    question: 'Engine failure the day after maintenance was completed',
    keywordText: 'engine failure maintenance completed previous day annual inspection',
  },
  {
    id: 'q-midair-two-airplanes',
    split: 'dev',
    question: 'Two airplanes collided and one had just had maintenance',
    keywordText: 'collided midair two airplanes maintenance inspection',
  },
  {
    id: 'q-midair-first-flight',
    split: 'dev',
    question: 'Midair collision on the first flight after an annual inspection',
    keywordText: 'midair collision first flight after annual inspection both airplanes',
  },
  {
    id: 'q-oil-change',
    split: 'holdout',
    question: 'Loss of oil after an oil change',
    keywordText: 'oil loss oil change oil filler cap oil filter not secured maintenance',
  },
  {
    id: 'q-engine-replaced',
    split: 'holdout',
    question: 'Power loss after the engine was replaced or overhauled',
    keywordText: 'engine replaced overhauled power loss hours after installation',
  },
  {
    id: 'q-fuel-line-fitting',
    split: 'holdout',
    question: 'Loose fuel line fitting found after recent maintenance',
    keywordText: 'loose fuel line fitting torque maintenance power loss',
  },
  {
    id: 'q-midair-maintenance',
    split: 'holdout',
    question: 'Midair collisions where one of the airplanes had recent maintenance',
    keywordText: 'midair collision annual inspection maintenance first flight',
  },
];
