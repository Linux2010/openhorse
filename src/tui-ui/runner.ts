import { renderFrameRows, type TuiFrame } from '../tui-core/frame';
import {
  isLikelyUnbracketedMultilinePaste,
  normalizePastedText,
  TuiInputParser,
  type TuiInputEvent,
  type TuiKey,
} from '../tui-core/input-parser';
import type { UiEventSink } from '../runtime/ui-events';
import { getCommands } from '../commands';
import { renderTuiLiveFrame, renderTuiUiFrame } from './layout';
import { getFileQuery, visibleCommandItems, visibleFileItems, type TuiPickerItem } from './pickers';
import {
  InlineTerminalSurface,
  type CommittedEntry,
  type LiveFrameProvider,
  type TranscriptCommitBatch,
} from './inline-surface';
import {
  createTuiRenderScheduler,
  type TuiRenderScheduler,
  type TuiRenderSchedulerDeps,
} from './render-scheduler';
import {
  createTuiUiEventSink,
  initialTuiUiState,
  markTranscriptQueued,
  markTranscriptCommitted,
  pendingCommitEntries,
  tuiUiReducer,
  type TuiUiAction,
  type TuiUiState,
} from './state';
import type { TranscriptEntry } from '../runtime/ui-events';

/** Actions that should use 'stream' priority (FPS-capped). */
const STREAM_ACTIONS: ReadonlySet<string> = new Set([
  'updateTranscript',
  'setStatusSnapshot',
  'setStatus',
  'toolStarted',
  'toolFinished',
  'subtaskEvent',
]);

export interface TuiRunnerOptions {
  output: Pick<NodeJS.WriteStream, 'write'>;
  width: number;
  height: number;
  cwd?: string;
  onSubmit?: (input: string) => void | Promise<void>;
  onCtrlC?: () => void;
  onPermissionDecision?: (requestId: string, approved: boolean) => void | Promise<void>;
  /** Inject scheduler deps for testing (fake timers). */
  schedulerDeps?: Partial<TuiRenderSchedulerDeps>;
  /** Inline surface for committed scrollback + live region rendering. */
  surface?: InlineTerminalSurface;
}

export interface TuiRunnerCounters {
  layoutCount: number;
  paintCount: number;
  changedRows: number;
  commitCount: number;
}

export class TuiRunner {
  readonly events: UiEventSink;
  private readonly parser = new TuiInputParser();
  private readonly scheduler: TuiRenderScheduler;
  private readonly surface: InlineTerminalSurface | null;
  private state: TuiUiState = initialTuiUiState;
  private width: number;
  private height: number;
  private lastFrame: TuiFrame | null = null;
  readonly counters: TuiRunnerCounters = { layoutCount: 0, paintCount: 0, changedRows: 0, commitCount: 0 };

  constructor(private readonly options: TuiRunnerOptions) {
    this.width = options.width;
    this.height = options.height;
    this.surface = options.surface ?? null;
    this.scheduler = createTuiRenderScheduler(
      () => this.renderLive(),
      options.schedulerDeps,
    );
    this.events = createTuiUiEventSink(action => this.dispatch(action));
    // Initial render: paint the live region immediately.
    this.renderLive();
  }

  getState(): TuiUiState {
    return this.state;
  }

  getLastFrame(): TuiFrame | null {
    return this.lastFrame;
  }

  getVisibleRows(): string[] {
    return this.lastFrame ? renderFrameRows(this.lastFrame) : [];
  }

  /** Get the scheduler for external lifecycle management (flush, stop). */
  getScheduler(): TuiRenderScheduler {
    return this.scheduler;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    if (this.surface) {
      // Surface resize is async (serialized FIFO); fire-and-forget is safe
      // because subsequent renders go through the surface queue too.
      void this.surface.resize(width, height, () => this.getLiveFrame());
    }
    this.scheduler.request('immediate');
    this.scheduler.flush();
  }

  dispatch(action: TuiUiAction): void {
    const prevState = this.state;
    this.state = tuiUiReducer(this.state, action);

    // Check if any transcript entries became committable (finalized).
    this.tryCommit(prevState);

    const priority = STREAM_ACTIONS.has(action.type) ? 'stream' : 'immediate';
    this.scheduler.request(priority);
  }

  feedInput(chunk: Buffer | string): TuiInputEvent[] {
    const raw = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    if (isLikelyUnbracketedMultilinePaste(raw)) {
      const event: TuiInputEvent = { type: 'paste', value: normalizePastedText(raw) };
      this.applyInputEvent(event);
      return [event];
    }

    const events = this.parser.feed(chunk);
    for (const event of events) {
      this.applyInputEvent(event);
    }
    return events;
  }

  /**
   * Render the full frame (legacy path for tests without surface).
   * Uses renderTuiUiFrame which includes both static and live transcript.
   */
  renderFullFrame(): TuiFrame {
    this.counters.layoutCount += 1;
    const frame = renderTuiUiFrame(this.state, {
      width: this.width,
      height: this.height,
    });
    this.lastFrame = frame;
    this.counters.paintCount += 1;
    return frame;
  }

  /**
   * Render the live region via InlineTerminalSurface.
   * When surface is available, only ephemeral content (live transcript, overlay,
   * status, prompt) is painted into the live region.
   * When no surface (test mode), renders the full frame including committed
   * transcript so tests can inspect complete content via getLastFrame().
   */
  private renderLive(): void {
    this.counters.layoutCount += 1;
    if (this.surface) {
      // Production path: render only the live region for inline surface.
      const frame = this.getLiveFrame();
      this.lastFrame = frame;
      this.counters.paintCount += 1;
      // Surface renderLive is async (serialized FIFO), but for production use
      // we fire-and-forget because the next render will also go through the queue.
      void this.surface.renderLive(frame);
    } else {
      // Test path (no surface): render the full frame so getLastFrame() /
      // getVisibleRows() return complete content including committed transcript.
      const frame = renderTuiUiFrame(this.state, {
        width: this.width,
        height: this.height,
      });
      this.lastFrame = frame;
      this.counters.paintCount += 1;
    }
  }

  /** Build the live-region frame from current state.
   *  With an inline surface, the frame height is the live band height
   *  (bottom ~75% of the terminal) so committed history scrolls into native
   *  scrollback above the band. Without a surface (test mode), render the full
   *  height minus one row so tests can inspect complete content. */
  private getLiveFrame(): TuiFrame {
    const height = this.surface ? this.surface.getLiveBandRows() : this.height - 1;
    return renderTuiLiveFrame(this.state, {
      width: this.width,
      height,
    });
  }

  /**
   * Try to commit any newly-finalized transcript entries to scrollback.
   * Called after each dispatch. Only commits entries that are committable
   * but not yet queued.
   */
  private tryCommit(prevState: TuiUiState): void {
    if (!this.surface) return;

    const prevCommittable = prevState.committableTranscriptCount;
    const currCommittable = this.state.committableTranscriptCount;

    if (currCommittable <= prevCommittable) return;
    if (currCommittable <= this.state.queuedTranscriptCount) return;

    // Gather entries to commit: from queued boundary to new committable boundary.
    const entriesToCommit = pendingCommitEntries(this.state);
    if (entriesToCommit.length === 0) return;

    // Advance the queued boundary so we don't double-commit.
    this.state = markTranscriptQueued(this.state, entriesToCommit.length);

    // Build the commit batch.
    const committedEntries: CommittedEntry[] = entriesToCommit.map(entry => ({
      displayKey: entry.id,
      rows: this.layoutTranscriptEntry(entry),
    }));

    const batch: TranscriptCommitBatch = {
      generation: this.state.transcriptGeneration,
      reason: 'finalize',
      entries: committedEntries,
    };

    // The LiveFrameProvider ensures the live frame is rebuilt after commit
    // with the latest state (where committed entries are no longer in the
    // live region).
    const getLatestLiveFrame: LiveFrameProvider = () => {
      // Advance the committed boundary after the surface has written.
      this.state = markTranscriptCommitted(this.state, entriesToCommit.length);
      this.counters.commitCount += 1;
      return this.getLiveFrame();
    };

    // Surface commit is async (serialized FIFO). Fire-and-forget: the
    // commit's internal getLatestLiveFrame already rebuilds the live region,
    // so no additional scheduler paint is needed here.
    void this.surface.commit(batch, getLatestLiveFrame);
  }

  /** Layout a single transcript entry into styled rows for surface commit. */
  private layoutTranscriptEntry(entry: TranscriptEntry): { text: string; style?: import('../tui-core/style').TuiStyle }[][] {
    // For now, use simple text rows. The TranscriptLayoutCache will be
    // integrated in P1-3 to avoid re-laying-out committed entries on resize.
    const prefix = transcriptPrefix(entry);
    const lines = entry.content.split('\n');
    const rows: { text: string; style?: import('../tui-core/style').TuiStyle }[][] = [];
    for (let i = 0; i < lines.length; i++) {
      const text = `${i === 0 ? prefix : '  '}${lines[i]}`;
      // Wrap to terminal width; each wrapped segment becomes a row.
      for (const segment of this.wrapToRows(text)) {
        rows.push([{ text: segment }]);
      }
    }
    return rows;
  }

  /** Wrap text to rows respecting terminal width. */
  private wrapToRows(text: string): string[] {
    const width = this.width;
    if (width <= 0) return [''];
    const rows: string[] = [];
    let current = '';
    let currentWidth = 0;
    for (const char of graphemeIterate(text)) {
      const charWidth = Math.max(0, stringWidthFn(char));
      if (currentWidth > 0 && currentWidth + charWidth > width) {
        rows.push(current);
        current = '';
        currentWidth = 0;
      }
      current += char;
      currentWidth += charWidth;
    }
    rows.push(current);
    return rows;
  }

  private applyInputEvent(event: TuiInputEvent): void {
    if (this.state.overlay?.type === 'permission') {
      if (event.type === 'text') {
        const answer = event.value.trim().toLowerCase();
        if (answer === 'y' || answer === 'yes') {
          this.answerPermission(true);
          return;
        }
        if (answer === 'n' || answer === 'no') {
          this.answerPermission(false);
          return;
        }
        return;
      }
      // Ignore paste and non-escape keys during permission overlay
      if (event.type === 'paste') return;
    }

    switch (event.type) {
      case 'text':
      case 'paste':
        if (event.type === 'text' && event.value === '?' && this.state.prompt.value === '') {
          this.dispatch({ type: 'showShortcuts' });
          return;
        }
        this.updatePrompt(insertAtCursor(this.state.prompt.value, this.state.prompt.cursor, event.value));
        return;
      case 'key':
        this.applyKey(event.key);
        return;
    }
  }

  private applyKey(key: TuiKey): void {
    const { value, cursor } = this.state.prompt;
    const overlay = this.state.overlay;

    if (overlay?.type === 'sessions') {
      switch (key) {
        case 'up':
          this.dispatch({ type: 'moveOverlaySelection', delta: -1 });
          return;
        case 'down':
        case 'tab':
          this.dispatch({ type: 'moveOverlaySelection', delta: 1 });
          return;
        case 'pageup':
          this.dispatch({ type: 'moveOverlaySelection', delta: -Math.max(1, overlay.request.maxVisibleItems ?? 10) });
          return;
        case 'pagedown':
          this.dispatch({ type: 'moveOverlaySelection', delta: Math.max(1, overlay.request.maxVisibleItems ?? 10) });
          return;
        case 'enter':
          this.submitPrompt({ allowEmpty: true });
          return;
      }
    }

    if (overlay?.type === 'edit') {
      switch (key) {
        case 'up':
          this.dispatch({ type: 'moveOverlaySelection', delta: -1 });
          return;
        case 'down':
        case 'tab':
          this.dispatch({ type: 'moveOverlaySelection', delta: 1 });
          return;
        case 'pageup':
          this.dispatch({ type: 'moveOverlaySelection', delta: -10 });
          return;
        case 'pagedown':
          this.dispatch({ type: 'moveOverlaySelection', delta: 10 });
          return;
        case 'enter':
        case 'escape':
          this.dispatch({ type: 'closeOverlay' });
          return;
      }
    }

    if (overlay?.type === 'commands') {
      switch (key) {
        case 'up':
          this.dispatch({ type: 'moveOverlaySelection', delta: -1 });
          return;
        case 'down':
          this.dispatch({ type: 'moveOverlaySelection', delta: 1 });
          return;
        case 'pageup':
          this.dispatch({ type: 'moveOverlaySelection', delta: -10 });
          return;
        case 'pagedown':
          this.dispatch({ type: 'moveOverlaySelection', delta: 10 });
          return;
        case 'tab':
          this.completeCommand(overlay.items[overlay.selectedIndex], false);
          return;
        case 'enter':
          this.completeCommand(overlay.items[overlay.selectedIndex], true);
          return;
        case 'escape':
          this.dispatch({ type: 'closeOverlay' });
          return;
      }
    }

    if (overlay?.type === 'files') {
      switch (key) {
        case 'up':
          this.dispatch({ type: 'moveOverlaySelection', delta: -1 });
          return;
        case 'down':
          this.dispatch({ type: 'moveOverlaySelection', delta: 1 });
          return;
        case 'pageup':
          this.dispatch({ type: 'moveOverlaySelection', delta: -10 });
          return;
        case 'pagedown':
          this.dispatch({ type: 'moveOverlaySelection', delta: 10 });
          return;
        case 'tab':
        case 'enter':
          this.completeFile(overlay.items[overlay.selectedIndex]);
          return;
        case 'escape':
          this.dispatch({ type: 'closeOverlay' });
          return;
      }
    }

    if (overlay?.type === 'shortcuts') {
      switch (key) {
        case 'enter':
        case 'escape':
          this.dispatch({ type: 'closeOverlay' });
          return;
      }
    }

    if (overlay?.type === 'permission') {
      switch (key) {
        case 'up':
          this.dispatch({ type: 'moveOverlaySelection', delta: -1 });
          return;
        case 'down':
        case 'tab':
          this.dispatch({ type: 'moveOverlaySelection', delta: 1 });
          return;
        case 'enter':
          this.answerPermission(overlay.selectedIndex === 0);
          return;
        case 'escape':
        case 'ctrl+c':
          this.answerPermission(false);
          return;
      }
      return;
    }

    switch (key) {
      case 'enter':
        this.submitPrompt();
        return;
      case 'backspace':
        this.updatePrompt(deleteBeforeCursor(value, cursor));
        return;
      case 'delete':
        this.updatePrompt(deleteAfterCursor(value, cursor));
        return;
      case 'left':
        this.dispatch({ type: 'setPrompt', value, cursor: previousBoundary(value, cursor) });
        return;
      case 'right':
        this.dispatch({ type: 'setPrompt', value, cursor: nextBoundary(value, cursor) });
        return;
      case 'home':
        this.dispatch({ type: 'setPrompt', value, cursor: 0 });
        return;
      case 'end':
        this.dispatch({ type: 'setPrompt', value, cursor: value.length });
        return;
      case 'ctrl+u':
        this.dispatch({ type: 'setPrompt', value: '', cursor: 0 });
        this.dispatch({ type: 'closeOverlay' });
        return;
      case 'ctrl+w':
        this.updatePrompt(deleteWordBeforeCursor(value, cursor));
        return;
      case 'ctrl+c':
        this.options.onCtrlC?.();
        return;
      case 'escape':
        this.dispatch({ type: 'closeOverlay' });
        return;
      case 'tab':
        if (value.startsWith('/')) {
          this.syncPromptOverlay(value);
        } else if (getFileQuery(value)) {
          this.syncPromptOverlay(value);
        }
        return;
      case 'up':
      case 'down':
        // Inline surface uses shell native scrollback; no manual scroll.
        // These keys will be wired to InputHistory in P0-2.
        return;
    }
  }

  private submitPrompt(options: { allowEmpty?: boolean } = {}): void {
    const input = this.state.prompt.value;
    if (!input.trim() && !options.allowEmpty) return;
    this.dispatch({ type: 'setPrompt', value: '', cursor: 0 });
    try {
      const submission = this.options.onSubmit?.(input);
      if (submission) {
        void submission.catch(() => this.reportSubmitFailure());
      }
    } catch {
      this.reportSubmitFailure();
    }
  }

  private reportSubmitFailure(): void {
    this.events.append({ role: 'error', content: 'Input submission failed.' });
  }

  private updatePrompt(next: { value: string; cursor: number }): void {
    this.dispatch({ type: 'setPrompt', value: next.value, cursor: next.cursor });
    this.syncPromptOverlay(next.value);
  }

  private syncPromptOverlay(value: string): void {
    if (this.state.overlay?.type === 'shortcuts' && value.trim()) {
      this.dispatch({ type: 'closeOverlay' });
    }

    if (value.startsWith('/')) {
      this.dispatch({
        type: 'showCommandPalette',
        query: value.slice(1),
        items: visibleCommandItems(value),
      });
      return;
    }

    const fileQuery = getFileQuery(value);
    if (fileQuery) {
      this.dispatch({
        type: 'showFilePicker',
        base: fileQuery.base,
        query: fileQuery.query,
        items: visibleFileItems(this.options.cwd ?? process.cwd(), value),
      });
      return;
    }

    if (this.state.overlay?.type === 'commands' || this.state.overlay?.type === 'files') {
      this.dispatch({ type: 'closeOverlay' });
    }
  }

  private completeCommand(item: TuiPickerItem | undefined, submitImmediately: boolean): void {
    if (!item) return;
    const command = getCommands().find(candidate => candidate.name === item.value);
    const needsArgs = Boolean(command?.argumentHint || command?.params?.some(param => param.required));
    const value = `/${item.value}${needsArgs ? ' ' : ''}`;
    const promptAlreadyMatchesCommand = this.state.prompt.value.trim() === `/${item.value}`;
    const nextValue = promptAlreadyMatchesCommand ? `/${item.value}` : value;
    this.dispatch({ type: 'closeOverlay' });
    this.dispatch({ type: 'setPrompt', value: nextValue, cursor: nextValue.length });
    if (submitImmediately && (!needsArgs || promptAlreadyMatchesCommand)) {
      this.submitPrompt();
    }
  }

  private completeFile(item: TuiPickerItem | undefined): void {
    if (!item) return;
    const fileQuery = getFileQuery(this.state.prompt.value);
    if (!fileQuery) return;
    const value = `${fileQuery.base}@${item.value}${item.value.endsWith('/') ? '' : ' '}`;
    this.dispatch({ type: 'closeOverlay' });
    this.dispatch({ type: 'setPrompt', value, cursor: value.length });
  }

  private answerPermission(approved: boolean): void {
    const overlay = this.state.overlay;
    if (overlay?.type !== 'permission') return;
    this.dispatch({ type: 'closeOverlay' });
    void this.options.onPermissionDecision?.(overlay.request.id, approved);
  }
}

function transcriptPrefix(entry: TranscriptEntry): string {
  switch (entry.role) {
    case 'user':
      return '› ';
    case 'tool':
      return '• ';
    case 'error':
      return '! ';
    case 'command':
      return '/ ';
    case 'status':
      return '= ';
    case 'assistant':
    case 'system':
    default:
      return '';
  }
}

// Lazy-import stringWidth to avoid top-level ESM side effects in test bundles.
let _stringWidth: ((str: string) => number) | null = null;
function stringWidthFn(str: string): number {
  if (_stringWidth === null) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _stringWidth = require('string-width') as (str: string) => number;
  }
  return _stringWidth!(str);
}

function* graphemeIterate(text: string): Generator<string> {
  const Segmenter = (Intl as any).Segmenter;
  if (Segmenter) {
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
    for (const part of segmenter.segment(text) as Iterable<{ segment: string }>) {
      yield part.segment;
    }
  } else {
    yield* Array.from(text);
  }
}

function insertAtCursor(value: string, cursor: number, text: string): { value: string; cursor: number } {
  const safeCursor = clampCursor(value, cursor);
  return {
    value: value.slice(0, safeCursor) + text + value.slice(safeCursor),
    cursor: safeCursor + text.length,
  };
}

function deleteBeforeCursor(value: string, cursor: number): { value: string; cursor: number } {
  const safeCursor = clampCursor(value, cursor);
  if (safeCursor === 0) return { value, cursor: 0 };
  const previous = previousBoundary(value, safeCursor);
  return {
    value: value.slice(0, previous) + value.slice(safeCursor),
    cursor: previous,
  };
}

function deleteAfterCursor(value: string, cursor: number): { value: string; cursor: number } {
  const safeCursor = clampCursor(value, cursor);
  if (safeCursor >= value.length) return { value, cursor: safeCursor };
  const next = nextBoundary(value, safeCursor);
  return {
    value: value.slice(0, safeCursor) + value.slice(next),
    cursor: safeCursor,
  };
}

function deleteWordBeforeCursor(value: string, cursor: number): { value: string; cursor: number } {
  const safeCursor = clampCursor(value, cursor);
  const before = value.slice(0, safeCursor).replace(/\s*\S+\s*$/u, '');
  return {
    value: before + value.slice(safeCursor),
    cursor: before.length,
  };
}

function previousBoundary(value: string, cursor: number): number {
  const safeCursor = clampCursor(value, cursor);
  let previous = 0;
  for (const boundary of graphemeBoundaries(value)) {
    if (boundary >= safeCursor) break;
    previous = boundary;
  }
  return previous;
}

function nextBoundary(value: string, cursor: number): number {
  const safeCursor = clampCursor(value, cursor);
  for (const boundary of graphemeBoundaries(value)) {
    if (boundary > safeCursor) return boundary;
  }
  return value.length;
}

function graphemeBoundaries(value: string): number[] {
  const Segmenter = (Intl as any).Segmenter;
  if (!Segmenter) {
    const boundaries: number[] = [0];
    let index = 0;
    for (const char of Array.from(value)) {
      index += char.length;
      boundaries.push(index);
    }
    return boundaries;
  }

  const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
  const boundaries = [0];
  for (const part of segmenter.segment(value) as Iterable<{ index: number; segment: string }>) {
    boundaries.push(part.index + part.segment.length);
  }
  return Array.from(new Set(boundaries)).sort((left, right) => left - right);
}

function clampCursor(value: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return value.length;
  return Math.min(Math.max(0, Math.floor(cursor)), value.length);
}
