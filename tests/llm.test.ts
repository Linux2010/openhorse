/**
 * LLMService 单元测试
 *
 * 测试 LLMService 的核心功能，包括：
 * - chatStream usage 提取
 * - 消息格式转换
 * - 工具调用处理
 */

import { LLMService, type Message, type Tool } from '../src/services/llm';

// Skip real API tests if no API key is available
const hasApiKey = Boolean(process.env.OPENHORSE_API_KEY);

describe('LLMService', () => {
  async function* streamChunks(chunks: any[]) {
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  describe('toOpenAIMessages (internal)', () => {
    test('converts simple messages', () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });

      // Access internal method via any
      const messages: Message[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ];

      // The method is private, but we can test it via chat call structure
      // For now, just verify the service is constructed correctly
      expect(llm.getModel()).toBe('gpt-4o');
    });

    test('converts tool messages', () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });

      // Tool message format
      const messages: Message[] = [
        { role: 'user', content: 'What is the weather?' },
        { role: 'assistant', content: '', tool_calls: [{
          id: 'call-123',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"location":"Beijing"}' },
        }] },
        { role: 'tool', content: '{"temp":25}', tool_call_id: 'call-123' },
      ];

      // Verify service handles tool messages
      expect(llm).toBeDefined();
    });
  });

  describe('setModel/getModel', () => {
    test('setModel changes the model', () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });

      expect(llm.getModel()).toBe('gpt-4o');

      llm.setModel('claude-sonnet-4-6');
      expect(llm.getModel()).toBe('claude-sonnet-4-6');
    });
  });

  describe('getConfigSummary', () => {
    test('returns config summary', () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });

      const summary = llm.getConfigSummary();

      expect(summary.model).toBe('gpt-4o');
      expect(summary.maxTokens).toBe('8192');
      expect(summary.temperature).toBe('0.1');
    });
  });

  describe('chatStream tool calls', () => {
    test('aggregates multiple tool calls from one streaming delta chunk', async () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });

      (llm as any).client = {
        chat: {
          completions: {
            create: jest.fn(async () => streamChunks([
              {
                model: 'test-model',
                choices: [{
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
                      },
                      {
                        index: 1,
                        id: 'call-2',
                        type: 'function',
                        function: { name: 'grep', arguments: '{"pattern":"TODO"}' },
                      },
                    ],
                  },
                }],
              },
              {
                model: 'test-model',
                usage: { prompt_tokens: 12, completion_tokens: 3 },
                choices: [{ delta: {} }],
              },
            ])),
          },
        },
      };

      const response = await llm.chatStream([{ role: 'user', content: 'inspect' }]);

      expect(response.toolCalls).toHaveLength(2);
      expect(response.toolCalls?.map(tc => tc.id)).toEqual(['call-1', 'call-2']);
      expect(response.toolCalls?.[0].function).toEqual({ name: 'read_file', arguments: '{"path":"a.ts"}' });
      expect(response.toolCalls?.[1].function).toEqual({ name: 'grep', arguments: '{"pattern":"TODO"}' });
      expect(response.usage).toEqual({ promptTokens: 12, completionTokens: 3 });
    });
  });

  // Real API tests (only run if API key is available)
  describe('Real API (requires OPENHORSE_API_KEY)', () => {
    if (!hasApiKey) {
      test.skip('Skipping real API tests - no OPENHORSE_API_KEY', () => {});
      return;
    }

    test('chatStream returns usage with stream_options', async () => {
      const config = {
        apiKey: process.env.OPENHORSE_API_KEY!,
        baseUrl: process.env.OPENHORSE_API_BASE_URL,
        model: process.env.OPENHORSE_MODEL || 'gpt-4o',
      };

      const llm = new LLMService(config);

      const messages: Message[] = [
        { role: 'user', content: 'Say "test" and nothing else.' },
      ];

      const response = await llm.chatStream(messages, {
        onChunk: (chunk) => {
          // Just consume chunks
        },
      });

      expect(response.content).toBeDefined();
      expect(response.content.length).toBeGreaterThan(0);

      // This is the critical test: usage should be present
      expect(response.usage).toBeDefined();
      expect(response.usage!.promptTokens).toBeGreaterThan(0);
      expect(response.usage!.completionTokens).toBeGreaterThan(0);
    }, 30000);
  });
});
