import { useLayoutEffect } from 'react';
import stringWidth from 'string-width';
import { getPromptInputViewport, promptTextWidth, splitByVisualWidth } from '../runtime/prompt-layout';
import { disablePromptCursor, schedulePromptCursorRestore, setPromptCursorState } from '../runtime/stdout';

export interface TerminalCursorProps {
  value: string;
  terminalHeight: number;
  terminalWidth: number;
  cursor?: number;
  maxRows?: number;
  sticky?: boolean;
}

const NORMAL_RESTORE_DELAYS_MS = [0];
const STICKY_RESTORE_DELAYS_MS = [0];
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

export function getCursorRestoreDelays(_sticky = false): number[] {
  return NORMAL_RESTORE_DELAYS_MS;
}

export function TerminalCursor({ value, terminalWidth, cursor = value.length, maxRows = 6, sticky = false }: TerminalCursorProps): null {
  useLayoutEffect(() => {
    const viewport = getPromptInputViewport(value, terminalWidth, maxRows, cursor);
    setPromptCursorState({
      enabled: true,
      column: viewport.cursorColumn,
      rowsUp: viewport.rowsUpFromPromptBottom,
    });
    schedulePromptCursorRestore();

    return () => {
      disablePromptCursor();
    };
  }, [sticky, value, terminalWidth, cursor, maxRows]);

  return null;
}
