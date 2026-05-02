import { buildSystemPrompt, getSystemPrompt } from '../src/framework/prompt';
import type { PromptContext } from '../src/framework/prompt';
import { buildTool } from '../src/framework/tool';
import type { OpenHorseTool } from '../src/framework/tool';

const mockTool: OpenHorseTool = buildTool({
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path' } } },
  execute: async () => ({ success: true, output: '' }),
});

const baseContext: PromptContext = {
  cwd: '/test/dir',
  platform: 'darwin',
  nodeVersion: 'v20.0.0',
  tools: [mockTool],
};

describe('buildSystemPrompt', () => {
  test('returns static and dynamic parts', () => {
    const result = buildSystemPrompt(baseContext);
    expect(result).toHaveProperty('static');
    expect(result).toHaveProperty('dynamic');
  });

  test('static part contains intro and capabilities', () => {
    const result = buildSystemPrompt(baseContext);
    expect(result.static).toContain('You are OpenHorse');
    expect(result.static).toContain('Read and write files');
  });

  test('static part contains tool names', () => {
    const result = buildSystemPrompt(baseContext);
    expect(result.static).toContain('read_file');
  });

  test('dynamic part contains environment info', () => {
    const result = buildSystemPrompt(baseContext);
    expect(result.dynamic).toContain('/test/dir');
    expect(result.dynamic).toContain('darwin');
    expect(result.dynamic).toContain('v20.0.0');
  });

  test('dynamic part includes memory when provided', () => {
    const ctx: PromptContext = {
      ...baseContext,
      memoryContent: 'Some project memory',
    };
    const result = buildSystemPrompt(ctx);
    expect(result.dynamic).toContain('Some project memory');
  });

  test('dynamic part excludes memory when not provided', () => {
    const result = buildSystemPrompt(baseContext);
    expect(result.dynamic).not.toContain('Project memory');
  });

  test('multiple tools are listed in static part', () => {
    const tools: OpenHorseTool[] = [
      buildTool({
        name: 'read_file',
        description: 'Read',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ success: true, output: '' }),
      }),
      buildTool({
        name: 'write_file',
        description: 'Write',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ success: true, output: '' }),
      }),
    ];
    const ctx: PromptContext = { ...baseContext, tools };
    const result = buildSystemPrompt(ctx);
    expect(result.static).toContain('read_file');
    expect(result.static).toContain('write_file');
  });
});

describe('getSystemPrompt', () => {
  test('returns a single combined string', () => {
    const prompt = getSystemPrompt(baseContext);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  test('contains both static and dynamic content', () => {
    const prompt = getSystemPrompt(baseContext);
    expect(prompt).toContain('You are OpenHorse');
    expect(prompt).toContain('/test/dir');
  });

  test('joins with separator', () => {
    const prompt = getSystemPrompt(baseContext);
    expect(prompt).toContain('\n\n---\n');
  });
});
