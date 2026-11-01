/** A real IPC client with no database URLs, env files or provider credentials. */
import { workerHostFacts } from '../../worker/importer/facts.js';
import { classify } from '../../worker/importer/failure.js';

async function send(value: object): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error('test IPC unavailable'));
    process.send(value, (error) => (error ? reject(error) : resolve()));
  });
}

async function main(): Promise<void> {
  const own = process.argv[2];
  if (own !== 'dev' && own !== 'live') throw new Error('invalid test environment');
  const facts = workerHostFacts();
  const other = own === 'dev' ? 'live' : 'dev';
  const retention = await facts.retention(other);
  // A second request also exercises the host's one-request-at-a-time lifecycle.
  const repeated = await facts.retention(other);
  const canary = own === 'live' ? await facts.canary(process.argv[3]!) : null;
  await send({ type: 'facts-test-result', retention, repeated, canary });
}

main()
  .catch(async (error) => {
    process.exitCode = 1;
    await send({ type: 'facts-test-failure', reason: classify(error).reason });
  })
  .finally(() => {
    if (process.connected) process.disconnect();
  });
