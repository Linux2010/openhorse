import stringWidth from 'string-width';
import { createTuiFrame, setFrameCursor, writeFrameText, type TuiFrame } from '../tui-core/frame';
import type { TranscriptEntry } from '../runtime/ui-events';
import {
  liveTuiTranscriptEntries,
  staticTuiTranscriptEntries,
  type TuiUiState,
} from './state';

export interface TuiLayoutOptions {
  width: number;
  height: number;
  maxTranscriptRows?: number;
}

const MIN_WIDTH = 24;
const MIN_HEIGHT = 8;
const PROMPT_TOP_ROWS = 3;

export function renderTuiUiFrame(state: TuiUiState, options: TuiLayoutOptions): TuiFrame {
  const width = Math.max(MIN_WIDTH, Math.floor(options.width));
  const height = Math.max(MIN_HEIGHT, Math.floor(options.height));
  const frame = createTuiFrame(width, height);

  const promptTop = height - PROMPT_TOP_ROWS;
  const statusRow = promptTop - 1;
  const transcriptRows = Math.max(0, Math.min(options.maxTranscriptRows ?? statusRow, statusRow));

  renderTranscript(frame, state, transcriptRows);
  renderStatus(frame, state, statusRow);
  renderPrompt(frame, state, promptTop);
  renderOverlay(frame, state, transcriptRows);

  const cursorColumn = promptCursorColumn(state.prompt.value, state.prompt.cursor, width);
  setFrameCursor(frame, promptTop + 1, cursorColumn, true);
  return frame;
}

function renderTranscript(frame: TuiFrame, state: TuiUiState, maxRows: number): void {
  const entries = [
    ...staticTuiTranscriptEntries(state),
    ...liveTuiTranscriptEntries(state),
  ];
  const lines = entries.flatMap(entry => formatTranscriptEntry(entry, frame.width));
  const maxOffset = Math.max(0, lines.length - maxRows);
  const scrollOffset = Math.min(Math.max(0, state.transcriptScrollOffset), maxOffset);
  const start = Math.max(0, lines.length - maxRows - scrollOffset);
  const visible = lines.slice(start, start + maxRows);

  visible.forEach((line, index) => {
    writeFrameText(frame, index, 0, line);
  });
}

function renderStatus(frame: TuiFrame, state: TuiUiState, row: number): void {
  if (row < 0) return;
  const left = state.processing ? 'working' : 'ready';
  const right = state.statusMessage ? state.statusMessage : '';
  const available = Math.max(0, frame.width - stringWidth(left) - 1);
  const status = right
    ? `${left}${' '.repeat(Math.max(1, available - stringWidth(right)))}${truncateCells(right, available)}`
    : left;
  writeFrameText(frame, row, 0, truncateCells(status, frame.width));
}

function renderPrompt(frame: TuiFrame, state: TuiUiState, top: number): void {
  const width = frame.width;
  writeFrameText(frame, top, 0, `┌${'─'.repeat(width - 2)}┐`);
  writeFrameText(frame, top + 1, 0, '│ ');
  writeFrameText(frame, top + 1, 2, truncateCells(`› ${state.prompt.value}`, width - 4));
  writeFrameText(frame, top + 1, width - 1, '│');
  writeFrameText(frame, top + 2, 0, `└${'─'.repeat(width - 2)}┘`);
}

function renderOverlay(frame: TuiFrame, state: TuiUiState, maxRows: number): void {
  if (!state.overlay || maxRows <= 0) return;

  if (state.overlay.type === 'sessions') {
    const overlay = state.overlay;
    const request = overlay.request;
    const visibleCount = Math.max(0, Math.min(
      maxRows - 1,
      request.maxVisibleItems ?? maxRows - 1,
      request.sessions.length,
    ));
    const start = sessionPickerStartIndex(state.overlay.selectedIndex, visibleCount, request.sessions.length);
    const visibleSessions = request.sessions.slice(start, start + visibleCount);
    const rows = [
      `Sessions: ${request.title} (${overlay.selectedIndex + 1}/${request.sessions.length})`,
      ...visibleSessions.map((session, offset) => {
        const index = start + offset;
        const marker = index === overlay.selectedIndex ? '›' : ' ';
        const label = session.name || session.taskSummary || session.id.slice(0, 8);
        const size = formatBytes(session.historySizeBytes ?? 0);
        const messages = `${session.messageCount ?? 0} msgs`;
        const project = request.showProject ? `  ${session.projectPath}` : '';
        return `${marker} ${String(index + 1).padStart(2, ' ')} ${session.id.slice(0, 8)}  ${label}  ${messages}  ${size}  ${session.model}${project}`;
      }),
    ].map(row => truncateCells(row, frame.width));

    rows.slice(0, maxRows).forEach((line, index) => {
      writeFrameText(frame, index, 0, line);
    });
    return;
  }

  if (state.overlay.type === 'edit') {
    const overlay = state.overlay;
    const req = overlay.request;
    const visibleCount = Math.max(0, Math.min(
      maxRows - 1,
      10,
      req.candidates.length,
    ));
    const start = pickerStartIndex(overlay.selectedIndex, visibleCount, req.candidates.length);
    const visible = req.candidates.slice(start, start + visibleCount);
    const kindLabel = req.kind === 'fuzzy' ? `fuzzy (${req.strategy ?? 'match'})` : 'exact';
    const rows = [
      `Edit Preview: ${req.path} (${kindLabel}, ${req.candidates.length} candidate${req.candidates.length === 1 ? '' : 's'})`,
      ...visible.map((c, offset) => {
        const index = start + offset;
        const marker = index === overlay.selectedIndex ? '›' : ' ';
        const matchPreview = c.match.length > 60 ? c.match.slice(0, 57) + '...' : c.match;
        const newPreview = req.newString.length > 40 ? req.newString.slice(0, 37) + '...' : req.newString;
        return `${marker} line ${String(c.line).padStart(3, ' ')}  "${matchPreview}"  → "${newPreview}"`;
      }),
    ].map(row => truncateCells(row, frame.width));

    rows.slice(0, maxRows).forEach((line, index) => {
      writeFrameText(frame, index, 0, line);
    });
    return;
  }

  if (state.overlay.type === 'commands' || state.overlay.type === 'files') {
    const overlay = state.overlay;
    const visibleCount = Math.max(0, Math.min(maxRows - 2, 10, overlay.items.length || 1));
    const start = pickerStartIndex(overlay.selectedIndex, visibleCount, overlay.items.length);
    const visibleItems = overlay.items.slice(start, start + visibleCount);
    const title = overlay.type === 'commands'
      ? `Commands${overlay.query ? ` "${overlay.query}"` : ''}`
      : `Files${overlay.query ? ` "${overlay.query}"` : ''}`;
    const rows = [
      `${title} (${overlay.items.length} match${overlay.items.length === 1 ? '' : 'es'})`,
      ...(overlay.items.length === 0
        ? ['  No matching items']
        : visibleItems.map((item, offset) => {
          const index = start + offset;
          const marker = index === overlay.selectedIndex ? '›' : ' ';
          const description = item.description ? `  ${item.description}` : '';
          return `${marker} ${item.label}${description}`;
        })),
    ].map(row => truncateCells(row, frame.width));

    rows.slice(0, maxRows).forEach((line, index) => {
      writeFrameText(frame, index, 0, line);
    });
    return;
  }

  if (state.overlay.type === 'permission') {
    const overlay = state.overlay;
    const detail = compactPermissionArgs(overlay.request.args);
    const rows = [
      `Tool Permission: ${overlay.request.name}`,
      ...(detail ? [`  ${detail}`] : []),
      ...(overlay.request.reason ? [`  ${overlay.request.reason}`] : []),
      `${overlay.selectedIndex === 0 ? '›' : ' '} Allow`,
      `${overlay.selectedIndex === 1 ? '›' : ' '} Deny`,
      'Enter select   y allow   n/Esc deny',
    ].map(row => truncateCells(row, frame.width));

    rows.slice(0, maxRows).forEach((line, index) => {
      writeFrameText(frame, index, 0, line);
    });
    return;
  }

  if (state.overlay.type === 'shortcuts') {
    const rows = [
      'Shortcuts',
      '/ commands    @ files    ? shortcuts',
      'Enter submit/select    Tab complete    Esc cancel',
      'PageUp/PageDown transcript history    Ctrl+C interrupt / twice exits',
    ].map(row => truncateCells(row, frame.width));

    rows.slice(0, maxRows).forEach((line, index) => {
      writeFrameText(frame, index, 0, line);
    });
  }
}

function compactPermissionArgs(args: Record<string, unknown>): string {
  for (const key of ['path', 'file_path', 'file', 'cwd', 'command', 'pattern', 'query', 'url', 'target', 'sessionId']) {
    const value = args[key];
    if (typeof value === 'string') {
      return value.length > 72 ? `${value.slice(0, 69)}...` : value;
    }
  }
  const firstString = Object.values(args).find(value => typeof value === 'string');
  if (typeof firstString === 'string') {
    return firstString.length > 72 ? `${firstString.slice(0, 69)}...` : firstString;
  }
  return '';
}

function sessionPickerStartIndex(selectedIndex: number, visibleCount: number, total: number): number {
  return pickerStartIndex(selectedIndex, visibleCount, total);
}

function pickerStartIndex(selectedIndex: number, visibleCount: number, total: number): number {
  if (visibleCount <= 0 || total <= visibleCount) return 0;
  const halfWindow = Math.floor(visibleCount / 2);
  const desired = selectedIndex - halfWindow;
  return Math.min(total - visibleCount, Math.max(0, desired));
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatTranscriptEntry(entry: TranscriptEntry, width: number): string[] {
  const prefix = transcriptPrefix(entry);
  const rawLines = entry.content.split('\n');
  const lines = rawLines.length > 0 ? rawLines : [''];

  return lines.flatMap((line, index) => {
    const text = `${index === 0 ? prefix : '  '}${line}`;
    return wrapCells(text, width);
  });
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

function promptCursorColumn(value: string, cursor: number, width: number): number {
  const safeCursor = Math.min(Math.max(0, Math.floor(cursor)), value.length);
  const beforeCursor = value.slice(0, safeCursor);
  return Math.min(width - 2, 4 + stringWidth(beforeCursor));
}

function wrapCells(value: string, width: number): string[] {
  if (width <= 0) return [''];
  const rows: string[] = [];
  let current = '';
  let currentWidth = 0;

  for (const char of Array.from(value)) {
    const charWidth = Math.max(0, stringWidth(char));
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

function truncateCells(value: string, width: number): string {
  if (width <= 0) return '';
  let output = '';
  let used = 0;
  for (const char of Array.from(value)) {
    const charWidth = Math.max(0, stringWidth(char));
    if (used + charWidth > width) break;
    output += char;
    used += charWidth;
  }
  return output;
}
