/**
 * openhorse - 命令面板组件
 *
 * 交互式 slash 命令选择面板，支持 ↑↓ 导航、实时过滤、Enter 选择。
 */

import chalk from 'chalk';
import { findCommand, getCommands } from '../commands/index';
import type { SlashCommand } from '../commands/types';

// ============================================================================
// 颜色常量
// ============================================================================

const ACCENT = chalk.hex('#00D4AA');
const BRAND = chalk.hex('#FF6B35');
const DIM = chalk.dim;
const SELECTED = chalk.bgHex('#1E293B').hex('#E2E8F0');

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
    state.matches = commands.slice(0, 10);
  } else {
    state.matches = commands
      .filter(c => c.name.startsWith(state.filter) || c.aliases?.some(a => a.startsWith(state.filter)))
      .slice(0, 10);
  }
}

function render(): void {
  clearPanel();

  if (state.matches.length === 0) {
    return;
  }

  const terminalWidth = process.stdout.columns || 80;
  const innerWidth = Math.min(terminalWidth - 4, 60);

  const lines: string[] = [];

  // 标题行
  const title = state.filter ? `Matching "${state.filter}"` : 'Commands';
  lines.push(DIM(`┌─ ${title} `) + DIM('─'.repeat(innerWidth - title.length - 3)) + DIM('┐'));

  // 命令列表
  for (let i = 0; i < state.matches.length; i++) {
    const cmd = state.matches[i];
    const isSelected = i === state.selectedIndex;

    // 格式: /name [alias] - description
    const aliases = cmd.aliases?.length ? ` (${cmd.aliases[0]})` : '';
    const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
    const desc = cmd.description.length > 30 ? cmd.description.slice(0, 27) + '...' : cmd.description;

    // 类型标签
    const typeLabel = cmd.type === 'chat' ? '[Chat]' : '[Cmd]';

    const content = `${cmd.name}${aliases}${hint}`;
    const padding = innerWidth - content.length - desc.length - typeLabel.length - 4;

    if (isSelected) {
      lines.push(SELECTED(` ${'/' + content} `) + ' '.repeat(Math.max(0, padding)) + SELECTED(` ${desc} ${typeLabel} `));
    } else {
      lines.push(DIM('│ ') + ACCENT('/' + content) + ' '.repeat(Math.max(0, padding)) + DIM(` ${desc} `) + DIM(typeLabel) + DIM(' │'));
    }
  }

  // 底部
  lines.push(DIM('└') + DIM('─'.repeat(innerWidth)) + DIM('┘'));

  // 操作提示
  lines.push(DIM('  ↑↓ Navigate  Enter Select  Esc Cancel'));

  // 渲染
  for (const line of lines) {
    process.stdout.write('\n' + line);
  }

  panelHeight = lines.length;

  // 恢复光标到输入位置
  process.stdout.write(`\x1b[${panelHeight}A`);
  process.stdout.write('\r');
}

function clearPanel(): void {
  if (panelHeight > 0) {
    // 下移并清除每一行
    for (let i = 0; i < panelHeight; i++) {
      process.stdout.write('\x1b[B');  // 下移一行
      process.stdout.write('\x1b[2K'); // 清除整行
    }
    // 移回原位置
    process.stdout.write(`\x1b[${panelHeight}A`);
    process.stdout.write('\r');
    panelHeight = 0;
  }
}

/**
 * 重绘输入行（带 prompt）
 */
export function redrawInputWithPrompt(input: string, modeIndicator: string = ''): void {
  process.stdout.write('\r\x1b[2K');
  const prompt = ACCENT('❯ ') + (modeIndicator ? DIM(modeIndicator) : '');
  process.stdout.write(prompt + input);
}