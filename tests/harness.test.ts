import { buildTool } from '../src/framework/tool';
import { query } from '../src/framework/query';
import {
  ContextLedger,
  createContextHarness,
  createTaskContract,
  renderContextCapsule,
} from '../src/harness';
import { getAutoCompact, resetAutoCompact } from '../src/services/compact/auto-compact';
import type { LLMResponse, LLMService, Message } from '../src/services/llm';

function makeMockLLM(
  responses: LLMResponse[],
  onCall?: (messages: Message[]) => void,
): jest.Mocked<LLMService> {
  let callIndex = 0;
  return {
    chatStream: jest.fn(async (messages: Message[]) => {
      onCall?.(messages);
      const resp = responses[callIndex++];
      return resp ?? { content: 'done', model: 'test-model' };
    }),
    getModel: jest.fn(() => 'gpt-4o'),
    setModel: jest.fn(),
    getConfigSummary: jest.fn(() => ({ model: 'gpt-4o' })),
  } as unknown as jest.Mocked<LLMService>;
}

const bashTool = buildTool({
  name: 'bash',
  description: 'Run a shell command',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to run' },
    },
    required: ['command'],
  },
  execute: async () => ({ success: true, output: '' }),
});

describe('Context Harness', () => {
  afterEach(() => {
    resetAutoCompact();
  });

  test('creates contract, ledger, and capsule from user input and tool evidence', () => {
    const contract = createTaskContract('完成输入背景修复，必须运行测试', '/repo');
    const ledger = new ContextLedger();
    ledger.recordUserRequirement('必须运行测试');
    ledger.recordToolResult({
      name: 'bash',
      args: { command: 'npm test -- --no-coverage' },
      result: JSON.stringify({ success: true, output: 'passed' }),
      duration: 123,
      success: true,
    });

    const harness = createContextHarness({
      cwd: '/repo',
      modelId: 'gpt-4o',
      state: {
        contract,
        ledger: ledger.getEntries(),
        updatedAt: Date.now(),
      },
    });

    const capsule = harness.getCapsule();
    expect(capsule?.contract?.objective).toContain('完成输入背景修复');
    expect(capsule?.verification.passed.length).toBe(1);
    expect(renderContextCapsule(capsule!)).toContain('Context Capsule');
  });

  test('assembler injects harness context into cloned system prompt', () => {
    const harness = createContextHarness({ cwd: '/repo', modelId: 'gpt-4o' });
    harness.updateContractFromUserInput('修复 CLI 输入背景，要求不要改 provider');

    const original: Message[] = [
      { role: 'system', content: 'base system' },
      { role: 'user', content: 'hello' },
    ];
    const assembled = harness.assembleMessages(original);

    expect(assembled).not.toBe(original);
    expect(assembled[0].content).toContain('OpenHorse Context Harness');
    expect(assembled[0].content).toContain('修复 CLI 输入背景');
    expect(original[0].content).toBe('base system');
  });

  test('query uses assembled messages and records tool results', async () => {
    const harness = createContextHarness({ cwd: '/repo', modelId: 'gpt-4o' });
    harness.updateContractFromUserInput('请运行测试验证');

    const seenRequests: Message[][] = [];
    const llm = makeMockLLM([
      {
        content: '',
        model: 'gpt-4o',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"command":"npm test -- --no-coverage"}' } },
        ],
      },
      { content: 'Tests passed', model: 'gpt-4o' },
    ], messages => seenRequests.push(messages));

    const messages: Message[] = [
      { role: 'system', content: 'base' },
      { role: 'user', content: 'go' },
    ];

    for await (const _event of query({
      messages,
      tools: [bashTool],
      toolExecutor: async () => JSON.stringify({ success: true, output: 'passed' }),
      llm,
      harness,
    })) {
      // consume
    }

    expect(seenRequests[0][0].content).toContain('OpenHorse Context Harness');
    expect(harness.getCapsule()?.verification.passed.length).toBe(1);
  });

  test('auto compact preserves context capsule', async () => {
    const harness = createContextHarness({ cwd: '/repo', modelId: 'gpt-4o' });
    harness.updateContractFromUserInput('完成 Context Harness，必须保留 open todos');

    const autoCompact = getAutoCompact({
      modelId: 'gpt-4o',
      maxMessages: 2,
      getContextCapsule: () => harness.getCapsule(),
    });

    const messages: Message[] = [
      { role: 'system', content: 'base' },
      ...Array.from({ length: 12 }, (_, i) => ({
        role: 'user' as const,
        content: `old message ${i}`,
      })),
    ];

    const compacted = await autoCompact.checkAndCompact(messages, 125000);
    const joined = compacted.map(message => message.content).join('\n');

    expect(compacted.length).toBeLessThan(messages.length);
    expect(joined).toContain('Context Capsule');
    expect(joined).toContain('完成 Context Harness');
  });
});

