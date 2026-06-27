import stringWidth from 'string-width';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { moveTo } from '../src/tui-core/terminal-writer';
import { TuiRunner } from '../src/tui-ui/runner';

function createOutput() {
  const writes: string[] = [];
  return {
    writes,
    output: {
      write: (chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      },
    },
  };
}

describe('tui-ui runner', () => {
  it('keeps CJK input and the native cursor in the prompt frame', () => {
    const { output } = createOutput();
    const runner = new TuiRunner({ output, width: 48, height: 10 });
    const bytes = Buffer.from('开源小？事收到', 'utf8');

    runner.feedInput(bytes.subarray(0, 5));
    runner.feedInput(bytes.subarray(5));

    expect(runner.getState().prompt.value).toBe('开源小？事收到');
    const frame = runner.getLastFrame();
    expect(frame?.cursor).toEqual({
      row: 8,
      column: 4 + stringWidth('开源小？事收到'),
      visible: true,
    });
    expect(runner.getLastRenderResult()?.output).toContain(moveTo(8, 4 + stringWidth('开源小？事收到')));
  });

  it('maps macOS DEL to backspace and removes the previous grapheme', () => {
    const { output } = createOutput();
    const runner = new TuiRunner({ output, width: 48, height: 10 });

    runner.feedInput(Buffer.from('开源小？事收到', 'utf8'));
    runner.feedInput(Buffer.from('\x7f'));

    expect(runner.getState().prompt.value).toBe('开源小？事收');
    expect(runner.getLastFrame()?.cursor.column).toBe(4 + stringWidth('开源小？事收'));
  });

  it('submits once, clears the prompt, and parks the cursor at prompt start', () => {
    const { output } = createOutput();
    const submitted: string[] = [];
    const runner = new TuiRunner({
      output,
      width: 42,
      height: 9,
      onSubmit: input => {
        submitted.push(input);
      },
    });

    runner.feedInput(Buffer.from('hello'));
    runner.feedInput(Buffer.from('\r'));

    expect(submitted).toEqual(['hello']);
    expect(runner.getState().prompt).toEqual({ value: '', cursor: 0 });
    expect(runner.getLastFrame()?.cursor).toEqual({ row: 7, column: 4, visible: true });
  });

  it('routes UI event sink updates through the same frame instead of stdout side channels', () => {
    const { output } = createOutput();
    const runner = new TuiRunner({ output, width: 50, height: 10 });

    runner.events.setStatus('model=glm-5 session=abcd');
    const liveId = runner.events.append({ role: 'assistant', content: 'partial', live: true });
    runner.events.update(liveId, { content: 'done' });
    runner.events.finalize(liveId);

    const visible = runner.getVisibleRows().join('\n');
    expect(visible).toContain('done');
    expect(visible).toContain('model=glm-5 session=abcd');
    expect(runner.getState().transcript.map(entry => [entry.id, entry.finalized])).toEqual([[liveId, true]]);
  });

  it('keeps tool transcript output and structured runtime tool events ordered', () => {
    const { output } = createOutput();
    const runner = new TuiRunner({ output, width: 72, height: 12 });

    runner.events.toolStarted?.({
      callId: 'call-1',
      name: 'read_file',
      args: { path: 'src/index.ts' },
    });
    const toolId = runner.events.append({
      role: 'tool',
      title: 'tool',
      content: 'Running read_file src/index.ts',
    });
    runner.events.toolFinished?.({
      callId: 'call-1',
      name: 'read_file',
      args: { path: 'src/index.ts' },
      success: true,
      duration: 12,
      summary: '✓ read_file src/index.ts (12ms)',
    });
    runner.events.finalize(toolId, {
      role: 'tool',
      title: 'tool',
      content: '✓ read_file src/index.ts (12ms)',
    });
    const assistantId = runner.events.append({
      role: 'assistant',
      content: 'Done.',
      live: true,
    });
    runner.events.finalize(assistantId);

    const visible = runner.getVisibleRows().join('\n');
    expect(visible).toContain('✓ read_file src/index.ts (12ms)');
    expect(visible).toContain('Done.');
    expect(visible.indexOf('✓ read_file')).toBeLessThan(visible.indexOf('Done.'));
    expect(runner.getState().runtimeToolEvents).toEqual([
      { type: 'started', callId: 'call-1', name: 'read_file', args: { path: 'src/index.ts' } },
      {
        type: 'finished',
        callId: 'call-1',
        name: 'read_file',
        args: { path: 'src/index.ts' },
        success: true,
        duration: 12,
        summary: '✓ read_file src/index.ts (12ms)',
      },
    ]);
    expect(runner.getState().transcript.map(entry => entry.id)).toEqual([toolId, assistantId]);
  });

  it('navigates session picker overlay and submits the selected row with empty Enter', () => {
    const { output } = createOutput();
    const submitted: string[] = [];
    const runner = new TuiRunner({
      output,
      width: 64,
      height: 12,
      onSubmit: input => {
        submitted.push(input);
      },
    });

    runner.events.showSessionPicker({
      title: 'Pick a Session',
      maxVisibleItems: 3,
      sessions: Array.from({ length: 5 }, (_, index) => ({
        id: `session-${index}`,
        projectPath: '/tmp/project',
        model: 'glm-5',
        startTime: index,
        tokenCount: 0,
        cost: 0,
        messageCount: 1,
      })),
    });

    runner.feedInput(Buffer.from('\x1b[B\x1b[B\r'));

    expect(runner.getState().overlay).toMatchObject({ type: 'sessions', selectedIndex: 2 });
    expect(submitted).toEqual(['']);
  });

  it('routes tool permission overlay decisions through the callback', () => {
    const { output } = createOutput();
    const decisions: Array<{ requestId: string; approved: boolean }> = [];
    const runner = new TuiRunner({
      output,
      width: 64,
      height: 12,
      onPermissionDecision: (requestId, approved) => {
        decisions.push({ requestId, approved });
      },
    });

    runner.events.showPermissionRequest!({
      id: 'permission-1',
      name: 'exec_command',
      args: { command: 'npm publish --dry-run' },
      reason: 'requires confirmation',
    });
    runner.feedInput(Buffer.from('\x1b[B\r'));

    expect(decisions).toEqual([{ requestId: 'permission-1', approved: false }]);
    expect(runner.getState().overlay).toBeNull();

    runner.events.showPermissionRequest!({
      id: 'permission-2',
      name: 'git_push',
      args: { remote: 'origin' },
    });
    runner.feedInput(Buffer.from('y'));

    expect(decisions).toEqual([
      { requestId: 'permission-1', approved: false },
      { requestId: 'permission-2', approved: true },
    ]);
    expect(runner.getState().overlay).toBeNull();
  });

  it('resets the writer on resize so stale wide rows are fully redrawn', () => {
    const { output } = createOutput();
    const runner = new TuiRunner({ output, width: 30, height: 8 });

    runner.feedInput(Buffer.from('resize me'));
    runner.resize(44, 12);

    expect(runner.getLastFrame()).toMatchObject({ width: 44, height: 12 });
    expect(runner.getLastRenderResult()?.diff.changedRows).toHaveLength(12);
  });

  it('uses PageUp/PageDown for transcript scrollback when no picker owns those keys', () => {
    const { output } = createOutput();
    const runner = new TuiRunner({ output, width: 32, height: 9 });

    for (let index = 0; index < 10; index += 1) {
      runner.events.append({ role: 'assistant', content: `history-${index}` });
    }

    expect(runner.getVisibleRows().join('\n')).toContain('history-9');
    runner.feedInput(Buffer.from('\x1b[5~'));
    expect(runner.getState().transcriptScrollOffset).toBeGreaterThan(0);
    expect(runner.getVisibleRows().join('\n')).toContain('history-1');
    runner.feedInput(Buffer.from('\x1b[6~'));
    expect(runner.getState().transcriptScrollOffset).toBe(0);
    expect(runner.getVisibleRows().join('\n')).toContain('history-9');
  });

  it('opens the slash command overlay and completes with Tab', () => {
    const { output } = createOutput();
    const runner = new TuiRunner({ output, width: 72, height: 12 });

    runner.feedInput(Buffer.from('/sta'));

    expect(runner.getState().overlay).toMatchObject({ type: 'commands' });
    expect(runner.getVisibleRows().join('\n')).toContain('Commands "sta"');

    runner.feedInput(Buffer.from('\t'));

    expect(runner.getState().prompt.value).toBe('/status');
    expect(runner.getState().overlay).toBeNull();
  });

  it('submits an exact slash command on Enter even while the overlay is visible', () => {
    const { output } = createOutput();
    const submitted: string[] = [];
    const runner = new TuiRunner({
      output,
      width: 72,
      height: 12,
      onSubmit: input => {
        submitted.push(input);
      },
    });

    runner.feedInput(Buffer.from('/resume\r'));

    expect(submitted).toEqual(['/resume']);
    expect(runner.getState().prompt.value).toBe('');
  });

  it('opens shortcuts without inserting ? into the prompt', () => {
    const { output } = createOutput();
    const runner = new TuiRunner({ output, width: 72, height: 12 });

    runner.feedInput(Buffer.from('?'));

    expect(runner.getState().prompt.value).toBe('');
    expect(runner.getState().overlay).toEqual({ type: 'shortcuts' });
    expect(runner.getVisibleRows().join('\n')).toContain('Shortcuts');
  });

  it('opens the file picker and completes the active @ token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openhorse-tui-runner-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'cli.ts'), '');
      const { output } = createOutput();
      const runner = new TuiRunner({ output, width: 72, height: 12, cwd: dir });

      runner.feedInput(Buffer.from('open @src/c'));

      expect(runner.getState().overlay).toMatchObject({ type: 'files' });
      expect(runner.getVisibleRows().join('\n')).toContain('file src/cli.ts');

      runner.feedInput(Buffer.from('\t'));

      expect(runner.getState().prompt.value).toBe('open @src/cli.ts ');
      expect(runner.getState().overlay).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
