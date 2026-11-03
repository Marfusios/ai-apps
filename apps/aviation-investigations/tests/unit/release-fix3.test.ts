import { expect, it } from 'vitest';
import { hasStartupWarning, runRelease } from '../../scripts/release-runner.js';
import { fakeRelease } from '../support/release.js';

const listening = JSON.stringify({ level: 30, msg: 'Server listening at http://127.0.0.1:3000' });
const message = 'passages index not servable: AI evidence stays off';
const passagesWarning = (code: unknown, extra = {}) => JSON.stringify({ level: 40, msg: message, code, ...extra });

it.each(['incompatible', 'not_configured'])('fails first run and rerun at live-up for lazy passages code %s', async (code) => {
  const f = fakeRelease();
  f.behavior.startupLogs.set(f.importer.live!.container,
    `${listening}\n{"level":40,"msg":"evidence rerank unavailable"}\n${passagesWarning(code)}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await runRelease(f.args, f.fx)).toBe(1);
    f.behavior.clock += 3_600_000;
  }
  expect(f.output.filter((line) => line === 'live-up: failed; startup warning or error; see the private step log')).toHaveLength(2);
  expect(f.events).not.toContain('dev-up');
  expect(f.events).not.toContain('recertify');
  expect(f.writes).not.toContain(f.config.importerConfig);
  const reads = f.commands.filter((c) => c.command === 'docker' && c.args[0] === 'logs');
  expect(reads).toHaveLength(2); expect(reads[0]!.args).toEqual(reads[1]!.args);
});
it('passes first run and rerun when the lazy passages warning is transient', async () => {
  const f = fakeRelease();
  f.behavior.startupLogs.set(f.importer.live!.container, `${listening}\n${passagesWarning('unavailable')}`);
  expect(await runRelease(f.args, f.fx)).toBe(0);
  f.behavior.clock += 3_600_000;
  expect(await runRelease(f.args, f.fx)).toBe(0);
  expect(f.output.filter((line) => line === 'live-up: ok')).toHaveLength(2);
  expect(f.output.filter((line) => line === 'recertify: ok')).toHaveLength(2);
});
it.each([40, 50, 60])('counts definitive passages level %i before or after listening, or without a marker', (level) => {
  const warning = passagesWarning('incompatible', { level });
  for (const window of [warning, `${warning}\n${listening}`, `${listening}\n${warning}`]) {
    expect(hasStartupWarning(window)).toBe(true);
  }
});
it.each([undefined, null, 'unknown_code', 'Unavailable'])('fails closed for passages code %s after listening', (code) => {
  expect(hasStartupWarning(`${listening}\n${passagesWarning(code)}`)).toBe(true);
});
it('ignores the transient passages warning at any position in the window', () => {
  const warning = passagesWarning('unavailable');
  for (const window of [warning, `${warning}\n${listening}`, `${listening}\n${warning}`]) {
    expect(hasStartupWarning(window)).toBe(false);
  }
});
it('keeps the exact-message, level and request-scope constraints after listening', () => {
  for (const extra of [{ level: 30 }, { reqId: 'request' }, { reqId: null }, { msg: `${message}.` }]) {
    expect(hasStartupWarning(`${listening}\n${passagesWarning('incompatible', extra)}`)).toBe(false);
  }
});
it('does not let a transient warning hide another definitive warning', () => {
  expect(hasStartupWarning(`${listening}\n${passagesWarning('unavailable')}\n${passagesWarning('incompatible')}`)).toBe(true);
  expect(hasStartupWarning(`${passagesWarning('unavailable')}\n{"level":40,"msg":"configuration warning"}\n${listening}`)).toBe(true);
});
