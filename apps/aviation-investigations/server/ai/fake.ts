/**
 * Deterministic provider for tests (`AI_LLM_PROVIDER=fake`, NODE_ENV=test only).
 * It applies the same input bounds, context caps and output schemas as the real
 * adapter, so a pipeline test fails where production would.
 */
import type { z } from 'zod';
import { CHECK_PROMPT_VERSION } from './prompts/check.v1.js';
import { COMPOSE_PROMPT_VERSION } from './prompts/compose.v1.js';
import { SCOPE_PROMPT_VERSION } from './prompts/scope.v1.js';
import {
  CheckInputSchema,
  CheckOutputSchema,
  ComposeInputSchema,
  ComposeOutputSchema,
  isValidStageCtx,
  ScopeInputSchema,
  ScopeOutputSchema,
  STAGE_ROLE,
  StageError,
  type CheckInput,
  type CheckOutput,
  type ComposeInput,
  type ComposeOutput,
  type LlmProvider,
  type LlmStage,
  type ScopeInput,
  type ScopeOutput,
  type StageBilling,
  type StageCtx,
  type StageErrorCategory,
  type StageModels,
  type StageResult,
  type StageUsage,
} from './provider.js';

export const DEFAULT_FAKE_MODELS: StageModels = {
  scope: 'claude-haiku-5-5',
  answer: 'claude-opus-5-5',
  check: 'claude-haiku-5-5',
};

export const DEFAULT_FAKE_USAGE: StageUsage = {
  inputTokens: 1_000,
  outputTokens: 100,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
};

/**
 * One scripted call:
 * - `{ output }` returns it (validated against the stage's output schema);
 * - `{ fail }` throws that `StageError`;
 * - `{ hang: true }` waits until the signal aborts or `timeoutMs` passes, then fails with `timeout`;
 * - a function computes the output from the input.
 */
export type FakeStep<I, O> =
  | { output: O; usage?: Partial<StageUsage> }
  | { fail: StageErrorCategory; billing?: StageBilling; refusalCategory?: string }
  | { hang: true }
  | ((input: I, ctx: StageCtx) => O | Promise<O>);

/** A single step repeats for every call; an array is consumed in order and must not run out. */
export type FakeSteps<I, O> = FakeStep<I, O> | FakeStep<I, O>[];

export interface FakeScript {
  models?: StageModels;
  scope?: FakeSteps<ScopeInput, ScopeOutput>;
  compose?: FakeSteps<ComposeInput, ComposeOutput>;
  check?: FakeSteps<CheckInput, CheckOutput>;
}

export interface FakeCall {
  stage: LlmStage;
  input: unknown;
}

export interface FakeProvider extends LlmProvider {
  /** Every call that passed input validation, in order. */
  readonly calls: readonly FakeCall[];
}

const BILLED_ON_FAILURE: readonly StageErrorCategory[] = ['refusal', 'truncated', 'invalid_output', 'cap_exceeded'];
const UNCERTAIN_ON_FAILURE: readonly StageErrorCategory[] = ['timeout', 'network', 'provider_error', 'unexpected'];

function defaultBilling(category: StageErrorCategory): StageBilling {
  if (BILLED_ON_FAILURE.includes(category)) return { kind: 'usage', usage: { ...DEFAULT_FAKE_USAGE } };
  if (UNCERTAIN_ON_FAILURE.includes(category)) return { kind: 'uncertain' };
  return { kind: 'none' };
}

function waitForAbort(ctx: StageCtx): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ctx.timeoutMs);
    ctx.signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

export function createFakeProvider(script: FakeScript = {}): FakeProvider {
  const models = script.models ?? DEFAULT_FAKE_MODELS;
  const calls: FakeCall[] = [];

  function stage<I, O>(
    name: LlmStage,
    promptVersion: string,
    inputSchema: z.ZodType<I>,
    outputSchema: z.ZodType<O>,
    steps: FakeSteps<I, O> | undefined,
  ) {
    const queue = Array.isArray(steps) ? [...steps] : undefined;
    const model = models[STAGE_ROLE[name]];
    const fail = (category: StageErrorCategory, billing: StageBilling, refusalCategory?: string) =>
      new StageError(category, { stage: name, provider: 'fake', model, promptVersion, billing, refusalCategory });

    return async (rawInput: I, ctx: StageCtx): Promise<StageResult<O>> => {
      if (!isValidStageCtx(name, ctx)) throw fail('invalid_input', { kind: 'none' });
      const parsed = inputSchema.safeParse(rawInput);
      if (!parsed.success) throw fail('invalid_input', { kind: 'none' });
      if (ctx.signal.aborted) throw fail('timeout', { kind: 'none' });

      let step: FakeStep<I, O> | undefined;
      if (queue) {
        step = queue.shift();
        if (step === undefined) throw new Error(`Fake provider: no scripted ${name} step left`);
      } else {
        step = steps as FakeStep<I, O> | undefined;
        if (step === undefined) throw new Error(`Fake provider: no ${name} step scripted`);
      }
      calls.push({ stage: name, input: parsed.data });

      let output: unknown;
      let usage = DEFAULT_FAKE_USAGE;
      if (typeof step === 'function') {
        output = await step(parsed.data, ctx);
        if (ctx.signal.aborted) throw fail('timeout', { kind: 'uncertain' });
      } else if ('fail' in step) {
        throw fail(step.fail, step.billing ?? defaultBilling(step.fail), step.refusalCategory);
      } else if ('hang' in step) {
        await waitForAbort(ctx);
        throw fail('timeout', { kind: 'uncertain' });
      } else {
        output = step.output;
        usage = { ...DEFAULT_FAKE_USAGE, ...step.usage };
      }

      const valid = outputSchema.safeParse(output);
      if (!valid.success) throw fail('invalid_output', { kind: 'usage', usage });
      return { output: valid.data, usage, provider: 'fake', model, promptVersion, stopReason: 'end_turn' };
    };
  }

  return {
    name: 'fake',
    models: { ...models },
    calls,
    scope: stage('scope', SCOPE_PROMPT_VERSION, ScopeInputSchema, ScopeOutputSchema, script.scope),
    compose: stage('compose', COMPOSE_PROMPT_VERSION, ComposeInputSchema, ComposeOutputSchema, script.compose),
    check: stage('check', CHECK_PROMPT_VERSION, CheckInputSchema, CheckOutputSchema, script.check),
  };
}
