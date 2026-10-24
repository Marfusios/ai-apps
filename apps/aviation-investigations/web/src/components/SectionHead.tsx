import type { ReactNode } from 'react';
import { Placard } from './Placard';

/**
 * A story section head: an ink placard ("THE FLIGHT"), a hairline, and the source
 * tag on the right ("NTSB EVENT SEQUENCE"). The tag says whose words follow.
 */
export function SectionHead({ id, children, tag }: { id?: string; children: ReactNode; tag?: ReactNode }) {
  return (
    <div className="section-head">
      <Placard tone="ink" as="h3" id={id} className="tracking-label">
        {children}
      </Placard>
      {tag && <span className="section-tag text-micro tracking-[.12em] text-muted uppercase">{tag}</span>}
    </div>
  );
}
