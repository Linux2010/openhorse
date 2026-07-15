/**
 * Production binding for {@link ExecuteChildQuery}.
 *
 * Bridges the Supervisor (which is LLM-agnostic) to the real `query()` loop.
 * Each child gets its own {@link LLMService} so mutable per-request state
 * (`consecutive529Errors`, `usingFallback`, `lastRequestDiagnostics`) is not
 * shared across concurrent children. All children still flow through the shared
 * {@link SubagentProviderGate} for concurrency bounding and cooldown.
 *
 * `createLlm` and `runQuery` are injectable so the binding is unit-testable
 * without a live provider; production wires them to `new LLMService(...)` and
 * `query()`.
 */

import { LLMService, type LLMConfig, type Message } from '../../services/llm';
import type { LoopStats } from '../../framework';
import { query, type QueryEvent, type QueryParams } from '../../framework/query';
import type { ExecuteChildQuery } from './runner';
import type { SubtaskUsage } from './types';
import { EMPTY_SUBTASK_USAGE } from './types';
import type { SubagentProviderGate } from './provider-gate';

export interface SubagentLlmFactoryDeps {
  /** Root config used to derive each child's LLMConfig. */
  rootConfig: Pick<LLMConfig, 'apiKey' | 'baseUrl' | 'model' | 'fallbackModel'>;
  /** Injectable LLMService factory (production: `new LLMService(config)`). */
  createLlm?: (config: LLMConfig) => LLMService;
  /** Injectable query loop (production: `query`). */
  runQuery?: (params: QueryParams) => AsyncIterable<QueryEvent>;
  /** Shared gate; a child that observes a 429 enters cooldown for siblings. */
  providerGate: SubagentProviderGate;
  /** Per-child turn cap. */
  maxTurnsPerTask: number;
}

/**
 * Create a per-child LLMService. Children share the provider account but not
 * the mutable request state, so one child's fallback/retry does not reshape
 * another child's model choice or diagnostics.
 */
export function createChildLlmConfig(
  rootConfig: Pick<LLMConfig, 'apiKey' | 'baseUrl' | 'model' | 'fallbackModel'>,
): LLMConfig {
  return {
    apiKey: rootConfig.apiKey,
    baseUrl: rootConfig.baseUrl,
    model: rootConfig.model,
    fallbackModel: rootConfig.fallbackModel,
    timeout: 60_000,
  };
}

/**
 * Build the production {@link ExecuteChildQuery}. The returned function runs one
 * child to completion: it creates an isolated LLMService, drives `query()` with
 * the child messages + filtered tools, and returns the final assistant text and
 * observed usage. Never throws - provider errors surface as an empty result so
 * the runner normalizes them into a `failed` SubtaskResult.
 */
export function createProductionExecuteQuery(deps: SubagentLlmFactoryDeps): ExecuteChildQuery {
  const createLlm = deps.createLlm ?? ((config: LLMConfig) => new LLMService(config));
  const runQuery = deps.runQuery ?? (((params: QueryParams) => query(params)) as (params: QueryParams) => AsyncIterable<QueryEvent>);
  return async (messages, toolSet, abortSignal): Promise<{ content: string; usage: SubtaskUsage }> => {
    const llm = createLlm(createChildLlmConfig(deps.rootConfig));
    let finalContent = '';
    let usage: SubtaskUsage = { ...EMPTY_SUBTASK_USAGE };
    let modelRequests = 0;

    try {
      const params: QueryParams = {
        messages: messages as Message[],
        tools: toolSet.tools as QueryParams['tools'],
        toolExecutor: toolSet.toolExecutor,
        llm,
        maxTurns: deps.maxTurnsPerTask,
        abortSignal,
        // Children stream nothing to stdout; the root only sees the structured result.
        streamCallbacks: { onChunk: () => undefined },
      };

      for await (const event of runQuery(params)) {
        if (event.type === 'message' && event.role === 'assistant') {
          finalContent = event.content;
        } else if (event.type === 'complete') {
          finalContent = event.content;
          usage = loopStatsToUsage(event.stats, modelRequests, event.usage?.promptTokens, event.usage?.completionTokens);
        } else if (event.type === 'assistant_tool_calls') {
          modelRequests += 1;
          finalContent = event.content;
        }
      }
    } catch (err) {
      // A 429 with retry-after should pause siblings; surface the cooldown.
      if (isRateLimitError(err)) {
        const retryAfter = extractRetryAfterMs(err);
        deps.providerGate.enterCooldown(retryAfter);
      }
      // Re-throw so the runner normalizes into failed/cancelled. The runner
      // never lets this propagate to the root loop.
      throw err;
    }

    usage.modelRequests = Math.max(usage.modelRequests, modelRequests);
    return { content: finalContent, usage };
  };
}

function loopStatsToUsage(
  stats: LoopStats | undefined,
  modelRequests: number,
  promptTokens?: number,
  completionTokens?: number,
): SubtaskUsage {
  return {
    modelRequests: Math.max(modelRequests, stats?.llmRequests ?? modelRequests, 1),
    toolCalls: stats?.toolCalls ?? 0,
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    durationMs: 0,
  };
}

function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  const status = e.status ?? e.statusCode;
  return status === 429 || /rate.?limit|429|too many requests/i.test(String(e.message ?? ''));
}

function extractRetryAfterMs(err: unknown): number {
  if (!err || typeof err !== 'object') return 5_000;
  const e = err as Record<string, unknown>;
  const headers = e.headers as Record<string, string> | undefined;
  const retryAfter = headers?.['retry-after'];
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  return 5_000; // conservative default cooldown
}
