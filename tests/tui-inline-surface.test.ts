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

  it('clears live region before committing', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    // Render a live frame first to populate live region.
    await surface.renderLive(makeFrame(40, 3, 'live content'));
    output.chunks = [];
    const batch = makeBatch([makeCommittedEntry('e1', [['committed']])]);
    await surface.commit(batch, noLiveFrame);
    const text = output.text();
    // Live content should be cleared (EL2) before commit.
    expect(text).toContain('\x1b[2K');
    expect(text).toContain('committed');
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

  it('liveRegionCapacity grows with ensureCapacity', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(80, 24);
    await surface.renderLive(makeFrame(40, 4, 'test'));
    expect(surface.getState().liveRegionCapacity).toBeGreaterThan(0);
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
