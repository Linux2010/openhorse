import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findCommand } from '../src/commands';
import { Store } from '../src/framework/store';
import { loadConfig } from '../src/services/config';
import { TOOLS } from '../src/tools';
import type { CommandContext } from '../src/commands/types';

const stripAnsi = (text: string): string => text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

function makeRuntime() {
  return {
    brain: {
      getStatus: () => ({ agents: [], pendingTasks: 0, strategy: 'sequential' }),
    },
    memory: {
      getStatus: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }),
    },
    store: {
      getStats: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }),
    },
  };
}

describe('/status context diagnostics', () => {
  let root: string;
  let logs: string[];
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openhorse-status-command-'));
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'Root rules');
    writeFileSync(join(root, 'packages', 'cli', 'AGENTS.md'), 'Package rules');
    logs = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('shows loaded project instruction files and prompt context sizes', async () => {
    const cwd = join(root, 'packages', 'cli');
    const config = loadConfig({ apiKey: 'test-key' });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: 'gpt-4o',
      memoryContent: 'memory',
      skillsContent: 'skills',
    });
    const ctx: CommandContext = {
      cwd,
      config,
      store,
      llm: null,
      runtime: makeRuntime() as any,
    };

    const result = await findCommand('status')!.execute(ctx, '');
    const rendered = stripAnsi(logs.join('\n'));

    expect(result.success).toBe(true);
    expect(rendered).toContain('Context:');
    expect(rendered).toContain('Project rules 2 files');
    expect(rendered).toContain('AGENTS.md');
    expect(rendered).toContain('packages/cli/AGENTS.md');
    expect(rendered).toContain('Prompt rules');
    expect(rendered).toContain('Project memory 6 chars');
    expect(rendered).toContain('Skills index   6 chars');
    expect(store.getSnapshot().projectInstructionsContent).toContain('Root rules');
    expect(store.getSnapshot().projectInstructionsContent).toContain('Package rules');
  });

  it('shows last agent-loop stats when available', async () => {
    const cwd = join(root, 'packages', 'cli');
    const config = loadConfig({ apiKey: 'test-key' });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: 'gpt-4o',
    });
    store.setLastLoopStats({
      turnsStarted: 2,
      llmRequests: 2,
      toolCalls: 3,
      readOnlyToolCalls: 2,
      unsafeToolCalls: 1,
      toolResultBytes: 12_000,
      modelVisibleToolBytes: 2_000,
      summarizedBytes: 10_000,
      compactTrigger: 'pre_turn',
      finishReason: 'completed',
    });
    const ctx: CommandContext = {
      cwd,
      config,
      store,
      llm: null,
      runtime: makeRuntime() as any,
    };

    const result = await findCommand('status')!.execute(ctx, '');
    const rendered = stripAnsi(logs.join('\n'));

    expect(result.success).toBe(true);
    expect(rendered).toContain('Last loop:');
    expect(rendered).toContain('Finish     completed');
    expect(rendered).toContain('Requests   2 LLM / 2 turns');
    expect(rendered).toContain('Tools      3 total (2 read-only, 1 unsafe)');
    expect(rendered).toContain('Saved');
    expect(rendered).toContain('Compact    pre_turn');
  });
});
