/**
 * openhorse - 命令面板组件
 *
 * 交互式 slash 命令选择面板，支持 ↑↓ 导航、实时过滤、Enter 选择。
 *
 * Issue #32 #3.11: SIGWINCH 终端大小调整 + NO_COLOR 环境变量支持
 */

import chalk from 'chalk';
import { findCommand, getCommands } from '../commands/index';
import type { SlashCommand } from '../commands/types';

// ============================================================================
// 颜色常量 - Issue #32 #3.11: NO_COLOR 支持
// ============================================================================

// 检查 NO_COLOR 环境变量（https://no-color.org/）
const NO_COLOR = process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb';

// 如果 NO_COLOR 设置，使用无颜色的 chalk
const colorize = NO_COLOR ? {
  accent: (s: string) => s,
  brand: (s: string) => s,
  dim: (s: string) => s,
  selected: (s: string) => s,
} : {
  accent: chalk.hex('#00D4AA'),
  brand: chalk.hex('#FF6B35'),
  dim: chalk.dim,
  selected: chalk.bgHex('#1E293B').hex('#E2E8F0'),
};

const ACCENT = colorize.accent;
const BRAND = colorize.brand;
const DIM = colorize.dim;
const SELECTED = colorize.selected;

const DEFAULT_MATCH_LIMIT = 8;
const FILTERED_MATCH_LIMIT = 6;

// ============================================================================
// SIGWINCH 处理 - Issue #32 #3.11
// ============================================================================

let terminalWidth = process.stdout.columns || 80;
let terminalHeight = process.stdout.rows || 24;

// 监听终端大小变化
if (process.stdout.isTTY) {
  process.stdout.on('resize', () => {
    terminalWidth = process.stdout.columns || 80;
    terminalHeight = process.stdout.rows || 24;
    // 如果面板可见，重新渲染
    if (state.visible) {
      render();
    }
  });
}

// ============================================================================
// 状态管理
// ============================================================================

export interface CommandPanelState {
  visible: boolean;
  selectedIndex: number;
  filter: string;
  matches: SlashCommand[];
}

let state: CommandPanelState = {
  visible: false,
  selectedIndex: 0,
  filter: '',
  matches: [],
};

/** 面板高度（用于清除） */
let panelHeight = 0;

/** 当前输入缓冲（供 CLI 读取） */
let pendingCommand: string | null = null;

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 显示命令面板
 * @param filter 过滤字符串（不含 "/"）
 */
export function showCommandPanel(filter: string = ''): void {
  state.visible = true;
  state.filter = filter;
  state.selectedIndex = 0;
  updateMatches();
  render();
}

/**
 * 隐藏命令面板
 */
export function hideCommandPanel(): void {
  if (state.visible) {
    clearPanel();
    state.visible = false;
    state.matches = [];
    state.filter = '';
    state.selectedIndex = 0;
  }
}

/**
 * 导航选择
 */
export function navigatePanel(direction: 'up' | 'down'): void {
  if (!state.visible || state.matches.length === 0) return;

  if (direction === 'up') {
    state.selectedIndex = Math.max(0, state.selectedIndex - 1);
  } else {
    state.selectedIndex = Math.min(state.matches.length - 1, state.selectedIndex + 1);
  }
  render();
}

/**
 * 选择当前命令
 * @returns 选中命令的完整输入（含 "/"），或 null
 */
export function selectCommand(): string | null {
  if (!state.visible || state.matches.length === 0) return null;

  const cmd = state.matches[state.selectedIndex];
  pendingCommand = '/' + cmd.name;
  hideCommandPanel();
  return pendingCommand;
}

/**
 * 更新过滤条件
 */
export function updatePanelFilter(filter: string): void {
  state.filter = filter;
  state.selectedIndex = 0;
  updateMatches();
  if (state.matches.length > 0) {
    render();
  } else {
    hideCommandPanel();
  }
}

/**
 * 获取面板是否可见
 */
export function isPanelVisible(): boolean {
  return state.visible;
}

/**
 * 获取当前选中的命令名
 */
export function getSelectedCommandName(): string | null {
  if (!state.visible || state.matches.length === 0) return null;
  return state.matches[state.selectedIndex].name;
}

/**
 * 获取待处理的命令（选择后的）
 */
export function getPendingCommand(): string | null {
  return pendingCommand;
}

/**
 * 清除待处理命令
 */
export function clearPendingCommand(): void {
  pendingCommand = null;
}

// ============================================================================
// 内部辅助
// ============================================================================

function updateMatches(): void {
  const commands = getCommands();
  if (!state.filter) {
    state.matches = commands.slice(0, DEFAULT_MATCH_LIMIT);
  } else {
    state.matches = commands
      .filter(c => c.name.startsWith(state.filter) || c.aliases?.some(a => a.startsWith(state.filter)))
      .slice(0, FILTERED_MATCH_LIMIT);
  }
}

/** 上次渲染的面板行数 */
let lastPanelLines: string[] = [];

function render(): void {
  // 先清除上次的面板（使用保存的行数）
  clearPanel();

  if (state.matches.length === 0) {
    return;
  }

  // Issue #32 #3.11: 使用动态终端宽度
  const innerWidth = Math.min(terminalWidth - 4, 60);

  const lines: string[] = [];

  // 标题行
  const title = state.filter ? `Matching "${state.filter}"` : 'Commands';
  lines.push(DIM(`┌─ ${title} `) + DIM('─'.repeat(innerWidth - title.length - 3)) + DIM('┐'));

  // 命令列表
  for (let i = 0; i < state.matches.length; i++) {
    const cmd = state.matches[i];
    const isSelected = i === state.selectedIndex;

    // 格式: /name (alias) description. Keep rows compact while users type.
    const aliases = cmd.aliases?.length ? ` (${cmd.aliases[0]})` : '';
    const content = `/${cmd.name}${aliases}`;
    const desc = cmd.description.length > 28 ? cmd.description.slice(0, 25) + '...' : cmd.description;
    const padding = innerWidth - content.length - desc.length - 2;
    const gap = ' '.repeat(Math.max(1, padding));

    if (isSelected) {
      lines.push(DIM('│ ') + SELECTED(content + gap + desc) + DIM(' │'));
    } else {
      lines.push(DIM('│ ') + ACCENT(content) + gap + DIM(desc) + DIM(' │'));
    }
  }

  // 底部
  lines.push(DIM('└') + DIM('─'.repeat(innerWidth)) + DIM('┘'));

  // 操作提示
  lines.push(DIM('  ↑↓ Select  Enter  Esc'));

  // 保存行数用于下次清除
  lastPanelLines = lines;
  panelHeight = lines.length;

  // 使用更安全的渲染方式：保存光标位置，清除下方区域，写入面板，恢复光标
  process.stdout.write('\x1b[s');  // 保存光标位置

  // 清除从当前行到屏幕底部的内容（不移动光标）
  process.stdout.write('\x1b[J');  // 清除从光标到屏幕底部

  // 现在写入面板内容（光标在原位置）
  for (const line of lines) {
    process.stdout.write('\n');     // 换行（更安全）
    process.stdout.write('\r' + line);
  }

  // 恢复光标到保存的位置
  process.stdout.write('\x1b[u');
}

function clearPanel(): void {
  // 使用保存的行数清除
  const height = lastPanelLines.length || panelHeight;
  if (height > 0) {
    // 保存当前光标位置
    process.stdout.write('\x1b[s');

    // 清除从光标到屏幕底部
    process.stdout.write('\x1b[J');

    // 恢复光标位置
    process.stdout.write('\x1b[u');

    lastPanelLines = [];
    panelHeight = 0;
  }
}

/** 上次渲染的总长度（prompt + input 的可见宽度） */
let lastTotalRendered = 0;
/** 是否是首次渲染（首次不清除） */
let isFirstRender = true;

/**
 * 计算字符串在终端中的可见宽度（字符数，不含 ANSI 码）
 * CJK 字符占 2 格，普通字符占 1 格
 */
function visualWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0) || 0;
    // CJK / CJK Unified Ideographs / Hangul / Full-width 占 2 格
    width += (cp >= 0x1100 && (
      cp <= 0x115F || cp === 0x2329 || cp === 0x232A ||
      (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) ||
      (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE10 && cp <= 0xFE19) ||
      (cp >= 0xFE30 && cp <= 0xFE6F) ||
      (cp >= 0xFF01 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||
      (cp >= 0x20000 && cp <= 0x2FFFD) ||
      (cp >= 0x30000 && cp <= 0x3FFFD)
    )) ? 2 : 1;
  }
  return width;
}

/**
 * 重绘输入行（带 prompt）
 * v0.1.15: 修复换行残留 — 使用可见宽度计算（CJK 占 2 格）
 */
export function redrawInputWithPrompt(input: string, modeIndicator: string = ''): void {
  const prompt = ACCENT('❯ ') + (modeIndicator ? DIM(modeIndicator) : '');
  const promptWidth = visualWidth(stripAnsi(prompt));

  if (!isFirstRender) {
    const lastTotal = lastTotalRendered;

    // 使用可见宽度计算上次渲染占用的行数
    let lines = 1;
    if (lastTotal > 0) {
      lines = Math.ceil(lastTotal / terminalWidth);
    }

    // 光标在最后渲染行的下一行（wrap 后）
    const cursorOnNextLine = lastTotal > 0 && lastTotal % terminalWidth === 0;

    if (cursorOnNextLine) {
      process.stdout.write('\x1b[1A');
    }

    // 清除最后渲染行
    process.stdout.write('\x1b[2K');

    // 上移清除其余行
    for (let i = 1; i < lines; i++) {
      process.stdout.write('\x1b[1A\x1b[2K');
    }

    process.stdout.write('\r');
  }

  // 绘制新的输入
  process.stdout.write(prompt + input);

  // 记录可见总宽度（prompt + input）
  lastTotalRendered = promptWidth + visualWidth(input);
  isFirstRender = false;
}

/**
 * 重置渲染长度跟踪
 */
export function resetRenderLength(): void {
  lastTotalRendered = 0;
  isFirstRender = true;
}

/**
 * 去除 ANSI 颜色码，计算实际可见长度
 */
function stripAnsi(str: string): string {
  // 简单的 ANSI 去除
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}
