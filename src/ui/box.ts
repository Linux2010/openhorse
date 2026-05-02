/**
 * openhorse - UI 组件
 *
 * 参考 Claude Code 风格的 CLI 界面：
 *   - 用户消息直接内联显示（❯ 前缀）
 *   - Thinking 动画（ASCII spinner）
 *   - 工具调用紧凑单行显示（▸ name  args  ✓ 123ms）
 */

import chalk from 'chalk';

// ============================================================================
// 颜色常量
// ============================================================================

const ACCENT = chalk.hex('#00D4AA');
const DIM = chalk.dim;
const GRAY = chalk.hex('#6B7280');
const GREEN = chalk.green;
const RED = chalk.red;

// ASCII Spinner 动画帧
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ============================================================================
// Thinking Spinner
// ============================================================================

export interface Spinner {
  /** 开始 spinner 动画 */
  start: (text?: string) => void;
  /** 停止 spinner，清除动画行并换行 */
  stop: () => void;
  /** 更新 spinner 文本 */
  update: (text?: string) => void;
}

/**
 * 创建 Thinking spinner
 *
 * ```
 * ⠋ Thinking...
 * ```
 */
export function createSpinner(): Spinner {
  let interval: NodeJS.Timeout | null = null;
  let frame = 0;
  let currentText = '';
  let startTime = Date.now();
  let isRunning = false;

  function render(): void {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    const line = ` ${spinner} ${currentText} (${elapsed}s)`;

    process.stdout.write(`\r${' '.repeat(100)}\r${line}`);
    frame++;
  }

  return {
    start(text = 'Thinking') {
      if (isRunning) return;
      isRunning = true;
      currentText = text;
      startTime = Date.now();
      frame = 0;

      render();
      interval = setInterval(render, 100);
    },

    stop() {
      if (!isRunning) return;
      isRunning = false;

      if (interval) {
        clearInterval(interval);
        interval = null;
      }

      // 清除 spinner 行，换到下一行
      process.stdout.write(`\r${' '.repeat(100)}\r\n`);
    },

    update(text) {
      if (text) currentText = text;
    },
  };
}

// ============================================================================
// 紧凑工具调用行
// ============================================================================

/**
 * 渲染紧凑的工具调用行
 *
 * ```
 *   ▸ read_file  path: src/index.ts  ✓ 234ms
 * ```
 */
export function toolLine(
  name: string,
  args: Record<string, unknown>,
  success: boolean,
  duration?: number,
): string {
  const argSummary = compactArgs(name, args);
  const status = success
    ? `${GREEN('✓')}${duration !== undefined ? ` ${duration}ms` : ''}`
    : `${RED('✗')}${duration !== undefined ? ` ${duration}ms` : ''}`;

  return `  ${ACCENT('▸')} ${ACCENT(name)} ${DIM(argSummary)} ${status}`;
}

/** 渲染进行中的工具调用行 */
export function toolLineInProgress(name: string, args: Record<string, unknown>): string {
  const argSummary = compactArgs(name, args);
  const spinner = SPINNER_FRAMES[0];
  return `  ${GRAY(spinner)} ${ACCENT(name)} ${DIM(argSummary)} ${DIM('...')}`;
}

/** 将工具参数摘要为简短可读字符串 */
function compactArgs(name: string, args: Record<string, unknown>): string {
  // 优先取 path 参数（文件类工具）
  if (typeof args.path === 'string') {
    return args.path.length > 48 ? args.path.slice(0, 45) + '...' : args.path;
  }
  // exec_command 取 command 的前 48 字符
  if (typeof args.command === 'string') {
    return args.command.length > 48 ? args.command.slice(0, 45) + '...' : args.command;
  }
  // fallback：取第一个字符串值
  for (const val of Object.values(args)) {
    if (typeof val === 'string') {
      return val.length > 48 ? val.slice(0, 45) + '...' : val;
    }
  }
  return '';
}
