const PROMPT_CURSOR_RESTORE_DELAY_MS = 0;

interface PromptCursorState {
  enabled: boolean;
  column: number;
  rowsUp: number;
}

let cursorState: PromptCursorState = {
  enabled: false,
  column: 5,
  rowsUp: 2,
};
let cursorOutput: NodeJS.WriteStream = process.stdout;
let pendingCursorRestore: ReturnType<typeof setTimeout> | null = null;
let cursorParked = false;
let parkedRowsUp = 2;

function cancelPendingPromptCursorRestore(): void {
  if (pendingCursorRestore) {
    clearTimeout(pendingCursorRestore);
    pendingCursorRestore = null;
  }
}

function unparkPromptCursor(output: NodeJS.WriteStream = cursorOutput): void {
  if (!cursorParked || output.isTTY === false) {
    cursorParked = false;
    return;
  }

  const rowsDown = Math.max(1, parkedRowsUp);
  output.write(`\r\x1b[${rowsDown}B`);
  cursorParked = false;
}

function writePromptCursor(): void {
  pendingCursorRestore = null;

  if (!cursorState.enabled || cursorOutput.isTTY === false) {
    cursorParked = false;
    return;
  }

  const rowsUp = Math.max(1, cursorState.rowsUp);
  const column = Math.max(1, cursorState.column);
  cursorOutput.write(`\x1b[?25h\x1b[${rowsUp}A\r\x1b[${column}G`);
  parkedRowsUp = rowsUp;
  cursorParked = true;
}

export function setPromptCursorState(state: PromptCursorState): void {
  cursorState = state;
}

export function disablePromptCursor(): void {
  cursorState = { ...cursorState, enabled: false };
  cancelPendingPromptCursorRestore();
  unparkPromptCursor();
}

export function schedulePromptCursorRestore(): void {
  if (!cursorState.enabled || pendingCursorRestore) {
    return;
  }

  pendingCursorRestore = setTimeout(writePromptCursor, PROMPT_CURSOR_RESTORE_DELAY_MS);
}

export function createInkStdout(stdout: NodeJS.WriteStream): NodeJS.WriteStream {
  cursorOutput = stdout;

  return new Proxy(stdout, {
    get(target, property, receiver) {
      if (property === 'write') {
        return (...args: Parameters<NodeJS.WriteStream['write']>) => {
          cancelPendingPromptCursorRestore();
          unparkPromptCursor(target);
          const result = target.write(...args);
          schedulePromptCursorRestore();
          return result;
        };
      }

      const value = Reflect.get(target, property, receiver);
      if (typeof value === 'function') {
        return value.bind(target);
      }

      return value;
    },
    set(target, property, value, receiver) {
      return Reflect.set(target, property, value, receiver);
    },
  });
}
