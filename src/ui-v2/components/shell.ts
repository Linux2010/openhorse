/**
 * UI v2 visible shell components.
 */

import { basename } from 'path';
import chalk from 'chalk';
import { padEndVisible, truncateVisible, visualWidth } from '../runtime/text';

const NO_COLOR = process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb';

const colorize = NO_COLOR ? {
  brand: (s: string) => s,
  accent: (s: string) => s,
  dim: (s: string) => s,
  success: (s: string) => s,
  warn: (s: string) => s,
  danger: (s: string) => s,
  label: (s: string) => s,
} : {
  brand: chalk.hex('#FF6B35').bold,
  accent: chalk.hex('#00D4AA'),
  dim: chalk.dim,
  success: chalk.green,
  warn: chalk.yellow,
  danger: chalk.red,
  label: chalk.hex('#94A3B8'),
};

const INPUT_BG = '\x1b[48;2;56;56;56m';
const INPUT_FG = '\x1b[38;2;226;232;240m';
const RESET_COLORS = '\x1b[39;49m';
const CLEAR_TO_EOL = '\x1b[K';

export interface V2ShellHeaderConfig {
  provider: string;
  model: string;
  projectPath: string;
  status: 'ready' | 'loading' | 'error' | 'processing';
  statusText?: string;
  version: string;
  width?: number;
}

export interface V2StatusLineStats {
  model: string;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  ctxPercent: number;
  mcpConnected: number;
  mcpTotal: number;
  sessionId?: string;
  modeText?: string;
  width?: number;
}

export interface V2ShortcutItem {
  key: string;
  label: string;
}

export interface V2InputFrameOptions {
  input: string;
  modeIndicator?: string;
  width?: number;
  statusText?: string;
}

export interface V2InputFrameRender {
  output: string;
  height: number;
  cursorRow: number;
  cursorColumn: number;
}

const DEFAULT_SHORTCUTS: V2ShortcutItem[] = [
  { key: '/', label: 'commands' },
  { key: '@', label: 'files' },
  { key: 'Ctrl+R', label: 'history' },
  { key: 'Ctrl+L', label: 'clear view' },
  { key: '?', label: 'shortcuts' },
  { key: 'Ctrl+C', label: 'exit' },
];

export function renderV2ShellHeader(config: V2ShellHeaderConfig): string {
  const width = Math.max(44, config.width || process.stdout.columns || 80);
  const innerWidth = Math.max(24, width - 4);
  const title = `OpenHorse v${config.version}`;
  const topFill = Math.max(1, innerWidth - visualWidth(title) - 3);
  const projectName = basename(config.projectPath) || config.projectPath;
  const status = renderStatus(config.status, config.statusText);

  const body = [
    renderToken('model', config.model),
    renderToken('provider', shortProvider(config.provider)),
    renderToken('project', projectName),
    status,
  ].filter(Boolean).join(colorize.dim('  |  '));

  return [
    colorize.dim(`╭─ ${colorize.brand(title)} ${'─'.repeat(topFill)}╮`),
    colorize.dim('│ ') + padEndVisible(truncateVisible(body, innerWidth - 2), innerWidth - 2) + colorize.dim(' │'),
    colorize.dim(`╰${'─'.repeat(innerWidth)}╯`),
  ].join('\n');
}

export function renderV2Prompt(modeIndicator: string = ''): string {
  const mode = modeIndicator ? colorize.dim(`${modeIndicator} `) : '';
  return `${colorize.accent('›')} ${mode}`;
}

export function renderV2InputFrame(options: V2InputFrameOptions): V2InputFrameRender {
  const width = Math.max(24, options.width || process.stdout.columns || 80);
  const inputWidth = Math.max(1, width - 1);
  const logicalLines = options.input.length > 0 ? options.input.split('\n') : [''];
  const firstPrompt = renderV2Prompt(options.modeIndicator || '');
  const continuationPrompt = ' '.repeat(visualWidth(firstPrompt));

  const renderedLines = logicalLines.map((line, index) => {
    const prefix = index === 0 ? firstPrompt : continuationPrompt;
    return renderInputLine(truncateVisible(prefix + line, inputWidth));
  });
  const statusLine = options.statusText ? renderInputStatusLine(inputWidth, options.statusText) : undefined;

  const rowSpans = logicalLines.map((line, index) => {
    const prefix = index === 0 ? firstPrompt : continuationPrompt;
    return terminalRowsFor(visualWidth(prefix) + visualWidth(line), width);
  });
  const rowsBeforeCursor = rowSpans.slice(0, -1).reduce((sum, rows) => sum + rows, 0);
  const lastLine = logicalLines[logicalLines.length - 1] || '';
  const lastPrefix = logicalLines.length === 1 ? firstPrompt : continuationPrompt;
  const lastVisibleWidth = visualWidth(lastPrefix) + visualWidth(lastLine);

  return {
    output: [...renderedLines, ...(statusLine ? [statusLine] : [])].join('\n'),
    height: rowSpans.reduce((sum, rows) => sum + rows, 0) + (statusLine ? 1 : 0),
    cursorRow: rowsBeforeCursor + Math.floor(lastVisibleWidth / width),
    cursorColumn: (lastVisibleWidth % width) + 1,
  };
}

function renderInputLine(content: string): string {
  if (NO_COLOR) {
    return content;
  }

  return `${INPUT_BG}${INPUT_FG}${content}${CLEAR_TO_EOL}${RESET_COLORS}`;
}

function renderInputStatusLine(width: number, statusText: string): string {
  const badge = ` ${statusText} `;
  const badgeWidth = visualWidth(badge);
  if (badgeWidth >= width) {
    return truncateVisible(badge, width);
  }

  return ' '.repeat(width - badgeWidth) + badge;
}

export function renderV2StatusBadge(stats: V2StatusLineStats): string {
  const width = Math.max(20, stats.width || process.stdout.columns || 80);
  const parts = buildStatusParts(stats).join(colorize.dim('  '));
  return truncateVisible(parts, Math.max(1, width));
}

export function renderV2StatusLine(stats: V2StatusLineStats): string {
  const width = Math.max(44, stats.width || process.stdout.columns || 80);
  const content = buildStatusParts(stats).join(colorize.dim('  '));
  return colorize.dim('  ') + truncateVisible(content, Math.max(1, width - 2));
}

function buildStatusParts(stats: V2StatusLineStats): string[] {
  return [
    renderToken('model', stats.model),
    stats.sessionId ? renderToken('session', stats.sessionId.slice(0, 8)) : '',
    renderToken('tokens', formatTokens(stats.tokens)),
    stats.cost > 0 ? renderToken('cost', formatCost(stats.cost)) : '',
    stats.ctxPercent > 0 ? renderToken('ctx', `${stats.ctxPercent}%`) : '',
    stats.mcpTotal > 0 ? renderToken('mcp', `${stats.mcpConnected}/${stats.mcpTotal}`) : '',
    stats.modeText ? renderToken('mode', stats.modeText) : '',
  ].filter(Boolean);
}

export function renderV2FooterHint(width: number = process.stdout.columns || 80): string {
  const text = DEFAULT_SHORTCUTS
    .slice(0, 5)
    .map(item => `${colorize.accent(item.key)} ${colorize.label(item.label)}`)
    .join(colorize.dim('   '));
  return colorize.dim('  ') + truncateVisible(text, Math.max(1, width - 2));
}

export function renderV2Shortcuts(width: number = process.stdout.columns || 80): string {
  const innerWidth = Math.max(36, Math.min(width - 4, 72));
  const title = 'Shortcuts';
  const titleFill = Math.max(1, innerWidth - visualWidth(title) - 3);
  const rows = DEFAULT_SHORTCUTS.map(item => {
    const key = padEndVisible(item.key, 8);
    const content = `${colorize.accent(key)} ${colorize.label(item.label)}`;
    return colorize.dim('│ ') + padEndVisible(truncateVisible(content, innerWidth - 2), innerWidth - 2) + colorize.dim(' │');
  });

  return [
    colorize.dim(`┌─ ${title} ${'─'.repeat(titleFill)}┐`),
    ...rows,
    colorize.dim(`└${'─'.repeat(innerWidth)}┘`),
  ].join('\n');
}

function renderStatus(status: V2ShellHeaderConfig['status'], text?: string): string {
  const dot = status === 'ready'
    ? colorize.success('●')
    : status === 'loading'
      ? colorize.warn('●')
      : status === 'error'
        ? colorize.danger('●')
        : colorize.accent('●');
  return `${dot} ${colorize.label(text || status)}`;
}

function renderToken(label: string, value: string): string {
  return `${colorize.label(label)}=${colorize.accent(value)}`;
}

function terminalRowsFor(visibleWidth: number, terminalWidth: number): number {
  if (visibleWidth <= 0) return 1;
  return Math.floor(visibleWidth / terminalWidth) + 1;
}

function shortProvider(provider: string): string {
  return provider === 'Alibaba Cloud' ? 'Qwen' : provider;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(1)}`;
}
