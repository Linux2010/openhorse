import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyTerminalTabCompletion,
  completeFileMention,
  completeSlashCommand,
  createTerminalCompleter,
} from '../src/terminal-ui/completion';
import {
  TerminalEventSink,
  TerminalInputComposer,
  normalizeTerminalAnswer,
  parseEditInput,
  resolveTerminalSessionPickerInput,
  truncateTerminalText,
  visibleLength,
} from '../src/terminal-ui/launch';
import { RawTerminalEditor } from '../src/terminal-ui/raw-editor';
import type { OpenHorseUiRuntime } from '../src/runtime/ui-events';

function makeRawEditor(options: {
  cwd?: string;
  onSubmit?: (input: string) => void;
  onNotice?: (message: string) => void;
} = {}) {
  const writes: string[] = [];
  const output = {
    isTTY: true,
    columns: 80,
    write: (chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    },
  } as NodeJS.WriteStream;

  const editor = new RawTerminalEditor({
    cwd: options.cwd ?? process.cwd(),
    output,
    onSubmit: options.onSubmit ?? (() => undefined),
    onCtrlC: () => undefined,
    onNotice: options.onNotice,
  });

  return { editor, writes };
}

function makeRuntime(): OpenHorseUiRuntime {
  return {
    cwd: '/tmp/openhorse-terminal-renderer',
    version: 'test',
    config: { model: 'test-model', ui: { renderer: 'terminal' } } as OpenHorseUiRuntime['config'],
    store: {
      setProcessing: jest.fn(),
    } as unknown as OpenHorseUiRuntime['store'],
    llm: null,
    runtime: {} as OpenHorseUiRuntime['runtime'],
    isConfigured: true,
    ensureSession: jest.fn(),
    setSession: jest.fn(),
    getSession: jest.fn(() => null),
    shutdown: jest.fn(),
  };
}

function makeTerminalSink() {
  const writes: string[] = [];
  const sink = new TerminalEventSink(makeRuntime(), {
    write: text => writes.push(text),
  });
  return { sink, writes };
}

describe('terminal UI input normalization', () => {
  it('applies DEL/backspace before submitting text', () => {
    expect(normalizeTerminalAnswer('/helpx\x7f')).toBe('/help');
    expect(normalizeTerminalAnswer('/helpx\b')).toBe('/help');
  });

  it('removes the previous unicode character for CJK input', () => {
    expect(normalizeTerminalAnswer('开源小?\x7f')).toBe('开源小');
    expect(normalizeTerminalAnswer('开源小\x7f')).toBe('开源');
  });

  it('supports common line editing control characters when terminals pass them through', () => {
    expect(normalizeTerminalAnswer('abc\x15next')).toBe('next');
    expect(normalizeTerminalAnswer('hello world\x17agent')).toBe('helloagent');
  });

  it('drops leaked terminal escape sequences', () => {
    expect(normalizeTerminalAnswer('/help\x1b[A')).toBe('/help');
    expect(normalizeTerminalAnswer('/help\x1b[3~')).toBe('/help');
  });
});

describe('terminal UI renderer adapter', () => {
  it('maps session picker selections to runtime protocol inputs', () => {
    const { sink, writes } = makeTerminalSink();

    sink.showSessionPicker({
      title: 'Pick a Session',
      allProjects: true,
      showProject: true,
      sessions: [
        {
          id: '11111111-aaaa-bbbb-cccc-111111111111',
          projectPath: '/tmp/project-a',
          model: 'glm-5',
          startTime: 1,
          tokenCount: 0,
          cost: 0,
          messageCount: 4,
          historySizeBytes: 1536,
          taskSummary: 'older task',
        },
        {
          id: '22222222-aaaa-bbbb-cccc-222222222222',
          projectPath: '/tmp/project-b',
          model: 'glm-5',
          startTime: 2,
          tokenCount: 0,
          cost: 0,
          messageCount: 8,
          historySizeBytes: 2048,
          taskSummary: 'newer task',
        },
      ],
    });

    expect(writes.join('')).toContain('Pick a Session');
    expect(writes.join('')).toContain('newer task');
    expect(writes.join('')).toContain('session id prefix');
    expect(sink.consumePendingSelection('2')).toEqual({
      type: 'select_session',
      sessionId: '22222222-aaaa-bbbb-cccc-222222222222',
      allProjects: true,
      source: 'picker',
    });
  });

  it('resolves session picker input by index, id prefix, and unique title text', () => {
    const request = {
      title: 'Pick a Session',
      allProjects: true,
      sessions: [
        {
          id: '11111111-aaaa-bbbb-cccc-111111111111',
          projectPath: '/tmp/project-a',
          model: 'glm-5',
          startTime: 1,
          tokenCount: 0,
          cost: 0,
          messageCount: 4,
          historySizeBytes: 1536,
          taskSummary: 'storage cleanup work',
        },
        {
          id: '22222222-aaaa-bbbb-cccc-222222222222',
          projectPath: '/tmp/project-b',
          model: 'glm-5',
          startTime: 2,
          tokenCount: 0,
          cost: 0,
          messageCount: 8,
          historySizeBytes: 2048,
          name: 'terminal ui polish',
          taskSummary: 'newer task',
        },
      ],
    };

    expect(resolveTerminalSessionPickerInput('#2', request)).toEqual({
      type: 'selected',
      sessionId: '22222222-aaaa-bbbb-cccc-222222222222',
    });
    expect(resolveTerminalSessionPickerInput('11111111', request)).toEqual({
      type: 'selected',
      sessionId: '11111111-aaaa-bbbb-cccc-111111111111',
    });
    expect(resolveTerminalSessionPickerInput('terminal ui', request)).toEqual({
      type: 'selected',
      sessionId: '22222222-aaaa-bbbb-cccc-222222222222',
    });
  });

  it('prefers bare numeric row selection over numeric id-prefix matching', () => {
    const request = {
      title: 'Pick a Session',
      sessions: [
        {
          id: '22222222-aaaa-bbbb-cccc-222222222222',
          projectPath: '/tmp/project-a',
          model: 'glm-5',
          startTime: 1,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'numeric id prefix',
        },
        {
          id: 'aaaaaaaa-aaaa-bbbb-cccc-aaaaaaaaaaaa',
          projectPath: '/tmp/project-b',
          model: 'glm-5',
          startTime: 2,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'second visible row',
        },
      ],
    };

    expect(resolveTerminalSessionPickerInput('2', request)).toEqual({
      type: 'selected',
      sessionId: 'aaaaaaaa-aaaa-bbbb-cccc-aaaaaaaaaaaa',
    });
    expect(resolveTerminalSessionPickerInput('2222', request)).toEqual({
      type: 'selected',
      sessionId: '22222222-aaaa-bbbb-cccc-222222222222',
    });
  });

  it('limits visible picker rows while keeping hidden sessions selectable by id or title', () => {
    const { sink, writes } = makeTerminalSink();
    const request = {
      title: 'Pick a Session',
      maxVisibleItems: 2,
      sessions: [
        {
          id: '11111111-aaaa-bbbb-cccc-111111111111',
          projectPath: '/tmp/project-a',
          model: 'glm-5',
          startTime: 1,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'first task',
        },
        {
          id: '22222222-aaaa-bbbb-cccc-222222222222',
          projectPath: '/tmp/project-b',
          model: 'glm-5',
          startTime: 2,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'second task',
        },
        {
          id: '33333333-aaaa-bbbb-cccc-333333333333',
          projectPath: '/tmp/project-c',
          model: 'glm-5',
          startTime: 3,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'hidden task',
        },
      ],
    };

    sink.showSessionPicker(request);

    const output = writes.join('');
    expect(output).toContain('first task');
    expect(output).toContain('second task');
    expect(output).not.toContain('hidden task');
    expect(output).toContain('Showing 2 of 3');
    expect(resolveTerminalSessionPickerInput('3', request)).toEqual({
      type: 'selected',
      sessionId: '33333333-aaaa-bbbb-cccc-333333333333',
    });
    expect(resolveTerminalSessionPickerInput('3333', request)).toEqual({
      type: 'selected',
      sessionId: '33333333-aaaa-bbbb-cccc-333333333333',
    });
    expect(resolveTerminalSessionPickerInput('hidden', request)).toEqual({
      type: 'selected',
      sessionId: '33333333-aaaa-bbbb-cccc-333333333333',
    });
  });

  it('keeps ambiguous session picker text local and shows a helpful error', () => {
    const { sink, writes } = makeTerminalSink();

    sink.showSessionPicker({
      title: 'Pick a Session',
      sessions: [
        {
          id: '11111111-aaaa-bbbb-cccc-111111111111',
          projectPath: '/tmp/project-a',
          model: 'glm-5',
          startTime: 1,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'ui polish',
        },
        {
          id: '22222222-aaaa-bbbb-cccc-222222222222',
          projectPath: '/tmp/project-b',
          model: 'glm-5',
          startTime: 2,
          tokenCount: 0,
          cost: 0,
          taskSummary: 'ui review',
        },
      ],
    });

    expect(sink.consumePendingSelection('ui')).toBe('');
    expect(writes.join('')).toContain('Multiple sessions match "ui"');
    expect(writes.join('')).toContain('Type a number or a longer session id');
    expect(sink.consumePendingSelection('11111111')).toEqual({
      type: 'select_session',
      sessionId: '11111111-aaaa-bbbb-cccc-111111111111',
      allProjects: undefined,
      source: 'picker',
    });
  });

  it('keeps terminal scrollback transcript append-only for tool output', () => {
    const { sink, writes } = makeTerminalSink();

    const toolId = sink.append({
      role: 'tool',
      title: 'tool',
      content: 'Running read_file src/index.ts',
    });
    sink.finalize(toolId, {
      role: 'tool',
      title: 'tool',
      content: '✓ read_file src/index.ts (12ms)',
    });
    const assistantId = sink.append({
      role: 'assistant',
      content: 'Done.',
    });
    sink.finalize(assistantId);

    const output = writes.join('');
    expect(output).toContain('Running read_file src/index.ts');
    expect(output).toContain('✓ read_file src/index.ts (12ms)');
    expect(output).toContain('Done.');
    expect(output.indexOf('Running read_file')).toBeLessThan(output.indexOf('✓ read_file'));
    expect(output.indexOf('✓ read_file')).toBeLessThan(output.indexOf('Done.'));
  });

  it('clears renderer view state without clearing terminal scrollback', () => {
    const { sink, writes } = makeTerminalSink();

    const assistantId = sink.append({ role: 'assistant', content: 'existing transcript' });
    sink.finalize(assistantId);
    sink.clearTranscript();

    const output = writes.join('');
    expect(output).toContain('existing transcript');
    expect(output).toContain('Terminal scrollback is preserved.');
  });

  it('does not print duplicate consecutive status messages', () => {
    const { sink, writes } = makeTerminalSink();

    sink.setStatus('Thinking...');
    sink.setStatus('Thinking...');
    sink.setStatus('Running 2 tools...');

    const output = writes.join('');
    expect(output.match(/Thinking\.\.\./g)).toHaveLength(1);
    expect(output).toContain('Running 2 tools...');
  });
});

describe('terminal UI visual width helpers', () => {
  it('counts CJK and emoji by terminal cell width instead of UTF-16 length', () => {
    expect(visibleLength('abc')).toBe(3);
    expect(visibleLength('开源')).toBe(4);
    expect(visibleLength('\x1b[36m开源\x1b[0m')).toBe(4);
    expect(visibleLength('小马🐎')).toBeGreaterThan('小马🐎'.length - 1);
  });

  it('truncates long terminal text without exceeding the requested visual width', () => {
    const truncated = truncateTerminalText('项目路径/开源小马/非常非常长的目录名', 16);

    expect(visibleLength(truncated)).toBeLessThanOrEqual(16);
    expect(truncated.endsWith('...')).toBe(true);
  });
});

describe('raw terminal editor', () => {
  it('keeps CJK input in its buffer and deletes one grapheme with Backspace', () => {
    const { editor } = makeRawEditor();
    editor.setPrompt('› ');

    editor.feed(Buffer.from('开源小？事收到', 'utf8'));
    expect(editor.getBuffer().value).toBe('开源小？事收到');

    editor.feed(Buffer.from('\x7f'));
    expect(editor.getBuffer().value).toBe('开源小？事收');
  });

  it('restores the current input after external assistant output', () => {
    const { editor, writes } = makeRawEditor();
    editor.setPrompt('› ');
    editor.feed(Buffer.from('输入中事地方', 'utf8'));

    editor.writeExternal('assistant chunk');

    const output = writes.join('');
    expect(output).toContain('assistant chunk\n');
    expect(output).toContain('› 输入中事地方');
  });

  it('submits the current buffer on Enter and clears it', () => {
    const submitted: string[] = [];
    const { editor } = makeRawEditor({ onSubmit: input => submitted.push(input) });
    editor.setPrompt('› ');

    editor.feed(Buffer.from('hello\r'));

    expect(submitted).toEqual(['hello']);
    expect(editor.getBuffer().value).toBe('');
  });

  it('keeps bracketed multiline paste in the buffer and submits it once', () => {
    const submitted: string[] = [];
    const notices: string[] = [];
    const { editor, writes } = makeRawEditor({ onSubmit: input => submitted.push(input), onNotice: message => notices.push(message) });
    editor.setPrompt('› ');

    editor.feed(Buffer.from('\x1b[200~first line\nsecond line\x1b[201~', 'utf8'));

    expect(submitted).toEqual([]);
    expect(editor.getBuffer().value).toBe('first line\nsecond line');
    expect(writes.join('')).toContain('first line⏎ second line');
    expect(notices).toEqual(['Pasted 2 lines. Enter sends once; Ctrl+U clears.']);

    editor.feed(Buffer.from('\r'));

    expect(submitted).toEqual(['first line\nsecond line']);
    expect(editor.getBuffer().value).toBe('');
  });

  it('keeps split bracketed paste chunks inside the parser before applying paste heuristics', () => {
    const submitted: string[] = [];
    const notices: string[] = [];
    const { editor } = makeRawEditor({ onSubmit: input => submitted.push(input), onNotice: message => notices.push(message) });
    editor.setPrompt('› ');

    editor.feed(Buffer.from('\x1b[200~', 'utf8'));
    editor.feed(Buffer.from('first line\nsecond line', 'utf8'));

    expect(editor.getBuffer().value).toBe('');
    expect(notices).toEqual([]);

    editor.feed(Buffer.from('\x1b[201~', 'utf8'));

    expect(submitted).toEqual([]);
    expect(editor.getBuffer().value).toBe('first line\nsecond line');
    expect(notices).toEqual(['Pasted 2 lines. Enter sends once; Ctrl+U clears.']);
  });

  it('treats unbracketed multiline paste chunks as one buffer insert', () => {
    const submitted: string[] = [];
    const notices: string[] = [];
    const { editor } = makeRawEditor({ onSubmit: input => submitted.push(input), onNotice: message => notices.push(message) });
    editor.setPrompt('› ');

    editor.feed(Buffer.from('one\ntwo\nthree', 'utf8'));

    expect(submitted).toEqual([]);
    expect(editor.getBuffer().value).toBe('one\ntwo\nthree');
    expect(notices).toEqual(['Pasted 3 lines. Enter sends once; Ctrl+U clears.']);

    editor.feed(Buffer.from('\r'));

    expect(submitted).toEqual(['one\ntwo\nthree']);
  });

  it('suggests editor mode for very long pasted drafts', () => {
    const notices: string[] = [];
    const { editor } = makeRawEditor({ onNotice: message => notices.push(message) });
    editor.setPrompt('› ');

    editor.feed(Buffer.from(Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n'), 'utf8'));

    expect(notices[0]).toContain('Pasted 20 lines');
    expect(notices[0]).toContain('/edit is better');
  });
});

describe('terminal UI multiline composer', () => {
  it('submits explicit /paste blocks when /end is received', () => {
    const composer = new TerminalInputComposer();

    expect(composer.receive('/paste').input).toBeUndefined();
    expect(composer.isActive()).toBe(true);
    expect(composer.prompt('› ')).toContain('[paste 1L]');
    expect(composer.receive('第一行').input).toBeUndefined();
    expect(composer.prompt('› ')).toContain('[paste 2L]');
    expect(composer.receive('second line').input).toBeUndefined();
    expect(composer.prompt('› ')).toContain('[paste 3L]');

    expect(composer.receive('/end')).toEqual({ input: '第一行\nsecond line' });
    expect(composer.isActive()).toBe(false);
  });

  it('cancels explicit multiline input without submitting content', () => {
    const composer = new TerminalInputComposer();

    composer.receive('/paste');
    composer.receive('draft');

    const result = composer.receive('/cancel');
    expect(result.cancelled).toBe(true);
    expect(result.input).toBeUndefined();
    expect(composer.isActive()).toBe(false);
  });

  it('submits backslash continuations as one multiline input', () => {
    const composer = new TerminalInputComposer();

    expect(composer.receive('line one\\').input).toBeUndefined();
    expect(composer.isActive()).toBe(true);
    expect(composer.receive('line two')).toEqual({ input: 'line one\nline two' });
    expect(composer.isActive()).toBe(false);
  });

  it('passes normal single-line input through', () => {
    const composer = new TerminalInputComposer();

    expect(composer.receive('/help')).toEqual({ input: '/help' });
  });
});

describe('terminal UI edit command parsing', () => {
  it('detects /edit and optional initial content', () => {
    expect(parseEditInput('/edit')).toEqual({ isEdit: true, initialContent: '' });
    expect(parseEditInput('   /edit write a plan')).toEqual({ isEdit: true, initialContent: 'write a plan' });
  });

  it('does not treat similar commands as editor mode', () => {
    expect(parseEditInput('/editor')).toEqual({ isEdit: false, initialContent: '' });
    expect(parseEditInput('/editors hello')).toEqual({ isEdit: false, initialContent: '' });
  });
});

describe('terminal UI readline completion', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'openhorse-terminal-completion-'));
    mkdirSync(join(tempDir, 'src'));
    mkdirSync(join(tempDir, 'docs'));
    writeFileSync(join(tempDir, 'src', 'terminal.ts'), '');
    writeFileSync(join(tempDir, 'docs', 'plan.md'), '');
    writeFileSync(join(tempDir, '.hidden'), '');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('completes visible slash commands with a trailing space', () => {
    const [matches, token] = completeSlashCommand('/mod');

    expect(token).toBe('/mod');
    expect(matches).toContain('/model ');
  });

  it('does not try slash completion after command arguments begin', () => {
    const [matches] = completeSlashCommand('/resume abc');

    expect(matches).toEqual([]);
  });

  it('completes @ file mentions in chat text', () => {
    const [matches, token] = completeFileMention('read @src/ter', tempDir);

    expect(token).toBe('read @src/ter');
    expect(matches).toEqual(['read @src/terminal.ts ']);
  });

  it('completes @ directories with a slash and ignores hidden files', () => {
    const [matches] = completeFileMention('open @', tempDir);

    expect(matches).toContain('open @src/');
    expect(matches).toContain('open @docs/');
    expect(matches.some(item => item.includes('.hidden'))).toBe(false);
  });

  it('creates one readline completer for slash and file paths', () => {
    const completer = createTerminalCompleter(tempDir);

    expect(completer('/stat')[0]).toContain('/status ');
    expect(completer('look @docs/pl')[0]).toEqual(['look @docs/plan.md ']);
  });

  it('applies tab completion when a cooked terminal passes tab through as text', () => {
    expect(applyTerminalTabCompletion('/stat\t', tempDir)).toBe('/status ');
    expect(applyTerminalTabCompletion('look @docs/pl\t', tempDir)).toBe('look @docs/plan.md ');
  });

  it('uses the common prefix for ambiguous tab completion', () => {
    expect(applyTerminalTabCompletion('/s\t', tempDir)).toBe('/s');
  });
});
