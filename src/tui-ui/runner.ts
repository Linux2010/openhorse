import { renderFrameRows, type TuiFrame } from '../tui-core/frame';
import type { StyledRow, TuiTheme } from '../tui-core/style';
import {
  isLikelyUnbracketedMultilinePaste,
  normalizePastedText,
  TuiInputParser,
  type TuiInputEvent,
  type TuiKey,
} from '../tui-core/input-parser';
import type { UiEventSink } from '../runtime/ui-events';
import { getCommands } from '../commands';
import {
  measureTuiLiveFrameHeight,
  renderTuiLiveFrame,
  renderTuiUiFrame,
} from './layout';
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
  pendingCommitRecords,
  tuiUiReducer,
  type TuiUiAction,
  type TuiTranscriptRecord,
  type TuiUiState,
} from './state';
import { TranscriptLayoutCache } from './transcript-cache';
import { layoutTranscriptEntry } from './transcript-layout';
import {
  DEFAULT_TUI_THEME_ID,
  resolveTuiTheme,
  type ResolvedTuiTheme,
} from './theme';
import {
  initialHistoryState,
  historyCurrentValue,
  historyNext,
  historyPrevious,
  pushHistoryEntry,
  type InputHistoryState,
} from '../runtime/composer/history';

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
  /** Fatal surface failures must restore terminal ownership and stop the renderer. */
  onSurfaceError?: (error: unknown) => void;
  /** Immutable transcript theme for this runner instance. */
  theme?: TuiTheme;
  themeId?: string;
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
  private readonly transcriptCache = new TranscriptLayoutCache();
  private readonly theme: ResolvedTuiTheme;
  private readonly themeId: string;
  private history: InputHistoryState = initialHistoryState;
  private surfaceFailed = false;
  private state: TuiUiState = initialTuiUiState;
  private width: number;
  private height: number;
  private lastFrame: TuiFrame | null = null;
  private surfaceResizePending = false;
  private resizeEpoch = 0;
  private surfaceResizeGeneration = 0;
  readonly counters: TuiRunnerCounters = { layoutCount: 0, paintCount: 0, changedRows: 0, commitCount: 0 };

  constructor(private readonly options: TuiRunnerOptions) {
    this.width = options.width;
    this.height = options.height;
    this.surface = options.surface ?? null;
    this.theme = resolveTuiTheme(options.theme);
    this.themeId = options.themeId ?? DEFAULT_TUI_THEME_ID;
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

  /** Stop stale-width paints as soon as the terminal reports SIGWINCH. */
  beginResize(width = this.width): void {
    if (!this.surface || this.surfaceFailed) return;
    this.surfaceResizePending = true;
    this.resizeEpoch += 1;
    this.surfaceResizeGeneration = this.surface.beginResize(width);
  }

  resize(width: number, height: number): void {
    this.beginResize(width);
    const resizeEpoch = this.resizeEpoch;
    const surfaceResizeGeneration = this.surfaceResizeGeneration;
    this.width = width;
    this.height = height;
    // Invalidate transcript cache on resize so committed entries are re-laid-out
    // at the new width.
    this.transcriptCache.invalidate(
      this.state.transcriptGeneration,
      this.transcriptWidth,
      this.themeId,
    );
    if (this.surface && !this.surfaceFailed) {
      // Surface resize is async (serialized FIFO); fire-and-forget is safe
      // because subsequent renders go through the surface queue too.
      void this.surface
        .resize(width, height, () => {
          const frame = this.buildLiveFrame(width);
          this.lastFrame = frame;
          this.counters.layoutCount += 1;
          this.counters.paintCount += 1;
          return frame;
        }, surfaceResizeGeneration)
        .then(() => {
          if (resizeEpoch !== this.resizeEpoch) return;
          this.surfaceResizePending = false;
          this.tryCommit(this.state, true);
          this.scheduler.request('immediate');
          this.scheduler.flush();
        })
        .catch(error => this.handleSurfaceError(error));
      return;
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
      ...this.transcriptLayoutOptions(),
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
    if (this.surface && !this.surfaceFailed) {
      if (this.surfaceResizePending) return;
      this.counters.layoutCount += 1;
      // Production path: render only the live region for inline surface.
      const frame = this.buildLiveFrame(this.width);
      this.lastFrame = frame;
      this.counters.paintCount += 1;
      // Surface renderLive is async (serialized FIFO), but for production use
      // we fire-and-forget because the next render will also go through the queue.
      void this.surface.renderLive(frame).catch(error => this.handleSurfaceError(error));
    } else {
      this.counters.layoutCount += 1;
      // Test path (no surface): render the full frame so getLastFrame() /
      // getVisibleRows() return complete content including committed transcript.
      const frame = renderTuiUiFrame(this.state, {
        width: this.width,
        height: this.height,
        ...this.transcriptLayoutOptions(),
      });
      this.lastFrame = frame;
      this.counters.paintCount += 1;
    }
  }

  /** Build a compact live-region frame that grows only for active content. */
  private buildLiveFrame(terminalWidth: number): TuiFrame {
    const width = this.surface
      ? Math.max(1, Math.floor(terminalWidth) - 1)
      : Math.max(1, Math.floor(terminalWidth));
    const height = this.surface
      ? measureTuiLiveFrameHeight(
        this.state,
        width,
        this.surface.getLiveBandRows(),
        this.transcriptLayoutOptions(),
      )
      : this.height - 1;
    return renderTuiLiveFrame(this.state, {
      width,
      height,
      ...this.transcriptLayoutOptions(),
    });
  }

  /**
   * Try to commit any newly-finalized transcript entries to scrollback.
   * Called after each dispatch. Only commits entries that are committable
   * but not yet queued.
   */
  private tryCommit(prevState: TuiUiState, force = false): void {
    if (!this.surface || this.surfaceResizePending) return;

    const prevCommittable = prevState.committableTranscriptCount;
    const currCommittable = this.state.committableTranscriptCount;
    const generationChanged = this.state.transcriptGeneration !== prevState.transcriptGeneration;

    if (!force && !generationChanged && currCommittable <= prevCommittable) return;
    if (currCommittable <= this.state.queuedTranscriptCount) return;

    // Gather entries to commit: from queued boundary to new committable boundary.
    const entriesToCommit = pendingCommitRecords(this.state);
    if (entriesToCommit.length === 0) return;

    // Advance the queued boundary so we don't double-commit.
    this.state = markTranscriptQueued(this.state, entriesToCommit.length);

    // Build the commit batch.
    const committedEntries: CommittedEntry[] = entriesToCommit.map(entry => ({
      displayKey: entry.id,
      rows: this.layoutTranscriptRecord(entry, this.transcriptWidth),
    }));

    const batch: TranscriptCommitBatch = {
      generation: this.state.transcriptGeneration,
      reason: 'finalize',
      entries: committedEntries,
    };

    // The LiveFrameProvider ensures the live frame is rebuilt after commit
    // with the latest state (where committed entries are no longer in the
    // live region).
    const generation = batch.generation;
    const getLatestLiveFrame: LiveFrameProvider = () => this.buildLiveFrame(this.width);

    // Surface commit is async (serialized FIFO). Fire-and-forget: the
    // commit's internal getLatestLiveFrame already rebuilds the live region,
    // so no additional scheduler paint is needed here.
    void this.surface
      .commit(batch, getLatestLiveFrame)
      .then(() => {
        if (this.state.transcriptGeneration !== generation) return;
        this.state = markTranscriptCommitted(this.state, entriesToCommit.length);
        this.counters.commitCount += 1;
      })
      .catch(error => this.handleSurfaceError(error));
  }

  /** Layout a transcript record once per revision/width/theme combination. */
  private layoutTranscriptRecord(entry: TuiTranscriptRecord, width: number): StyledRow[] {
    const cached = this.transcriptCache.get(
      entry.id,
      entry.revision,
      this.state.transcriptGeneration,
      width,
      this.themeId,
    );
    if (cached) return cached;

    const rows = layoutTranscriptEntry(entry, { width, theme: this.theme });
    this.transcriptCache.set(
      entry.id,
      entry.revision,
      rows,
      this.state.transcriptGeneration,
      width,
      this.themeId,
    );
    return rows;
  }

  private get transcriptWidth(): number {
    return this.surface
      ? Math.max(1, this.width - 1)
      : Math.max(1, this.width);
  }

  private transcriptLayoutOptions() {
    return {
      transcriptWidth: this.transcriptWidth,
      theme: this.theme,
      layoutTranscriptRecord: (entry: TuiTranscriptRecord, width: number) => (
        this.layoutTranscriptRecord(entry, width)
      ),
    };
  }

  private handleSurfaceError(error: unknown): void {
    if (this.surfaceFailed) return;
    this.surfaceFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    this.state = tuiUiReducer(this.state, {
      type: 'setStatus',
      message: `TUI output error: ${message}`,
    });
    this.options.onSurfaceError?.(error);
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
      case 'newline':
        this.updatePrompt(insertAtCursor(value, cursor, '\n'));
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
        this.moveCursorLineHome();
        return;
      case 'end':
        this.moveCursorLineEnd();
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
        this.moveCursorUpOrHistory();
        return;
      case 'down':
        this.moveCursorDownOrHistory();
        return;
    }
  }

  /** Navigate to previous history entry. */
  private historyBack(): void {
    if (this.state.overlay) return; // overlay handles up/down itself
    const { value, cursor } = this.state.prompt;
    const next = historyPrevious(this.history, value);
    this.history = next;
    const displayValue = historyCurrentValue(next, value);
    this.dispatch({ type: 'setPrompt', value: displayValue, cursor: displayValue.length });
  }

  /** Navigate to next history entry (or back to draft). */
  private historyForward(): void {
    if (this.state.overlay) return;
    const { value } = this.state.prompt;
    const next = historyNext(this.history);
    this.history = next;
    const displayValue = historyCurrentValue(next, value);
    this.dispatch({ type: 'setPrompt', value: displayValue, cursor: displayValue.length });
  }

  /**
   * Up in a multi-line prompt moves the cursor to the previous visual line;
   * only at the first line does it fall back to command history (matching
   * shell/editor behaviour). Single-line prompts behave exactly as before.
   */
  private moveCursorUpOrHistory(): void {
    if (this.state.overlay) return;
    const { value, cursor } = this.state.prompt;
    const { line, col } = lineColOfCursor(value, cursor);
    if (line > 0) {
      this.dispatch({ type: 'setPrompt', value, cursor: cursorOfLineCol(value, line - 1, col) });
    } else {
      this.historyBack();
    }
  }

  /**
   * Down in a multi-line prompt moves the cursor to the next visual line;
   * only at the last line does it fall back to command history.
   */
  private moveCursorDownOrHistory(): void {
    if (this.state.overlay) return;
    const { value, cursor } = this.state.prompt;
    const lines = value.split('\n');
    const { line, col } = lineColOfCursor(value, cursor);
    if (line < lines.length - 1) {
      this.dispatch({ type: 'setPrompt', value, cursor: cursorOfLineCol(value, line + 1, col) });
    } else {
      this.historyForward();
    }
  }

  /** Home: move to the start of the current visual line (not whole buffer). */
  private moveCursorLineHome(): void {
    if (this.state.overlay) return;
    const { value, cursor } = this.state.prompt;
    const { line } = lineColOfCursor(value, cursor);
    this.dispatch({ type: 'setPrompt', value, cursor: cursorOfLineCol(value, line, 0) });
  }

  /** End: move to the end of the current visual line (not whole buffer). */
  private moveCursorLineEnd(): void {
    if (this.state.overlay) return;
    const { value, cursor } = this.state.prompt;
    const { line } = lineColOfCursor(value, cursor);
    const lines = value.split('\n');
    this.dispatch({ type: 'setPrompt', value, cursor: cursorOfLineCol(value, line, lines[line].length) });
  }

  private submitPrompt(options: { allowEmpty?: boolean } = {}): void {
    const input = this.state.prompt.value;
    if (!input.trim() && !options.allowEmpty) return;
    // Push to history before clearing.
    this.history = pushHistoryEntry(this.history, input);
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

/** Map an absolute character cursor to {line, col} within a multi-line value. */
function lineColOfCursor(value: string, cursor: number): { line: number; col: number } {
  const lines = value.split('\n');
  const safeCursor = clampCursor(value, cursor);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length;
    if (safeCursor <= offset + lineLen) {
      return { line: i, col: safeCursor - offset };
    }
    offset += lineLen + 1; // +1 for the newline separator
  }
  const last = lines.length - 1;
  return { line: last, col: lines[last].length };
}

/** Map a {line, col} back to an absolute character cursor within a multi-line value. */
function cursorOfLineCol(value: string, line: number, col: number): number {
  const lines = value.split('\n');
  const safeLine = Math.max(0, Math.min(line, lines.length - 1));
  let offset = 0;
  for (let i = 0; i < safeLine; i++) {
    offset += lines[i].length + 1;
  }
  return offset + Math.max(0, Math.min(col, lines[safeLine].length));
}
