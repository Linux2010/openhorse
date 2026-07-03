import { query } from '../src/framework/query';
import type { QueryEvent } from '../src/framework/query';
import { buildTool } from '../src/framework/tool';
import type { OpenHorseTool, ToolContext } from '../src/framework/tool';
import type { LLMService, LLMResponse, Message, Tool } from '../src/services/llm';
import { resetAutoCompact } from '../src/services/compact/auto-compact';

const mockTool: OpenHorseTool = buildTool({
  name: 'read_file',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path' } },
    required: ['path'],
  },
  execute: async () => ({ success: true, output: 'file content' }),
  isReadOnly: () => true,
});

const askTool: OpenHorseTool = buildTool({
  name: 'web_search',
  description: 'Search the web',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Query' } },
    required: ['query'],
  },
  execute: async () => ({ success: true, output: 'search results' }),
  checkPermissions: () => ({ behavior: 'ask', reason: 'External query' }),
});

const batchReadTool: OpenHorseTool = buildTool({
  name: 'batch_read',
  description: 'Batch read-only exploration',
  parameters: {
    type: 'object',
    properties: { steps: { type: 'array', description: 'Steps' } },
    required: ['steps'],
  },
  execute: async () => ({ success: true, output: '' }),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
});

const toolContext: ToolContext = {
  cwd: '/tmp/project',
  config: { name: 'test', mode: 'development' },
};

function makeMockLLM(responses: LLMResponse[], model = 'test-model'): jest.Mocked<LLMService> {
  let callIndex = 0;
  return {
    chat: jest.fn(async () => ({ content: 'compact summary', model })),
    chatStream: jest.fn(async () => {
      const resp = responses[callIndex++];
      return resp ?? { content: 'done', model };
    }),
    getModel: jest.fn(() => model),
    setModel: jest.fn(),
    getConfigSummary: jest.fn(() => ({ model })),
  } as unknown as jest.Mocked<LLMService>;
}

function collectEvents(params: Parameters<typeof query>[0]) {
  const events: QueryEvent[] = [];
  return query(params);
}

describe('query generator', () => {
  beforeEach(() => {
    resetAutoCompact();
  });

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
      expect.objectContaining({
        type: 'tool_result',
        name: 'read_file',
        callId: 'call-1',
        args: { path: '/test' },
        result: 'file content here',
      })
    );
    expect(executedTools).toHaveLength(1);
    expect(executedTools[0].name).toBe('read_file');
    expect(executedTools[0].args).toEqual({ path: '/test' });
  });

  test('emits multi-tool event sequence in stable runtime order', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/one"}' } },
          { id: 'call-2', type: 'function', function: { name: 'read_file', arguments: '{"path":"/two"}' } },
        ],
      },
      { content: 'Read both files', model: 'test-model' },
    ]);

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Read two files' },
      ],
      tools: [mockTool],
      toolExecutor: async (_name, args) => JSON.stringify({
        success: true,
        output: `content:${args.path}`,
      }),
      llm,
    })) {
      events.push(event);
    }

    expect(events.map(event => event.type)).toEqual([
      'request_start',
      'assistant_tool_calls',
      'tool_call',
      'tool_call',
      'tool_result',
      'tool_result',
      'request_start',
      'message',
      'complete',
    ]);
    expect(events[2]).toMatchObject({
      type: 'tool_call',
      callId: 'call-1',
      batchCount: 2,
      batchIndex: 0,
    });
    expect(events[3]).toMatchObject({
      type: 'tool_call',
      callId: 'call-2',
      batchCount: 2,
      batchIndex: 1,
    });
    expect(events[4]).toMatchObject({
      type: 'tool_result',
      callId: 'call-1',
      batchCount: 2,
      batchIndex: 0,
    });
    expect(events[5]).toMatchObject({
      type: 'tool_result',
      callId: 'call-2',
      batchCount: 2,
      batchIndex: 1,
    });
  });

  test('propagates structured tool result summary metadata', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/test"}' } },
        ],
      },
      { content: 'Done', model: 'test-model' },
    ]);

    const events: QueryEvent[] = [];

    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Read the file' },
      ],
      tools: [mockTool],
      toolExecutor: async () => JSON.stringify({
        success: true,
        output: 'file content',
        summary: 'read /test (1L, 12B)',
        outputBytes: 12,
      }),
      llm,
    })) {
      events.push(event);
    }

    const toolResult = events.find(event => event.type === 'tool_result') as Extract<QueryEvent, { type: 'tool_result' }>;
    expect(toolResult.summary).toBe('read /test (1L, 12B)');
    expect(toolResult.outputBytes).toBe(12);
  });

  test('reports loop stats on complete events', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/test"}' } },
        ],
      },
      { content: 'Done', model: 'test-model' },
    ]);

    const events: QueryEvent[] = [];
    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Read the file' },
      ],
      tools: [mockTool],
      toolExecutor: async () => JSON.stringify({
        success: true,
        output: 'file content',
        summary: 'read /test',
        outputBytes: 12,
      }),
      llm,
    })) {
      events.push(event);
    }

    const complete = events.find(event => event.type === 'complete') as Extract<QueryEvent, { type: 'complete' }>;
    expect(complete.stats).toMatchObject({
      finishReason: 'completed',
      turnsStarted: 2,
      llmRequests: 2,
      toolCalls: 1,
      readOnlyToolCalls: 1,
      unsafeToolCalls: 0,
      toolResultBytes: 12,
    });
    expect(complete.stats?.modelVisibleToolBytes).toBeGreaterThan(0);
  });

  test('compresses model-visible tool results while preserving full UI event results', async () => {
    const largeOutput = 'line with details\n'.repeat(1000);
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/large"}' } },
        ],
      },
      { content: 'Done', model: 'test-model' },
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Read the large file' },
    ];
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => JSON.stringify({
        success: true,
        output: largeOutput,
        summary: 'read /large (1000L)',
        outputBytes: Buffer.byteLength(largeOutput, 'utf8'),
        artifactRef: { id: 'read_file-large', outputBytes: Buffer.byteLength(largeOutput, 'utf8') },
      }),
      llm,
      maxModelVisibleToolResultBytes: 700,
    })) {
      events.push(event);
    }

    const toolResult = events.find(event => event.type === 'tool_result') as Extract<QueryEvent, { type: 'tool_result' }>;
    expect(JSON.parse(toolResult.result).output).toContain(largeOutput.slice(0, 100));
    expect(Buffer.byteLength(toolResult.modelVisibleResult, 'utf8')).toBeLessThanOrEqual(700);
    expect(toolResult.modelVisibleResult).not.toBe(toolResult.result);
    expect(toolResult.artifactRef).toEqual({ id: 'read_file-large', outputBytes: Buffer.byteLength(largeOutput, 'utf8') });

    const toolMessage = messages.find(message => message.role === 'tool');
    expect(toolMessage?.content.length).toBeLessThan(toolResult.result.length);
    expect(Buffer.byteLength(toolMessage?.content ?? '', 'utf8')).toBeLessThanOrEqual(700);
    expect(toolMessage?.content).toContain('modelVisibleCompressed');
    expect(toolMessage?.content).toContain('read_file-large');

    const complete = events.find(event => event.type === 'complete') as Extract<QueryEvent, { type: 'complete' }>;
    expect(complete.stats?.toolResultBytes).toBe(Buffer.byteLength(largeOutput, 'utf8'));
    expect(complete.stats?.modelVisibleToolBytes).toBeLessThan(complete.stats?.toolResultBytes ?? 0);
    expect(complete.stats?.summarizedBytes).toBeGreaterThan(0);
  });

  test('keeps model-visible tool result under byte budget for CJK output and long metadata', async () => {
    const largeOutput = '中文输出🙂'.repeat(1000);
    const longSummary = '摘要🙂'.repeat(300);
    const longError = '错误🙂'.repeat(300);
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/large"}' } },
        ],
      },
      { content: 'Done', model: 'test-model' },
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Read the large file' },
    ];

    for await (const _event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => JSON.stringify({
        success: false,
        output: largeOutput,
        summary: longSummary,
        error: longError,
        outputBytes: Buffer.byteLength(largeOutput, 'utf8'),
      }),
      llm,
      maxModelVisibleToolResultBytes: 700,
    })) {
      // consume
    }

    const toolMessage = messages.find(message => message.role === 'tool');
    expect(Buffer.byteLength(toolMessage?.content ?? '', 'utf8')).toBeLessThanOrEqual(700);
    expect(toolMessage?.content).toContain('modelVisibleCompressed');
  });

  test('records batch_read inner steps as harness evidence without changing tool protocol', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          {
            id: 'call-batch',
            type: 'function',
            function: {
              name: 'batch_read',
              arguments: JSON.stringify({
                steps: [
                  { tool: 'read_file', args: { path: 'src/index.ts' } },
                  { tool: 'grep', args: { pattern: 'TODO', path: 'src' } },
                ],
              }),
            },
          },
        ],
      },
      { content: 'Done', model: 'test-model' },
    ]);
    const harness = {
      assembleMessages: jest.fn((messages: Message[]) => messages),
      getCapsule: jest.fn(() => ({ summary: '' })),
      toJSON: jest.fn(() => ({})),
      recordAssistantResponse: jest.fn(),
      beforeToolUse: jest.fn(() => undefined),
      asToolBlockedResult: jest.fn(),
      beforeComplete: jest.fn(() => ({ canComplete: true })),
      asCompletionBlockedMessage: jest.fn(),
      recordToolResult: jest.fn(),
    };
    const batchPayload = {
      success: true,
      output: '1. read_file: read src/index.ts\n2. grep: grep TODO',
      summary: 'batch_read completed 2/2 steps',
      steps: [
        {
          index: 1,
          tool: 'read_file',
          args: { path: 'src/index.ts' },
          success: true,
          summary: 'read src/index.ts (10L, 100B)',
          output: 'file content',
        },
        {
          index: 2,
          tool: 'grep',
          args: { pattern: 'TODO', path: 'src' },
          success: true,
          summary: 'grep /TODO/ -> 3 matches',
          output: 'src/index.ts:1:TODO',
        },
      ],
    };
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Inspect project' },
      ],
      tools: [batchReadTool],
      toolExecutor: async () => JSON.stringify({
        success: true,
        output: JSON.stringify(batchPayload),
        summary: batchPayload.summary,
        outputBytes: 120,
      }),
      llm,
      harness: harness as any,
    })) {
      events.push(event);
    }

    expect(events.filter(event => event.type === 'tool_result')).toHaveLength(1);
    expect(harness.recordToolResult).toHaveBeenCalledWith(expect.objectContaining({
      name: 'batch_read',
      summary: batchPayload.summary,
    }));
    expect(harness.recordToolResult).toHaveBeenCalledWith(expect.objectContaining({
      name: 'read_file',
      args: { path: 'src/index.ts' },
      summary: 'read src/index.ts (10L, 100B)',
    }));
    expect(harness.recordToolResult).toHaveBeenCalledWith(expect.objectContaining({
      name: 'grep',
      args: { pattern: 'TODO', path: 'src' },
      summary: 'grep /TODO/ -> 3 matches',
    }));
  });

  test('runs concurrency-safe tool calls in parallel and preserves result order', async () => {
    const safeTools = ['glob', 'grep'].map(name => buildTool({
      name,
      description: `Run ${name}`,
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string', description: 'Pattern' } },
        required: ['pattern'],
      },
      execute: async () => ({ success: true, output: 'ok' }),
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
    }));
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*.ts"}' } },
          { id: 'call-2', type: 'function', function: { name: 'grep', arguments: '{"pattern":"needle"}' } },
        ],
      },
      { content: 'Done', model: 'test-model' },
    ]);
    let active = 0;
    let maxActive = 0;
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Search' },
      ],
      tools: safeTools,
      toolExecutor: async (name) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, name === 'glob' ? 30 : 10));
        active--;
        return JSON.stringify({ success: true, output: name });
      },
      llm,
    })) {
      events.push(event);
    }

    expect(maxActive).toBe(2);
    expect(events.filter(event => event.type === 'tool_result').map(event => (event as Extract<QueryEvent, { type: 'tool_result' }>).name))
      .toEqual(['glob', 'grep']);
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

  test('reports cancelled stats when aborted after tool execution', async () => {
    const controller = new AbortController();
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/test"}' } },
        ],
      },
    ]);
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages: [
        { role: 'system', content: 'You are a bot.' },
        { role: 'user', content: 'Read' },
      ],
      tools: [mockTool],
      toolExecutor: async () => {
        controller.abort();
        return JSON.stringify({ success: true, output: 'late output' });
      },
      llm,
      abortSignal: controller.signal,
    })) {
      events.push(event);
    }

    const complete = events.find(event => event.type === 'complete') as Extract<QueryEvent, { type: 'complete' }>;
    expect(complete).toMatchObject({
      type: 'complete',
      content: 'Operation cancelled.',
      stats: {
        finishReason: 'cancelled',
        turnsStarted: 1,
        llmRequests: 1,
        toolCalls: 1,
      },
    });
    expect(events.some(event => event.type === 'tool_result')).toBe(false);
  });

  test('passes abort signal to chatStream', async () => {
    const controller = new AbortController();
    const llm = makeMockLLM([
      { content: 'Hello!', model: 'test-model' },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Hi' },
    ];

    for await (const _event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'result',
      llm,
      abortSignal: controller.signal,
    })) {
      // consume
    }

    expect(llm.chatStream).toHaveBeenCalledWith(
      expect.any(Array),
      undefined,
      expect.any(Array),
      { abortSignal: controller.signal },
    );
  });

  test('does not emit assistant message when aborted after stream returns', async () => {
    const controller = new AbortController();
    const llm = {
      chatStream: jest.fn(async () => {
        controller.abort();
        return { content: 'late response', model: 'test-model' };
      }),
      getModel: jest.fn(() => 'test-model'),
    } as unknown as jest.Mocked<LLMService>;

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

    expect(events).toEqual([
      expect.objectContaining({ type: 'request_start' }),
      expect.objectContaining({ type: 'complete', content: 'Operation cancelled.' }),
    ]);
    expect(messages).toHaveLength(2);
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

    expect((complete as any).content).toContain('Reached maximum turns');
    expect(events.filter(e => e.type === 'request_start')).toHaveLength(1);
    expect((complete as Extract<QueryEvent, { type: 'complete' }>).stats).toMatchObject({
      finishReason: 'max_turns',
      turnsStarted: 1,
      llmRequests: 1,
    });
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

  test('runs predictive compact before sending an oversized request', async () => {
    const llm = makeMockLLM([
      { content: 'Answer', model: 'gpt-4' },
    ], 'gpt-4');

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      ...Array.from({ length: 30 }, (_, index) => ({
        role: 'user' as const,
        content: `large historical message ${index} ${'x'.repeat(4000)}`,
      })),
    ];
    const originalLength = messages.length;

    for await (const _event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => 'result',
      llm,
    })) {
      // consume
    }

    expect(llm.chat).toHaveBeenCalled();
    const requestMessages = (llm.chatStream as jest.Mock).mock.calls[0][0] as Message[];
    expect(requestMessages.length).toBeLessThan(originalLength);
    expect(requestMessages.map(message => message.content).join('\n')).toContain('[Context Summary]');
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

  test('allows ask-permission tools when toolConfirmation is allow', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'web_search', arguments: '{"query":"openhorse"}' } },
        ],
      },
      { content: 'Final answer', model: 'test-model' },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Search' },
    ];
    const toolExecutor = jest.fn(async () => JSON.stringify({ success: true, output: 'ok' }));
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [askTool],
      toolExecutor,
      llm,
      permissionMode: 'default',
      toolConfirmation: 'allow',
      toolContext,
    })) {
      events.push(event);
    }

    expect(toolExecutor).toHaveBeenCalledWith('web_search', { query: 'openhorse' }, undefined);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      name: 'web_search',
      success: true,
    }));
  });

  test('denies ask-permission tools when toolConfirmation is deny', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'web_search', arguments: '{"query":"openhorse"}' } },
        ],
      },
      { content: 'Final answer', model: 'test-model' },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Search' },
    ];
    const toolExecutor = jest.fn(async () => JSON.stringify({ success: true, output: 'ok' }));
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [askTool],
      toolExecutor,
      llm,
      permissionMode: 'default',
      toolConfirmation: 'deny',
      toolContext,
    })) {
      events.push(event);
    }

    const toolResult = events.find(event => event.type === 'tool_result') as Extract<QueryEvent, { type: 'tool_result' }>;
    expect(toolExecutor).not.toHaveBeenCalled();
    expect(toolResult.success).toBe(false);
    expect(toolResult.error).toContain('toolConfirmation=deny');
  });

  test('does not inject extra user noise after failed tool results', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/missing"}' } },
        ],
      },
      { content: 'The file is missing.', model: 'test-model' },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Read the file' },
    ];

    for await (const _event of query({
      messages,
      tools: [mockTool],
      toolExecutor: async () => JSON.stringify({
        success: false,
        output: '',
        error: 'not found',
      }),
      llm,
    })) {
      // consume
    }

    expect(messages.map(message => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(messages.map(message => message.content).join('\n')).not.toContain('[System] Tool read_file failed');
    const secondRequest = (llm.chatStream as jest.Mock).mock.calls[1][0] as Message[];
    expect(secondRequest.map(message => message.content).join('\n')).not.toContain('[System] Tool read_file failed');
  });

  test('uses interactive confirmation hook for ask-permission tools', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'web_search', arguments: '{"query":"openhorse"}' } },
        ],
      },
      { content: 'Final answer', model: 'test-model' },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Search' },
    ];
    const toolExecutor = jest.fn(async () => JSON.stringify({ success: true, output: 'ok' }));
    const confirmToolUse = jest.fn(async () => true);

    for await (const _event of query({
      messages,
      tools: [askTool],
      toolExecutor,
      llm,
      permissionMode: 'default',
      toolConfirmation: 'ask',
      confirmToolUse,
      toolContext,
    })) {
      // consume
    }

    expect(confirmToolUse).toHaveBeenCalledWith(expect.objectContaining({
      name: 'web_search',
      args: { query: 'openhorse' },
      reason: 'External query',
    }));
    expect(toolExecutor).toHaveBeenCalledWith('web_search', { query: 'openhorse' }, undefined);
  });

  test('interactive confirmation hook can deny ask-permission tools', async () => {
    const llm = makeMockLLM([
      {
        content: '',
        model: 'test-model',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'web_search', arguments: '{"query":"openhorse"}' } },
        ],
      },
      { content: 'Final answer', model: 'test-model' },
    ]);

    const messages: Message[] = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Search' },
    ];
    const toolExecutor = jest.fn(async () => JSON.stringify({ success: true, output: 'ok' }));
    const events: QueryEvent[] = [];

    for await (const event of query({
      messages,
      tools: [askTool],
      toolExecutor,
      llm,
      permissionMode: 'default',
      toolConfirmation: 'ask',
      confirmToolUse: async () => false,
      toolContext,
    })) {
      events.push(event);
    }

    const toolResult = events.find(event => event.type === 'tool_result') as Extract<QueryEvent, { type: 'tool_result' }>;
    expect(toolExecutor).not.toHaveBeenCalled();
    expect(toolResult.success).toBe(false);
    expect(toolResult.error).toContain('denied by user');
  });
});
