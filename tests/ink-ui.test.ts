import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import stringWidth from 'string-width';
import { getCursorRestoreDelays, getPromptCursorPosition } from '../src/ink-ui/components/TerminalCursor';
import { formatPromptLine } from '../src/ink-ui/components/PromptInput';
import { decodeHtmlEntities, markdownBlockTypes } from '../src/ink-ui/components/Markdown';
import { getRunningHorseFrame, runningHorseLabel } from '../src/ink-ui/components/RunningHorseIndicator';
import { createAssistantStreamPresenter, createToolEventPresenter, sessionMessagesToTranscriptEntries } from '../src/ink-ui/controllers/chat-controller';
import { initialInputBuffer, reduceInputBuffer } from '../src/ink-ui/runtime/input-buffer';
import { formatPromptVisualLine, getPromptInputViewport, getPromptVisualLines, getVisiblePromptVisualLines } from '../src/ink-ui/runtime/prompt-layout';
import { createInkStdout, disablePromptCursor, setPromptCursorState } from '../src/ink-ui/runtime/stdout';
import { getFileQuery, isMultilinePasteValue, normalizePastedInput, sessionItems, visibleCommandItems, visibleFileItems } from '../src/ink-ui/screens/ReplScreen';
import type { TranscriptEntry, UiEventSink } from '../src/ink-ui/types';
import type { SessionMeta } from '../src/services/session-storage';
import { appendSessionMessage, createSession, markSessionTranscriptDisplayStart } from '../src/services/session-storage';

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

  it('detects pasted multiline chunks without treating Enter as paste', () => {
    expect(isMultilinePasteValue('line one\nline two')).toBe(true);
    expect(isMultilinePasteValue('line one\r\nline two')).toBe(true);
    expect(isMultilinePasteValue('\n')).toBe(false);
    expect(isMultilinePasteValue('\r')).toBe(false);
    expect(isMultilinePasteValue('plain text')).toBe(false);
  });

  it('normalizes bracketed paste and CRLF newlines', () => {
    expect(normalizePastedInput('\x1b[200~one\r\ntwo\x1b[201~')).toBe('one\ntwo');
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
    const empty = getPromptCursorPosition('', 24, 80);

    expect(ascii.row).toBe(23);
    expect(ascii.column).toBe(7);
    expect(chinese.row).toBe(23);
    expect(chinese.column).toBe(9);
    expect(empty.row).toBe(23);
    expect(empty.column).toBe(5);
  });

  it('schedules one native cursor restore pass for IME anchoring', () => {
    expect(getCursorRestoreDelays(false)).toEqual([0]);
    expect(getCursorRestoreDelays(true)).toEqual([0]);
  });

  it('wraps Ink stdout without changing real terminal dimensions', () => {
    const writes: string[] = [];
    const stdout = {
      rows: 4,
      columns: 40,
      isTTY: true,
      write: (chunk: string | Buffer) => {
        writes.push(String(chunk));
        return true;
      },
      on: jest.fn(),
      off: jest.fn(),
    } as unknown as NodeJS.WriteStream;

    const wrapped = createInkStdout(stdout);

    expect(wrapped.rows).toBe(4);
    expect(wrapped.columns).toBe(40);
    wrapped.write('frame');
    expect(writes).toEqual(['frame']);
    disablePromptCursor();
  });

  it('parks the native cursor after Ink writes a frame', done => {
    const writes: string[] = [];
    const stdout = {
      rows: 4,
      columns: 40,
      isTTY: true,
      write: (chunk: string | Buffer) => {
        writes.push(String(chunk));
        return true;
      },
      on: jest.fn(),
      off: jest.fn(),
    } as unknown as NodeJS.WriteStream;

    const wrapped = createInkStdout(stdout);
    setPromptCursorState({ enabled: true, column: 9, rowsUp: 2 });
    wrapped.write('frame');

    setTimeout(() => {
      expect(writes.join('')).toContain('frame');
      expect(writes.join('')).toContain('\x1b[?25h\x1b[2A\r\x1b[9G');
      disablePromptCursor();
      done();
    }, 5);
  });

  it('returns the native cursor to Ink baseline before the next frame write', done => {
    const writes: string[] = [];
    const stdout = {
      rows: 4,
      columns: 40,
      isTTY: true,
      write: (chunk: string | Buffer) => {
        writes.push(String(chunk));
        return true;
      },
      on: jest.fn(),
      off: jest.fn(),
    } as unknown as NodeJS.WriteStream;

    const wrapped = createInkStdout(stdout);
    setPromptCursorState({ enabled: true, column: 9, rowsUp: 2 });
    wrapped.write('frame');

    setTimeout(() => {
      expect(writes.join('')).toContain('\x1b[?25h\x1b[2A\r\x1b[9G');
      wrapped.write('next');
      expect(writes.slice(-2)).toEqual(['\r\x1b[2B', 'next']);
      disablePromptCursor();
      done();
    }, 5);
  });

  it('pads live prompt lines to the full input width', () => {
    const line = formatPromptLine('你好', 0, 20);

    expect(line.startsWith('› 你好')).toBe(true);
    expect(line.length).toBeGreaterThan('› 你好'.length);
  });

  it('can render a visual cursor when explicitly requested', () => {
    const line = formatPromptVisualLine({ logicalIndex: 0, wrapIndex: 0, content: '', start: 0, end: 0 }, 20, { showCursor: true });

    expect(line.startsWith('› ▌')).toBe(true);
  });

  it('soft-wraps long prompt input before it reaches the footer', () => {
    const visualLines = getPromptVisualLines('abcdefghij', 12);
    const cursor = getPromptCursorPosition('abcdefghij', 24, 12);

    expect(visualLines.length).toBeGreaterThan(1);
    expect(cursor.row).toBe(23);
    expect(cursor.column).toBeGreaterThan(4);
  });

  it('renders only the tail of very tall prompt input', () => {
    const { lines, hiddenRows } = getVisiblePromptVisualLines('one\ntwo\nthree\nfour', 40, 2);

    expect(hiddenRows).toBe(2);
    expect(lines.map(line => line.content)).toEqual(['three', 'four']);
  });

  it('keeps prompt viewport within the row budget including the hidden indicator', () => {
    const viewport = getPromptInputViewport('one\ntwo\nthree\nfour', 40, 3);

    expect(viewport.showHiddenIndicator).toBe(true);
    expect(viewport.hiddenRows).toBe(2);
    expect(viewport.lines.map(line => line.content)).toEqual(['three', 'four']);
    expect(viewport.lines.length + 1).toBeLessThanOrEqual(3);
  });

  it('keeps the prompt viewport centered around an earlier cursor', () => {
    const viewport = getPromptInputViewport('one\ntwo\nthree\nfour', 40, 3, 1);

    expect(viewport.lines.map(line => line.content)).toEqual(['one', 'two']);
    expect(viewport.cursorLineIndex).toBe(1);
    expect(viewport.cursorColumn).toBe(6);
  });

  it('edits input at the cursor instead of always appending', () => {
    const draft = reduceInputBuffer(initialInputBuffer, { type: 'set', value: 'helo', cursor: 2 });
    const inserted = reduceInputBuffer(draft, { type: 'insert', text: 'l' });
    const removed = reduceInputBuffer(inserted, { type: 'backspace' });
    const deleted = reduceInputBuffer({ value: 'abcd', cursor: 1 }, { type: 'delete' });

    expect(inserted).toEqual({ value: 'hello', cursor: 3 });
    expect(removed).toEqual({ value: 'helo', cursor: 2 });
    expect(deleted).toEqual({ value: 'acd', cursor: 1 });
  });

  it('parses mixed text and arrow escape sequences in one input chunk', () => {
    const edited = reduceInputBuffer(initialInputBuffer, { type: 'inputChunk', text: 'helo\x1b[D\x1b[Dl' });
    const deleted = reduceInputBuffer(initialInputBuffer, { type: 'inputChunk', text: 'ab\x1b[D\x1b[3~' });

    expect(edited).toEqual({ value: 'hello', cursor: 3 });
    expect(deleted).toEqual({ value: 'a', cursor: 1 });
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
      finalize: jest.fn(),
      replaceTranscript: jest.fn(),
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
    presenter.closeSegment();

    expect(entries.map(entry => entry.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(entries.map(entry => entry.content)).toEqual(['先说明', 'Running read_file src/index.ts', '再给结论']);
    expect(events.finalize).toHaveBeenCalledWith('entry-1');
  });

  it('updates a running tool entry when the matching result arrives', () => {
    const entries: TranscriptEntry[] = [];
    const finalized: Array<{ id: string; patch?: Partial<Omit<TranscriptEntry, 'id'>> }> = [];
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
      finalize: (id, patch) => {
        finalized.push({ id, patch });
        if (!patch) return;
        const index = entries.findIndex(entry => entry.id === id);
        if (index >= 0) {
          entries[index] = { ...entries[index], ...patch };
        }
      },
      replaceTranscript: jest.fn(),
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
    expect(finalized).toHaveLength(1);
    expect(finalized[0].id).toBe('entry-1');
  });

  it('rebuilds resumed transcript and hides messages before compact boundary', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'openhorse-ink-session-'));
    const originalConfigDir = process.env.OPENHORSE_CONFIG_DIR;
    process.env.OPENHORSE_CONFIG_DIR = configDir;

    try {
      const session = createSession('/tmp/openhorse-ink-resume', 'glm-5');
      appendSessionMessage(session.id, { role: 'user', content: 'before compact', timestamp: 1000 });
      appendSessionMessage(session.id, { role: 'assistant', content: 'old answer', timestamp: 1001 });
      markSessionTranscriptDisplayStart(session.id, 2000);
      appendSessionMessage(session.id, { role: 'user', content: 'after compact', timestamp: 2001 });
      appendSessionMessage(session.id, { role: 'assistant', content: 'new answer', timestamp: 2002 });

      const entries = sessionMessagesToTranscriptEntries(session.id);

      expect(entries.map(entry => entry.content)).toEqual(['after compact', 'new answer']);
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.OPENHORSE_CONFIG_DIR;
      } else {
        process.env.OPENHORSE_CONFIG_DIR = originalConfigDir;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('rebuilds full resumed transcript when there is no compact boundary', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'openhorse-ink-session-'));
    const originalConfigDir = process.env.OPENHORSE_CONFIG_DIR;
    process.env.OPENHORSE_CONFIG_DIR = configDir;

    try {
      const session = createSession('/tmp/openhorse-ink-full-resume', 'glm-5');
      appendSessionMessage(session.id, { role: 'user', content: 'first question', timestamp: 1000 });
      appendSessionMessage(session.id, { role: 'assistant', content: 'first answer', timestamp: 1001 });
      appendSessionMessage(session.id, { role: 'user', content: 'second question', timestamp: 1002 });
      appendSessionMessage(session.id, { role: 'assistant', content: 'second answer', timestamp: 1003 });

      const entries = sessionMessagesToTranscriptEntries(session.id);

      expect(entries.map(entry => entry.content)).toEqual([
        'first question',
        'first answer',
        'second question',
        'second answer',
      ]);
    } finally {
      if (originalConfigDir === undefined) {
        delete process.env.OPENHORSE_CONFIG_DIR;
      } else {
        process.env.OPENHORSE_CONFIG_DIR = originalConfigDir;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
