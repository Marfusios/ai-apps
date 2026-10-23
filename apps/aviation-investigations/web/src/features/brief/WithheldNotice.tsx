import { DataCaution } from '../../components/DataCaution';

export const WITHHELD_LABEL = 'Summary withheld';

/**
 * UI_DESIGN §4.3 "Validation failed" (owner ruling: every withheld reason uses the
 * citation-check copy). The count is the number of cases returned as plain cards.
 */
export function withheldText(count: number): string {
  return count === 1
    ? "The AI's summary didn't pass the citation check, so it isn't shown. Below is the 1 case it found, with its NTSB text. You can still open, compare and print it."
    : `The AI's summary didn't pass the citation check, so it isn't shown. Below are the ${count} cases it found, with their NTSB text. You can still open, compare and print them.`;
}

/** A hatched box labelled SUMMARY WITHHELD; the cases follow as plain cards with no AI lines. */
export function WithheldNotice({ count }: { count: number }) {
  return (
    <DataCaution label={WITHHELD_LABEL} className="mt-4 text-body">
      {withheldText(count)}
    </DataCaution>
  );
}
