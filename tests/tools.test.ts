import { TOOLS, executeTool, getToolNames } from '../src/tools';
import type { ToolContext } from '../src/framework/tool';
import fs from 'fs';
import path from 'path';

const ctx: ToolContext = {
  cwd: process.cwd(),
  config: { name: 'test', mode: 'development' },
};

const testDir = path.join(process.cwd(), 'tests', 'tmp');

function setupTestDir() {
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
}

function cleanupTestDir() {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

describe('TOOLS array', () => {
  test('contains 4 tools', () => {
    expect(TOOLS).toHaveLength(4);
  });

  test('includes expected tool names', () => {
    const names = TOOLS.map(t => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('list_files');
    expect(names).toContain('exec_command');
  });
});

describe('read_file tool', () => {
  const tool = TOOLS.find(t => t.name === 'read_file')!;

  test('isReadOnly returns true', () => {
    expect(tool.isReadOnly?.({})).toBe(true);
  });

  test('reads existing file successfully', async () => {
    const result = await tool.execute({ path: 'package.json' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('openhorse');
  });

  test('returns error for nonexistent file', async () => {
    const result = await tool.execute({ path: 'tests/nonexistent-file-xyz.txt' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
  });

  test('returns error for directory path', async () => {
    const result = await tool.execute({ path: 'src' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not a file');
  });

  test('respects maxLines parameter', async () => {
    const result = await tool.execute({ path: 'package.json', maxLines: 2 }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('truncated');
  });

  test('userFacingName returns path', () => {
    const name = tool.userFacingName?.({ path: '/my/file.txt' });
    expect(name).toBe('Read /my/file.txt');
  });
});

describe('write_file tool', () => {
  const tool = TOOLS.find(t => t.name === 'write_file')!;

  beforeAll(() => {
    setupTestDir();
  });

  afterAll(() => {
    cleanupTestDir();
  });

  test('isDestructive returns true', () => {
    expect(tool.isDestructive?.({})).toBe(true);
  });

  test('writes and reads back file', async () => {
    const testFile = path.join(testDir, 'test-write.txt');
    const result = await tool.execute({ path: testFile, content: 'hello world' }, ctx);
    expect(result.success).toBe(true);

    const content = fs.readFileSync(testFile, 'utf-8');
    expect(content).toBe('hello world');
  });

  test('overwrites existing file', async () => {
    const testFile = path.join(testDir, 'test-overwrite.txt');
    fs.writeFileSync(testFile, 'original', 'utf-8');

    const result = await tool.execute({ path: testFile, content: 'new content' }, ctx);
    expect(result.success).toBe(true);

    const content = fs.readFileSync(testFile, 'utf-8');
    expect(content).toBe('new content');
  });
});

describe('list_files tool', () => {
  const tool = TOOLS.find(t => t.name === 'list_files')!;

  test('isReadOnly returns true', () => {
    expect(tool.isReadOnly?.({})).toBe(true);
  });

  test('isConcurrencySafe returns true', () => {
    expect(tool.isConcurrencySafe?.({})).toBe(true);
  });

  test('lists files in src directory', async () => {
    const result = await tool.execute({ path: 'src', maxDepth: 1 }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('cli.ts');
  });

  test('returns error for nonexistent path', async () => {
    const result = await tool.execute({ path: 'tests/nonexistent-path-xyz' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('userFacingName returns path', () => {
    const name = tool.userFacingName?.({ path: 'src' });
    expect(name).toBe('List src');
  });
});

describe('exec_command tool', () => {
  const tool = TOOLS.find(t => t.name === 'exec_command')!;

  test('executes simple command', async () => {
    const result = await tool.execute({ command: 'echo hello' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
  });

  test('handles failing command', async () => {
    const result = await tool.execute({ command: 'exit 1' }, ctx);
    expect(result.success).toBe(false);
  });

  test('isDestructive detects rm -rf', () => {
    expect(tool.isDestructive?.({ command: 'rm -rf /' })).toBe(true);
    expect(tool.isDestructive?.({ command: 'ls -la' })).toBe(false);
  });

  test('userFacingName returns truncated command', () => {
    const name = tool.userFacingName?.({ command: 'echo hello world' });
    expect(name).toBe('Exec echo hello world');
  });
});

describe('executeTool', () => {
  test('executes read_file tool', async () => {
    const result = await executeTool('read_file', { path: 'package.json' });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.output).toContain('openhorse');
  });

  test('returns error for unknown tool', async () => {
    const result = await executeTool('unknown_tool', {});
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('Unknown tool');
  });
});

describe('getToolNames', () => {
  test('returns comma-separated names', () => {
    const names = getToolNames();
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('list_files');
    expect(names).toContain('exec_command');
  });
});
