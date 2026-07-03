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
import { estimateMessagesTokens } from '../utils/token-estimate';
import { parseToolResultEnvelope, serializeToolResult } from './tool-serializer';

export const DEFAULT_MAX_MODEL_VISIBLE_TOOL_RESULT_BYTES = 4096;

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

function cancelledCompleteEvent(llm: LLMService, stats: LoopStats): Extract<QueryEvent, { type: 'complete' }> {
  return {
    type: 'complete',
    content: 'Operation cancelled.',
    model: llm.getModel(),
    stats: cloneLoopStats(stats, 'cancelled'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(raw: unknown): Record<string, unknown> | undefined {
  if (isRecord(raw)) return raw;
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

interface BatchReadEvidenceStep {
  tool: string;
  args: Record<string, unknown>;
  success: boolean;
  summary?: string;
  error?: string;
  output: string;
}

function parseBatchReadEvidenceSteps(result: string): BatchReadEvidenceStep[] {
  const envelope = parseRecord(result);
  const inner = parseRecord(envelope?.output);
  const steps = inner?.steps;
  if (!Array.isArray(steps)) return [];

  return steps.flatMap(step => {
    if (!isRecord(step) || typeof step.tool !== 'string') return [];
    const args = isRecord(step.args) ? step.args : {};
    const output = typeof step.output === 'string'
      ? step.output
      : JSON.stringify(step.output ?? '');
    return [{
      tool: step.tool,
      args,
      success: step.success === true,
      summary: typeof step.summary === 'string' ? step.summary : undefined,
      error: typeof step.error === 'string' ? step.error : undefined,
      output,
    }];
  });
}

export type LoopFinishReason =
  | 'completed'
  | 'cancelled'
  | 'max_turns'
  | 'completion_gate'
  | 'running';

export interface LoopStats {
  turnsStarted: number;
  llmRequests: number;
  toolCalls: number;
  readOnlyToolCalls: number;
  unsafeToolCalls: number;
  toolResultBytes: number;
  modelVisibleToolBytes: number;
  summarizedBytes: number;
  compactTrigger?: 'pre_turn' | 'post_turn';
  finishReason: LoopFinishReason;
}

function createLoopStats(): LoopStats {
  return {
    turnsStarted: 0,
    llmRequests: 0,
    toolCalls: 0,
    readOnlyToolCalls: 0,
    unsafeToolCalls: 0,
    toolResultBytes: 0,
    modelVisibleToolBytes: 0,
    summarizedBytes: 0,
    finishReason: 'running',
  };
}

function cloneLoopStats(stats: LoopStats, finishReason?: LoopFinishReason): LoopStats {
  return {
    ...stats,
    finishReason: finishReason ?? stats.finishReason,
  };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function takeUtf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let result = '';
  let bytes = 0;
  for (const char of text) {
    const nextBytes = byteLength(char);
    if (bytes + nextBytes > maxBytes) break;
    result += char;
    bytes += nextBytes;
  }
  return result;
}

function takeUtf8Suffix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let result = '';
  let bytes = 0;
  const chars = Array.from(text);
  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index];
    const nextBytes = byteLength(char);
    if (bytes + nextBytes > maxBytes) break;
    result = char + result;
    bytes += nextBytes;
  }
  return result;
}

function truncateForModel(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const marker = '\n...[truncated]';
  if (maxBytes <= 128) {
    return `${takeUtf8Prefix(text, Math.max(0, maxBytes - byteLength(marker)))}${marker}`;
  }

  const middle = `\n...[truncated ${byteLength(text)}B output for model context]...\n`;
  const contentBudget = Math.max(0, maxBytes - byteLength(middle));
  const headBytes = Math.floor(contentBudget * 0.65);
  const tailBytes = contentBudget - headBytes;
  return [
    takeUtf8Prefix(text, headBytes),
    middle,
    takeUtf8Suffix(text, tailBytes),
  ].join('');
}

function summarizeModelVisibleToolResult(
  executed: ExecutedToolCall,
  maxBytes: number,
): { result: string; bytes: number; summarizedBytes: number } {
  const rawBytes = byteLength(executed.result);
  const fullOutputBytes = executed.outputBytes ?? rawBytes;
  if (rawBytes <= maxBytes && !executed.artifactRef) {
    return { result: executed.result, bytes: rawBytes, summarizedBytes: 0 };
  }

  const envelope = parseToolResultEnvelope(executed.result);
  const output = typeof envelope.output === 'string' ? envelope.output : executed.result;
  const summary = executed.summary || envelope.summary;
  const compactSummary = summary ? truncateForModel(summary, 192) : undefined;
  const rawError = executed.error ?? envelope.error;
  const compactError = rawError ? truncateForModel(rawError, 192) : undefined;
  const artifactText = executed.artifactRef
    ? ` Full output is available as artifact ${executed.artifactRef.id} (${executed.artifactRef.outputBytes}B).`
    : '';

  const serializeCompact = (compactOutput: string): string => serializeToolResult({
    success: executed.success,
    output: compactOutput,
    error: compactError,
    summary: compactSummary,
    outputBytes: fullOutputBytes,
    artifactRef: executed.artifactRef ?? envelope.artifactRef,
    metadata: {
      ...(envelope.metadata ?? {}),
      modelVisibleCompressed: true,
      originalResultBytes: rawBytes,
    },
  });

  let outputBudget = Math.max(128, maxBytes - 768);
  let compact = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    compact = serializeCompact([
      compactSummary ? `Summary: ${compactSummary}` : 'Tool output was summarized for model context.',
      artifactText.trim(),
      truncateForModel(output, outputBudget),
    ].filter(Boolean).join('\n'));

    const compactBytes = byteLength(compact);
    if (compactBytes <= maxBytes || outputBudget <= 128) break;
    outputBudget = Math.max(128, outputBudget - Math.max(compactBytes - maxBytes, 128));
  }

  if (byteLength(compact) > maxBytes) {
    compact = serializeCompact([
      compactSummary ? `Summary: ${compactSummary}` : 'Tool output was summarized for model context.',
      artifactText.trim(),
      `Output body omitted from model context (${fullOutputBytes}B total).`,
    ].filter(Boolean).join('\n'));
  }

  if (byteLength(compact) > maxBytes) {
    compact = serializeToolResult({
      success: executed.success,
      output: `Tool result omitted from model context (${fullOutputBytes}B total).`,
      outputBytes: fullOutputBytes,
      metadata: {
        modelVisibleCompressed: true,
        originalResultBytes: rawBytes,
      },
    });
  }

  const bytes = byteLength(compact);
  return {
    result: compact,
    bytes,
    summarizedBytes: Math.max(0, fullOutputBytes - bytes),
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
      modelVisibleResult: string;
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
  | {
      type: 'complete';
      content: string;
      usage?: { promptTokens: number; completionTokens: number };
      model: string;
      stats?: LoopStats;
    };

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
  /** Maximum number of concurrency-safe tools to execute at once (default 6). */
  maxParallelToolCalls?: number;
  /** Maximum bytes of one tool result to expose to the next model request. */
  maxModelVisibleToolResultBytes?: number;
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
    maxParallelToolCalls = 6,
  } = params;

  const openaiTools = toOpenAITools(tools) as unknown as Tool[];
  let turn = 0;
  const stats = createLoopStats();
  const maxModelVisibleToolResultBytes = Math.max(
    512,
    params.maxModelVisibleToolResultBytes ?? DEFAULT_MAX_MODEL_VISIBLE_TOOL_RESULT_BYTES,
  );

  // 无限循环，依赖安全机制停止
  while (true) {
    turn++;

    // Check abort
    if (isAborted(abortSignal)) {
      yield cancelledCompleteEvent(llm, stats);
      return;
    }

    // Safety valve: check maxTurns if specified (optional)
    if (maxTurns && turn > maxTurns) {
      yield {
        type: 'complete',
        content: `Reached maximum turns (${maxTurns}). Task may be incomplete.`,
        model: llm.getModel(),
        stats: cloneLoopStats(stats, 'max_turns'),
      };
      return;
    }

    // Request start
    yield { type: 'request_start', model: llm.getModel(), turn };
    stats.turnsStarted = turn;

    const autoCompact = getAutoCompact({
      modelId: llm.getModel(),
      getContextCapsule: harness ? () => harness.getCapsule() : undefined,
      getHarnessState: harness ? () => harness.toJSON() : undefined,
      llm,
    });

    // Stream the LLM response. Harness context is injected into a cloned
    // request payload so the durable conversation history stays clean.
    let requestMessages = harness
      ? harness.assembleMessages(messages, { input, tools: tools.map(tool => ({ name: tool.name, description: tool.description })) })
      : messages;
    const predictedTokens = estimateMessagesTokens(requestMessages);
    const preCompacted = await autoCompact.checkPredictiveAndCompact(messages, predictedTokens);
    if (preCompacted !== messages) {
      stats.compactTrigger = 'pre_turn';
      messages.length = 0;
      messages.push(...preCompacted);
      requestMessages = harness
        ? harness.assembleMessages(messages, { input, tools: tools.map(tool => ({ name: tool.name, description: tool.description })) })
        : messages;
    }

    if (isAborted(abortSignal)) {
      yield cancelledCompleteEvent(llm, stats);
      return;
    }

    const response = await llm.chatStream(requestMessages, streamCallbacks, openaiTools, { abortSignal });
    stats.llmRequests++;

    if (isAborted(abortSignal)) {
      yield cancelledCompleteEvent(llm, stats);
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
      stats.toolCalls += preparedCalls.length;
      for (const prepared of preparedCalls) {
        if (prepared.tool?.isReadOnly?.(prepared.args) === true) {
          stats.readOnlyToolCalls++;
        } else {
          stats.unsafeToolCalls++;
        }
      }

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
        maxParallelToolCalls,
      })) {
        if (isAborted(abortSignal)) {
          yield cancelledCompleteEvent(llm, stats);
          return;
        }

        const { prepared } = executed;
        const { tc, args, attemptId } = prepared;
        const modelVisible = summarizeModelVisibleToolResult(
          executed,
          maxModelVisibleToolResultBytes,
        );
        stats.toolResultBytes += executed.outputBytes ?? byteLength(executed.result);
        stats.modelVisibleToolBytes += modelVisible.bytes;
        stats.summarizedBytes += modelVisible.summarizedBytes;

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
        if (harness && tc.function.name === 'batch_read') {
          for (const step of parseBatchReadEvidenceSteps(executed.result)) {
            harness.recordToolResult({
              name: step.tool,
              args: step.args,
              result: JSON.stringify({
                success: step.success,
                output: step.output,
                summary: step.summary,
                error: step.error,
              }),
              duration: executed.duration,
              success: step.success,
              error: step.error,
              summary: step.summary,
            });
          }
        }

        yield {
          type: 'tool_result',
          name: tc.function.name,
          args,
          callId: tc.id,
          result: executed.result,
          modelVisibleResult: modelVisible.result,
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
          content: modelVisible.result,
          tool_call_id: tc.id,
        });

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
      stats.finishReason = 'completion_gate';
      continue;
    }

    yield { type: 'message', role: 'assistant', content: response.content };

    // Record usage to cost tracker
    if (costTracker && response.usage) {
      costTracker.record(response.usage, { model: response.model });
    }

    // Auto-compact at 95% context usage (token-based)
    const totalTokens = response.usage?.promptTokens ?? 0;
    autoCompact.configure({
      modelId: response.model || llm.getModel(),
      getContextCapsule: harness ? () => harness.getCapsule() : undefined,
      getHarnessState: harness ? () => harness.toJSON() : undefined,
      llm,
    });
    const compacted = await autoCompact.checkAndCompact(messages, totalTokens);
    if (compacted !== messages) {
      stats.compactTrigger = stats.compactTrigger ?? 'post_turn';
      messages.length = 0;
      messages.push(...compacted);
    }

    yield {
      type: 'complete',
      content: response.content,
      usage: response.usage,
      model: response.model,
      stats: cloneLoopStats(stats, 'completed'),
    };
    return;
  }
  // Note: Loop exits via return statements above, not by falling through
}
