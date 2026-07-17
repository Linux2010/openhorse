import {
  InlineTerminalSurface,
  MemoryOutput,
  type CommittedEntry,
  type TranscriptCommitBatch,
} from '../src/tui-ui/inline-surface';
import { createTuiFrame, writeFrameText, setFrameCursor, type TuiFrame } from '../src/tui-core/frame';

function makeFrame(width: number, height: number, text: string, cursorRow = 0): TuiFrame {
  const frame = createTuiFrame(width, height);
  writeFrameText(frame, 0, 0, text);
  setFrameCursor(frame, cursorRow, text.length);
  return frame;
}

function makeCommittedEntry(key: string, rows: string[][]): CommittedEntry {
  return {
    displayKey: key,
    rows: rows.map(r => r.map(text => ({ text }))),
  };
}

function makeBatch(entries: CommittedEntry[], generation = 1, reason: 'append' | 'finalize' | 'restore' | 'replace' | 'clear-divider' = 'append'): TranscriptCommitBatch {
  return { generation, reason, entries };
}

const noLiveFrame = () => null;

// ============================================================================
// Surface lifecycle
// ============================================================================

describe('inline surface: lifecycle', () => {
  it('mounts without entering alternate screen', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    expect(output.text()).not.toContain('\x1b[?1049h');
    output.assertNoForbidden();
  });

  it('unmounts without erasing scrollback', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    output.chunks = [];
    await surface.unmount();
    const text = output.text();
    expect(text).not.toContain('\x1b[?1049l');
    expect(text).not.toContain('\x1b[2J');
    output.assertNoForbidden();
  });

  it('suspend disables bracketed paste and shows cursor', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    output.chunks = [];
    await surface.suspend();
    const text = output.text();
    expect(text).toContain('\x1b[?2004l'); // disable bracketed paste
    expect(text).toContain('\x1b[?25h'); // show cursor
  });

  it('restore re-enables bracketed paste', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    await surface.suspend();
    output.chunks = [];
    await surface.restore(noLiveFrame);
    expect(output.text()).toContain('\x1b[?2004h'); // enable bracketed paste
  });

  it('never emits forbidden sequences', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    const frame = makeFrame(40, 3, 'hello');
    await surface.renderLive(frame);
    const batch = makeBatch([makeCommittedEntry('e1', [['committed line']])]);
    await surface.commit(batch, () => frame);
    await surface.resize(60, 20, () => frame);
    await surface.suspend();
    await surface.restore(() => frame);
    await surface.unmount();
    output.assertNoForbidden();
  });
});

// ============================================================================
// Commit protocol
// ============================================================================

describe('inline surface: commit', () => {
  it('commits finalized entries to scrollback with hard newline', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    output.chunks = [];
    const batch = makeBatch([makeCommittedEntry('e1', [['hello'], ['world']])]);
    const result = await surface.commit(batch, noLiveFrame);
    const text = output.text();
    expect(text).toContain('hello');
    expect(text).toContain('world');
    expect(result.committedEntries).toBe(1);
    // Each committed row ends with SGR reset + newline (hard boundary).
    expect(text).toMatch(/hello\x1b\[0m\n/);
    expect(text).toMatch(/world\x1b\[0m\n/);
  });

  it('writes committed rows at the screen bottom so they scroll into native scrollback', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    // Render a live frame first to anchor the band at the screen bottom.
    await surface.renderLive(makeFrame(40, 3, 'live content'));
    output.chunks = [];
    const batch = makeBatch([makeCommittedEntry('e1', [['committed']])]);
    // Provide a live frame so the band is repainted after the commit.
    await surface.commit(batch, () => makeFrame(40, 3, 'live after'));
    const text = output.text();
    // The committed row is written and terminated by a hard newline so it
    // scrolls into native scrollback (never relies on pending wrap).
    expect(text).toMatch(/committed\x1b\[0m\n/);
    // The committed row is followed by a live band repaint (EL2 clear).
    expect(text).toContain('\x1b[2K');
    expect(text).toContain('live after');
  });

  it('rebuilds live frame after commit using latest state', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    const latestFrame = makeFrame(40, 3, 'post-commit live');
    const batch = makeBatch([makeCommittedEntry('e1', [['committed']])]);
    await surface.commit(batch, () => latestFrame);
    expect(output.text()).toContain('post-commit live');
  });

  it('accumulates incremental commits into native scrollback (each row scrolls)', async () => {
    // Regression for the v0.2.21 native-scrollback bug: the old protocol wrote
    // committed rows into the live region and immediately overwrote them with
    // the live frame, so history never scrolled into scrollback. The fix writes
    // each committed row at the screen bottom so its trailing \n scrolls it into
    // scrollback, exactly like ordinary shell output.
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    // Anchor the band first.
    await surface.renderLive(makeFrame(40, 3, 'anchor'));
    output.chunks = [];

    // Several incremental commits (small batches, like finalized turns).
    await surface.commit(makeBatch([makeCommittedEntry('e1', [['turn-1-line-a'], ['turn-1-line-b']])]), noLiveFrame);
    await surface.commit(makeBatch([makeCommittedEntry('e2', [['turn-2']])]), noLiveFrame);
    await surface.commit(makeBatch([makeCommittedEntry('e3', [['turn-3']])]), noLiveFrame);

    const text = output.text();
    // Every committed row remains in the authoritative raw stream (what a real
    // PTY received and what a user can scroll back to see)...
    expect(text).toContain('turn-1-line-a');
    expect(text).toContain('turn-1-line-b');
    expect(text).toContain('turn-2');
    expect(text).toContain('turn-3');
    // ...and each is terminated by a hard newline (the scroll trigger).
    const scrollRows = text.match(/[^\n]*\x1b\[0m\n/g) ?? [];
    expect(scrollRows.length).toBeGreaterThanOrEqual(4);
    // No forbidden sequences across the commit burst.
    output.assertNoForbidden();
  });
});

// ============================================================================
// Live rendering
// ============================================================================

describe('inline surface: live render', () => {
  it('renders live frame content', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    output.chunks = [];
    await surface.renderLive(makeFrame(40, 2, 'streaming'));
    expect(output.text()).toContain('streaming');
  });

  it('uses relative cursor movement only', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    output.chunks = [];
    await surface.renderLive(makeFrame(40, 3, 'test'));
    output.assertNoForbidden();
  });

  it('restores cursor visibility at end of paint batch', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    output.chunks = [];
    await surface.renderLive(makeFrame(40, 2, 'test'));
    // Render restores cursor visibility (SHOW_CURSOR) based on frame.cursor.visible.
    expect(output.text()).toContain('\x1b[?25h');
  });
});

// ============================================================================
// Resize
// ============================================================================

describe('inline surface: resize', () => {
  it('resizes without rewriting committed history', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    const batch = makeBatch([makeCommittedEntry('e1', [['committed line 1']])]);
    await surface.commit(batch, noLiveFrame);
    output.chunks = [];
    await surface.resize(60, 20, () => makeFrame(40, 2, 'live after resize'));
    const text = output.text();
    expect(text).not.toContain('committed line 1');
    output.assertNoForbidden();
  });
});

// ============================================================================
// Serialized queue
// ============================================================================

describe('inline surface: serialized queue', () => {
  it('operations execute in FIFO order', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    const order: string[] = [];
    // Enqueue commits and renders - they should not interleave.
    const p1 = surface.commit(makeBatch([makeCommittedEntry('e1', [['first']])]), noLiveFrame)
      .then(() => order.push('commit1'));
    const p2 = surface.renderLive(makeFrame(40, 2, 'render1'))
      .then(() => order.push('render1'));
    await Promise.all([p1, p2]);
    expect(order).toEqual(['commit1', 'render1']);
  });
});

// ============================================================================
// State
// ============================================================================

describe('inline surface: state', () => {
  it('reports phase transitions', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    expect(surface.getState().phase).toBe('idle');
    await surface.mount(80, 24);
    expect(surface.getState().phase).toBe('mounted');
    await surface.suspend();
    expect(surface.getState().phase).toBe('suspended');
    await surface.restore(noLiveFrame);
    expect(surface.getState().phase).toBe('mounted');
    await surface.unmount();
    expect(surface.getState().phase).toBe('unmounted');
  });

  it('safeContentWidth avoids last column', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    expect(surface.safeContentWidth).toBe(79);
  });

  it('liveRegionCapacity equals the live band height after anchoring', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    // 24-row terminal -> band = round(24*0.75) = 18 rows.
    expect(surface.getLiveBandRows()).toBe(18);
    expect(surface.getState().liveBandRows).toBe(18);
    await surface.renderLive(makeFrame(40, 4, 'test'));
    // Capacity is the fixed band height, not the full screen.
    expect(surface.getState().liveRegionCapacity).toBe(18);
    expect(surface.getState().liveRegionCapacity).toBeLessThanOrEqual(23);
  });
});

// ============================================================================
// MemoryOutput test double
// ============================================================================

describe('MemoryOutput test double', () => {
  it('collects chunks', () => {
    const out = new MemoryOutput();
    out.write('hello ');
    out.write('world');
    expect(out.text()).toBe('hello world');
  });

  it('assertNoForbidden throws on alternate screen', () => {
    const out = new MemoryOutput();
    out.write('\x1b[?1049h');
    expect(() => out.assertNoForbidden()).toThrow('alternate-screen');
  });

  it('assertNoForbidden throws on absolute positioning', () => {
    const out = new MemoryOutput();
    out.write('\x1b[10;20H');
    expect(() => out.assertNoForbidden()).toThrow('absolute cursor');
  });

  it('assertNoForbidden throws on full clear', () => {
    const out = new MemoryOutput();
    out.write('\x1b[2J');
    expect(() => out.assertNoForbidden()).toThrow('full-screen clear');
  });
});
