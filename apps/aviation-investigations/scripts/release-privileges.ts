/** Read-only deployment privilege check. Never provisions a database or regenerates the baseline. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { sql } from 'drizzle-orm';
import { closeDb, createDb } from '../server/db/client.js';
import { comparePrivileges, privilegeSnapshot } from '../server/db/privileges.js';
import { EXPECTED_PRIVILEGES } from '../server/db/privileges-expected.js';
import { checkDatabaseUrl } from './compose.js';
import { readPrivateFile } from './release-config.js';

export async function checkReleasePrivileges(args: string[], env = process.env): Promise<number> {
  const { values } = parseArgs({ args, options: { environment: { type: 'string' } }, strict: true });
  const name = values.environment, path = env.AVIATION_ENV_FILES;
  if (!['dev', 'live'].includes(name ?? '') || !path?.startsWith('/') || path.includes(',')) throw new Error();
  // Do not load DATABASE_MIGRATOR_URL from the process or copy other file values into it.
  const url = parseEnv((await readPrivateFile(path)).toString('utf8')).DATABASE_MIGRATOR_URL ?? '';
  if (!['postgres:', 'postgresql:'].includes(new URL(url).protocol)) throw new Error();
  checkDatabaseUrl('DATABASE_MIGRATOR_URL', url, name!, 'aviation_migrator');
  const db = createDb(url, { max: 1, applicationName: 'aviation-release-privileges',
    execution: { statementTimeoutMs: 15_000, idleInTransactionTimeoutMs: 15_000, transportTimeoutMs: 20_000 },
    onConnectionError: () => {} });
  try {
    const diff = await db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      return comparePrivileges(await privilegeSnapshot(tx), EXPECTED_PRIVILEGES);
    });
    process.stdout.write(JSON.stringify({ found: diff.unexpected, expected: diff.missing }) + '\n');
    return diff.missing.length || diff.unexpected.length ? 1 : 0;
  } finally { await closeDb(db); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await checkReleasePrivileges(process.argv.slice(2)); }
  catch { process.stderr.write('release privilege check failed\n'); process.exitCode = 1; }
}
