/**
 * Manual check: sends one synthetic, content-free span to the configured Langfuse
 * project. Needs AVIATION_ENV_FILES (or env) with AVIATION_TRACING_ENABLED=true,
 * LANGFUSE_BASE_URL and the project keys. Not part of any automated test.
 */
import { loadConfig } from '../shared/config.js';
import { stageSpan, startTracing } from '../server/observability/tracing.js';

const cfg = loadConfig();
if (!cfg.tracing.enabled) throw new Error('Tracing is not enabled in the configuration');
const tracing = startTracing(cfg);
if (!tracing.enabled) throw new Error(`Tracing is off: ${tracing.reason}`);
await stageSpan('trace_smoke', { stage: 'smoke', outcome: 'ok', passageCount: 0 }, () => undefined);
await tracing.shutdown();
console.log('Sent one synthetic span.');
