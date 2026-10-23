/**
 * The checker calibration's item types (Task 16c). No label is an expert's: every one is
 * `constructed` (known by how the claim was built, a verbatim restatement or a deliberate
 * mutation, and then checked against the complete supplied evidence: a mutation is not
 * automatically false) or `model-reviewed` (judged by a model against the complete
 * supplied evidence: the paid run's manual review, corrected per gate G6, or the author's
 * review of a composed brief). A claim that review cannot settle is labelled `unknown`
 * and stays out of the accuracy figures.
 */
import type { ComposeOutput } from '../../shared/contracts/briefs.js';
import type { ClaimKind } from '../../server/ai/provider.js';
import type { ReadingState } from '../../server/briefs/clarify.js';

export type Label = 'supported' | 'not_supported' | 'unknown';
export type Provenance = 'constructed' | 'model-reviewed';
/**
 * The reporting families of gate G6 (detection target ≥ 95% each), or `control` for a
 * claim labelled supported.
 */
export const FAMILIES = ['timing', 'attribution', 'contradiction', 'unsupported_addition', 'control'] as const;
export type Family = (typeof FAMILIES)[number];

/** How a not-supported claim was made (each belongs to one family). */
export const MUTATIONS = {
  timing: [
    'unit_swap', // flight hours and calendar days, weeks and days, or minutes and hours swapped
    'before_after', // the maintenance put after the event, or the reverse
    'wrong_anchor', // a time measured from another event presented as the time since the relevant maintenance
    'previous_day_hours', // "the day before" presented as 24 hours
    'zero_interval', // "immediately before" or "the first flight" presented as zero days or hours
    'first_flight_window', // the first flight presented as settling a calendar-day or flight-hour window
    'approximate_exact', // "about N" presented as exactly N
    'words_number', // wording turned into a number
    'wrong_ordinal', // the wrong flight after the maintenance
    'wrong_window', // a window decision the stated dates or hours rule out
    'fabricated_interval', // a time no passage states
    'settled_as_unknown', // "the passages do not settle" a window or flight they settle
  ],
  attribution: [
    'wrong_aircraft', // in a multi-aircraft event, another aircraft's fact
    'wrong_speaker', // a pilot's, witness's or mechanic's account presented as the investigators', or the reverse
    'quote_context_loss', // a verbatim excerpt that loses its antecedent or qualifier
    'misleading_excerpt', // a verbatim excerpt that drops a negation, condition or source and so says something else
    'wrong_actor', // the work, failure or report of one person attributed to another
  ],
  contradiction: ['negation', 'wrong_value', 'wrong_cause', 'compound_contradiction'],
  unsupported_addition: ['added_detail', 'causal_overstatement', 'certainty_overstatement', 'compound', 'wrong_citation'],
} as const;

export interface ClaimItem {
  /** Stable item id within its batch. */
  id: string;
  kind: ClaimKind;
  /** The case the claim is about (a summary claim may name several in its text). */
  case: string;
  text: string;
  /** The passages the claim cites, as the bundle's aliases (`P1`..), or `all` (every supplied passage of its case: an absence claim's scope). */
  cites: string[] | 'all';
  absence?: boolean;
  label: Label;
  /** For `not_supported`: the verdict the label expects (either one withholds). */
  expect?: 'contradicted' | 'not_established';
  provenance: Provenance;
  family: Family;
  mutation?: string;
  /** A known critical regression: it must be withheld by the chosen configuration, every time. */
  critical?: boolean;
  /** For a criterion claim: the criterion and the server decision it states (a contradicted `unknown` is `chronology_missed`). */
  criterion?: 'timing_window' | 'first_flight_only' | 'failure_type';
  decision?: 'matches' | 'does_not_match' | 'unknown';
  /** `paid-run`: one of the 35 claims of the paid run at efe27ce (index in `paidIndex`). */
  source?: 'paid-run' | 'control';
  paidIndex?: number;
  /** Why the label holds against the complete supplied evidence. */
  note: string;
}

/** A batch of claims about cases of one bundle, judged in one check call with every passage of those cases. */
export interface ClaimBatch {
  id: string;
  bundle: string;
  cases: string[];
  /** The reader's criteria in effect (the check input's `<criteria>`); default: the "shortly" window. */
  readings?: ReadingState;
  claims: ClaimItem[];
}

/** A labelled error put into a supported brief: exactly one rendered claim must differ. */
export interface BriefError {
  family: Exclude<Family, 'control'>;
  mutation: string;
  expect: 'contradicted' | 'not_established';
  critical?: boolean;
  note: string;
}

/**
 * A complete brief as the answer model would write it for a real retrieval bundle
 * (passage aliases, as the model sees them), rendered by the production code. Every
 * rendered claim of the supported brief is labelled supported (model-reviewed: a brief
 * with a claim review cannot settle is not authored as wholly supported); each error
 * variant edits one field so that exactly one rendered claim changes, and that claim is
 * the brief's one known error (constructed).
 */
export interface BriefSpec {
  id: string;
  bundle: string;
  mechanicalCause: boolean;
  readings: ReadingState;
  composition: ComposeOutput;
  note: string;
  errors: (BriefError & { id: string; edit: (c: ComposeOutput) => void })[];
}
