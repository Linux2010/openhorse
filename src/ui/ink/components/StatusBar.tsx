import React from 'react';
import { Box, Text } from 'ink';

export interface StatusBarProps {
  model: string;
  tokens: number;
  cost: number;
  ctxPercent: number;
}

export function StatusBar({ model, tokens, cost, ctxPercent }: StatusBarProps) {
  return (
    <Box justifyContent="space-between" width="100%">
      <Box>
        <Text color="cyan" bold>
          OpenHorse
        </Text>
        <Text> | </Text>
        <Text color="green">{model}</Text>
      </Box>
      <Box>
        <Text dimColor>
          {tokens} tok | $${cost.toFixed(4)} | {ctxPercent}% ctx
        </Text>
      </Box>
    </Box>
  );
}