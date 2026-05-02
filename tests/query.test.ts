import { query } from '../src/framework/query';
import type { QueryEvent } from '../src/framework/query';
import { buildTool } from '../src/framework/tool';
import type { OpenHorseTool } from '../src/framework/tool';
import type { LLMService, LLMResponse, Message, Tool } from '../src/services/llm';

const mockTool: OpenHorseTool = buildTool({
  name: 'read_file',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path' } },
    required: ['path'],
  },
  execute: async () => ({ success: true, output: 'file content' }),
});

function makeMockLLM(responses: LLMResponse[]): jest.Mocked<LLMService> {
  let callIndex = 0;
  return {
    chatStream: jest.fn(async () => {
      const resp = responses[callIndex++];
      return resp ?? { content: 'done', model: 'test-model' };
    }),
    getModel: jest.fn(() => 'test-model'),
    setModel: jest.fn(),
    getConfigSummary: jest.fn(() => ({ model: 'test-model' })),
  } as unknown as jest.Mocked<LLMService>;
}

function collectEvents(params: Parameters<typeof query>[0]) {
  const events: QueryEvent[] = [];
  return query(params);
}

describe('query generator', () => {
  test('yields request_start, message, complete on simple response', async () => {
    const llm = makeMockLLM([
      { content: 'Hello!', model: 'test-model' },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Hi' },
    ];

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'result',
      llm,
    })) {
      events.push(event);
    }

    expect(events.length).toBe(3);
    expect(events[0]).toMatchObject({ type: 'request_start', model: 'test-model', turn: 1 });
    expect(events[1]).toMatchObject({ type: 'message', role: 'assistant', content: 'Hello!' });
    expect(events[2]).toMatchObject({ type: 'complete', content: 'Hello!', model: 'test-model' });
  });

  test('yields tool_call and tool_result when tool is called', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/test"}' } },
        ],
      },
      { content: 'The file says hello', model: 'test-model' },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Read the file' },
    ];

    const executedTools: Array<{ name: string; args: Record<string, unknown> }> = [];
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async (name, args) => {
        executedTools.push({ name, args });
        return 'file content here';
      },
      llm,
    })) {
      events.push(event);
    }

    // Expect: request_start → tool_call → tool_result → request_start → message → complete
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool_call', name: 'read_file' })
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool_result', name: 'read_file', result: 'file content here' })
    );
    expect(executedTools).toHaveLength(1);
    expect(executedTools[0].name).toBe('read_file');
    expect(executedTools[0].args).toEqual({ path: '/test' });
  });

  test('respects abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const llm = makeMockLLM([
      { content: 'should not reach', model: 'test-model' },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Hi' },
    ];

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'result',
      llm,
      abortSignal: controller.signal,
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'complete',
      content: 'Operation cancelled.',
    });
    // chatStream should never have been called
    expect(llm.chatStream).not.toHaveBeenCalled();
  });

  test('reaches max turns and returns truncation message', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/1"}' } },
        ],
      },
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'call-2', type: 'function', function: { name: 'read_file', arguments: '{"path":"/2"}' } },
        ],
      },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Go' },
    ];

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'result',
      llm,
      maxTurns: 1,
    })) {
      events.push(event);
    }

    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeDefined();
    expect((complete as any).content).toContain('maximum execution steps');
  });

  test('passes usage info in complete event', async () => {
    const llm = makeMockLLM([
      {
        content: 'Answer',
        model: 'test-model',
        usage: { promptTokens: 10, completionTokens: 20 },
      },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Hi' },
    ];

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'result',
      llm,
    })) {
      events.push(event);
    }

    const complete = events.find(e => e.type === 'complete') as any;
    expect(complete.usage).toEqual({ promptTokens: 10, completionTokens: 20 });
  });

  test('increments turn counter correctly', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/1"}' } },
        ],
      },
      { content: 'Final answer', model: 'test-model' },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Go' },
    ];

    const requestStarts: QueryEvent[] = [];
    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'result',
      llm,
    })) {
      if (event.type === 'request_start') requestStarts.push(event);
    }

    expect(requestStarts).toHaveLength(2);
    expect((requestStarts[0] as any).turn).toBe(1);
    expect((requestStarts[1] as any).turn).toBe(2);
  });
});
