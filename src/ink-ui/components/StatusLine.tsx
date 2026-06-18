import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { calculateCtxPercent } from '../../services/model-context';
import { mcpManager } from '../../tools/mcp';
import type { OpenHorseInkRuntime } from '../types';
import { RunningHorseIndicator, runningHorseLabel } from './RunningHorseIndicator';

export interface StatusLineProps {
  runtime: OpenHorseInkRuntime;
  running: boolean;
  statusMessage?: string;
  width?: number;
}

function truncateVisual(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;
  let result = '';
  for (const char of text) {
    if (stringWidth(`${result}${char}...`) > maxWidth) break;
    result += char;
  }
  return `${result}...`;
}

export function StatusLine({ runtime, running, statusMessage, width = 80 }: StatusLineProps): JSX.Element {
  const snapshot = runtime.store.getSnapshot();
  const usage = snapshot.tokenUsage;
  const totalTokens = usage ? usage.promptTokens + usage.completionTokens : 0;
  const costStats = snapshot.costTracker.getSessionStats();
  const session = runtime.getSession();
  const mcpStatus = mcpManager.getStatus();
  const connectedMcp = mcpStatus.filter(item => item.connected).length;
  const ctxPercent = calculateCtxPercent(totalTokens, snapshot.currentModel || snapshot.config.model);
  const rightText = [
    `model=${snapshot.currentModel}`,
    `session=${session?.id.slice(0, 8) ?? 'none'}`,
    `tokens=${(totalTokens / 1000).toFixed(1)}K`,
    `cost=$${costStats.totalCost.toFixed(4)}`,
    `ctx=${ctxPercent}%`,
    mcpStatus.length > 0 ? `mcp=${connectedMcp}/${mcpStatus.length}` : '',
  ].filter(Boolean).join('  ');
  const leftMaxWidth = Math.max(10, width - stringWidth(rightText) - 2);
  const leftText = truncateVisual(statusMessage || 'ready', leftMaxWidth);

  return (
    <Box justifyContent="space-between">
      {running ? (
        <RunningHorseIndicator label={runningHorseLabel(statusMessage)} maxWidth={leftMaxWidth} />
      ) : (
        <Text color="gray">
          {leftText}
        </Text>
      )}
      <Text color="gray">
        model=<Text color="cyan">{snapshot.currentModel}</Text>
        {'  '}session=<Text color="cyan">{session?.id.slice(0, 8) ?? 'none'}</Text>
        {'  '}tokens=<Text color="cyan">{(totalTokens / 1000).toFixed(1)}K</Text>
        {'  '}cost=<Text color="cyan">${costStats.totalCost.toFixed(4)}</Text>
        {'  '}ctx=<Text color="cyan">{ctxPercent}%</Text>
        {mcpStatus.length > 0 ? <Text>  mcp=<Text color="cyan">{connectedMcp}/{mcpStatus.length}</Text></Text> : null}
      </Text>
    </Box>
  );
}
