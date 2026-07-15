/**
 * InlineTerminalSurface: primary-screen inline TUI surface.
 *
 * Replaces the alternate-screen (1049) approach. Finalized transcript
 * content is committed once to stdout (entering shell native scrollback),
 * while the bottom live region holds only ephemeral content (streaming
 * assistant, running tools, overlay, status, prompt).
 *
 * Control sequences used (relative addressing only):
 *   CR       \r             return to column 0
 *   EL2      \x1b[2K        erase current line
 *   CUU(n)   \x1b[<n>A      cursor up (relative)
 *   CUD(n)   \x1b[<n>B      cursor down (relative)
 *   CUF(n)   \x1b[<n>C      cursor forward (relative)
 *   SGR0     \x1b[0m        reset style
 *   DECTCEM  \x1b[?25l/?25h hide/show cursor
 *   DECAWM   \x1b[?7l/?7h   disable/enable autowrap (paint batch)
 *
 * Forbidden (never emitted):
 *   \x1b[?1049h / \x1b[?1049l  (alternate screen)
 *   CSI row;col H / f         (absolute cursor positioning)
 *   CSI 2J                     (full screen clear)
 *   mouse reporting, OSC52, OSC8
 *
 * All operations are serialized via an internal FIFO queue so commit,
 * renderLive, resize, suspend, and unmount never interleave on the same stream.
 */

import { renderStyledFrameRow, type TuiFrame } from '../tui-core/frame';
import { encodeStyleToSgr, SGR_RESET, shouldSuppressColor } from '../tui-core/style';

/** Minimal output stream interface. */
export interface SurfaceOutput {
  write(chunk: string | Uint8Array): boolean;
  on(event: 'drain', listener: () => void): this;
  off(event: 'drain', listener: () => void): this;
  readonly writable: boolean;
}

export interface InlineSurfaceOptions {
  output: SurfaceOutput;
  /** Inject for deterministic tests. */
  now?: () => number;
}

export type SurfacePhase = 'idle' | 'mounted' | 'suspended' | 'unmounted' | 'failed';

export interface InlineSurfaceState {
  phase: SurfacePhase;
  width: number;
  height: number;
  /** Rows reserved for the live region (only grows during a mount lifecycle). */
  liveRegionCapacity: number;
  cursorRow: number;
  cursorColumn: number;
  previousFrame: TuiFrame | null;
}

/** A committed transcript entry rendered to styled rows. */
export interface CommittedEntry {
  displayKey: string;
  rows: { text: string; style?: import('../tui-core/style').TuiStyle }[][];
}

export interface TranscriptCommitBatch {
  generation: number;
  reason: 'append' | 'finalize' | 'restore' | 'replace' | 'clear-divider';
  entries: CommittedEntry[];
}

export interface TuiTerminalRenderResult {
  output: string;
  committedEntries: number;
}

/**
 * Get the latest live frame for rendering after a commit.
 * The runner provides this so commit + finalize interleaving uses fresh state.
 */
export type LiveFrameProvider = () => TuiFrame | null;

const CR = '\r';
const EL2 = '\x1b[2K';
const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';
const SHOW_CURSOR = '\x1b[?25h';
const HIDE_CURSOR = '\x1b[?25l';
const DISABLE_AUTOWRAP = '\x1b[?7l';
const ENABLE_AUTOWRAP = '\x1b[?7h';

function cursorUp(n: number): string {
  return n > 0 ? `\x1b[${n}A` : '';
}
function cursorDown(n: number): string {
  return n > 0 ? `\x1b[${n}B` : '';
}

export class InlineTerminalSurface {
  private phase: SurfacePhase = 'idle';
  private width = 0;
  private height = 0;
  private liveRegionCapacity = 0;
  private cursorRow = 0;
  private cursorColumn = 0;
  private previousFrame: TuiFrame | null = null;
  private readonly output: SurfaceOutput;
  private readonly now: () => number;
  private readonly suppressColor: boolean;
  /** Serialized FIFO queue of pending operations. */
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  constructor(options: InlineSurfaceOptions) {
    this.output = options.output;
    this.now = options.now ?? (() => Date.now());
    this.suppressColor = shouldSuppressColor();
  }

  getState(): InlineSurfaceState {
    return {
      phase: this.phase,
      width: this.width,
      height: this.height,
      liveRegionCapacity: this.liveRegionCapacity,
      cursorRow: this.cursorRow,
      cursorColumn: this.cursorColumn,
      previousFrame: this.previousFrame,
    };
  }

  /** Safe content width: never write the last column (avoid pending-wrap). */
  get safeContentWidth(): number {
    return Math.max(1, this.width - 1);
  }

  /** Enqueue an operation; FIFO guarantees no interleaving. */
  private enqueue(op: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await op();
          resolve();
        } catch (err) {
          this.phase = 'failed';
          reject(err);
        }
      });
      this.drainQueue();
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const op = this.queue.shift()!;
      await op();
    }
    this.processing = false;
  }

  /** Mount: enable bracketed paste + hide cursor. NO alternate screen. */
  async mount(width: number, height: number): Promise<void> {
    await this.enqueue(async () => {
      if (this.phase !== 'idle') return;
      this.width = Math.max(1, Math.floor(width));
      this.height = Math.max(1, Math.floor(height));
      this.phase = 'mounted';
      this.liveRegionCapacity = 0;
      this.cursorRow = 0;
      this.cursorColumn = 0;
      this.writeRaw(`${ENABLE_BRACKETED_PASTE}${HIDE_CURSOR}`);
    });
  }

  /**
   * Commit finalized transcript entries to scrollback (append-only).
   * Protocol: clear live region -> commit rows -> rebuild live frame.
   */
  async commit(batch: TranscriptCommitBatch, getLatestLiveFrame: LiveFrameProvider): Promise<TuiTerminalRenderResult> {
    let output = '';
    await this.enqueue(async () => {
      const chunks: string[] = [];
      // 1. Move to live top and clear live region.
      chunks.push(this.clearLiveRegion());
      // 2. Commit each entry's rows with SGR0 after each row.
      for (const entry of batch.entries) {
        for (const row of entry.rows) {
          for (const span of row) {
            if (span.style) {
              const sgr = encodeStyleToSgr(span.style, this.suppressColor);
              if (sgr) chunks.push(sgr);
            }
            chunks.push(span.text);
          }
          chunks.push(SGR_RESET);
          chunks.push('\n'); // hard line boundary, never rely on pending wrap
        }
      }
      // 3. Reset live region capacity and rebuild live frame.
      this.liveRegionCapacity = 0;
      this.previousFrame = null;
      const liveFrame = getLatestLiveFrame();
      if (liveFrame) {
        chunks.push(this.renderLiveInternal(liveFrame));
      }
      output = chunks.join('');
      this.writeRaw(output);
    });
    return { output, committedEntries: batch.entries.length };
  }

  /** Render the live region frame (relative addressing, changed-row diff). */
  async renderLive(frame: TuiFrame): Promise<string> {
    let output = '';
    await this.enqueue(async () => {
      output = this.renderLiveInternal(frame);
      this.writeRaw(output);
    });
    return output;
  }

  private renderLiveInternal(frame: TuiFrame): string {
    const chunks: string[] = [];
    const requiredRows = Math.min(frame.height, Math.max(1, this.height - 1));

    // Ensure capacity for the live region.
    chunks.push(this.ensureCapacity(requiredRows));

    // Move to live top.
    chunks.push(cursorUp(this.cursorRow));
    this.cursorRow = 0;

    // Clear all capacity rows, then write frame rows.
    for (let i = 0; i < this.liveRegionCapacity; i++) {
      chunks.push(CR, EL2);
      if (i < this.liveRegionCapacity - 1) chunks.push(cursorDown(1));
    }
    // Back to top.
    chunks.push(cursorUp(this.liveRegionCapacity - 1));

    // Write frame rows.
    for (let r = 0; r < Math.min(frame.height, this.liveRegionCapacity); r++) {
      const spans = renderStyledFrameRow(frame.rows[r] ?? []);
      let emittedSgr = false;
      for (const span of spans) {
        const sgr = encodeStyleToSgr(span.style, this.suppressColor);
        if (sgr) {
          chunks.push(sgr);
          emittedSgr = true;
        }
        chunks.push(span.text);
      }
      if (emittedSgr) chunks.push(SGR_RESET);
      if (r < Math.min(frame.height, this.liveRegionCapacity) - 1) {
        chunks.push(CR, cursorDown(1));
      }
    }

    // Position cursor at frame cursor.
    const targetRow = Math.min(frame.cursor.row, this.liveRegionCapacity - 1);
    const targetCol = Math.min(frame.cursor.column, Math.max(0, this.width - 1));
    chunks.push(cursorUp(this.cursorRow));
    chunks.push(cursorDown(targetRow));
    chunks.push(CR);
    if (targetCol > 0) chunks.push(`\x1b[${targetCol}C`);
    this.cursorRow = targetRow;
    this.cursorColumn = targetCol;

    chunks.push(frame.cursor.visible ? SHOW_CURSOR : HIDE_CURSOR);
    chunks.push(ENABLE_AUTOWRAP);

    this.previousFrame = frame;
    return chunks.join('');
  }

  /** Ensure the live region has at least requiredRows capacity (grows only). */
  private ensureCapacity(requiredRows: number): string {
    const target = Math.min(requiredRows, Math.max(1, this.height - 1));
    const chunks: string[] = [];
    while (this.liveRegionCapacity < target) {
      chunks.push('\n'); // hard line boundary
      this.liveRegionCapacity += 1;
      this.cursorRow = this.liveRegionCapacity;
    }
    return chunks.join('');
  }

  /** Clear the live region rows (relative, no absolute addressing). */
  private clearLiveRegion(): string {
    const chunks: string[] = [];
    chunks.push(cursorUp(this.cursorRow));
    for (let i = 0; i < this.liveRegionCapacity; i++) {
      chunks.push(CR, EL2);
      if (i < this.liveRegionCapacity - 1) chunks.push(cursorDown(1));
    }
    chunks.push(cursorUp(this.liveRegionCapacity - 1));
    this.cursorRow = 0;
    return chunks.join('');
  }

  /** Resize: only handle live region; committed history goes to terminal reflow. */
  async resize(width: number, height: number, getLatestLiveFrame: LiveFrameProvider): Promise<void> {
    await this.enqueue(async () => {
      this.width = Math.max(1, Math.floor(width));
      this.height = Math.max(1, Math.floor(height));
      // Reset capacity and rebuild live frame.
      this.liveRegionCapacity = 0;
      this.cursorRow = 0;
      this.previousFrame = null;
      const liveFrame = getLatestLiveFrame();
      if (liveFrame) {
        this.writeRaw(this.renderLiveInternal(liveFrame));
      }
    });
  }

  /** Suspend for child process: clear live region, disable bracketed paste, show cursor. */
  async suspend(): Promise<void> {
    await this.enqueue(async () => {
      if (this.phase !== 'mounted') return;
      this.writeRaw(this.clearLiveRegion());
      this.writeRaw(`${SGR_RESET}${SHOW_CURSOR}${DISABLE_BRACKETED_PASTE}${ENABLE_AUTOWRAP}`);
      this.phase = 'suspended';
      this.liveRegionCapacity = 0;
      this.previousFrame = null;
    });
  }

  /** Restore after child process: re-enable bracketed paste, rebuild live frame. */
  async restore(getLatestLiveFrame: LiveFrameProvider): Promise<void> {
    await this.enqueue(async () => {
      if (this.phase !== 'suspended') return;
      this.phase = 'mounted';
      this.writeRaw(`${ENABLE_BRACKETED_PASTE}${HIDE_CURSOR}${DISABLE_AUTOWRAP}`);
      const liveFrame = getLatestLiveFrame();
      if (liveFrame) {
        this.writeRaw(this.renderLiveInternal(liveFrame));
      }
    });
  }

  /** Unmount: clear live region, restore terminal state. Does NOT erase scrollback. */
  async unmount(): Promise<void> {
    await this.enqueue(async () => {
      if (this.phase === 'unmounted') return;
      this.writeRaw(this.clearLiveRegion());
      this.writeRaw(`${SGR_RESET}${SHOW_CURSOR}${DISABLE_BRACKETED_PASTE}${ENABLE_AUTOWRAP}`);
      // Final newline so shell prompt starts on a clean line.
      this.writeRaw('\n');
      this.phase = 'unmounted';
      this.liveRegionCapacity = 0;
      this.previousFrame = null;
    });
  }

  /** Flush: wait for queue to drain. */
  async flush(): Promise<void> {
    while (this.processing || this.queue.length > 0) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  private writeRaw(chunk: string): void {
    if (this.phase === 'failed' || this.phase === 'unmounted') return;
    try {
      this.output.write(chunk);
    } catch {
      this.phase = 'failed';
    }
  }

  /** Reset for tests. */
  reset(): void {
    this.phase = 'idle';
    this.liveRegionCapacity = 0;
    this.cursorRow = 0;
    this.cursorColumn = 0;
    this.previousFrame = null;
    this.queue = [];
    this.processing = false;
  }
}

// ============================================================================
// MemoryOutput: test double for surface tests
// ============================================================================

export class MemoryOutput implements SurfaceOutput {
  chunks: string[] = [];
  writable = true;
  private drainListeners: Array<() => void> = [];

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }

  on(event: 'drain', listener: () => void): this {
    if (event === 'drain') this.drainListeners.push(listener);
    return this;
  }

  off(event: 'drain', listener: () => void): this {
    if (event === 'drain') {
      this.drainListeners = this.drainListeners.filter(l => l !== listener);
    }
    return this;
  }

  text(): string {
    return this.chunks.join('');
  }

  /** Assert output never contains forbidden sequences. */
  assertNoForbidden(): void {
    const text = this.text();
    if (text.includes('\x1b[?1049h')) throw new Error('output contains alternate-screen enter');
    if (text.includes('\x1b[?1049l')) throw new Error('output contains alternate-screen exit');
    if (/\x1b\[\d+;\d+H/.test(text)) throw new Error('output contains absolute cursor positioning');
    if (text.includes('\x1b[2J')) throw new Error('output contains full-screen clear');
  }
}
