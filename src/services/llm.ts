/**
 * openhorse - LLM 服务层
 *
 * 封装 OpenAI 兼容 API，支持流式和非流式调用。
 * 兼容 OpenAI、Claude (via proxy)、本地 Ollama 等。
 * 支持工具调用（function calling）和 agentic 循环。
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
  /** 最大输出 token 数 */
  maxTokens?: number;
  /** 温度 */
  temperature?: number;
  /** 请求超时 (ms) */
  timeout?: number;
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
// LLMService
// ============================================================================

export class LLMService {
  private client: OpenAI;
  private config: Required<
    Pick<LLMConfig, 'model' | 'maxTokens' | 'temperature' | 'timeout'>
  >;

  constructor(config: LLMConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeout ?? 60000,
      dangerouslyAllowBrowser: true,
    });

    this.config = {
      model: config.model,
      maxTokens: config.maxTokens ?? 4096,
      temperature: config.temperature ?? 0.7,
      timeout: config.timeout ?? 60000,
    };
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
   * 流式对话
   */
  async chatStream(
    messages: Message[],
    callbacks?: StreamCallbacks | StreamCallback,
    tools?: Tool[],
  ): Promise<LLMResponse> {
    const onChunk = typeof callbacks === 'function' ? callbacks : callbacks?.onChunk;
    const onThinking = typeof callbacks === 'object' ? callbacks?.onThinking : undefined;

    const params: Record<string, unknown> = {
      model: this.config.model,
      messages: this.toOpenAIMessages(messages),
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
    };

    if (tools && tools.length > 0) {
      params.tools = tools as ChatCompletionTool[];
    }

    onThinking?.();

    const stream = await this.client.chat.completions.create(params as any) as unknown as AsyncIterable<any>;

    let content = '';
    let usedModel = this.config.model;
    const toolCallsMap = new Map<string, {
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>();

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;

      // 文本内容
      const text = delta?.content ?? '';
      if (text) {
        content += text;
        onChunk?.(text);
      }

      // 工具调用片段
      const tc = delta?.tool_calls?.[0];
      if (tc?.id) {
        toolCallsMap.set(tc.index ?? 0, {
          id: tc.id,
          type: 'function',
          function: { name: tc.function?.name ?? '', arguments: '' },
        });
      } else if (tc?.function?.arguments) {
        const entry = toolCallsMap.get(tc.index ?? 0);
        if (entry) {
          entry.function.arguments += tc.function.arguments;
        }
      }

      if (chunk.model) {
        usedModel = chunk.model;
      }
    }

    const toolCalls = Array.from(toolCallsMap.values());

    return {
      content,
      model: usedModel,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  /**
   * 带工具调用的 agentic 循环
   *
   * 循环：LLM → tool_call → 执行工具 → 结果喂回 → LLM → ... → 最终文本
   *
   * @param messages 对话历史
   * @param tools 工具定义
   * @param toolExecutor 工具执行函数 (name, args) => result
   * @param callbacks 流式回调
   * @param maxIterations 最大循环次数
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
        // 只在第一轮显示 thinking（后续循环是工具调用，用户不需要看到 thinking）
        onThinking: iteration === 1 ? callbacks?.onThinking : undefined,
      }, tools);

      // 保存助手回复到历史
      const assistantMsg: Message = {
        role: 'assistant',
        content: response.content,
      };
      if (response.toolCalls) {
        assistantMsg.tool_calls = response.toolCalls;
      }
      messages.push(assistantMsg);

      // 如果有工具调用，执行并继续
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

      // 无工具调用，循环结束
      return response;
    }

    // 超过最大循环次数
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
      maxTokens: String(this.config.maxTokens),
      temperature: String(this.config.temperature),
      timeout: String(this.config.timeout),
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
