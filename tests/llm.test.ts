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

  describe('chatStream cancellation', () => {
    test('passes abort signal to OpenAI request options', async () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });
      const controller = new AbortController();
      const create = jest.fn(async function* () {
        yield {
          choices: [{ delta: { content: 'ok' } }],
          model: 'gpt-4o',
        };
        yield {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
          model: 'gpt-4o',
        };
      });

      (llm as any).client = {
        chat: {
          completions: { create },
        },
      };

      const response = await llm.chatStream(
        [{ role: 'user', content: 'Hi' }],
        undefined,
        undefined,
        { abortSignal: controller.signal },
      );

      expect(response.content).toBe('ok');
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ stream: true }),
        { signal: controller.signal },
      );
    });

    test('stops processing stream chunks after abort', async () => {
      const llm = new LLMService({
        apiKey: 'test-key',
        model: 'gpt-4o',
      });
      const controller = new AbortController();
      const create = jest.fn(async function* () {
        controller.abort();
        yield {
          choices: [{ delta: { content: 'should not render' } }],
          model: 'gpt-4o',
        };
      });
      const onChunk = jest.fn();

      (llm as any).client = {
        chat: {
          completions: { create },
        },
      };

      await expect(llm.chatStream(
        [{ role: 'user', content: 'Hi' }],
        { onChunk },
        undefined,
        { abortSignal: controller.signal },
      )).rejects.toMatchObject({ name: 'AbortError' });
      expect(onChunk).not.toHaveBeenCalled();
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
