import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { TranscriptEntry } from '../types';
import { splitByVisualWidth } from '../runtime/prompt-layout';
import { Markdown } from './Markdown';

export interface TranscriptProps {
  entries: TranscriptEntry[];
  maxItems?: number;
  width?: number;
}

const USER_BACKGROUND = '#50545c';

function padLine(line: string, width: number): string {
  const padding = Math.max(0, width - stringWidth(line));
  return line + ' '.repeat(padding);
}

function transcriptLines(entry: TranscriptEntry, width: number): string[] {
  const rawLines = entry.content.split('\n');
  if (entry.role !== 'user' && entry.role !== 'command') {
    return rawLines.map(line => line || ' ');
  }

  return rawLines.flatMap(line =>
    splitByVisualWidth(line || ' ', width).map(chunk => padLine(chunk, width))
  );
}

export function Transcript({ entries, maxItems = 20, width = 80 }: TranscriptProps): JSX.Element {
  const visible = entries.slice(Math.max(0, entries.length - maxItems));
  const contentWidth = Math.max(1, width - 2);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.length === 0 ? (
        <Text color="gray">OpenHorse is ready.</Text>
      ) : (
        visible.map(entry => (
          <Box key={entry.id} flexDirection="column" marginBottom={1}>
            {entry.role === 'assistant' || entry.role === 'system' || entry.role === 'status' ? (
              <Markdown width={contentWidth}>{entry.content}</Markdown>
            ) : (
              transcriptLines(entry, contentWidth).map((line, index) => (
                <Text
                  key={index}
                  color={entry.role === 'error' ? 'red' : entry.role === 'tool' ? 'gray' : undefined}
                  backgroundColor={entry.role === 'user' || entry.role === 'command' ? USER_BACKGROUND : undefined}
                  wrap="truncate"
                >
                  {line}
                </Text>
              ))
            )}
          </Box>
        ))
      )}
    </Box>
  );
}
