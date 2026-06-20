import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { TranscriptEntry } from '../types';

export type ToolActivityState = 'running' | 'success' | 'error' | 'requested';

export interface ParsedToolActivity {
  state: ToolActivityState;
  name: string;
  detail: string;
  duration?: string;
  error?: string;
}

function takeVisualWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';

  let result = '';
  for (const char of text) {
    const next = `${result}${char}`;
    if (stringWidth(next) > maxWidth) break;
    result = next;
  }
  return result;
}

export function truncateVisual(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return takeVisualWidth(text, maxWidth);
  return `${takeVisualWidth(text, maxWidth - 3)}...`;
}

function parseDoneActivity(firstLine: string, lines: string[]): ParsedToolActivity | null {
  const match = firstLine.match(/^([✓✗])\s+(\S+)(?:\s+(.*))?$/u);
  if (!match) return null;

  const rawDetail = match[3] ?? '';
  const durationMatch = rawDetail.match(/\s+\((\d+ms)\)$/);
  const duration = durationMatch?.[1];
  const detail = durationMatch ? rawDetail.slice(0, durationMatch.index).trim() : rawDetail.trim();
  const errorLine = lines.slice(1).find(line => line.startsWith('Error:'));

  return {
    state: match[1] === '✓' ? 'success' : 'error',
    name: match[2],
    detail,
    duration,
    error: errorLine ? errorLine.slice('Error:'.length).trim() : undefined,
  };
}

export function parseToolActivity(content: string): ParsedToolActivity | null {
  const lines = content.split('\n');
  const firstLine = lines[0]?.trim() ?? '';
  if (!firstLine) return null;

  const running = firstLine.match(/^Running\s+(\S+)(?:\s+(.*))?$/u);
  if (running) {
    return {
      state: 'running',
      name: running[1],
      detail: (running[2] ?? '').trim(),
    };
  }

  const requested = firstLine.match(/^Requested\s+(\S+)(?:\s+(.*))?$/u);
  if (requested) {
    return {
      state: 'requested',
      name: requested[1],
      detail: (requested[2] ?? '').trim(),
    };
  }

  return parseDoneActivity(firstLine, lines);
}

export function formatToolActivityLine(activity: ParsedToolActivity, width: number): string {
  const symbol = activity.state === 'running'
    ? '›'
    : activity.state === 'success'
      ? '✓'
      : activity.state === 'error'
        ? '✗'
        : '•';
  const duration = activity.duration ? ` (${activity.duration})` : '';
  const prefix = `${symbol} ${activity.name}`;
  const detail = activity.detail ? ` ${activity.detail}` : '';
  return truncateVisual(`${prefix}${detail}${duration}`, width);
}

function stateColor(state: ToolActivityState): string {
  switch (state) {
    case 'running':
      return 'cyan';
    case 'success':
      return 'green';
    case 'error':
      return 'red';
    case 'requested':
      return 'gray';
  }
}

export function ToolActivityBlock({ entry, width = 80 }: { entry: TranscriptEntry; width?: number }): JSX.Element | null {
  const activity = parseToolActivity(entry.content);
  if (!activity) return null;

  const contentWidth = Math.max(1, width - 2);
  const line = formatToolActivityLine(activity, contentWidth);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={stateColor(activity.state)} wrap="truncate">
        {line}
      </Text>
      {activity.error ? (
        <Text color="red" wrap="truncate">
          {truncateVisual(`  Error: ${activity.error}`, contentWidth)}
        </Text>
      ) : null}
    </Box>
  );
}
