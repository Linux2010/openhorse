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

  it('renders tool timeline transcript rows without disturbing status or prompt', () => {
    const state = reduce([
      {
        type: 'appendTranscript',
        entry: {
          id: 'tool-1',
          role: 'tool',
          content: '#1 read_file src/index.ts (12 ms)\n  output 2.0 KB  artifact tool-1',
        },
      },
      { type: 'setStatus', message: 'model=gpt-4o' },
    ]);

    const rows = renderFrameRows(renderTuiUiFrame(state, { width: 72, height: 10 }));

    expect(rows.join('\n')).toContain('• #1 read_file src/index.ts (12 ms)');
    expect(rows.join('\n')).toContain('artifact tool-1');
    expect(rows[6]).toContain('model=gpt-4o');
    expect(rows[8]).toContain('│ ›');
  });

  // --- 切片1: golden frame tests ---

  it('renders correctly at minimum supported dimensions (24x8)', () => {
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'hello' } },
      { type: 'appendTranscript', entry: { id: 'a1', role: 'assistant', content: 'ok' } },
    ]);
    const frame = renderTuiUiFrame(state, { width: 24, height: 8 });
    const rows = renderFrameRows(frame);
    expect(rows).toHaveLength(8);
    // Prompt box must occupy the bottom 3 rows
    expect(rows[5]).toBe('┌──────────────────────┐');
    expect(rows[6]).toContain('│ ›');
    expect(rows[7]).toBe('└──────────────────────┘');
    // Status row is above prompt (height=8 → status row = 4)
    expect(rows[4]).toContain('ready');
  });

  it('renders correctly at narrow width 30', () => {
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'hello' } },
      { type: 'setStatus', message: 'model=gpt-4o  ctx=50%' },
    ]);
    const frame = renderTuiUiFrame(state, { width: 30, height: 10 });
    const rows = renderFrameRows(frame);
    // Prompt box must be at fixed offset from bottom
    expect(rows[7]).toBe('┌────────────────────────────┐');
    expect(rows[8]).toContain('│ ›');
    expect(rows[9]).toBe('└────────────────────────────┘');
    // Status row must be above prompt
    expect(rows[6]).toContain('ready');
    expect(rows[6]).toContain('model=gpt-4o');
  });

  it('does not overlap status, prompt, and overlay regions', () => {
    // If an overlay is active, it must be rendered in the transcript area,
    // not overwriting the prompt or status rows.
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
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'resume' } },
      { type: 'showSessionPicker', request: { title: 'Resume', sessions: [session] } },
    ]);
    const frame = renderTuiUiFrame(state, { width: 72, height: 10 });
    const rows = renderFrameRows(frame);
    // Overlay occupies transcript rows, not status/prompt rows
    expect(rows[6]).toContain('ready'); // status
    expect(rows[7]).toContain('┌');     // prompt top border
    expect(rows[8]).toContain('│ ›');   // prompt input
    expect(rows[9]).toContain('└');     // prompt bottom border
    // Overlay is in the transcript area
    expect(rows[0]).toContain('Sessions');
  });

  it('clamps dimensions below minimum gracefully', () => {
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'hello' } },
    ]);
    const frame = renderTuiUiFrame(state, { width: 5, height: 3 });
    // Must not crash; frame has at least MIN_WIDTH x MIN_HEIGHT
    expect(frame.width).toBeGreaterThanOrEqual(24);
    expect(frame.height).toBeGreaterThanOrEqual(8);
  });

  it('handles wrap for entries containing CJK characters', () => {
    // CJK characters are width 2 each; ensure wrapping does not split a character
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'a1', role: 'assistant', content: '你好世界' } },
    ]);
    const frame = renderTuiUiFrame(state, { width: 24, height: 8 });
    const rows = renderFrameRows(frame);
    // Each CJK char = 2 cells wide, 10 cells = "你好世界" → 20 cells
    // With width 24 and no prefix, it should fit on one line
    const visible = rows.filter(row => row.includes('你好世界'));
    expect(visible.length).toBeGreaterThanOrEqual(1);
  });

  it('preserves prompt cursor position after resize', () => {
    const state = reduce([
      { type: 'setPrompt', value: 'hello world', cursor: 5 },
    ]);
    // Simulate two consecutive renders at different sizes
    const frame1 = renderTuiUiFrame(state, { width: 40, height: 12 });
    const frame2 = renderTuiUiFrame(state, { width: 80, height: 24 });
    // Cursor should be visible and on the prompt row in both frames
    expect(frame1.cursor.visible).toBe(true);
    expect(frame2.cursor.visible).toBe(true);
    // Prompt row is at height - 2 in both layouts
    expect(frame1.cursor.row).toBe(10); // 12 - 2
    expect(frame2.cursor.row).toBe(22); // 24 - 2
  });

  // --- v0.2.19 completion: long status truncation ---

  it('truncates super-long status text to fit the frame width', () => {
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'hello' } },
      { type: 'setStatus', message: 'model=gpt-4o-very-long-model-name  ctx=85%  tokens=123456/200000  cost=$0.42  session=abc-def-ghi-jkl-mno-pqr' },
    ]);
    const frame = renderTuiUiFrame(state, { width: 30, height: 10 });
    const rows = renderFrameRows(frame);
    // Status row must not exceed frame width
    const statusRow = rows[6];
    expect(statusRow.length).toBeLessThanOrEqual(30);
    // Status row must still contain the key prefix
    expect(statusRow).toContain('model=');
    // Prompt box must be intact
    expect(rows[7]).toBe('┌────────────────────────────┐');
    expect(rows[9]).toBe('└────────────────────────────┘');
  });

  // --- v0.2.19 completion: rapid consecutive resize ---

  it('produces correct frame after multiple rapid resizes', () => {
    const state = reduce([
      { type: 'setPrompt', value: 'test input', cursor: 4 },
    ]);
    // Simulate rapid resize sequence: 40x12 → 80x24 → 24x8 → 60x16
    const frame1 = renderTuiUiFrame(state, { width: 40, height: 12 });
    const frame2 = renderTuiUiFrame(state, { width: 80, height: 24 });
    const frame3 = renderTuiUiFrame(state, { width: 24, height: 8 });
    const frame4 = renderTuiUiFrame(state, { width: 60, height: 16 });

    // Each frame must have correct dimensions
    expect(frame1.width).toBe(40);
    expect(frame1.height).toBe(12);
    expect(frame2.width).toBe(80);
    expect(frame2.height).toBe(24);
    expect(frame3.width).toBe(24);
    expect(frame3.height).toBe(8);
    expect(frame4.width).toBe(60);
    expect(frame4.height).toBe(16);

    // Cursor must be visible and on the correct prompt row in each frame
    expect(frame1.cursor).toMatchObject({ visible: true, row: 10 });
    expect(frame2.cursor).toMatchObject({ visible: true, row: 22 });
    expect(frame3.cursor).toMatchObject({ visible: true, row: 6 });
    expect(frame4.cursor).toMatchObject({ visible: true, row: 14 });

    // Prompt box borders must be intact in the final frame
    const rows4 = renderFrameRows(frame4);
    expect(rows4[13]).toContain('┌');
    expect(rows4[15]).toContain('└');
  });
});
