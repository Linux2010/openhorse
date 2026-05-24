/**
 * openhorse - LLM 服务层
 *
 * 封装 OpenAI 兼容 API，支持流式和非流式调用。
 * 兼容 OpenAI、Claude (via proxy)、本地 Ollama 等。
 * 支持工具调用（function calling）和 agentic 循环。
 * 支持重试机制和 fallback model。
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

// ============================================================================
// 类型定义
// ============================================================================

/** LLM 配置 */
export interface LLMConfig {
  /** API Key */
  apiKey: string;
  /** API Base URL（兼容第三方） */
  baseUrl?: string;
  /** 模型名称 */
  model: string;
  /** 备用模型（主模型失败时切换） */
  fallbackModel?: string;
  /** 最大输出 token 数 */
  maxTokens?: number;
  /** 温度 */
  temperature?: number;
  /** 请求超时 (ms) */
  timeout?: number;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 重试基础延迟 (ms) */
  retryBaseDelay?: number;
}

/** 重试配置 */
export interface RetryConfig {
  /** 最大重试次数 */
  maxRetries: number;
  /** 基础延迟 ms */
  baseDelayMs: number;
  /** 最大延迟 ms */
  maxDelayMs?: number;
  /** 重试回调 */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

/** Fallback 触发错误 */
export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Fallback triggered: ${originalModel} -> ${fallbackModel}`);
    this.name = 'FallbackTriggeredError';
  }
}

/** 对话消息 */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** 工具定义 */
export interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** LLM 响应 */
export interface LLMResponse {
  /** 回复内容 */
  content: string;
  /** Token 用量 */
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
  /** 使用的模型 */
  model: string;
  /** 工具调用 */
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/** 流式回调 */
export type StreamCallback = (chunk: string) => void;

/** 工具回调 — LLM 流式输出时的钩子 */
export interface StreamCallbacks {
  /** 文本块回调 */
  onChunk?: StreamCallback;
  /** 思考提示回调（流式开始前） */
  onThinking?: () => void;
}

// ============================================================================
// 重试机制
// ============================================================================

/** 默认重试配置 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10000,
};

/** 529 错误最大重试次数（触发 fallback） */
const MAX_529_RETRIES = 3;

/** 判断错误是否可重试 */
function isRetryableError(error: unknown): boolean {
  if (!error) return false;

  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('timeout') || msg.includes('connection') || msg.includes('econnreset') || msg.includes('epipe');
  }

  return false;
}

/** 判断是否为 529 错误 */
function is529Error(error: unknown): boolean {
  return error instanceof OpenAI.APIError && error.status === 529;
}

/** 从错误中提取 retry-after 时间 */
function getRetryAfterMs(error: unknown): number | null {
  if (error instanceof OpenAI.APIError && error.headers) {
    const headers = error.headers;
    let retryAfter: string | null = null;

    // headers may be Headers object or plain object
    if (headers && typeof headers === 'object') {
      if ('get' in headers && typeof headers.get === 'function') {
        retryAfter = headers.get('retry-after');
      } else if ('retry-after' in headers) {
        retryAfter = (headers as Record<string, string>)['retry-after'];
      }
    }

    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) return seconds * 1000;
    }
  }
  return null;
}

/** 指数退避计算 */
function exponentialBackoff(attempt: number, baseDelayMs: number, maxDelayMs?: number): number {
  const delay = baseDelayMs * Math.pow(2, attempt - 1);
  return maxDelayMs ? Math.min(delay, maxDelayMs) : delay;
}

/** Sleep 函数 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 带重试的操作 */
async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!isRetryableError(error)) {
        throw lastError;
      }

      if (attempt > config.maxRetries) {
        throw lastError;
      }

      let delayMs = exponentialBackoff(attempt, config.baseDelayMs, config.maxDelayMs);

      const retryAfter = getRetryAfterMs(error);
      if (retryAfter !== null) {
        delayMs = retryAfter;
      }

      config.onRetry?.(attempt, lastError, delayMs);

      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error('Unknown error');
}

// ============================================================================
// LLMService
// ============================================================================

export class LLMService {
  private client: OpenAI;
  private config: Required<
    Pick<LLMConfig, 'model' | 'maxTokens' | 'temperature' | 'timeout'>
  > & { fallbackModel: string; maxRetries: number; retryBaseDelay: number };
  private consecutive529Errors = 0;
  private usingFallback = false;

  constructor(config: LLMConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeout ?? 60000,
      dangerouslyAllowBrowser: true,
    });

    this.config = {
      model: config.model,
      fallbackModel: config.fallbackModel ?? '',
      maxTokens: config.maxTokens ?? 4096,
      temperature: config.temperature ?? 0.7,
      timeout: config.timeout ?? 60000,
      maxRetries: config.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
      retryBaseDelay: config.retryBaseDelay ?? DEFAULT_RETRY_CONFIG.baseDelayMs,
    };
  }

  /** 是否正在使用 fallback model */
  isUsingFallback(): boolean {
    return this.usingFallback;
  }

  /** 触发 fallback */
  triggerFallback(): void {
    if (this.config.fallbackModel && !this.usingFallback) {
      this.usingFallback = true;
      this.config.model = this.config.fallbackModel;
      this.consecutive529Errors = 0;
    }
  }

  /** 重置为原始 model */
  resetToPrimary(): void {
    this.usingFallback = false;
    this.consecutive529Errors = 0;
  }

  /**
   * 非流式对话
   */
  async chat(messages: Message[], tools?: Tool[]): Promise<LLMResponse> {
    const params: Record<string, unknown> = {
      model: this.config.model,
      messages: this.toOpenAIMessages(messages),
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
    };

    if (tools && tools.length > 0) {
      params.tools = tools as ChatCompletionTool[];
    }

    const response = await this.client.chat.completions.create(params as any);

    const message = response.choices?.[0]?.message;
    const content = message?.content ?? '';
    const toolCalls = message?.tool_calls?.map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

    const usage = response.usage
      ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
        }
      : undefined;

    return {
      content,
      usage,
      model: response.model,
      toolCalls,
    };
  }

  /**
   * 流式对话（带重试）
   */
  async chatStream(
    messages: Message[],
    callbacks?: StreamCallbacks | StreamCallback,
    tools?: Tool[],
  ): Promise<LLMResponse> {
    const onChunk = typeof callbacks === 'function' ? callbacks : callbacks?.onChunk;
    const onThinking = typeof callbacks === 'object' ? callbacks?.onThinking : undefined;

    const retryConfig: RetryConfig = {
      maxRetries: this.config.maxRetries,
      baseDelayMs: this.config.retryBaseDelay,
      maxDelayMs: 10000,
      onRetry: (_attempt, error, _delayMs) => {
        // 529 错误计数
        if (is529Error(error)) {
          this.consecutive529Errors++;
          if (this.consecutive529Errors >= MAX_529_RETRIES && this.config.fallbackModel) {
            this.triggerFallback();
          }
        }
      },
    };

    return withRetry(
      async () => {
        const params: Record<string, unknown> = {
          model: this.config.model,
          messages: this.toOpenAIMessages(messages),
          max_tokens: this.config.maxTokens,
          temperature: this.config.temperature,
          stream: true,
          stream_options: { include_usage: true },
        };

        if (tools && tools.length > 0) {
          params.tools = tools as ChatCompletionTool[];
        }

        onThinking?.();

        const stream = await this.client.chat.completions.create(params as any) as unknown as AsyncIterable<any>;

        let content = '';
        let usedModel = this.config.model;
        let usage: { promptTokens: number; completionTokens: number } | undefined;
        const toolCallsMap = new Map<string, {
          id: string;
          type: 'function';
          function: { name: string; arguments: string };
        }>();

        for await (const chunk of stream) {
          // Debug: log raw chunk when tool_calls present (for diagnosing API compatibility)
          if (process.env.OPENHORSE_DEBUG_TOOLS === 'true') {
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.tool_calls || chunk.choices?.[0]?.message?.tool_calls) {
              console.log('[DEBUG] Raw chunk:', JSON.stringify(chunk, null, 2));
            }
          }

          const delta = chunk.choices?.[0]?.delta;

          const text = delta?.content ?? '';
          if (text) {
            content += text;
            onChunk?.(text);
          }

          // Handle tool_calls from delta (OpenAI standard streaming format)
          // Note: Some APIs (like DashScope) send id AND arguments in the same chunk
          const tc = delta?.tool_calls?.[0];
          if (tc) {
            const idx = tc.index ?? 0;
            // Create or update entry
            if (tc.id) {
              toolCallsMap.set(idx, {
                id: tc.id,
                type: 'function',
                function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
              });
            } else if (tc.function?.arguments) {
              // Arguments chunk (no id, just adding arguments)
              const entry = toolCallsMap.get(idx);
              if (entry) {
                entry.function.arguments += tc.function.arguments;
              }
            }
          }

          // Handle tool_calls from message (some APIs like DashScope may use this format)
          const msg = chunk.choices?.[0]?.message;
          if (msg?.tool_calls && !delta?.tool_calls) {
            for (const msgTc of msg.tool_calls) {
              const existing = toolCallsMap.get(msgTc.index ?? 0);
              if (!existing && msgTc.id) {
                toolCallsMap.set(msgTc.index ?? 0, {
                  id: msgTc.id,
                  type: 'function',
                  function: { name: msgTc.function?.name ?? '', arguments: msgTc.function?.arguments ?? '' },
                });
              } else if (existing && msgTc.function?.arguments) {
                existing.function.arguments += msgTc.function.arguments;
              }
            }
          }

          if (chunk.usage) {
            usage = {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
            };
          }

          if (chunk.model) {
            usedModel = chunk.model;
          }
        }

        const toolCalls = Array.from(toolCallsMap.values());

        for (const tc of toolCalls) {
          if (!tc.function.arguments || tc.function.arguments.trim() === '') {
            tc.function.arguments = '{}';
          } else {
            try {
              const parsed = JSON.parse(tc.function.arguments);
              tc.function.arguments = JSON.stringify(parsed);
            } catch {
              tc.function.arguments = '{}';
            }
          }
        }

        return {
          content,
          model: usedModel,
          usage,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        };
      },
      retryConfig,
    );
  }

  /**
   * 带工具调用的 agentic 循环
   */
  async chatWithTools(
    messages: Message[],
    tools: Tool[],
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<string>,
    callbacks?: StreamCallbacks,
    maxIterations = 10,
  ): Promise<LLMResponse> {
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      const response = await this.chatStream(messages, {
        onChunk: callbacks?.onChunk,
        onThinking: iteration === 1 ? callbacks?.onThinking : undefined,
      }, tools);

      const assistantMsg: Message = {
        role: 'assistant',
        content: response.content,
      };
      if (response.toolCalls) {
        assistantMsg.tool_calls = response.toolCalls;
      }
      messages.push(assistantMsg);

      if (response.toolCalls && response.toolCalls.length > 0) {
        for (const tc of response.toolCalls) {
          const result = await toolExecutor(tc.function.name, JSON.parse(tc.function.arguments));
          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: tc.id,
          });
        }
        continue;
      }

      return response;
    }

    return {
      content: '达到了最大执行步数限制，未能完成。请简化任务。',
      model: this.config.model,
    };
  }

  /**
   * 切换模型
   */
  setModel(model: string): void {
    this.config.model = model;
  }

  /**
   * 获取当前模型
   */
  getModel(): string {
    return this.config.model;
  }

  /**
   * 获取当前配置摘要
   */
  getConfigSummary(): Record<string, string> {
    return {
      model: this.config.model,
      fallback: this.config.fallbackModel || '(none)',
      maxTokens: String(this.config.maxTokens),
      temperature: String(this.config.temperature),
      timeout: String(this.config.timeout),
      maxRetries: String(this.config.maxRetries),
    };
  }

  // ---- Internal ----

  /** 转换为 OpenAI SDK 消息格式 */
  private toOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
    return messages.map(msg => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.tool_call_id ?? '',
        } as ChatCompletionMessageParam;
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        return {
          role: 'assistant',
          content: msg.content,
          tool_calls: msg.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        } as ChatCompletionMessageParam;
      }
      return {
        role: msg.role,
        content: msg.content,
      } as ChatCompletionMessageParam;
    });
  }
}