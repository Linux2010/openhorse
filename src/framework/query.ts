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
import type { OpenHorseTool, ToolContext, PermissionResult } from './tool';
import type { PermissionMode } from '../commands/types';
import type { CostTracker } from '../core/cost-tracker';
import { toOpenAITools } from './tool';

// ============================================================================
// 事件类型
// ============================================================================

export type QueryEvent =
  | { type: 'request_start'; model: string; turn: number }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; callId: string }
  | { type: 'tool_result'; name: string; result: string; duration: number }
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
  /** Tool executor: (name, args) => result string */
  toolExecutor: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** LLM service instance */
  llm: LLMService;
  /** Maximum turns (default: 20) */
  maxTurns?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Streaming callbacks (onChunk writes to stdout, etc.) */
  streamCallbacks?: StreamCallbacks;
  /** Permission mode for tool execution */
  permissionMode?: PermissionMode;
  /** Tool execution context */
  toolContext?: ToolContext;
  /** Cost tracker for recording usage */
  costTracker?: CostTracker;
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
    maxTurns = 20,
    abortSignal,
    streamCallbacks,
    costTracker,
  } = params;

  const openaiTools = toOpenAITools(tools) as unknown as Tool[];
  let turn = 0;

  while (turn < maxTurns) {
    turn++;

    // Check abort
    if (abortSignal?.aborted) {
      yield {
        type: 'complete',
        content: 'Operation cancelled.',
        model: llm.getModel(),
      };
      return;
    }

    // Request start
    yield { type: 'request_start', model: llm.getModel(), turn };

    // Stream the LLM response
    const response = await llm.chatStream(messages, streamCallbacks, openaiTools);

    // Save assistant message to history
    const assistantMsg: Message = {
      role: 'assistant',
      content: response.content,
    };
    if (response.toolCalls) {
      assistantMsg.tool_calls = response.toolCalls;
    }
    messages.push(assistantMsg);

    // Handle tool calls
    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const tc of response.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          // Pass raw string as args fallback
        }

        yield {
          type: 'tool_call',
          name: tc.function.name,
          args,
          callId: tc.id,
        };

        const start = Date.now();

        // Permission check before execution
        let result: string;
        const tool = tools.find(t => t.name === tc.function.name);

        if (tool?.checkPermissions && params.toolContext) {
          const perm = tool.checkPermissions(args, params.toolContext);

          if (perm.behavior === 'deny') {
            result = JSON.stringify({
              success: false,
              error: perm.reason || 'Permission denied',
            });
          } else if (perm.behavior === 'ask' && params.permissionMode === 'default') {
            // In default mode, ask user for destructive operations
            // For now, deny with message (future: interactive prompt)
            result = JSON.stringify({
              success: false,
              error: `Tool ${tc.function.name} requires user confirmation. Use 'acceptEdits' or 'auto' mode to allow.`,
            });
          } else {
            // Allow: either permission is 'allow' or mode is 'acceptEdits'/'auto'
            result = await toolExecutor(tc.function.name, args);
          }
        } else {
          // No permission check defined, execute directly
          result = await toolExecutor(tc.function.name, args);
        }

        const duration = Date.now() - start;

        yield {
          type: 'tool_result',
          name: tc.function.name,
          result,
          duration,
        };

        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
        });
      }

      // Continue to next turn
      continue;
    }

    // No tool calls — done
    yield { type: 'message', role: 'assistant', content: response.content };

    // Record usage to cost tracker
    if (costTracker && response.usage) {
      costTracker.record(response.usage, { model: response.model });
    }

    yield {
      type: 'complete',
      content: response.content,
      usage: response.usage,
      model: response.model,
    };
    return;
  }

  // Max turns reached
  yield {
    type: 'complete',
    content: 'Reached maximum execution steps. Please simplify your request.',
    model: llm.getModel(),
  };
}
