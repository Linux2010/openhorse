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
  /** Height of the bottom live band. */
  liveBandRows: number;
  /** Rows reserved for the live region (equals liveBandRows once anchored). */
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

/** Fraction of the terminal height occupied by the bottom live band. */
const LIVE_BAND_RATIO = 0.75;

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
  /** Height of the bottom live band (status + prompt + live tail). */
  private liveBandRows = 0;
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

  /** Compute the live band height (~75% of screen, min 8, max height-1). */
  private static computeBandRows(height: number): number {
    const h = Math.max(1, Math.floor(height));
    const minBand = 8;
    const maxBand = Math.max(minBand, h - 1); // leave >=1 history row when possible
    const desired = Math.round(h * LIVE_BAND_RATIO);
    return Math.max(minBand, Math.min(maxBand, desired));
  }

  /** Live band height for the runner to size its live frame. */
  getLiveBandRows(): number {
    return this.liveBandRows;
  }

  /** History area rows above the band (recently scrolled committed lines). */
  get historyAreaRows(): number {
    return Math.max(0, this.height - this.liveBandRows);
  }

  getState(): InlineSurfaceState {
    return {
      phase: this.phase,
      width: this.width,
      height: this.height,
      liveBandRows: this.liveBandRows,
      liveRegionCapacity: this.liveRegionCapacity,
      cursorRow: this.cursorRow,
      cursorColumn: this.cursorColumn,
      previousFrame: this.previousFrame,
    };
  }

  /**
   * Await completion of all queued operations.
   * Because the queue is strictly FIFO, enqueueing a no-op and awaiting it
   * guarantees every operation enqueued before this call has finished. Used by
   * tests to deterministically observe the terminal after a burst of renders.
   */
  whenIdle(): Promise<void> {
    return this.enqueue(async () => {});
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
    // Re-check in case an enqueue happened during the last op's async yield.
    if (this.queue.length > 0) {
      void this.drainQueue();
    }
  }

  /** Mount: enable bracketed paste + hide cursor. NO alternate screen. */
  async mount(width: number, height: number): Promise<void> {
    await this.enqueue(async () => {
      if (this.phase !== 'idle') return;
      this.width = Math.max(1, Math.floor(width));
      this.height = Math.max(1, Math.floor(height));
      this.liveBandRows = InlineTerminalSurface.computeBandRows(this.height);
      this.phase = 'mounted';
      this.liveRegionCapacity = 0;
      this.cursorRow = 0;
      this.cursorColumn = 0;
      this.writeRaw(`${ENABLE_BRACKETED_PASTE}${HIDE_CURSOR}`);
    });
  }

  /**
   * Commit finalized transcript entries to native scrollback.
   *
   * Protocol (each committed line scrolls into the terminal's native
   * scrollback, exactly like ordinary shell output):
   *  1. Move the cursor to the bottom of the screen (band bottom = height-1).
   *  2. Write each committed row at column 0, terminated by a hard `\n`.
   *     Because the cursor sits on the last screen row, every `\n` scrolls
   *     that row into scrollback and re-pins the cursor at the bottom. This is
   *     what makes committed history accumulate in native scrollback (scroll up
   *     to review) rather than being overwritten by the live band.
   *  3. Move the cursor back to the band top and rebuild the live frame
   *     (clear + repaint the band only; the history area above is owned by the
   *     terminal's own scrollback and is never cleared).
   */
  async commit(batch: TranscriptCommitBatch, getLatestLiveFrame: LiveFrameProvider): Promise<TuiTerminalRenderResult> {
    let output = '';
    await this.enqueue(async () => {
      const chunks: string[] = [];
      // 1. Move to the screen bottom (band bottom). cursorRow is relative to
      //    the band top, so bandRows-1 is the bottom.
      const toBottom = this.liveBandRows - 1 - this.cursorRow;
      if (toBottom > 0) chunks.push(cursorDown(toBottom));
      this.cursorRow = this.liveBandRows - 1;
      // 2. Write each committed row at the bottom; the trailing `\n` scrolls
      //    the row into native scrollback.
      for (const entry of batch.entries) {
        for (const row of entry.rows) {
          chunks.push(CR); // return to column 0
          for (const span of row) {
            if (span.style) {
              const sgr = encodeStyleToSgr(span.style, this.suppressColor);
              if (sgr) chunks.push(sgr);
            }
            chunks.push(span.text);
          }
          chunks.push(SGR_RESET);
          chunks.push('\n'); // hard line boundary -> scrolls into scrollback
        }
      }
      // Cursor is pinned at the screen bottom (bandRows-1) after the scrolls.
      this.cursorRow = this.liveBandRows - 1;
      // 3. Move to band top and rebuild the live frame (band only).
      this.liveRegionCapacity = this.liveBandRows; // band is anchored
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
    const requiredRows = Math.min(frame.height, Math.max(1, this.liveBandRows));

    // Ensure the band is anchored (first call scrolls to the screen bottom).
    chunks.push(this.ensureCapacity(requiredRows));

    // Disable autowrap while painting band rows: a row that fills the last
    // column (e.g. the full-width prompt border ┌─...─┐) would otherwise leave
    // the terminal in a pending-wrap state that corrupts the next row's
    // repaint. Re-enabled at the end of the batch.
    chunks.push(DISABLE_AUTOWRAP);

    // Move to band top. `this.cursorRow` is the authoritative real-cursor row
    // relative to the band top, maintained across commits/renders.
    chunks.push(cursorUp(this.cursorRow));
    let row = 0;

    // Clear all band rows, then write frame rows. Track the real cursor
    // row in `row` so the final positioning block below is exact.
    for (let i = 0; i < this.liveRegionCapacity; i++) {
      chunks.push(CR, EL2);
      if (i < this.liveRegionCapacity - 1) {
        chunks.push(cursorDown(1));
        row += 1;
      }
    }
    // Back to band top.
    chunks.push(cursorUp(this.liveRegionCapacity - 1));
    row = 0;

    // Write frame rows.
    const frameRows = Math.min(frame.height, this.liveRegionCapacity);
    for (let r = 0; r < frameRows; r++) {
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
      if (r < frameRows - 1) {
        chunks.push(CR, cursorDown(1));
        row += 1;
      }
    }

    // Position cursor at frame cursor using the precisely-tracked `row`.
    const targetRow = Math.min(frame.cursor.row, this.liveRegionCapacity - 1);
    const targetCol = Math.min(frame.cursor.column, Math.max(0, this.width - 1));
    if (targetRow < row) {
      chunks.push(cursorUp(row - targetRow));
      row = targetRow;
    } else if (targetRow > row) {
      chunks.push(cursorDown(targetRow - row));
      row = targetRow;
    }
    chunks.push(CR);
    if (targetCol > 0) chunks.push(`\x1b[${targetCol}C`);
    this.cursorRow = row;
    this.cursorColumn = targetCol;

    chunks.push(frame.cursor.visible ? SHOW_CURSOR : HIDE_CURSOR);
    chunks.push(ENABLE_AUTOWRAP);

    this.previousFrame = frame;
    return chunks.join('');
  }

  /**
   * Ensure the live band is anchored to the screen bottom (first call / after
   * resize) and has at least `requiredRows` capacity (capped at liveBandRows).
   *
   * Re-anchoring: first scrub the whole visible screen with per-row EL2
   * (relative addressing - no 2J) so resize reflow ghosts (e.g. an old prompt
   * border left in the history area) cannot linger. Then advance the cursor to
   * the last screen row with `height-1` newlines; from the now-clean top this
   * lands on the bottom without adding blank lines to scrollback. After
   * anchoring, `liveRegionCapacity == liveBandRows` and
   * `cursorRow == liveBandRows-1` (band bottom == screen bottom).
   */
  private ensureCapacity(requiredRows: number): string {
    const target = Math.min(requiredRows, Math.max(1, this.liveBandRows));
    const chunks: string[] = [];
    if (this.liveRegionCapacity === 0) {
      // Scrub the whole visible screen (relative; ghosts from resize reflow).
      chunks.push(this.clearVisibleScreen());
      // Anchor the band to the screen bottom.
      for (let i = 0; i < this.height - 1; i++) chunks.push('\n');
      this.liveRegionCapacity = this.liveBandRows;
      this.cursorRow = this.liveBandRows - 1;
    }
    // Capacity never grows beyond the fixed band; no further newlines.
    void target;
    return chunks.join('');
  }

  /** Clear the live band rows (relative, no absolute addressing). */
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

  /**
   * Clear every visible screen row (relative addressing only - no 2J, no
   * absolute H). Used on resize to scrub stale ghost content (e.g. old prompt
   * borders) that terminal reflow leaves in the history area above the band.
   * The cleared rows are NOT scrolled into scrollback (EL2 erases in place),
   * so already-committed history in scrollback is preserved.
   */
  private clearVisibleScreen(): string {
    const chunks: string[] = [];
    // Move to the top of the visible screen. We may be anywhere in the band;
    // cursorUp is clamped by the terminal to row 0, so overshooting is safe.
    chunks.push(cursorUp(this.height));
    for (let i = 0; i < this.height; i++) {
      chunks.push(CR, EL2);
      if (i < this.height - 1) chunks.push(cursorDown(1));
    }
    chunks.push(cursorUp(this.height - 1));
    this.cursorRow = 0;
    return chunks.join('');
  }

  /** Resize: recompute band, re-anchor to the new bottom, rebuild live frame. */
  async resize(width: number, height: number, getLatestLiveFrame: LiveFrameProvider): Promise<void> {
    await this.enqueue(async () => {
      this.width = Math.max(1, Math.floor(width));
      this.height = Math.max(1, Math.floor(height));
      this.liveBandRows = InlineTerminalSurface.computeBandRows(this.height);
      // Reset capacity so ensureCapacity re-anchors the band on next render.
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

  /** Flush: wait for queue to drain. Yields to I/O between checks. */
  async flush(): Promise<void> {
    while (this.processing || this.queue.length > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
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
    this.liveBandRows = 0;
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
