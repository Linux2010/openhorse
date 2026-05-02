/**
 * openhorse - UI 组件
 *
 * 输出流设计：
 *   ╔════════════════════════════════════════════════════════╗
 *   │ Provider  Anthropic                                    │
 *   │ Model     glm-5                                        │
 *   │ Endpoint  https://coding.dashscope.aliyuncs.c...       │
 *   ╠════════════════════════════════════════════════════════╣
 *   │ ● cloud    Ready — type /help to begin                 │
 *   ╚════════════════════════════════════════════════════════╝
 *     openhorse v0.1.0
 *
 *   ─────────────────────────────────────────────────────────
 *   ❯
 *   ─────────────────────────────────────────────────────────
 *     ? for shortcuts                                         ● In file.ts
 */

import chalk from 'chalk';

// ============================================================================
// 颜色常量
// ============================================================================

const BRAND = chalk.hex('#FF6B35');
const ACCENT = chalk.hex('#00D4AA');
const DIM = chalk.dim;
const GREEN = chalk.green;
const RED = chalk.red;
const YELLOW = chalk.yellow;
const CYAN = chalk.cyan;

// Box drawing characters (double-line)
const BOX_TOP_LEFT = '╔';
const BOX_TOP_RIGHT = '╗';
const BOX_BOTTOM_LEFT = '╚';
const BOX_BOTTOM_RIGHT = '╝';
const BOX_LEFT = '║';
const BOX_RIGHT = '║';
const BOX_TOP = '═';
const BOX_BOTTOM = '═';
const BOX_MIDDLE_LEFT = '╠';
const BOX_MIDDLE_RIGHT = '╣';
const BOX_MIDDLE = '═';

// Single line for separators
const SEP_LINE = '─';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// 使用终端控制码清除整行，避免宽字符（中文）残留
const CLEAR_LINE = '\x1b[2K\r';

// ============================================================================
// Header Box
// ============================================================================

export interface HeaderBoxConfig {
  provider: string;
  model: string;
  endpoint: string;
  status: 'ready' | 'loading' | 'error' | 'processing';
  statusText?: string;
  version: string;
  width?: number;
}

/**
 * Renders a header box with Provider/Model/Endpoint info
 */
export function renderHeaderBox(config: HeaderBoxConfig): string {
  const width = config.width || 60;
  const innerWidth = width - 4; // Account for ╔ and ╗

  const lines: string[] = [];

  // Top border
  lines.push(`${BOX_TOP_LEFT}${BOX_TOP.repeat(innerWidth)}${BOX_TOP_RIGHT}`);

  // Provider row
  const providerVal = truncateRight(config.provider, innerWidth - 12);
  lines.push(`${BOX_LEFT}${ACCENT(' Provider')}  ${DIM(' ' + providerVal.padEnd(innerWidth - 11))}${BOX_RIGHT}`);

  // Model row
  const modelVal = truncateRight(config.model, innerWidth - 12);
  lines.push(`${BOX_LEFT}${ACCENT(' Model')}     ${DIM(' ' + modelVal.padEnd(innerWidth - 11))}${BOX_RIGHT}`);

  // Endpoint row (truncate long URLs)
  const endpointVal = truncateRight(config.endpoint, innerWidth - 12);
  lines.push(`${BOX_LEFT}${ACCENT(' Endpoint')}  ${DIM(' ' + endpointVal.padEnd(innerWidth - 11))}${BOX_RIGHT}`);

  // Middle separator
  lines.push(`${BOX_MIDDLE_LEFT}${BOX_MIDDLE.repeat(innerWidth)}${BOX_MIDDLE_RIGHT}`);

  // Status row
  const statusIcon = config.status === 'ready' ? GREEN('●')
    : config.status === 'loading' ? YELLOW('○')
    : config.status === 'error' ? RED('●')
    : config.status === 'processing' ? ACCENT('◌')
    : DIM('○');
  const statusText = config.statusText || 'Ready — type /help to begin';
  // Build status content: icon + " cloud    " + statusText
  const statusContent = ` ${statusIcon} cloud    ${statusText}`;
  const statusVisibleLen = stringWidth(statusContent);
  const statusPadding = innerWidth - statusVisibleLen - 1; // -1 for left space
  lines.push(`${BOX_LEFT}${DIM(' ' + statusIcon + ' cloud    ')}${DIM(statusText)}${' '.repeat(Math.max(0, statusPadding))}${BOX_RIGHT}`);

  // Bottom border
  lines.push(`${BOX_BOTTOM_LEFT}${BOX_BOTTOM.repeat(innerWidth)}${BOX_BOTTOM_RIGHT}`);

  // Version line
  lines.push(`  ${BRAND('openhorse')} ${DIM('v' + config.version)}`);

  return lines.join('\n');
}

/**
 * Renders the full prompt area with separators
 * Returns { topSep, promptLine, bottomSep }
 */
export function renderPromptArea(modeText?: string): { topSep: string; promptLine: string; bottomSep: string } {
  const terminalWidth = process.stdout.columns || 80;
  const modeIndicator = modeText ? ` [${modeText}]` : '';
  const promptChar = '❯';

  // Top separator line
  const topSep = DIM(SEP_LINE.repeat(terminalWidth));

  // Prompt line: centered ❯ with mode indicator
  const promptLine = `${ACCENT(promptChar)}${modeIndicator ? DIM(modeIndicator) : ''}`;

  // Bottom separator line
  const bottomSep = DIM(SEP_LINE.repeat(terminalWidth));

  return { topSep, promptLine, bottomSep };
}

/**
 * Renders the input separator line with prompt (legacy, single-line version)
 */
export function renderPromptSeparator(modeText?: string): string {
  const terminalWidth = process.stdout.columns || 80;
  const modeIndicator = modeText ? DIM(`[${modeText}] `) : '';
  const promptChar = ACCENT('❯');
  const leftSep = SEP_LINE.repeat(10);
  const rightSepLength = terminalWidth - 12 - (modeText ? modeText.length + 3 : 0);
  const rightSep = SEP_LINE.repeat(Math.max(0, rightSepLength));

  return `${DIM(leftSep)} ${promptChar}${modeIndicator} ${DIM(rightSep)}`;
}

/**
 * Renders the footer bar with shortcuts and context
 */
export function renderFooterBar(contextFile?: string, effort?: string): string {
  const terminalWidth = process.stdout.columns || 80;

  // Left side: shortcuts hint
  const shortcuts = DIM('? for shortcuts');

  // Right side: file context and effort
  let rightSide = '';
  if (contextFile) {
    const fileIndicator = truncateLeft(contextFile, 30);
    rightSide += `${ACCENT('⧉')} ${DIM('In ' + fileIndicator)}`;
  }
  if (effort) {
    rightSide += `  ${ACCENT('●')} ${DIM(effort)}`;
  }

  // Calculate spacing
  const leftLen = stringWidth(shortcuts);
  const rightLen = stringWidth(rightSide);
  const spacing = Math.max(1, terminalWidth - leftLen - rightLen - 2);

  return `  ${shortcuts}${' '.repeat(spacing)}${rightSide}`;
}

/**
 * Truncate string from right side, adding ... if truncated
 */
function truncateRight(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/**
 * Truncate string from left side, adding ... if truncated
 */
function truncateLeft(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return '...' + str.slice(-(maxLen - 3));
}

/**
 * Get visible width of string (ANSI codes excluded)
 */
function stringWidth(str: string): number {
  // Remove ANSI escape codes
  const clean = str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  return clean.length;
}

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
