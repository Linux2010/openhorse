/**
 * openhorse - UI 组件
 *
 * 输出流设计：
 *   ❯ hello                  ← readline prompt + 用户输入
 *    ⠋ Thinking (0.3s)       ← spinner 在单独行
 *   Here's the answer...      ← 响应流式输出（spinner 行被清除，响应从新行开始）
 *   tokens: 22+242  qwen3.5-plus  ← 统计
 *   ❯                  ← 下一轮
 */

import chalk from 'chalk';

// ============================================================================
// 颜色常量
// ============================================================================

const ACCENT = chalk.hex('#00D4AA');
const DIM = chalk.dim;
const GREEN = chalk.green;
const RED = chalk.red;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// 使用终端控制码清除整行，避免宽字符（中文）残留
const CLEAR_LINE = '\x1b[2K\r';

// ============================================================================
// Spinner
// ============================================================================

export interface Spinner {
  start: (text?: string) => void;
  stop: () => void;
  update: (text?: string) => void;
}

export function createSpinner(): Spinner {
  let interval: NodeJS.Timeout | null = null;
  let frame = 0;
  let currentText = '';
  let startTime = Date.now();
  let isRunning = false;
  let shouldStop = false;

  function render(): void {
    if (!isRunning || shouldStop) return;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    process.stdout.write(`${CLEAR_LINE}${spinner} ${currentText} (${elapsed}s)`);
    frame++;
  }

  return {
    start(text = 'Thinking') {
      if (isRunning) return;
      isRunning = true;
      shouldStop = false;
      currentText = text;
      startTime = Date.now();
      frame = 0;
      render();
      interval = setInterval(render, 100);
    },

    stop() {
      if (!isRunning) return;
      // 先设置标记，防止 clearInterval 前 pending 的回调仍渲染
      shouldStop = true;
      isRunning = false;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      process.stdout.write(CLEAR_LINE);
    },

    update(text) {
      if (text) currentText = text;
    },
  };
}

// ============================================================================
// 工具调用行
// ============================================================================

export function toolLine(
  name: string,
  args: Record<string, unknown>,
  success: boolean,
  duration?: number,
): string {
  const argSummary = compactArgs(args);
  const status = success
    ? `${GREEN('✓')}${duration !== undefined ? ` ${duration}ms` : ''}`
    : `${RED('✗')}${duration !== undefined ? ` ${duration}ms` : ''}`;
  return `  ${ACCENT('▸')} ${ACCENT(name)} ${DIM(argSummary)} ${status}`;
}

function compactArgs(args: Record<string, unknown>): string {
  if (typeof args.path === 'string') {
    return args.path.length > 48 ? args.path.slice(0, 45) + '...' : args.path;
  }
  if (typeof args.command === 'string') {
    return args.command.length > 48 ? args.command.slice(0, 45) + '...' : args.command;
  }
  for (const val of Object.values(args)) {
    if (typeof val === 'string') {
      return val.length > 48 ? val.slice(0, 45) + '...' : val;
    }
  }
  return '';
}
