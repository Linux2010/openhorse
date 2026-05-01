/**
 * openhorse - UI 组件
 *
 * 参考 Claude Code 风格的 CLI 界面：
 *   - 用户消息框（带圆角边框）
 *   - Thinking 动画（ASCII spinner）
 *   - 工具调用块（带状态显示）
 */

import chalk from 'chalk';

// ============================================================================
// 颜色常量
// ============================================================================

const ACCENT = chalk.hex('#00D4AA');
const CYAN = chalk.cyan;
const DIM = chalk.dim;
const GRAY = chalk.hex('#4B5563');
const GREEN = chalk.green;
const RED = chalk.red;

// Unicode 框绘制字符
const BOX = {
  TL: '╭', TR: '╮',
  BL: '╰', BR: '╯',
  H: '─', V: '│',
};

// ASCII Spinner 动画帧
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ============================================================================
// 用户消息框
// ============================================================================

/**
 * 渲染用户消息框
 *
 * ```
 * ╭─ You ───────────────────────────────────────╮
 * │  列出 src/ 目录中的文件                      │
 * ╰─────────────────────────────────────────────╯
 * ```
 */
export function userBox(text: string, width = 72): string {
  const label = ' You ';
  const lineWidth = Math.max(width, text.length + 4 + label.length);

  // 顶部边框
  const topBorder = BOX.TL + BOX.H + label + BOX.H.repeat(lineWidth - label.length - 2) + BOX.TR;

  // 内容行（自动换行）
  const contentWidth = lineWidth - 6; // 减去 "│  " 和前后空格
  const lines = wrapText(text, contentWidth);
  const contentLines = lines.map(line =>
    `│  ${line}${' '.repeat(Math.max(0, contentWidth - line.length))}  │`
  );

  // 底部边框
  const bottomBorder = BOX.BL + BOX.H.repeat(lineWidth - 2) + BOX.BR;

  return [topBorder, ...contentLines, bottomBorder].join('\n');
}

// ============================================================================
// Thinking Spinner
// ============================================================================

export interface Spinner {
  /** 开始 spinner 动画 */
  start: (text?: string) => void;
  /** 停止并清除 spinner，返回已写入的字符数（用于回退覆盖） */
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

  return {
    start(text = 'Thinking') {
      currentText = text;
      startTime = Date.now();

      interval = setInterval(() => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
        const dots = '.'.repeat((frame % 4));

        // 清除当前行
        process.stdout.write(`\r${' '.repeat(80)}\r`);
        process.stdout.write(`${GRAY(spinner)} ${currentText}${dots} (${elapsed}s)`);

        frame++;
      }, 100);
    },

    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }

      // 清除 spinner 行
      process.stdout.write(`\r${' '.repeat(80)}\r`);
    },

    update(text) {
      if (text) currentText = text;
    },
  };
}

// ============================================================================
// 工具调用块
// ============================================================================

/**
 * 渲染工具调用块
 *
 * ```
 * ╭─ read_file ─────────────────────────────────╮
 * │  path: "src/index.ts"                        │
 * │  ✓ OK                                        │
 * ╰──────────────────────────────────────────────╯
 * ```
 */
export function toolBlock(
  name: string,
  args: Record<string, unknown>,
  success: boolean,
  duration?: number,
  width = 68,
): string {
  const topLabel = `─ ${name} `;
  const lineWidth = width;

  // 顶部边框
  const topBorder = BOX.TL + topLabel + BOX.H.repeat(lineWidth - topLabel.length - 2) + BOX.TR;

  // 参数行
  const contentLines: string[] = [];
  const contentWidth = lineWidth - 6;

  for (const [key, value] of Object.entries(args)) {
    const argLine = `${key}: ${JSON.stringify(value).slice(0, 120)}`;
    contentLines.push(`│  ${argLine}${' '.repeat(Math.max(0, contentWidth - argLine.length))}  │`);
  }

  // 状态行
  const statusText = success
    ? `${GREEN('✓')} OK${duration !== undefined ? ` (${duration}ms)` : ''}`
    : `${RED('✗')} Failed${duration !== undefined ? ` (${duration}ms)` : ''}`;
  contentLines.push(`│  ${statusText}${' '.repeat(Math.max(0, contentWidth - statusText.length))}  │`);

  // 底部边框
  const bottomBorder = BOX.BL + BOX.H.repeat(lineWidth - 2) + BOX.BR;

  return [topBorder, ...contentLines, bottomBorder].join('\n');
}

// ============================================================================
// 内部辅助
// ============================================================================

/** 文本换行 */
function wrapText(text: string, maxWidth: number): string[] {
  if (text.length <= maxWidth) return [text];

  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const testLine = current ? `${current} ${word}` : word;
    if (testLine.length > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = testLine;
    }
  }

  if (current) lines.push(current);
  return lines;
}
