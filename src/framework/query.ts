/**
 * openhorse - Query Loop (async generator)
 *
 * Generator-based query loop replacing the callback-based chatWithTools.
 * Yields typed events: request_start, tool_call, tool_result, message, complete.
 *
 * Note: Streaming text chunks are handled via onChunk callback in llm.chatStream(),
 * not yielded as events (callbacks cannot yield). The handleChat consumer writes
 * chunks directly to stdout via the callback.
 */

import type { LLMService, Message, StreamCallbacks, Tool } from '../services/llm';
import type { OpenHorseTool, ToolContext } from './tool';
import type { PermissionMode } from '../commands/types';
import type { CostTracker } from '../core/cost-tracker';
import type { ToolConfirmationPolicy } from '../services/config';
import { toOpenAITools } from './tool';
import { createStrategyTracker, type StrategyTracker, type StrategyResult } from '../core/strategy-tracker';
import { getAutoCompact } from '../services/compact/auto-compact';
import type { ContextHarness } from '../harness';
import { prepareToolCalls, executeToolCalls, type PreparedToolCall, type ExecutedToolCall } from './tool-scheduler';

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function cancelledEvent(llm: LLMService): QueryEvent {
  return {
    type: 'complete',
    content: 'Operation cancelled.',
    model: llm.getModel(),
  };
}

// ============================================================================
// 事件类型
// ============================================================================

export type QueryEvent =
  | { type: 'request_start'; model: string; turn: number }
  | { type: 'assistant_tool_calls'; content: string; toolCalls: NonNullable<Message['tool_calls']> }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; callId: string; batchCount?: number; batchIndex?: number }
  | {
      type: 'tool_result';
      name: string;
      args: Record<string, unknown>;
      callId: string;
      result: string;
      duration: number;
      success: boolean;
      artifactRef?: { id: string; outputBytes: number };
      error?: string;
      summary?: string;
      outputBytes?: number;
      batchCount?: number;
      batchIndex?: number;
    }
  | { type: 'strategy_exhausted'; suggestion: string }
  | { type: 'message'; role: 'assistant'; content: string }
  | { type: 'complete'; content: string; usage?: { promptTokens: number; completionTokens: number }; model: string };

// ============================================================================
// 参数
// ============================================================================

export interface QueryParams {
  /** Conversation history (must include system prompt as first message) */
  messages: Message[];
  /** Available tools */
  tools: OpenHorseTool[];
  /** Tool executor: (name, args, abortSignal?) => result string
   *  Issue #32 #3.2: 支持 abortSignal 透传 */
  toolExecutor: (name: string, args: Record<string, unknown>, abortSignal?: AbortSignal) => Promise<string>;
  /** LLM service instance */
  llm: LLMService;
  /** Maximum turns (default: no limit, relies on safety mechanisms) */
  maxTurns?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Streaming callbacks (onChunk writes to stdout, etc.) */
  streamCallbacks?: StreamCallbacks;
  /** Permission mode for tool execution */
  permissionMode?: PermissionMode;
  /** Fallback for permission checks that would need an interactive prompt. */
  toolConfirmation?: ToolConfirmationPolicy;
  /** Optional UI confirmation hook for tools whose permission check returns ask. */
  confirmToolUse?: (request: {
    name: string;
    args: Record<string, unknown>;
    reason?: string;
    abortSignal?: AbortSignal;
  }) => Promise<boolean>;
  /** Tool execution context */
  toolContext?: ToolContext;
  /** Cost tracker for recording usage */
  costTracker?: CostTracker;
  /** Strategy tracker for alternative approaches */
  strategyTracker?: StrategyTracker;
  /** Optional Context Harness for turn-level context, ledger, and completion gates */
  harness?: ContextHarness;
  /** Current user input, used by Context Harness for evidence ranking */
  input?: string;
}

// ============================================================================
// query() — async generator
// ============================================================================

/**
 * Generator-based agentic loop.
 *
 * LLM → stream (via callback) → tool_call → execute → tool_result → repeat
 *
 * @example
 * for await (const event of query({
 *   messages, tools, toolExecutor, llm,
 *   streamCallbacks: { onChunk: (t) => process.stdout.write(t) },
 * })) {
 *   switch (event.type) {
 *     case 'complete': console.log(event.usage); break;
 *   }
 * }
 */
export async function* query(params: QueryParams): AsyncGenerator<QueryEvent> {
  const {
    messages,
    tools,
    toolExecutor,
    llm,
    maxTurns,  // 无默认值，可选参数
    abortSignal,
    streamCallbacks,
    costTracker,
    strategyTracker = createStrategyTracker({ maxAttempts: 5 }),  // 增加到 5 次
    harness,
    input,
  } = params;

  const openaiTools = toOpenAITools(tools) as unknown as Tool[];
  let turn = 0;

  // 无限循环，依赖安全机制停止
  while (true) {
    turn++;

    // Check abort
    if (isAborted(abortSignal)) {
      yield cancelledEvent(llm);
      return;
    }

    // Request start
    yield { type: 'request_start', model: llm.getModel(), turn };

    // Safety valve: check maxTurns if specified (optional)
    if (maxTurns && turn > maxTurns) {
      yield {
        type: 'complete',
        content: `Reached maximum turns (${maxTurns}). Task may be incomplete.`,
        model: llm.getModel(),
      };
      return;
    }

    // Stream the LLM response. Harness context is injected into a cloned
    // request payload so the durable conversation history stays clean.
    const requestMessages = harness
      ? harness.assembleMessages(messages, { input, tools: tools.map(tool => ({ name: tool.name, description: tool.description })) })
      : messages;
    const response = await llm.chatStream(requestMessages, streamCallbacks, openaiTools, { abortSignal });

    if (isAborted(abortSignal)) {
      yield cancelledEvent(llm);
      return;
    }

    // Save assistant message to history
    const assistantMsg: Message = {
      role: 'assistant',
      content: response.content,
    };
    if (response.toolCalls) {
      assistantMsg.tool_calls = response.toolCalls;
    }
    messages.push(assistantMsg);
    harness?.recordAssistantResponse(response);

    // Handle tool calls
    if (response.toolCalls && response.toolCalls.length > 0) {
      const toolCalls = response.toolCalls;
      yield {
        type: 'assistant_tool_calls',
        content: response.content,
        toolCalls,
      };

      const preparedCalls = prepareToolCalls({
        toolCalls,
        tools,
        toolExecutor,
        permissionMode: params.permissionMode,
        toolConfirmation: params.toolConfirmation,
        confirmToolUse: params.confirmToolUse,
        toolContext: params.toolContext,
        abortSignal,
        startApproach: (toolName: string) => strategyTracker.startApproach(toolName),
        addToolToTracker: (attemptId: string, toolName: string) => strategyTracker.addTool(attemptId, toolName),
        harnessDriftCheck: harness ? ({ name, args }) => harness.beforeToolUse({ name, args }) : undefined,
        harnessBlockedResult: harness ? (drift) => harness.asToolBlockedResult(drift) : undefined,
      });

      for (const prepared of preparedCalls) {
        yield {
          type: 'tool_call',
          name: prepared.tc.function.name,
          args: prepared.args,
          callId: prepared.tc.id,
          batchCount: toolCalls.length,
          batchIndex: prepared.index,
        };
      }

      for await (const executed of executeToolCalls(preparedCalls, {
        toolExecutor,
        abortSignal,
        confirmToolUse: params.confirmToolUse,
        permissionMode: params.permissionMode,
        toolConfirmation: params.toolConfirmation,
        harnessBlockedResult: harness ? (drift) => harness.asToolBlockedResult(drift) : undefined,
      })) {
        if (isAborted(abortSignal)) {
          yield cancelledEvent(llm);
          return;
        }

        const { prepared } = executed;
        const { tc, args, attemptId } = prepared;

        strategyTracker.recordResult(attemptId, executed.strategyResult, executed.strategyError, executed.duration);
        harness?.recordToolResult({
          name: tc.function.name,
          args,
          result: executed.result,
          duration: executed.duration,
          success: executed.success,
          error: executed.error,
          summary: executed.summary,
        });

        yield {
          type: 'tool_result',
          name: tc.function.name,
          args,
          callId: tc.id,
          result: executed.result,
          duration: executed.duration,
          success: executed.success,
          artifactRef: executed.artifactRef,
          error: executed.error,
          summary: executed.summary,
          outputBytes: executed.outputBytes,
          batchCount: toolCalls.length,
          batchIndex: prepared.index,
        };

        messages.push({
          role: 'tool',
          content: executed.result,
          tool_call_id: tc.id,
        });

        if (!executed.success) {
          messages.push({
            role: 'user',
            content: `[System] Tool ${tc.function.name} failed: ${executed.error}. Consider alternative approaches or inform the user.`,
          });
        }

        if (strategyTracker.isExhausted()) {
          const suggestion = strategyTracker.suggestAlternative();
          if (suggestion) {
            yield { type: 'strategy_exhausted', suggestion };
            messages.push({
              role: 'user',
              content: suggestion,
            });
            strategyTracker.reset();
          }
        }
      }

      // Continue to next turn
      continue;
    }

    // No tool calls — done, unless the harness requires one more pass.
    const completionGate = harness?.beforeComplete();
    if (completionGate && !completionGate.canComplete) {
      messages.push(harness!.asCompletionBlockedMessage(completionGate));
      continue;
    }

    yield { type: 'message', role: 'assistant', content: response.content };

    // Record usage to cost tracker
    if (costTracker && response.usage) {
      costTracker.record(response.usage, { model: response.model });
    }

    // Auto-compact at 95% context usage (token-based)
    const totalTokens = response.usage?.promptTokens ?? 0;
    const autoCompact = getAutoCompact({
      modelId: response.model || llm.getModel(),
      getContextCapsule: harness ? () => harness.getCapsule() : undefined,
      getHarnessState: harness ? () => harness.toJSON() : undefined,
      llm,
    });
    const compacted = await autoCompact.checkAndCompact(messages, totalTokens);
    if (compacted.length < messages.length) {
      messages.length = 0;
      messages.push(...compacted);
    }

    yield {
      type: 'complete',
      content: response.content,
      usage: response.usage,
      model: response.model,
    };
    return;
  }
  // Note: Loop exits via return statements above, not by falling through
}
