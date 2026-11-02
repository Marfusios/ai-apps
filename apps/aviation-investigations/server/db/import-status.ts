import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { DbOrTx } from './client.js';
import {
  AdminImportRunSchema,
  AdminImportsSchema,
  IMPORT_REASONS,
} from '../../shared/contracts/admin.js';
import { projectImports, type ImportSchedule } from '../../worker/importer/status.js';
const Rows = z
  .array(
    z.strictObject({
      public: AdminImportRunSchema,
      sourceCheckSucceeded: z.boolean(),
      canaryPassed: z.boolean(),
      goodCheck: z.boolean(),
      recertification: z.boolean(),
    }),
  )
  .max(200);
const Health = z.strictObject({
  automaticSince: z.iso.datetime(),
  restoreHeld: z.boolean(),
  switchHeld: z.boolean(),
  temporaryDays: z.number().int().min(0).max(7),
  delayedSince: z.iso.datetime().nullable(),
  serving: AdminImportsSchema.shape.serving,
  lastGood: AdminImportRunSchema.nullable(),
  waiting: z
    .strictObject({ source: AdminImportRunSchema.shape.source, since: z.iso.datetime() })
    .nullable(),
  issue: z
    .strictObject({
      reason: z.enum(IMPORT_REASONS).nullable(),
      fixed: z.boolean(),
      since: z.iso.datetime(),
      origin: z.enum(['dev', 'live', 'host']),
      siteState: z.enum(['unchanged', 'restored', 'restore_unverified', 'uncertain']),
      postSuccess: z.boolean(),
      details: AdminImportRunSchema.nullable(),
      originRunId: z.uuid().nullable(),
    })
    .nullable(),
});
/** Definer projections only, in the overview's snapshot; raw tables and errors never reach HTTP. */
export async function readImportStatus(
  db: DbOrTx,
  schedule: ImportSchedule | null,
  now = new Date(),
) {
  try {
    const r = await db.transaction((tx) =>
      tx.execute(
        sql`select import_status_rows() as rows,import_status_health() as health`,
      ),
    );
    return projectImports(
      Rows.parse(r.rows[0]?.rows),
      schedule,
      now,
      Health.parse(r.rows[0]?.health),
    );
  } catch {
    return projectImports([], schedule, now, true);
  }
}
