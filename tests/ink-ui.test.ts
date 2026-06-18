import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import stringWidth from 'string-width';
import { getCursorRestoreDelays, getPromptCursorPosition } from '../src/ink-ui/components/TerminalCursor';
import { formatPromptLine } from '../src/ink-ui/components/PromptInput';
import { decodeHtmlEntities, markdownBlockTypes } from '../src/ink-ui/components/Markdown';
import { getRunningHorseFrame, runningHorseLabel } from '../src/ink-ui/components/RunningHorseIndicator';
import { createAssistantStreamPresenter, createToolEventPresenter } from '../src/ink-ui/controllers/chat-controller';
import { getPromptVisualLines } from '../src/ink-ui/runtime/prompt-layout';
import { getFileQuery, sessionItems, visibleCommandItems, visibleFileItems } from '../src/ink-ui/screens/ReplScreen';
import type { TranscriptEntry, UiEventSink } from '../src/ink-ui/types';
import type { SessionMeta } from '../src/services/session-storage';

describe('Ink UI helpers', () => {
  it('filters command palette entries by slash query', () => {
    const items = visibleCommandItems('/s');
    expect(items.some(item => item.value === 'status')).toBe(true);
    expect(items.some(item => item.value === 'sessions')).toBe(true);
    expect(items.every(item => item.value.startsWith('s') || item.label.includes('(s'))).toBe(true);
  });

  it('shows coding-agent commands and hides legacy chat commands', () => {
    const items = visibleCommandItems('/');
    const values = items.map(item => item.value);

    expect(values).toEqual(expect.arrayContaining(['review', 'security', 'test-gen', 'tools', 'mode']));
    expect(values).not.toContain('chat');
    expect(values).not.toContain('run');
    expect(values).not.toContain('task');
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

  it('normalizes running status into a horse animation label', () => {
    expect(runningHorseLabel('Turn 2...')).toBe('working');
    expect(runningHorseLabel('Revision received. Interrupting current response...')).toBe('Revision received. Interrupting current response...');
  });

  it('uses stable-width running horse frames with moving dust', () => {
    const frames = [0, 1, 2, 3].map(getRunningHorseFrame);
    const widths = new Set(frames.map(frame => stringWidth(`${frame.horse} ${frame.dust}`)));

    expect(widths.size).toBe(1);
    expect(new Set(frames.map(frame => frame.dust)).size).toBeGreaterThan(1);
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

  it('decodes html entities in assistant markdown text', () => {
    expect(decodeHtmlEntities('I see you&#39;ve entered &quot;111&quot; &amp; more.')).toBe('I see you\'ve entered "111" & more.');
    expect(decodeHtmlEntities('numeric: &#8226; &#x2022;')).toBe('numeric: • •');
  });

  it('keeps tool events between assistant stream segments', () => {
    const entries: TranscriptEntry[] = [];
    const events: UiEventSink = {
      append: entry => {
        const id = `entry-${entries.length + 1}`;
        entries.push({ id, ...entry });
        return id;
      },
      update: (id, patch) => {
        const index = entries.findIndex(entry => entry.id === id);
        if (index >= 0) {
          entries[index] = { ...entries[index], ...patch };
        }
      },
      clearTranscript: jest.fn(),
      setStatus: jest.fn(),
      showSessionPicker: jest.fn(),
      setProcessing: jest.fn(),
    };

    const presenter = createAssistantStreamPresenter(events);
    presenter.appendChunk('先说明');
    presenter.closeSegment();
    events.append({ role: 'tool', content: 'Running read_file src/index.ts' });
    presenter.appendChunk('再给结论');

    expect(entries.map(entry => entry.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(entries.map(entry => entry.content)).toEqual(['先说明', 'Running read_file src/index.ts', '再给结论']);
  });

  it('updates a running tool entry when the matching result arrives', () => {
    const entries: TranscriptEntry[] = [];
    const events: UiEventSink = {
      append: entry => {
        const id = `entry-${entries.length + 1}`;
        entries.push({ id, ...entry });
        return id;
      },
      update: (id, patch) => {
        const index = entries.findIndex(entry => entry.id === id);
        if (index >= 0) {
          entries[index] = { ...entries[index], ...patch };
        }
      },
      clearTranscript: jest.fn(),
      setStatus: jest.fn(),
      showSessionPicker: jest.fn(),
      setProcessing: jest.fn(),
    };

    const presenter = createToolEventPresenter(events);
    presenter.start({
      type: 'tool_call',
      name: 'read_file',
      args: { path: 'src/index.ts' },
      callId: 'call-1',
    });
    presenter.finish({
      type: 'tool_result',
      name: 'read_file',
      args: { path: 'src/index.ts' },
      callId: 'call-1',
      result: '{"success":true}',
      duration: 12,
      success: true,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].role).toBe('tool');
    expect(entries[0].content).toContain('✓ read_file src/index.ts (12ms)');
  });
});
