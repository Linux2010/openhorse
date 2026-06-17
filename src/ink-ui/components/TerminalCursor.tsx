import { useEffect, useRef } from 'react';
import { useStdout } from 'ink';
import stringWidth from 'string-width';
import { promptTextWidth, splitByVisualWidth } from '../runtime/prompt-layout';

export interface TerminalCursorProps {
  value: string;
  terminalHeight: number;
  terminalWidth: number;
  sticky?: boolean;
}

const NORMAL_RESTORE_DELAYS_MS = [0, 16];
const STICKY_RESTORE_DELAYS_MS = [0, 16, 64];
const STICKY_RESTORE_INTERVAL_MS = 120;

export function getPromptCursorPosition(
  value: string,
  terminalHeight: number,
  terminalWidth: number
): { row: number; column: number } {
  const lines = value.length > 0 ? value.split('\n') : [''];
  const maxTextWidth = promptTextWidth(terminalWidth);
  const rows = lines.map(line => splitByVisualWidth(line, maxTextWidth).length);
  const totalInputRows = rows.reduce((sum, rowCount) => sum + rowCount, 0);
  const activeLine = lines[lines.length - 1] ?? '';
  const previousRows = rows.slice(0, -1).reduce((sum, rowCount) => sum + rowCount, 0);
  const activeChunks = splitByVisualWidth(activeLine, maxTextWidth);
  const wrapRow = Math.max(0, activeChunks.length - 1);
  const activeChunk = activeChunks[activeChunks.length - 1] ?? '';
  const columnInContent = 2 + stringWidth(activeChunk);

  return {
    row: Math.max(1, terminalHeight - totalInputRows + previousRows + wrapRow),
    column: Math.max(1, 3 + columnInContent),
  };
}

function writePromptCursor(
  stream: NodeJS.WriteStream,
  value: string,
  terminalHeight: number,
  terminalWidth: number
): void {
  const position = getPromptCursorPosition(value, terminalHeight, terminalWidth);
  stream.write(`\x1b[?25h\x1b[${position.row};${position.column}H`);
}

export function getCursorRestoreDelays(sticky = false): number[] {
  return sticky ? STICKY_RESTORE_DELAYS_MS : NORMAL_RESTORE_DELAYS_MS;
}

export function TerminalCursor({ value, terminalHeight, terminalWidth, sticky = false }: TerminalCursorProps): null {
  const { stdout } = useStdout();
  const latestRef = useRef({
    stream: stdout ?? process.stdout,
    value,
    terminalHeight,
    terminalWidth,
  });

  latestRef.current = {
    stream: stdout ?? process.stdout,
    value,
    terminalHeight,
    terminalWidth,
  };

  // Ink leaves the terminal cursor after the last rendered text. During streaming
  // the footer can flush after the input box, so restore the cursor in a few
  // closely-spaced passes rather than racing Ink with a single setTimeout(0).
  useEffect(() => {
    const timers = getCursorRestoreDelays(sticky).map(delay => setTimeout(() => {
      const latest = latestRef.current;
      writePromptCursor(latest.stream, latest.value, latest.terminalHeight, latest.terminalWidth);
    }, delay));

    return () => timers.forEach(timer => clearTimeout(timer));
  });

  useEffect(() => {
    if (!sticky) return undefined;

    const interval = setInterval(() => {
      const latest = latestRef.current;
      writePromptCursor(latest.stream, latest.value, latest.terminalHeight, latest.terminalWidth);
    }, STICKY_RESTORE_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [sticky]);

  return null;
}
