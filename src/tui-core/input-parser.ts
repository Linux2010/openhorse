export type TuiInputEvent =
  | { type: 'text'; value: string }
  | { type: 'paste'; value: string }
  | { type: 'key'; key: TuiKey; raw: string };

export type TuiKey =
  | 'enter'
  | 'tab'
  | 'escape'
  | 'backspace'
  | 'delete'
  | 'ctrl+c'
  | 'ctrl+u'
  | 'ctrl+w'
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown';

export interface TuiInputParserState {
  mode: 'normal' | 'paste';
  incompleteUtf8: Buffer;
  pasteBuffer: string;
  pendingEscape: string;
}

export const initialTuiInputParserState: TuiInputParserState = {
  mode: 'normal',
  incompleteUtf8: Buffer.alloc(0),
  pasteBuffer: '',
  pendingEscape: '',
};

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

const CSI_KEYS: Record<string, TuiKey> = {
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  '\x1b[H': 'home',
  '\x1b[F': 'end',
  '\x1b[1~': 'home',
  '\x1b[4~': 'end',
  '\x1b[5~': 'pageup',
  '\x1b[6~': 'pagedown',
  '\x1b[3~': 'delete',
};

export class TuiInputParser {
  private state: TuiInputParserState = {
    mode: initialTuiInputParserState.mode,
    incompleteUtf8: initialTuiInputParserState.incompleteUtf8,
    pasteBuffer: initialTuiInputParserState.pasteBuffer,
    pendingEscape: initialTuiInputParserState.pendingEscape,
  };

  reset(): void {
    this.state = {
      mode: 'normal',
      incompleteUtf8: Buffer.alloc(0),
      pasteBuffer: '',
      pendingEscape: '',
    };
  }

  isPasting(): boolean {
    return this.state.mode === 'paste';
  }

  hasPendingEscape(): boolean {
    return this.state.pendingEscape.length > 0;
  }

  feed(chunk: Buffer | string): TuiInputEvent[] {
    const { complete, incomplete } = splitCompleteUtf8(
      Buffer.concat([
        this.state.incompleteUtf8,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'),
      ])
    );
    this.state.incompleteUtf8 = incomplete;

    if (complete.length === 0) return [];

    const text = this.state.pendingEscape + complete.toString('utf8');
    this.state.pendingEscape = '';
    const events: TuiInputEvent[] = [];
    let index = 0;

    const emitText = (value: string): void => {
      if (!value) return;
      if (this.state.mode === 'paste') {
        this.state.pasteBuffer += value;
      } else {
        events.push({ type: 'text', value });
      }
    };

    while (index < text.length) {
      const slice = text.slice(index);

      if (slice.startsWith(PASTE_START)) {
        this.state.mode = 'paste';
        this.state.pasteBuffer = '';
        index += PASTE_START.length;
        continue;
      }

      if (slice.startsWith(PASTE_END)) {
        if (this.state.mode === 'paste') {
          events.push({ type: 'paste', value: normalizePastedText(this.state.pasteBuffer) });
        }
        this.state.mode = 'normal';
        this.state.pasteBuffer = '';
        index += PASTE_END.length;
        continue;
      }

      const csiKey = readCsiKey(slice);
      if (csiKey) {
        if (this.state.mode === 'paste') {
          this.state.pasteBuffer += csiKey.raw;
        } else {
          events.push({ type: 'key', key: csiKey.key, raw: csiKey.raw });
        }
        index += csiKey.raw.length;
        continue;
      }

      const incompleteEscapePrefix = readIncompleteEscapePrefix(slice);
      if (incompleteEscapePrefix) {
        this.state.pendingEscape = incompleteEscapePrefix;
        break;
      }

      const char = text[index];
      if (char === '\x1b') {
        if (index === text.length - 1) {
          this.state.pendingEscape = '\x1b';
        } else {
          events.push({ type: 'key', key: 'escape', raw: '\x1b' });
        }
        index += 1;
        continue;
      }

      if (this.state.mode === 'paste') {
        const codePoint = text.codePointAt(index);
        if (codePoint === undefined) break;
        const value = String.fromCodePoint(codePoint);
        this.state.pasteBuffer += value;
        index += value.length;
        continue;
      }

      const control = controlKeyFromChar(char);
      if (control) {
        events.push({ type: 'key', key: control, raw: char });
        index += 1;
        continue;
      }

      const codePoint = text.codePointAt(index);
      if (codePoint === undefined) break;
      const value = String.fromCodePoint(codePoint);
      emitText(value);
      index += value.length;
    }

    return coalesceTextEvents(events);
  }
}

function readIncompleteEscapePrefix(value: string): string | null {
  if (!value.startsWith('\x1b')) return null;

  const knownSequences = [PASTE_START, PASTE_END, ...Object.keys(CSI_KEYS)];
  return knownSequences.some(sequence => sequence.startsWith(value)) ? value : null;
}

function readCsiKey(value: string): { key: TuiKey; raw: string } | null {
  for (const [raw, key] of Object.entries(CSI_KEYS)) {
    if (value.startsWith(raw)) return { key, raw };
  }
  return null;
}

function controlKeyFromChar(char: string): TuiKey | null {
  switch (char) {
    case '\r':
    case '\n':
      return 'enter';
    case '\t':
      return 'tab';
    case '\x7f':
    case '\b':
      return 'backspace';
    case '\x03':
      return 'ctrl+c';
    case '\x15':
      return 'ctrl+u';
    case '\x17':
      return 'ctrl+w';
    default:
      return null;
  }
}

function coalesceTextEvents(events: TuiInputEvent[]): TuiInputEvent[] {
  const coalesced: TuiInputEvent[] = [];
  for (const event of events) {
    const previous = coalesced[coalesced.length - 1];
    if (event.type === 'text' && previous?.type === 'text') {
      previous.value += event.value;
    } else {
      coalesced.push(event);
    }
  }
  return coalesced;
}

export function normalizePastedText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function isLikelyUnbracketedMultilinePaste(value: string): boolean {
  if (!value || value.includes('\x1b')) {
    return false;
  }

  const normalized = normalizePastedText(value);
  if (!normalized.includes('\n')) return false;

  // Keep ordinary typed "text + Enter" behavior intact. Treat it as paste only
  // when there is content after a newline or more than one newline in the chunk.
  return /\n[^\n]/u.test(normalized) || (normalized.match(/\n/g)?.length ?? 0) > 1;
}

function splitCompleteUtf8(input: Buffer): { complete: Buffer; incomplete: Buffer } {
  if (input.length === 0) {
    return { complete: input, incomplete: Buffer.alloc(0) };
  }

  let start = input.length - 1;
  while (start >= 0 && (input[start] & 0xc0) === 0x80) {
    start -= 1;
  }

  if (start < 0) {
    return { complete: Buffer.alloc(0), incomplete: input };
  }

  const expected = utf8SequenceLength(input[start]);
  if (expected === 0) {
    return { complete: input, incomplete: Buffer.alloc(0) };
  }

  const available = input.length - start;
  if (available < expected) {
    return {
      complete: input.subarray(0, start),
      incomplete: input.subarray(start),
    };
  }

  return { complete: input, incomplete: Buffer.alloc(0) };
}

function utf8SequenceLength(byte: number): number {
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 0;
}
