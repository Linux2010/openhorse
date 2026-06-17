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
  test('contains expected number of tools', () => {
    // Core tools: 11, Web tools: 2, MCP tools: 2, Todo tools: 1, Plan tools: 2 = 18
    expect(TOOLS.length).toBeGreaterThanOrEqual(18);
  });

  test('includes expected tool names', () => {
    const names = TOOLS.map(t => t.name);
    // Core tools
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('list_files');
    expect(names).toContain('exec_command');
    expect(names).toContain('edit_file');
    expect(names).toContain('glob');
    expect(names).toContain('grep');
    expect(names).toContain('memory_save');
    expect(names).toContain('memory_recall');
    expect(names).toContain('memory_forget');
    expect(names).toContain('history_search');
    // New v0.1.4 tools
    expect(names).toContain('web_fetch');
    expect(names).toContain('web_search');
    expect(names).toContain('mcp_list');
    expect(names).toContain('mcp_call');
    expect(names).toContain('todo_write');
    expect(names).toContain('enter_plan_mode');
    expect(names).toContain('exit_plan_mode');
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

  test('allows writing an empty file', async () => {
    const testFile = path.join(testDir, 'test-empty.txt');

    const result = await tool.execute({ path: testFile, content: '' }, ctx);

    expect(result.success).toBe(true);
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('');
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

  test('checkPermissions allows bounded validation command', () => {
    const perm = tool.checkPermissions?.({ command: 'npx tsc --noEmit' }, ctx);
    expect(perm?.behavior).toBe('allow');
  });

  test('checkPermissions still asks for arbitrary commands', () => {
    const perm = tool.checkPermissions?.({ command: 'npm run start' }, ctx);
    expect(perm?.behavior).toBe('ask');
  });

  test('userFacingName returns truncated command', () => {
    const name = tool.userFacingName?.({ command: 'echo hello world' });
    expect(name).toBe('Exec echo hello world');
  });

  // Issue #28: Output truncation tests
  test('truncates large output with maxOutput parameter', async () => {
    // Generate 100KB of output
    const result = await tool.execute({
      command: 'yes "test line" | head -2000',
      maxOutput: 1024, // 1KB limit
    }, ctx);
    expect(result.success).toBe(true);
    expect(result.output.length).toBeLessThan(1100); // Allow some overhead for truncation message
    expect(result.output).toContain('[... output truncated');
  });

  test('default maxOutput is 50KB', async () => {
    // Generate 60KB of output, should be truncated
    const result = await tool.execute({
      command: 'yes "test line for truncation test" | head -1500',
    }, ctx);
    expect(result.success).toBe(true);
    // Default is 51200 bytes, output should be truncated
    expect(result.output.length).toBeLessThan(52000);
  });

  test('does not truncate small output', async () => {
    const result = await tool.execute({
      command: 'echo "small output"',
      maxOutput: 1024,
    }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('small output');
    expect(result.output).not.toContain('[... output truncated');
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
    expect(names).toContain('edit_file');
    expect(names).toContain('glob');
    expect(names).toContain('grep');
  });
});

describe('edit_file tool', () => {
  const tool = TOOLS.find(t => t.name === 'edit_file')!;

  beforeAll(() => {
    setupTestDir();
  });

  afterAll(() => {
    cleanupTestDir();
  });

  test('isDestructive returns true', () => {
    expect(tool.isDestructive?.({})).toBe(true);
  });

  test('checkPermissions returns ask', () => {
    const perm = tool.checkPermissions?.({ path: 'test.txt' }, ctx);
    expect(perm?.behavior).toBe('ask');
  });

  test('replaces unique string in file', async () => {
    const testFile = path.join(testDir, 'test-edit.txt');
    fs.writeFileSync(testFile, 'hello world', 'utf-8');

    const result = await tool.execute({ path: testFile, old_string: 'hello', new_string: 'hi' }, ctx);
    expect(result.success).toBe(true);

    const content = fs.readFileSync(testFile, 'utf-8');
    expect(content).toBe('hi world');
  });

  test('rejects when old_string not found', async () => {
    const testFile = path.join(testDir, 'test-edit-notfound.txt');
    fs.writeFileSync(testFile, 'hello world', 'utf-8');

    const result = await tool.execute({ path: testFile, old_string: 'notfound', new_string: 'hi' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('rejects multiple matches without replace_all', async () => {
    const testFile = path.join(testDir, 'test-edit-multi.txt');
    fs.writeFileSync(testFile, 'hello hello hello', 'utf-8');

    const result = await tool.execute({ path: testFile, old_string: 'hello', new_string: 'hi' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('3 times');
  });

  test('replaces all with replace_all=true', async () => {
    const testFile = path.join(testDir, 'test-edit-all.txt');
    fs.writeFileSync(testFile, 'hello hello hello', 'utf-8');

    const result = await tool.execute({ path: testFile, old_string: 'hello', new_string: 'hi', replace_all: true }, ctx);
    expect(result.success).toBe(true);

    const content = fs.readFileSync(testFile, 'utf-8');
    expect(content).toBe('hi hi hi');
  });

  test('allows replacing with an empty string', async () => {
    const testFile = path.join(testDir, 'test-edit-delete.txt');
    fs.writeFileSync(testFile, 'hello world', 'utf-8');

    const result = await tool.execute({ path: testFile, old_string: 'hello ', new_string: '' }, ctx);

    expect(result.success).toBe(true);
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('world');
  });
});

describe('glob tool', () => {
  const tool = TOOLS.find(t => t.name === 'glob')!;

  test('isReadOnly returns true', () => {
    expect(tool.isReadOnly?.({})).toBe(true);
  });

  test('isConcurrencySafe returns true', () => {
    expect(tool.isConcurrencySafe?.({})).toBe(true);
  });

  test('finds TypeScript files', async () => {
    const result = await tool.execute({ pattern: '**/*.ts', path: 'src' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('cli.ts');
  });

  test('returns message when no matches', async () => {
    const result = await tool.execute({ pattern: '*.xyz', path: 'src' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('No files');
  });
});

describe('grep tool', () => {
  const tool = TOOLS.find(t => t.name === 'grep')!;

  beforeAll(() => {
    setupTestDir();
  });

  afterAll(() => {
    cleanupTestDir();
  });

  test('isReadOnly returns true', () => {
    expect(tool.isReadOnly?.({})).toBe(true);
  });

  test('isConcurrencySafe returns true', () => {
    expect(tool.isConcurrencySafe?.({})).toBe(true);
  });

  test('finds pattern in files', async () => {
    const result = await tool.execute({ pattern: 'openhorse', path: 'package.json' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('openhorse');
  });

  test('returns message when no matches', async () => {
    const result = await tool.execute({ pattern: 'notfoundpattern', path: 'src' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('No matches');
  });

  test('does not skip repeated matches and respects glob filter', async () => {
    const grepDir = path.join(testDir, 'grep-fixture');
    fs.mkdirSync(grepDir, { recursive: true });
    fs.writeFileSync(path.join(grepDir, 'a.txt'), 'needle\nneedle\n', 'utf-8');
    fs.writeFileSync(path.join(grepDir, 'b.md'), 'needle\n', 'utf-8');

    const result = await tool.execute({ pattern: 'needle', path: grepDir, glob: '*.txt' }, ctx);

    expect(result.success).toBe(true);
    expect(result.output.match(/a\.txt:/g)).toHaveLength(2);
    expect(result.output).not.toContain('b.md');
  });
});

describe('todo_write tool', () => {
  const tool = TOOLS.find(t => t.name === 'todo_write')!;

  test('accepts direct array arguments as well as JSON strings', async () => {
    const result = await tool.execute({
      todos: [
        {
          content: 'Run tests',
          activeForm: 'Running tests',
          status: 'in_progress',
        },
      ],
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain('Run tests');
  });
});
