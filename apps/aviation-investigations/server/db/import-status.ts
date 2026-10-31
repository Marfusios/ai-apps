import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { DbOrTx } from './client.js';
import { AdminImportRunSchema } from '../../shared/contracts/admin.js';
import { projectImports, type ImportSchedule } from '../../worker/importer/status.js';

const Rows=z.array(z.strictObject({public:AdminImportRunSchema,sourceCheckSucceeded:z.boolean(),
  canaryPassed:z.boolean(),unresolved:z.boolean()})).max(2000);
/** Narrow definer projections only. The HTTP role receives no SELECT on importer state/certificates. */
export async function readImportStatus(db:DbOrTx,schedule:ImportSchedule|null,now=new Date()) {
  try {
    const r=await db.execute(sql`select import_status_rows() as rows,import_status_attention() as attention`);
    return projectImports(Rows.parse(r.rows[0]?.rows),schedule,now,r.rows[0]?.attention!==false);
  }catch{
    // Unknown never becomes "up to date"; no SQL/status parsing exception reaches the journal.
    return projectImports([],schedule,now,true);
  }
}
