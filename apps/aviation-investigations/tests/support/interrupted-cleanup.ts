/**
 * `index delete-unused --yes` for one alias of the local test environment, killed (SIGKILL,
 * no cleanup of any kind) when it reaches `index` at `point`: before Elasticsearch is asked to
 * delete it, or after Elasticsearch deleted it and before the deletion is recorded. Run by
 * tests/integration/index-deletion.test.ts as a child process:
 *
 *   tsx tests/support/interrupted-cleanup.ts <alias> <index> before-delete|after-delete
 */
import { deleteUnusedIndices } from '../../worker/index/publications.js';
import { testDb, testEs } from '../integration/helpers.js';

const [alias, index, point] = process.argv.slice(2);
if (!alias || !index || (point !== 'before-delete' && point !== 'after-delete')) {
  console.error('usage: interrupted-cleanup.ts <alias> <index> before-delete|after-delete');
  process.exit(2);
}
const die = (name: string): void => {
  if (name === index) process.kill(process.pid, 'SIGKILL');
};
await deleteUnusedIndices(testEs(), testDb('ingest'), {
  olderThanHours: 0,
  yes: true,
  aliases: [alias],
  ...(point === 'before-delete' ? { beforeDelete: die } : { afterDelete: die }),
});
console.error(`${index} was never reached`);
process.exit(1);
