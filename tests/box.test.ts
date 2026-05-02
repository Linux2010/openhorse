import { toolLine } from '../src/ui/box';

describe('toolLine', () => {
  test('includes tool name in output', () => {
    const line = toolLine('read_file', { path: '/test' }, true, 50);
    expect(line).toContain('read_file');
  });

  test('includes duration when success', () => {
    const line = toolLine('read_file', { path: '/test' }, true, 123);
    expect(line).toContain('123ms');
  });

  test('includes duration when failure', () => {
    const line = toolLine('exec_command', { command: 'rm -rf /' }, false, 5);
    expect(line).toContain('5ms');
  });

  test('includes path in args summary', () => {
    const line = toolLine('read_file', { path: '/some/long/path/file.txt' }, true);
    expect(line).toContain('/some/long/path/file.txt');
  });

  test('includes command in args summary', () => {
    const line = toolLine('exec_command', { command: 'ls -la' }, true);
    expect(line).toContain('ls -la');
  });

  test('truncates long paths', () => {
    const longPath = '/very/long/' + 'x'.repeat(100);
    const line = toolLine('read_file', { path: longPath }, true);
    // Should contain truncated version with ...
    expect(line.length).toBeLessThan(longPath.length + 50);
  });

  test('truncates long commands', () => {
    const longCmd = 'echo ' + 'a'.repeat(100);
    const line = toolLine('exec_command', { command: longCmd }, true);
    expect(line.length).toBeLessThan(longCmd.length + 50);
  });

  test('handles empty args', () => {
    const line = toolLine('some_tool', {}, true);
    expect(line).toContain('some_tool');
  });

  test('handles string arg values', () => {
    const line = toolLine('some_tool', { value: 'hello world' }, true);
    expect(line).toContain('hello world');
  });
});
