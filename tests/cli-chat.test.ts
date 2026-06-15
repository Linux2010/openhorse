/**
 * CLI 对话回归测试
 *
 * 测试完整的对话流程：
 * 1. Store 消息添加
 * 2. Query 循环执行
 * 3. LLMService 流式响应（包括 usage）
 */

import { Store } from '../src/framework/store';
import { query, type QueryEvent } from '../src/framework/query';
import { LLMService, type Message, type Tool } from '../src/services/llm';
import { TOOLS } from '../src/tools';
import { loadConfig } from '../src/services/config';
import { executeChat } from '../src/commands';

// Mock LLMService for testing without real API
class MockLLMService {
  private model: string;

  constructor(model: string = 'gpt-4o') {
    this.model = model;
  }

  async chatStream(
    messages: Message[],
    callbacks?: { onChunk?: (chunk: string) => void },
    tools?: Tool[],
  ): Promise<{
    content: string;
    model: string;
    usage?: { promptTokens: number; completionTokens: number };
    toolCalls?: any[];
  }> {
    // Simulate streaming response
    const response = 'This is a mock response.';
    if (callbacks?.onChunk) {
      // Stream word by word
      for (const word of response.split(' ')) {
        callbacks.onChunk(word + ' ');
      }
    }

    // Return response WITH usage (this is what we're testing)
    return {
      content: response,
      model: this.model,
      usage: {
        promptTokens: 100,
        completionTokens: 20,
      },
    };
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }
}

describe('CLI Chat Regression', () => {
  describe('Store message handling', () => {
    test('addMessage appends to conversation history', () => {
      const store = new Store({
        config: loadConfig(),
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });

      expect(store.getSnapshot().conversationHistory.length).toBe(0);

      store.addMessage({ role: 'user', content: 'Hello' });
      expect(store.getSnapshot().conversationHistory.length).toBe(1);
      expect(store.getSnapshot().conversationHistory[0].content).toBe('Hello');

      store.addMessage({ role: 'assistant', content: 'Hi there!' });
      expect(store.getSnapshot().conversationHistory.length).toBe(2);
    });

    test('resetConversation clears history and token usage', () => {
      const store = new Store({
        config: loadConfig(),
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });

      store.addMessage({ role: 'user', content: 'Test' });
      store.setTokenUsage({ promptTokens: 100, completionTokens: 50 });

      store.resetConversation();

      expect(store.getSnapshot().conversationHistory.length).toBe(0);
      expect(store.getSnapshot().tokenUsage).toBeNull();
    });

    test('setTokenUsage updates state', () => {
      const store = new Store({
        config: loadConfig(),
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });

      store.setTokenUsage({ promptTokens: 200, completionTokens: 100 });

      const usage = store.getSnapshot().tokenUsage;
      expect(usage?.promptTokens).toBe(200);
      expect(usage?.completionTokens).toBe(100);
    });
  });

  describe('Query loop', () => {
    test('query yields complete event with usage', async () => {
      const mockLLM = new MockLLMService() as unknown as LLMService;

      const messages: Message[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      const toolExecutor = async (name: string, args: Record<string, unknown>) => {
        return JSON.stringify({ success: true });
      };

      const events: QueryEvent[] = [];

      for await (const event of query({
        messages,
        tools: TOOLS,
        toolExecutor,
        llm: mockLLM,
        streamCallbacks: { onChunk: (chunk) => {} },
      })) {
        events.push(event);
      }

      // Should have request_start, message, and complete events
      expect(events.some(e => e.type === 'request_start')).toBe(true);
      expect(events.some(e => e.type === 'complete')).toBe(true);

      // Check complete event has usage
      const completeEvent = events.find(e => e.type === 'complete');
      if (completeEvent?.type === 'complete') {
        expect(completeEvent.usage).toBeDefined();
        expect(completeEvent.usage?.promptTokens).toBe(100);
        expect(completeEvent.usage?.completionTokens).toBe(20);
      }
    });

    test('query preserves conversation history', async () => {
      const mockLLM = new MockLLMService() as unknown as LLMService;

      const messages: Message[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'User message' },
      ];

      const toolExecutor = async () => JSON.stringify({ success: true });

      await (async () => {
        for await (const _ of query({
          messages,
          tools: TOOLS,
          toolExecutor,
          llm: mockLLM,
        })) {
          // Just consume events
        }
      })();

      // Messages should have assistant response appended
      expect(messages.length).toBe(3);
      expect(messages[2].role).toBe('assistant');
    });

    test('executeChat suppresses legacy token meta line in v2 UI', async () => {
      const config = loadConfig({
        apiKey: 'test-key',
        ui: { renderer: 'v2', confirmations: 'config' },
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'gpt-4o',
      });
      const mockLLM = new MockLLMService('gpt-4o') as unknown as LLMService;
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      try {
        await executeChat({
          cwd: process.cwd(),
          config,
          store,
          llm: mockLLM,
          runtime: {} as any,
        }, 'Hello');

        const output = [
          ...logSpy.mock.calls.flat().map(String),
          ...writeSpy.mock.calls.flat().map(String),
        ].join('\n');

        expect(output).toContain('This is a mock response.');
        expect(output).not.toContain('tokens: 100+20');
      } finally {
        logSpy.mockRestore();
        writeSpy.mockRestore();
      }
    });
  });

  describe('CostTracker integration', () => {
    test('CostTracker records usage from query', async () => {
      const { CostTracker } = await import('../src/core/cost-tracker');
      const mockLLM = new MockLLMService() as unknown as LLMService;
      const costTracker = new CostTracker();

      const messages: Message[] = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Test' },
      ];

      const toolExecutor = async () => JSON.stringify({ success: true });

      for await (const event of query({
        messages,
        tools: TOOLS,
        toolExecutor,
        llm: mockLLM,
        costTracker,
      })) {
        if (event.type === 'complete') {
          // After complete, costTracker should have recorded usage
        }
      }

      const stats = costTracker.getStats();
      expect(stats.recordCount).toBe(1);
      expect(stats.totalTokens).toBe(120); // 100 + 20
    });
  });
});
