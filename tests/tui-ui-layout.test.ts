import { renderFrameRows } from '../src/tui-core/frame';
import { renderTuiUiFrame } from '../src/tui-ui/layout';
import { initialTuiUiState, tuiUiReducer, type TuiUiAction } from '../src/tui-ui/state';
import type { SessionMeta } from '../src/services/session-storage';

function reduce(actions: TuiUiAction[]) {
  return actions.reduce(tuiUiReducer, initialTuiUiState);
}

describe('tui-ui layout', () => {
  it('renders transcript tail, status, and prompt into one frame with owned cursor', () => {
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: '你好' } },
      { type: 'appendTranscript', entry: { id: 'a1', role: 'assistant', content: '收到' } },
      { type: 'setStatus', message: 'model=glm-5' },
      { type: 'setPrompt', value: '开源小？事收到', cursor: '开源小？'.length },
    ]);

    const frame = renderTuiUiFrame(state, { width: 32, height: 10 });
    const rows = renderFrameRows(frame);

    expect(rows[0]).toContain('› 你好');
    expect(rows[1]).toContain('收到');
    expect(rows[6]).toContain('ready');
    expect(rows[6]).toContain('model=glm-5');
    expect(rows[7]).toBe('┌──────────────────────────────┐');
    expect(rows[8]).toContain('│ › 开源小？事收到');
    expect(rows[9]).toBe('└──────────────────────────────┘');
    expect(frame.cursor).toEqual({
      row: 8,
      column: 4 + 8,
      visible: true,
    });
  });

  it('shows session picker overlay in the frame without mutating transcript state', () => {
    const session: SessionMeta = {
      id: '12345678-aaaa-bbbb-cccc-123456789000',
      projectPath: '/tmp/project',
      model: 'glm-5',
      startTime: 1,
      tokenCount: 0,
      cost: 0,
      messageCount: 2,
      historySizeBytes: 2048,
      name: 'demo session',
    };
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'old transcript' } },
      { type: 'showSessionPicker', request: { title: 'Resume', sessions: [session] } },
    ]);

    const frame = renderTuiUiFrame(state, { width: 60, height: 9 });
    const rows = renderFrameRows(frame);

    expect(rows[0]).toContain('Sessions: Resume (1/1)');
    expect(rows[1]).toContain('›  1 12345678  demo session');
    expect(rows[1]).toContain('2.0 KB');
    expect(state.transcript.map(entry => entry.content)).toEqual(['old transcript']);
  });

  it('scrolls the session picker around the selected row and renders size metadata', () => {
    const sessions: SessionMeta[] = Array.from({ length: 12 }, (_, index) => ({
      id: `session-${String(index + 1).padStart(2, '0')}-aaaaaaaa`,
      projectPath: `/tmp/project-${index + 1}`,
      model: 'glm-5',
      startTime: index,
      tokenCount: 0,
      cost: 0,
      messageCount: index + 1,
      historySizeBytes: (index + 1) * 1024,
      name: `session ${index + 1}`,
    }));
    const state = reduce([
      { type: 'showSessionPicker', request: { title: 'Resume', sessions, maxVisibleItems: 4 } },
      { type: 'moveOverlaySelection', delta: 8 },
    ]);

    const frame = renderTuiUiFrame(state, { width: 72, height: 10 });
    const rows = renderFrameRows(frame);

    expect(rows[0]).toContain('Sessions: Resume (9/12)');
    expect(rows.join('\n')).toContain('›  9 session-');
    expect(rows.join('\n')).toContain('9 msgs');
    expect(rows.join('\n')).toContain('9.0 KB');
    expect(rows.join('\n')).not.toContain('  1 session-');
  });

  it('renders tool permission overlay without writing transcript entries', () => {
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'old transcript' } },
      {
        type: 'showPermissionRequest',
        request: {
          id: 'permission-1',
          name: 'exec_command',
          args: { command: 'npm publish --dry-run' },
          reason: 'requires confirmation',
        },
      },
      { type: 'moveOverlaySelection', delta: 1 },
    ]);

    const frame = renderTuiUiFrame(state, { width: 72, height: 10 });
    const rows = renderFrameRows(frame).join('\n');

    expect(rows).toContain('Tool Permission: exec_command');
    expect(rows).toContain('npm publish --dry-run');
    expect(rows).toContain('requires confirmation');
    expect(rows).toContain('› Deny');
    expect(state.transcript.map(entry => entry.content)).toEqual(['old transcript']);
  });

  it('renders command, file, and shortcut overlays without writing transcript entries', () => {
    const commandFrame = renderTuiUiFrame(reduce([
      {
        type: 'showCommandPalette',
        query: 's',
        items: [{ value: 'status', label: '/status', description: 'System  Show system status' }],
      },
    ]), { width: 72, height: 10 });
    const commandRows = renderFrameRows(commandFrame);
    expect(commandRows[0]).toContain('Commands "s"');
    expect(commandRows[1]).toContain('› /status');

    const fileFrame = renderTuiUiFrame(reduce([
      {
        type: 'showFilePicker',
        base: 'open ',
        query: 'src/c',
        items: [{ value: 'src/cli.ts', label: 'file src/cli.ts', description: 'file' }],
      },
    ]), { width: 72, height: 10 });
    expect(renderFrameRows(fileFrame).join('\n')).toContain('Files "src/c"');
    expect(renderFrameRows(fileFrame).join('\n')).toContain('file src/cli.ts');

    const shortcutFrame = renderTuiUiFrame(reduce([
      { type: 'showShortcuts' },
    ]), { width: 72, height: 10 });
    expect(renderFrameRows(shortcutFrame).join('\n')).toContain('/ commands');
    expect(renderFrameRows(shortcutFrame).join('\n')).toContain('Ctrl+C interrupt');
  });

  it('keeps only the visible transcript tail above the prompt', () => {
    const actions: TuiUiAction[] = [];
    for (let index = 0; index < 8; index += 1) {
      actions.push({
        type: 'appendTranscript',
        entry: { id: `m${index}`, role: 'assistant', content: `line-${index}` },
      });
    }

    const frame = renderTuiUiFrame(reduce(actions), { width: 24, height: 8, maxTranscriptRows: 3 });
    const rows = renderFrameRows(frame);

    expect(rows[0]).toContain('line-5');
    expect(rows[1]).toContain('line-6');
    expect(rows[2]).toContain('line-7');
    expect(rows.join('\n')).not.toContain('line-0');
  });

  it('can render older transcript rows when scrolled back', () => {
    const actions: TuiUiAction[] = [];
    for (let index = 0; index < 8; index += 1) {
      actions.push({
        type: 'appendTranscript',
        entry: { id: `m${index}`, role: 'assistant', content: `line-${index}` },
      });
    }
    actions.push({ type: 'scrollTranscript', delta: 4 });

    const frame = renderTuiUiFrame(reduce(actions), { width: 24, height: 8, maxTranscriptRows: 3 });
    const rows = renderFrameRows(frame);

    expect(rows[0]).toContain('line-1');
    expect(rows[1]).toContain('line-2');
    expect(rows[2]).toContain('line-3');
    expect(rows.join('\n')).not.toContain('line-7');
  });
});
