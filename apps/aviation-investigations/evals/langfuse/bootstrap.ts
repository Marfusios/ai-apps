/** Start a new Node process so its TLS trust is installed before any HTTP client exists. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readDotenvAllowlisted } from '../../shared/env-files.js';

export function projectEnvironment(file: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = ['LANGFUSE_BASE_URL', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'NODE_EXTRA_CA_CERTS'];
  const supplied = readDotenvAllowlisted(file, names);
  if (names.some(n => !supplied[n])) throw new Error('Selected Langfuse connection file is incomplete');
  const present = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'].map(n => !!inherited[n]?.trim());
  if (present[0] !== present[1]) throw new Error('Incomplete process Langfuse key pair');
  for (const name of names) if (inherited[name]?.trim() && inherited[name] !== supplied[name]) {
    throw new Error('Process Langfuse settings differ from the selected connection file');
  }
  if (new URL(supplied.LANGFUSE_BASE_URL!).protocol !== 'https:') throw new Error('Host evaluation requires verified HTTPS');
  return { ...inherited, ...supplied, AVIATION_TRACING_ENABLED: 'true' };
}
export function bootstrap() {
  const { values } = parseArgs({ strict: false, options: { 'langfuse-env': { type: 'string' } } });
  if (typeof values['langfuse-env'] !== 'string') throw new Error('Choose the aviation-dev host file with --langfuse-env');
  const env = projectEnvironment(values['langfuse-env'], process.env);
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./run.ts', import.meta.url)), ...process.argv.slice(2)],
    { env, stdio: 'inherit' });
  child.on('error', () => { console.error('Evaluation child could not start'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { bootstrap(); } catch { console.error('Evaluation setup refused; verify the selected dev file and complete, matching process settings. Values suppressed.'); process.exitCode = 1; }
}
