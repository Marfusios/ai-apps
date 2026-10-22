/**
 * Event labels for `Events_Sequence` rows.
 *
 * The exported `occurrence_description` is "<phase text> <event text>", for example
 * "Maneuvering Loss of engine power (total)". The phase text is fixed per `phase_no`:
 * in the 2026-10-16 avall.mdb snapshot every one of the 66,683 sequence rows starts
 * with the text below for its phase code, and each `eventsoe_no` then has exactly one
 * event text. The data dictionary's phase and event meanings are older wordings
 * ("Control flight into terr/obj" instead of the exported "Controlled flight into
 * terr/obj (CFIT)"), so the label is taken from the exported description itself.
 */

/** Phase text that prefixes `occurrence_description`, by `phase_no`. */
export const OCCURRENCE_PHASE_TEXT: Readonly<Record<number, string>> = {
  100: 'Prior to flight',
  150: 'Standing',
  151: 'Standing-engine(s) not oper',
  152: 'Standing-engine(s) start-up',
  153: 'Standing-engine(s) operating',
  154: 'Standing-engine(s) shutdown',
  200: 'Pushback/towing',
  201: 'Pushback/tow-engine not oper',
  202: 'Pushback/tow-engine start-up',
  203: 'Pushback/tow-engine oper',
  250: 'Taxi',
  251: 'Taxi-to runway',
  252: 'Taxi-into takeoff position',
  253: 'Taxi-from runway',
  300: 'Takeoff',
  301: 'Takeoff-rejected takeoff',
  350: 'Initial climb',
  400: 'Enroute',
  401: 'Enroute-climb to cruise',
  402: 'Enroute-cruise',
  403: 'Enroute-change of cruise level',
  404: 'Enroute-descent',
  405: 'Enroute-holding (IFR)',
  450: 'Maneuvering',
  451: 'Maneuvering-aerobatics',
  452: 'Maneuvering-low-alt flying',
  453: 'Maneuvering-hover',
  500: 'Approach',
  501: 'Approach-IFR initial approach',
  502: 'Approach-IFR final approach',
  503: 'Approach-circling (IFR)',
  504: 'Approach-IFR missed approach',
  505: 'Approach-VFR pattern crosswind',
  506: 'Approach-VFR pattern downwind',
  507: 'Approach-VFR pattern base',
  508: 'Approach-VFR pattern final',
  509: 'Approach-VFR go-around',
  550: 'Landing',
  551: 'Landing-flare/touchdown',
  552: 'Landing-landing roll',
  553: 'Landing-aborted after touchdown',
  600: 'Emergency descent',
  601: 'Autorotation',
  650: 'Uncontrolled descent',
  700: 'Post-impact',
  750: 'After landing',
  800: 'Other',
  990: 'Unknown',
};

export interface OccurrenceEventLabel {
  label: string;
  /** False when the description did not start with its phase text; `label` is then the whole description. */
  parsed: boolean;
}

/**
 * The event part of a sequence row's description ("Loss of engine power (total)").
 * Null for a blank description. A description that does not start with the known
 * phase text for `phaseNo` is returned whole with `parsed: false`, never guessed at.
 */
export function occurrenceEventLabel(phaseNo: number | null, description: string | null): OccurrenceEventLabel | null {
  const text = (description ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  const phase = phaseNo === null ? undefined : OCCURRENCE_PHASE_TEXT[phaseNo];
  if (phase !== undefined && text.startsWith(`${phase} `)) {
    const label = text.slice(phase.length + 1).trim();
    if (label !== '') return { label, parsed: true };
  }
  return { label: text, parsed: false };
}
