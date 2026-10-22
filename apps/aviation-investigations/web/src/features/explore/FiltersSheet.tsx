import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import type { SearchRequest, SearchResponse } from '../../../../shared/contracts/search';
import { plural } from '../../lib/format';
import { Facets } from './Facets';

export interface FiltersSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  response: SearchResponse | undefined;
  request: SearchRequest;
  onChange: (change: Partial<SearchRequest>) => void;
  onClearAll: () => void;
  trigger: ReactNode;
}

/**
 * Phone and tablet filters (UI_DESIGN §6): a bottom sheet with a grab handle,
 * "Filters · Clear all", the same facet bars, and a sticky "Show n
 * investigations" button. Counts update as values are ticked.
 */
export function FiltersSheet({ open, onOpenChange, response, request, onChange, onClearAll, trigger }: FiltersSheetProps) {
  const total = response?.total;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-shade" />
        <Dialog.Content
          aria-describedby={undefined}
          className="sheet fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col rounded-t-box border-t border-hairline bg-raised text-ink shadow-sheet sm:mx-auto sm:max-w-[560px]"
        >
          <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 rounded-full bg-rule" />
          <div className="flex items-center border-b border-hairline px-4 pt-2 pb-2.5">
            <Dialog.Title className="text-lead font-bold">Filters</Dialog.Title>
            <button
              type="button"
              onClick={onClearAll}
              className="ml-auto cursor-pointer text-ui text-blue hover:underline pointer-coarse:min-h-11"
            >
              Clear all
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3">
            <Facets response={response} request={request} onChange={onChange} expanded />
          </div>
          <div className="border-t border-hairline px-4 py-3">
            <Dialog.Close asChild>
              <button
                type="button"
                className="w-full cursor-pointer rounded-full bg-blue px-4 py-2.5 text-ui font-bold text-on-blue hover:shadow-[0_0_0_3px_var(--blue-wash)] pointer-coarse:min-h-11"
              >
                {total === undefined ? 'Show investigations' : `Show ${plural(total, 'investigation')}`}
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
