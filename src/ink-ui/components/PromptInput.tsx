import React from 'react';
import { Box, Text } from 'ink';
import { formatPromptVisualLine, getPromptVisualLines, type PromptVisualLine } from '../runtime/prompt-layout';

export interface PromptInputProps {
  value: string;
  running: boolean;
  modeText?: string;
  width?: number;
}

const INPUT_BACKGROUND = '#50545c';

export function formatPromptLine(line: string, index: number, width: number): string {
  return formatPromptVisualLine({ logicalIndex: index, wrapIndex: 0, content: line }, width);
}

export function PromptInput({ value, running, modeText, width = 80 }: PromptInputProps): JSX.Element {
  const lines = getPromptVisualLines(value, width);

  return (
    <Box flexDirection="column">
      <Text color="gray">
        / commands   @ files   ? shortcuts   Alt+Enter newline   Ctrl+C {running ? 'interrupt' : 'twice exits'}
        {modeText ? `   ${modeText}` : ''}
      </Text>
      <Box width={width} borderStyle="single" borderColor={running ? 'yellow' : 'gray'} paddingX={1} flexDirection="column">
        {lines.map((line: PromptVisualLine, index) => (
          <Text key={`${line.logicalIndex}:${line.wrapIndex}:${index}`} backgroundColor={INPUT_BACKGROUND} color="white" wrap="truncate">
            {formatPromptVisualLine(line, width)}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
