import { renderFrameRows, type TuiFrame } from '../tui-core/frame';
import {
  isLikelyUnbracketedMultilinePaste,
  normalizePastedText,
  TuiInputParser,
  type TuiInputEvent,
  type TuiKey,
} from '../tui-core/input-parser';
import { TuiTerminalWriter, type TuiTerminalRenderResult } from '../tui-core/terminal-writer';
import type { UiEventSink } from '../runtime/ui-events';
import { getCommands } from '../commands';
import { renderTuiUiFrame } from './layout';
import { getFileQuery, visibleCommandItems, visibleFileItems, type TuiPickerItem } from './pickers';
import {
  createTuiUiEventSink,
  initialTuiUiState,
  tuiUiReducer,
  type TuiUiAction,
  type TuiUiState,
} from './state';

export interface TuiRunnerOptions {
  output: Pick<NodeJS.WriteStream, 'write'>;
  width: number;
  height: number;
  cwd?: string;
  onSubmit?: (input: string) => void | Promise<void>;
  onCtrlC?: () => void;
  onPermissionDecision?: (requestId: string, approved: boolean) => void | Promise<void>;
}

export class TuiRunner {
  readonly events: UiEventSink;
  private readonly parser = new TuiInputParser();
  private readonly writer: TuiTerminalWriter;
  private state: TuiUiState = initialTuiUiState;
  private width: number;
  private height: number;
  private lastFrame: TuiFrame | null = null;
  private lastRenderResult: TuiTerminalRenderResult | null = null;

  constructor(private readonly options: TuiRunnerOptions) {
    this.width = options.width;
    this.height = options.height;
    this.writer = new TuiTerminalWriter(options.output);
    this.events = createTuiUiEventSink(action => this.dispatch(action));
    this.render();
  }

  getState(): TuiUiState {
    return this.state;
  }

  getLastFrame(): TuiFrame | null {
    return this.lastFrame;
  }

  getLastRenderResult(): TuiTerminalRenderResult | null {
    return this.lastRenderResult;
  }

  getVisibleRows(): string[] {
    return this.lastFrame ? renderFrameRows(this.lastFrame) : [];
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.writer.reset();
    this.render();
  }

  dispatch(action: TuiUiAction): void {
    this.state = tuiUiReducer(this.state, action);
    this.render();
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

  render(): TuiTerminalRenderResult {
    const frame = renderTuiUiFrame(this.state, {
      width: this.width,
      height: this.height,
    });
    const result = this.writer.render(frame);
    this.lastFrame = frame;
    this.lastRenderResult = result;
    return result;
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
        return;
      case 'pageup':
        this.dispatch({ type: 'scrollTranscript', delta: Math.max(1, this.height - 5) });
        return;
      case 'pagedown':
        this.dispatch({ type: 'scrollTranscript', delta: -Math.max(1, this.height - 5) });
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
