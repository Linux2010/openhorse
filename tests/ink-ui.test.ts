import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getCursorRestoreDelays, getPromptCursorPosition } from '../src/ink-ui/components/TerminalCursor';
import { formatPromptLine } from '../src/ink-ui/components/PromptInput';
import { markdownBlockTypes } from '../src/ink-ui/components/Markdown';
import { getPromptVisualLines } from '../src/ink-ui/runtime/prompt-layout';
import { getFileQuery, sessionItems, visibleCommandItems, visibleFileItems } from '../src/ink-ui/screens/ReplScreen';
import type { SessionMeta } from '../src/services/session-storage';

describe('Ink UI helpers', () => {
  it('filters command palette entries by slash query', () => {
    const items = visibleCommandItems('/s');
    expect(items.some(item => item.value === 'status')).toBe(true);
    expect(items.some(item => item.value === 'sessions')).toBe(true);
    expect(items.every(item => item.value.startsWith('s') || item.label.includes('(s'))).toBe(true);
  });

  it('extracts file completion query from the active @ token', () => {
    expect(getFileQuery('open @src/cli')).toEqual({ base: 'open ', query: 'src/cli' });
    expect(getFileQuery('@')).toEqual({ base: '', query: '' });
    expect(getFileQuery('no file token')).toBeNull();
  });

  it('lists matching file completion entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openhorse-ink-ui-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'cli.ts'), '');

    const items = visibleFileItems(dir, '@src/c');
    expect(items.map(item => item.value)).toContain('src/cli.ts');
  });

  it('includes session history size in picker descriptions', () => {
    const session: SessionMeta = {
      id: '12345678-aaaa-bbbb-cccc-123456789000',
      projectPath: '/tmp/project',
      model: 'glm-5',
      startTime: Date.now(),
      tokenCount: 0,
      cost: 0,
      messageCount: 3,
      historySizeBytes: 1536,
      taskSummary: 'demo task',
    };

    const [item] = sessionItems({
      title: 'Pick a Session',
      sessions: [session],
    });

    expect(item.label).toContain('12345678');
    expect(item.label).toContain('demo task');
    expect(item.description).toContain('3 msgs');
    expect(item.description).toContain('1.5 KB');
  });

  it('positions terminal cursor with fullwidth Chinese input', () => {
    const ascii = getPromptCursorPosition('ab', 24, 80);
    const chinese = getPromptCursorPosition('你好', 24, 80);

    expect(ascii.row).toBe(23);
    expect(ascii.column).toBe(7);
    expect(chinese.row).toBe(23);
    expect(chinese.column).toBe(9);
  });

  it('uses extra cursor restore passes while streaming', () => {
    expect(getCursorRestoreDelays(true).length).toBeGreaterThan(getCursorRestoreDelays(false).length);
    expect(getCursorRestoreDelays(true)).toContain(64);
  });

  it('pads live prompt lines to the full input width', () => {
    const line = formatPromptLine('你好', 0, 20);

    expect(line.startsWith('› 你好')).toBe(true);
    expect(line.length).toBeGreaterThan('› 你好'.length);
  });

  it('soft-wraps long prompt input before it reaches the footer', () => {
    const visualLines = getPromptVisualLines('abcdefghij', 12);
    const cursor = getPromptCursorPosition('abcdefghij', 24, 12);

    expect(visualLines.length).toBeGreaterThan(1);
    expect(cursor.row).toBe(23);
    expect(cursor.column).toBeGreaterThan(4);
  });

  it('recognizes rich markdown blocks for Ink transcript rendering', () => {
    const blocks = markdownBlockTypes([
      '# Title',
      '',
      '- item',
      '',
      '```ts',
      'const value = 1;',
      '```',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n'));

    expect(blocks).toEqual(expect.arrayContaining(['heading', 'list', 'code', 'table']));
  });
});
