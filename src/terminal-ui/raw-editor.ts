import readline from 'readline';
import stringWidth from 'string-width';
import {
  isLikelyUnbracketedMultilinePaste,
  normalizePastedText,
  TuiInputParser,
  type TuiInputEvent,
  type TuiKey,
} from '../tui-core/input-parser';
import { applyTerminalTabCompletion } from './completion';

const BRACKETED_PASTE_ENABLE = '\x1b[?2004h';
const BRACKETED_PASTE_DISABLE = '\x1b[?2004l';

type RawModeStream = NodeJS.ReadStream & {
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => NodeJS.ReadStream;
};

type RawOutputStream = NodeJS.WriteStream & {
  columns?: number;
};

export interface RawTerminalEditorOptions {
  input?: RawModeStream;
  output?: RawOutputStream;
  cwd: string;
  onSubmit: (input: string) => void;
  onCtrlC: () => void;
  onNotice?: (message: string) => void;
}

export class RawTerminalEditor {
  private readonly input: RawModeStream;
  private readonly output: RawOutputStream;
  private readonly parser = new TuiInputParser();
  private value = '';
  private cursor = 0;
  private promptValue = '';
  private questionPrompt: string | null = null;
  private questionResolve: ((answer: string) => void) | null = null;
  private readonly history: string[] = [];
  private historyIndex: number | null = null;
  private historyDraft = '';
  private running = false;
  private wasRaw = false;

  constructor(private readonly options: RawTerminalEditorOptions) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.wasRaw = this.input.isRaw === true;
    this.input.setEncoding('utf8');
    this.input.resume();
    if (this.input.isTTY && typeof this.input.setRawMode === 'function') {
      this.input.setRawMode(true);
    }
    if (this.output.isTTY !== false) {
      this.output.write(BRACKETED_PASTE_ENABLE);
    }
    this.input.on('data', this.handleData);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.input.off('data', this.handleData);
    if (this.output.isTTY !== false) {
      this.output.write(BRACKETED_PASTE_DISABLE);
    }
    if (this.input.isTTY && typeof this.input.setRawMode === 'function') {
      this.input.setRawMode(this.wasRaw);
    }
    if (!this.wasRaw) this.input.pause();
  }

  setPrompt(prompt: string): void {
    this.promptValue = prompt;
    this.render();
  }

  ask(prompt: string, abortSignal?: AbortSignal): Promise<string> {
    if (this.questionResolve) {
      this.questionResolve('');
    }

    this.questionPrompt = prompt;
    this.value = '';
    this.cursor = 0;
    this.render();

    return new Promise(resolve => {
      let settled = false;
      const finish = (answer: string): void => {
        if (settled) return;
        settled = true;
        abortSignal?.removeEventListener('abort', onAbort);
        resolve(answer);
      };
      const onAbort = (): void => {
        this.cancelQuestion();
        finish('');
      };

      this.questionResolve = finish;
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      if (abortSignal?.aborted) onAbort();
    });
  }

  cancelQuestion(): void {
    if (!this.questionResolve && !this.questionPrompt) return;
    const resolve = this.questionResolve;
    this.questionPrompt = null;
    this.questionResolve = null;
    this.value = '';
    this.cursor = 0;
    resolve?.('');
    this.render();
  }

  writeExternal(text: string): void {
    if (!text) return;
    this.clearPromptLine();
    this.output.write(text.endsWith('\n') ? text : `${text}\n`);
    this.render();
  }

  feed(chunk: Buffer | string): TuiInputEvent[] {
    const raw = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    if (!this.parser.isPasting() && !this.parser.hasPendingEscape() && isLikelyUnbracketedMultilinePaste(raw)) {
      const event: TuiInputEvent = { type: 'paste', value: normalizePastedText(raw) };
      this.applyEvent(event);
      return [event];
    }

    const events = this.parser.feed(chunk);
    for (const event of events) {
      this.applyEvent(event);
    }
    return events;
  }

  getBuffer(): { value: string; cursor: number } {
    return { value: this.value, cursor: this.cursor };
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    this.feed(chunk);
  };

  private applyEvent(event: TuiInputEvent): void {
    if (event.type === 'text' || event.type === 'paste') {
      this.insert(event.value);
      if (event.type === 'paste') {
        this.emitPasteNotice(event.value);
      }
      return;
    }
    this.applyKey(event.key);
  }

  private emitPasteNotice(value: string): void {
    const lines = normalizePastedText(value).split('\n').length;
    if (lines < 2) return;
    const suffix = lines >= 20 ? ' /edit is better for very long drafts.' : '';
    this.options.onNotice?.(`Pasted ${lines} lines. Enter sends once; Ctrl+U clears.${suffix}`);
  }

  private applyKey(key: TuiKey): void {
    switch (key) {
      case 'enter':
        this.submit();
        return;
      case 'tab':
        this.setValue(applyTerminalTabCompletion(`${this.value}\t`, this.options.cwd));
        return;
      case 'backspace':
        this.deleteBeforeCursor();
        return;
      case 'delete':
        this.deleteAfterCursor();
        return;
      case 'left':
        this.cursor = previousBoundary(this.value, this.cursor);
        this.render();
        return;
      case 'right':
        this.cursor = nextBoundary(this.value, this.cursor);
        this.render();
        return;
      case 'home':
        this.cursor = 0;
        this.render();
        return;
      case 'end':
        this.cursor = this.value.length;
        this.render();
        return;
      case 'up':
        this.moveHistory(-1);
        return;
      case 'down':
        this.moveHistory(1);
        return;
      case 'ctrl+u':
        this.setValue('');
        return;
      case 'ctrl+w':
        this.deleteWordBeforeCursor();
        return;
      case 'ctrl+c':
        this.options.onCtrlC();
        return;
      case 'escape':
      case 'pageup':
      case 'pagedown':
        return;
    }
  }

  private insert(text: string): void {
    const safeCursor = clampCursor(this.value, this.cursor);
    this.value = `${this.value.slice(0, safeCursor)}${text}${this.value.slice(safeCursor)}`;
    this.cursor = safeCursor + text.length;
    this.historyIndex = null;
    this.render();
  }

  private submit(): void {
    const submitted = this.value;
    this.output.write('\n');
    this.value = '';
    this.cursor = 0;
    this.historyIndex = null;
    this.historyDraft = '';

    if (this.questionPrompt) {
      const resolve = this.questionResolve;
      this.questionPrompt = null;
      this.questionResolve = null;
      resolve?.(submitted);
      return;
    }

    if (submitted.trim()) {
      this.history.push(submitted);
    }
    this.options.onSubmit(submitted);
  }

  private setValue(value: string): void {
    this.value = value;
    this.cursor = value.length;
    this.historyIndex = null;
    this.render();
  }

  private deleteBeforeCursor(): void {
    const safeCursor = clampCursor(this.value, this.cursor);
    if (safeCursor === 0) return;
    const previous = previousBoundary(this.value, safeCursor);
    this.value = `${this.value.slice(0, previous)}${this.value.slice(safeCursor)}`;
    this.cursor = previous;
    this.render();
  }

  private deleteAfterCursor(): void {
    const safeCursor = clampCursor(this.value, this.cursor);
    if (safeCursor >= this.value.length) return;
    const next = nextBoundary(this.value, safeCursor);
    this.value = `${this.value.slice(0, safeCursor)}${this.value.slice(next)}`;
    this.cursor = safeCursor;
    this.render();
  }

  private deleteWordBeforeCursor(): void {
    const safeCursor = clampCursor(this.value, this.cursor);
    const before = this.value.slice(0, safeCursor).replace(/\s*\S+\s*$/u, '');
    this.value = `${before}${this.value.slice(safeCursor)}`;
    this.cursor = before.length;
    this.render();
  }

  private moveHistory(delta: -1 | 1): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === null) {
      this.historyDraft = this.value;
      this.historyIndex = this.history.length;
    }

    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + delta));
    const next = this.historyIndex === this.history.length
      ? this.historyDraft
      : this.history[this.historyIndex] ?? '';
    this.value = next;
    this.cursor = next.length;
    this.render();
  }

  private render(): void {
    const prompt = this.questionPrompt ?? this.promptValue;
    const width = Math.max(20, this.output.columns || 80);
    const promptCells = stringWidth(stripAnsi(prompt));
    const available = Math.max(1, width - promptCells - 1);
    const displayValue = displayInputValue(this.value);
    const displayCursor = displayInputValue(this.value.slice(0, clampCursor(this.value, this.cursor))).length;
    const window = fitInputWindow(displayValue, displayCursor, available);

    this.clearPromptLine();
    this.output.write(`${prompt}${window.visible}`);
    readline.cursorTo(this.output, Math.min(width - 1, promptCells + window.cursorColumn));
  }

  private clearPromptLine(): void {
    if (this.output.isTTY === false) return;
    readline.cursorTo(this.output, 0);
    readline.clearLine(this.output, 0);
  }
}

function displayInputValue(value: string): string {
  return value.replace(/\n/g, '⏎ ');
}

function fitInputWindow(value: string, cursor: number, available: number): { visible: string; cursorColumn: number } {
  if (stringWidth(value) <= available) {
    return { visible: value, cursorColumn: stringWidth(value.slice(0, cursor)) };
  }

  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  const marker = '‹';
  const markerWidth = stringWidth(marker);
  const afterHead = takeLeftCells(after, Math.min(stringWidth(after), Math.max(0, Math.floor(available / 3))));
  const beforeTail = takeRightCells(before, Math.max(0, available - markerWidth - stringWidth(afterHead)));
  const visible = `${marker}${beforeTail}${afterHead}`;
  return {
    visible,
    cursorColumn: markerWidth + stringWidth(beforeTail),
  };
}

function takeLeftCells(value: string, maxWidth: number): string {
  let output = '';
  for (const char of Array.from(value)) {
    if (stringWidth(`${output}${char}`) > maxWidth) break;
    output += char;
  }
  return output;
}

function takeRightCells(value: string, maxWidth: number): string {
  let output = '';
  for (const char of Array.from(value).reverse()) {
    if (stringWidth(`${char}${output}`) > maxWidth) break;
    output = `${char}${output}`;
  }
  return output;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
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
    const boundaries = [0];
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
