/**
 * openhorse - 命令行交互入口
 *
 * 简洁版 REPL，使用 readline + keypress 事件处理
 */

import 'dotenv/config';
import chalk from 'chalk';
import readline from 'readline';
import { readFileSync } from 'fs';
import { join } from 'path';
import { init, OpenHorseRuntime } from './init';
import { LLMService } from './services/llm';
import { TOOLS } from './tools';
import { mcpManager } from './tools/mcp';
import { loadConfig, isConfigured, type UIRenderer } from './services/config';
import { ensureConfigDir } from './services/config-dir';
import { recordFirstStartTime, incrementSessionCount, addToInputHistory, getInputHistory } from './services/global-config';
import { calculateCtxPercent, discoverModelContexts } from './services/model-context';
import { createSession, type SessionMeta, readSessionMessages, updateSessionSummary, endSession } from './services/session-storage';
import { loadAllMemories } from './memory/storage';
import { getSkillsRegistry } from './skills';
import { Store, subscribeToolState, resetToolState } from './framework';
import { findCommand, executeChat, getCommandNames } from './commands';
import { parseInput, buildCommandSuggestions } from './commands/parser';
import type { CommandContext, CommandResult } from './commands/types';
import { getModeDisplayText } from './commands/types';
import { renderHeaderBox, createSpinner, toolLine } from './ui/box';
import {
  showCommandPanel,
  hideCommandPanel,
  navigatePanel,
  selectCommand,
  completeSelectedCommand,
  updatePanelFilter,
  isPanelVisible,
  getPendingCommand,
  clearPendingCommand,
  redrawInputWithPrompt,
  clearRenderedInput,
  resetRenderLength,
  writeLinePreservingInput,
  writeOutputPreservingInput,
  setInputPromptRenderer,
  setInputRenderContextProvider,
  setInputStatusText,
} from './ui/command-panel';
import {
  shouldEnterMultiline,
  enterMultiline,
  addMultilineLine,
  getMultilineInput,
  getMultilineLines,
  resetMultiline,
  isMultilineActive,
  renderContinuationPrompt,
} from './ui/multiline-input';
import {
  showFileCompletion,
  hideFileCompletion,
  navigateFiles,
  selectFile,
  completeFile,
  updateFileQuery,
  isFileCompletionVisible,
  getBaseInput,
  getFileQuery,
  redrawInputWithFile,
  setFileCompletionPromptRenderer,
} from './ui/file-completion';
import { renderStatusBar, type StatusBarStats } from './ui/status-bar';
import { renderUserInputEcho, renderUserInputEchoFrame } from './ui/user-input';
import { renderSessionPicker, renderV2FooterHint, renderV2ShellHeader, renderV2Shortcuts, renderV2StatusBadge } from './ui-v2';
import { TurnController } from './runtime/turn-controller';

// Get version from package.json
const VERSION = (() => {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.1.14';
  } catch {
    return '0.1.14';
  }
})();

// ============================================================================
// 颜色常量
// ============================================================================

const BRAND = chalk.hex('#FF6B35');
const ACCENT = chalk.hex('#00D4AA');
const DIM = chalk.dim;
const ERROR = chalk.red;
const WARN = chalk.yellow;
const SUCCESS = chalk.green;

// ============================================================================
// CLI Help
// ============================================================================

function showCliHelp(): void {
  console.log();
  console.log(BRAND('openhorse') + DIM(` v${VERSION}`));
  console.log(DIM('  Universal Agent Harness Framework'));
  console.log();
  console.log(ACCENT('Usage:'));
  console.log('  openhorse              Start interactive REPL');
  console.log('  openhorse --help       Show this help message');
  console.log('  openhorse --version    Show version');
  console.log('  openhorse --ui v2      Enable UI v2 preview components');
  console.log();
  console.log(ACCENT('Options:'));
  console.log('  -h, --help     Show help');
  console.log('  -v, --version  Show version');
  console.log('  --ui <mode>    UI renderer: legacy | v2');
  console.log();
  console.log(ACCENT('Interactive Commands:'));
  console.log('  /help          Show available slash commands');
  console.log('  /status        Show system status');
  console.log('  /model [name]  Show or change model');
  console.log('  /chat <msg>    Send message to LLM');
  console.log('  /exit          Exit the REPL');
  console.log();
  console.log(DIM('Type /help in REPL for full command list.'));
  console.log();
}

function parseCliUIRenderer(args: string[]): UIRenderer | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = arg === '--ui'
      ? args[i + 1]
      : arg.startsWith('--ui=')
        ? arg.slice('--ui='.length)
        : undefined;

    if (value === undefined) continue;
    if (value === 'legacy' || value === 'v2') return value;

    console.error(ERROR(`Invalid --ui value: ${value}`));
    console.error(DIM('Expected one of: legacy, v2'));
    process.exit(1);
  }

  return undefined;
}

// ============================================================================
// 全局状态
// ============================================================================

let llm: LLMService | null = null;
let store: Store;
let currentSession: SessionMeta | null = null;
let runtime: OpenHorseRuntime;
const turnController = new TurnController();
let isShuttingDown = false;

// 输入状态
let currentInput: string = '';
let inputHistory: { content: string; timestamp: number }[] = [];
let historyIndex: number = -1;
let historyMode: 'none' | 'navigate' | 'search' = 'none';
let searchQuery: string = '';

interface ResumePickerState {
  visible: boolean;
  sessions: SessionMeta[];
  selectedIndex: number;
  title: string;
  showProject?: boolean;
  moreCount?: number;
  allProjects?: boolean;
}

let resumePickerState: ResumePickerState | null = null;
let resumePickerLines: string[] = [];
let resumePickerReservedHeight = 0;

function ensureCurrentSession(): SessionMeta {
  if (!currentSession) {
    currentSession = createSession(process.cwd(), store.getSnapshot().currentModel || store.getSnapshot().config.model);
    incrementSessionCount();
  }
  return currentSession;
}

function setCurrentSession(session: SessionMeta): void {
  currentSession = session;
}

function getCurrentSession(): SessionMeta | null {
  return currentSession;
}

function echoSubmittedInput(input: string): void {
  clearRenderedInput();
  const rendered = isV2UI()
    ? renderUserInputEchoFrame(input)
    : renderUserInputEcho(input);
  writeLinePreservingInput(rendered);
  if (isV2UI()) {
    redrawInputWithPrompt(currentInput);
  }
}

function isExitCommandInput(input: string): boolean {
  const parsed = parseInput(input.trim());
  if (!parsed.isCommand) return false;
  const cmd = findCommand(parsed.name);
  return cmd?.name === 'exit';
}

function submitInput(input: string): void {
  const submittedInput = input;
  currentInput = '';
  echoSubmittedInput(submittedInput);
  addToInputHistory(submittedInput);
  inputHistory = getInputHistory();

  if (turnController.hasActiveTurn()) {
    const text = submittedInput.trim();
    const parsed = parseInput(text);

    if (isExitCommandInput(text)) {
      void shutdownCli();
      return;
    }

    if (parsed.isCommand) {
      console.log(DIM('Command ignored while agent is running. Press Ctrl+C to interrupt first.'));
      redrawInputWithPrompt(currentInput);
      return;
    }

    if (text) {
      turnController.clearExitIntent();
      turnController.requestRevision(submittedInput);
      redrawInputWithPrompt(currentInput);
    }
    return;
  }

  void runInputTurn(submittedInput);
}

async function runInputTurn(input: string): Promise<void> {
  let nextInput: string | undefined = input;

  while (nextInput) {
    const turn = turnController.beginTurn(nextInput);
    store.setProcessing(true);

    try {
      await handleInput(nextInput, turn.abortSignal, { redrawPrompt: false, updateStatus: false });
    } catch (err: any) {
      console.log(ERROR(`Input error: ${err.message || String(err)}`));
    } finally {
      const revision = turnController.finishTurn(turn.id);
      store.setProcessing(false);

      if (revision && revision.trim()) {
        writeLinePreservingInput(DIM('Interrupted. Restarting with latest instruction...'));
        nextInput = revision;
      } else {
        nextInput = undefined;
      }
    }
  }

  updateStatusBar();
  redrawInputWithPrompt(currentInput);
}

// ============================================================================
// keypress 事件处理
// ============================================================================

interface KeyInfo {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  sequence: string;
}

function parseKey(char: string | undefined, key: KeyInfo | undefined): KeyInfo {
  const sequence = key?.sequence || char || '';
  if (sequence === '\x1b[13;2u') {
    return { name: 'enter', ctrl: false, shift: true, meta: false, sequence };
  }
  if (sequence === '\x1b[13;3u') {
    return { name: 'enter', ctrl: false, shift: false, meta: true, sequence };
  }

  if (!key) {
    // 手动解析
    if (char === '\r' || char === '\n') return { name: 'enter', ctrl: false, shift: false, meta: false, sequence: char || '' };
    if (char === '\x1b') return { name: 'escape', ctrl: false, shift: false, meta: false, sequence: char };
    if (char === '\t') return { name: 'tab', ctrl: false, shift: false, meta: false, sequence: char };
    if (char === '\x7f' || char === '\b') return { name: 'backspace', ctrl: false, shift: false, meta: false, sequence: char };
    return { name: char || '', ctrl: false, shift: false, meta: false, sequence: char || '' };
  }

  // 统一 "return" 和 "enter"
  if (key.name === 'return') {
    key.name = 'enter';
  }

  if (key.name === 'enter' && (key.shift || key.meta)) {
    return key;
  }

  // 如果 key.name 为空，使用 char 作为 name
  if (!key.name && char) {
    key.name = char;
  }

  return key;
}

function handleKeypress(char: string | undefined, key: KeyInfo | undefined): void {
  const k = parseKey(char, key);

  if (k.ctrl && k.name === 'l') {
    clearTerminalView();
    return;
  }

  if (k.ctrl && k.name === 'c') {
    void handleCtrlC();
    return;
  }

  // 命令面板模式
  if (isPanelVisible()) {
    handlePanelKeypress(k, char);
    return;
  }

  // 文件补全模式
  if (isFileCompletionVisible()) {
    handleFileCompletionKeypress(k, char);
    return;
  }

  // Resume session picker mode
  if (resumePickerState?.visible) {
    handleResumePickerKeypress(k, char);
    return;
  }

  // 历史导航模式
  if (historyMode !== 'none') {
    handleHistoryKeypress(k, char);
    return;
  }

  // 正常输入模式
  handleNormalKeypress(k, char);
}

function handlePanelKeypress(k: KeyInfo, char: string | undefined): void {
  switch (k.name) {
    case 'up':
      navigatePanel('up');
      break;
    case 'down':
      navigatePanel('down');
      break;
    case 'tab':
      const completedCmd = completeSelectedCommand();
      if (completedCmd) {
        currentInput = completedCmd;
        redrawInputWithPrompt(currentInput);
      }
      break;
    case 'enter':
      const cmd = selectCommand();
      if (cmd) {
        submitInput(cmd);
        clearPendingCommand();
      }
      break;
    case 'escape':
      hideCommandPanel();
      currentInput = '';
      redrawInputWithPrompt('');
      break;
    case 'backspace':
      currentInput = currentInput.slice(0, -1);
      if (currentInput.length <= 1) {
        hideCommandPanel();
        redrawInputWithPrompt(currentInput);
      } else {
        redrawInputWithPrompt(currentInput);
        updatePanelFilter(currentInput.slice(1));
      }
      break;
    default:
      // 添加字符到过滤
      if (char && char.length === 1 && !k.ctrl) {
        currentInput += char;
        redrawInputWithPrompt(currentInput);
        updatePanelFilter(currentInput.slice(1));
      }
  }
}

function handleHistoryKeypress(k: KeyInfo, char: string | undefined): void {
  if (historyMode === 'search') {
    // 搜索模式：输入搜索词
    switch (k.name) {
      case 'enter':
        if (inputHistory.length > 0 && historyIndex >= 0) {
          currentInput = inputHistory[historyIndex]?.content || '';
        }
        historyMode = 'none';
        searchQuery = '';
        redrawInputWithPrompt(currentInput);
        break;
      case 'escape':
        historyMode = 'none';
        searchQuery = '';
        currentInput = '';
        redrawInputWithPrompt('');
        break;
      case 'backspace':
        searchQuery = searchQuery.slice(0, -1);
        updateHistorySearch();
        break;
      default:
        if (char && char.length === 1 && !k.ctrl) {
          searchQuery += char;
          updateHistorySearch();
        }
    }
  } else {
    // 导航模式
    switch (k.name) {
      case 'up':
        historyIndex = Math.min(inputHistory.length - 1, historyIndex + 1);
        currentInput = inputHistory[historyIndex]?.content || '';
        redrawInputWithPrompt(currentInput);
        break;
      case 'down':
        historyIndex = Math.max(-1, historyIndex - 1);
        if (historyIndex < 0) {
          currentInput = '';
          historyMode = 'none';
        } else {
          currentInput = inputHistory[historyIndex]?.content || '';
        }
        redrawInputWithPrompt(currentInput);
        break;
      case 'enter':
        historyMode = 'none';
        redrawInputWithPrompt(currentInput);
        break;
      case 'escape':
        historyMode = 'none';
        currentInput = '';
        historyIndex = -1;
        redrawInputWithPrompt('');
        break;
    }
  }
}

function handleFileCompletionKeypress(k: KeyInfo, char: string | undefined): void {
  switch (k.name) {
    case 'up':
      navigateFiles('up');
      break;
    case 'down':
      navigateFiles('down');
      break;
    case 'tab':
      const completedPath = completeFile();
      if (completedPath) {
        currentInput = getBaseInput() + '@' + completedPath;
        hideFileCompletion();
        redrawInputWithPrompt(currentInput);
      } else {
        // 目录：继续显示面板，更新 query
        currentInput = getBaseInput() + '@' + getFileQuery();
        redrawInputWithPrompt(currentInput);
      }
      break;
    case 'enter':
      const selectedPath = selectFile();
      if (selectedPath) {
        currentInput = getBaseInput() + '@' + selectedPath;
        redrawInputWithPrompt(currentInput);
      }
      break;
    case 'escape':
      hideFileCompletion();
      currentInput = getBaseInput() + '@' + getFileQuery();
      redrawInputWithPrompt(currentInput);
      break;
    case 'backspace':
      const query = getFileQuery();
      if (query.length > 0) {
        updateFileQuery(query.slice(0, -1));
        currentInput = getBaseInput() + '@' + getFileQuery();
        redrawInputWithPrompt(currentInput);
      } else {
        hideFileCompletion();
        currentInput = getBaseInput();
        redrawInputWithPrompt(currentInput);
      }
      break;
    default:
      // 添加字符到路径查询
      if (char && char.length === 1 && !k.ctrl) {
        const newQuery = getFileQuery() + char;
        updateFileQuery(newQuery);
        currentInput = getBaseInput() + '@' + newQuery;
        redrawInputWithPrompt(currentInput);
      }
  }
}

function handleResumePickerKeypress(k: KeyInfo, char: string | undefined): void {
  if (!resumePickerState?.visible) return;

  switch (k.name) {
    case 'up':
      resumePickerState.selectedIndex = Math.max(0, resumePickerState.selectedIndex - 1);
      renderResumePicker();
      break;
    case 'down':
      resumePickerState.selectedIndex = Math.min(resumePickerState.sessions.length - 1, resumePickerState.selectedIndex + 1);
      renderResumePicker();
      break;
    case 'enter':
      restoreSelectedResumeSession();
      break;
    case 'escape':
      hideResumePicker();
      redrawInputWithPrompt(currentInput);
      break;
    default:
      if (char && /^[1-9]$/.test(char)) {
        const index = Number(char) - 1;
        if (index >= 0 && index < resumePickerState.sessions.length) {
          resumePickerState.selectedIndex = index;
          restoreSelectedResumeSession();
        }
      }
  }
}

function showResumePicker(options: NonNullable<CommandResult['sessionPicker']>): void {
  resumePickerState = {
    visible: true,
    sessions: options.sessions,
    selectedIndex: 0,
    title: options.title,
    showProject: options.showProject,
    moreCount: options.moreCount,
    allProjects: options.allProjects,
  };
  renderResumePicker();
}

function renderResumePicker(): void {
  if (!resumePickerState?.visible) return;

  clearResumePicker({ release: false });

  const lines = renderSessionPicker({
    title: resumePickerState.title,
    sessions: resumePickerState.sessions,
    selectedIndex: resumePickerState.selectedIndex,
    width: process.stdout.columns || 80,
    showProject: resumePickerState.showProject,
    moreCount: resumePickerState.moreCount,
    footer: '  ↑↓ Select  Enter Resume  1-9 Quick  Esc Cancel',
    theme: {
      accent: ACCENT,
      dim: DIM,
      selected: text => chalk.bgHex('#1E293B').hex('#E2E8F0')(text),
    },
  });

  const offset = getResumePickerOffsetRows();
  reserveResumePickerSpace(lines.length + offset);
  resumePickerLines = lines;

  process.stdout.write('\x1b7');
  if (offset > 0) {
    process.stdout.write(`\x1b[${offset}B\r`);
  }
  process.stdout.write('\x1b[J');
  for (let index = 0; index < lines.length; index++) {
    if (index > 0 || offset === 0) {
      process.stdout.write('\n');
    }
    process.stdout.write('\r' + lines[index]);
  }
  process.stdout.write('\x1b8');
}

function hideResumePicker(): void {
  clearResumePicker({ release: true });
  resumePickerState = null;
}

function clearResumePicker(options: { release?: boolean } = {}): void {
  const height = Math.max(resumePickerReservedHeight, resumePickerLines.length);
  if (height <= 0) return;

  process.stdout.write('\x1b7');
  const offset = getResumePickerOffsetRows();
  if (offset > 0) {
    process.stdout.write(`\x1b[${offset}B\r`);
  }
  process.stdout.write('\x1b[J');
  process.stdout.write('\x1b8');

  resumePickerLines = [];
  if (options.release) {
    resumePickerReservedHeight = 0;
  }
}

function reserveResumePickerSpace(requiredHeight: number): void {
  if (requiredHeight <= resumePickerReservedHeight) return;

  const extraLines = requiredHeight - resumePickerReservedHeight;
  process.stdout.write('\n'.repeat(extraLines));
  process.stdout.write(`\x1b[${extraLines}A`);
  resumePickerReservedHeight = requiredHeight;
}

function getResumePickerOffsetRows(): number {
  return isV2UI() ? 2 : 1;
}

function restoreSelectedResumeSession(): void {
  if (!resumePickerState?.visible) return;

  const session = resumePickerState.sessions[resumePickerState.selectedIndex];
  const suffix = resumePickerState.allProjects ? ' --all' : '';
  hideResumePicker();
  currentInput = '';
  clearRenderedInput();

  runInputTurn(`/resume ${session.id}${suffix}`).catch(err => {
    console.log(ERROR(`Resume error: ${err.message || String(err)}`));
    redrawInputWithPrompt(currentInput);
  });
}

function handleNormalKeypress(k: KeyInfo, char: string | undefined): void {
  switch (k.name) {
    case 'enter':
      if (k.shift || k.meta) {
        if (isV2UI()) {
          insertInputNewline();
        }
        return;
      }

      // 多行模式：添加行
      if (isMultilineActive()) {
        if (shouldEnterMultiline(currentInput)) {
          addMultilineLine(currentInput);
          currentInput = '';
          if (isV2UI()) {
            redrawInputWithPrompt(currentInput);
          } else {
            process.stdout.write('\r\x1b[2K');
            process.stdout.write(renderContinuationPrompt());
          }
        } else {
          // 结束多行，发送完整输入
          addMultilineLine(currentInput);
          const fullInput = getMultilineInput();
          resetMultiline();
          if (fullInput.trim()) {
            submitInput(fullInput);
          }
          currentInput = '';
        }
        return;
      }

      // 检查是否进入多行模式
      if (shouldEnterMultiline(currentInput)) {
        enterMultiline(currentInput);
        currentInput = '';
        if (isV2UI()) {
          redrawInputWithPrompt(currentInput);
        } else {
          process.stdout.write('\r\x1b[2K');
          process.stdout.write(renderContinuationPrompt());
        }
        return;
      }

      // 正常发送输入
      if (currentInput.trim()) {
        submitInput(currentInput);
      }
      break;
    case 'backspace':
      currentInput = currentInput.slice(0, -1);
      redrawInputWithPrompt(currentInput);
      break;
    case 'up':
      // 进入历史导航
      if (currentInput === '' && inputHistory.length > 0) {
        historyMode = 'navigate';
        historyIndex = 0;
        currentInput = inputHistory[0]?.content || '';
        redrawInputWithPrompt(currentInput);
      }
      break;
    case 'r':
      if (k.ctrl) {
        // Ctrl+R：搜索历史
        historyMode = 'search';
        searchQuery = '';
        showHistorySearchPrompt();
      } else if (char) {
        currentInput += char;
        redrawInputWithPrompt(currentInput);
      }
      break;
    case 'c':
      if (k.ctrl) {
        // Ctrl+C：取消多行或退出
        if (isMultilineActive()) {
          resetMultiline();
          currentInput = '';
          redrawInputWithPrompt('');
          console.log(DIM('(cancelled)'));
        } else {
          handleCtrlC();
        }
      } else if (char) {
        currentInput += char;
        redrawInputWithPrompt(currentInput);
      }
      break;
    case 'd':
      if (k.ctrl && currentInput === '') {
        // Ctrl+D：退出（空输入时）
        void shutdownCli();
      } else if (char) {
        currentInput += char;
        redrawInputWithPrompt(currentInput);
      }
      break;
    case '/':
      // Issue #30 fix: 只在输入为空时触发命令面板（即 `/` 是第一个字符）
      // 避免在 URL（http://）、路径（src/）、正则等场景误触发
      if (currentInput === '' && !turnController.hasActiveTurn()) {
        currentInput = '/';
        redrawInputWithPrompt(currentInput);
        showCommandPanel('');
      } else {
        // 正常添加 `/` 到输入
        currentInput += '/';
        redrawInputWithPrompt(currentInput);
      }
      break;
    case '@':
      // 显示文件补全
      if (turnController.hasActiveTurn()) {
        currentInput += '@';
        redrawInputWithPrompt(currentInput);
      } else {
        const baseInput = currentInput;
        currentInput += '@';
        showFileCompletion('', baseInput);
        redrawInputWithPrompt(currentInput);
      }
      break;
    case '?':
      if (currentInput === '' && store.getSnapshot().config.ui?.renderer === 'v2' && !turnController.hasActiveTurn()) {
        showV2Shortcuts();
      } else {
        currentInput += '?';
        redrawInputWithPrompt(currentInput);
      }
      break;
    default:
      // 普通字符
      if (char && char.length === 1 && !k.ctrl && !k.meta) {
        currentInput += char;
        redrawInputWithPrompt(currentInput);
      }
  }
}

function insertInputNewline(): void {
  currentInput += '\n';
  redrawInputWithPrompt(currentInput);
}

function updateHistorySearch(): void {
  if (searchQuery) {
    const allHistory = getInputHistory();
    const matches = allHistory.filter(h => h.content.toLowerCase().includes(searchQuery.toLowerCase()));
    historyIndex = 0;
    currentInput = matches[0]?.content || '';
    // Don't replace inputHistory — just display filtered results
  } else {
    historyIndex = -1;
    currentInput = '';
  }
  redrawInputWithPrompt(currentInput, `[Search: ${searchQuery}]`);
}

function showHistorySearchPrompt(): void {
  clearRenderedInput();
  redrawInputWithPrompt('', '[Search: ]');
}

function isV2UI(): boolean {
  return store.getSnapshot().config.ui?.renderer === 'v2';
}

function showV2Shortcuts(): void {
  console.log();
  console.log(renderV2Shortcuts(process.stdout.columns || 80));
  redrawInputWithPrompt(currentInput);
}

function clearTerminalView(): void {
  hideCommandPanel();
  hideFileCompletion();
  resetRenderLength();
  process.stdout.write('\x1Bc');
  showBanner();
  if (isV2UI()) {
    console.log(DIM('  View cleared. Conversation context is preserved.'));
    console.log(renderV2FooterHint(process.stdout.columns || 80));
  } else {
    console.log(DIM('  View cleared. Conversation context is preserved.'));
  }
  console.log();
  redrawInputWithPrompt(currentInput);
}

function cancelActiveInputMode(): boolean {
  if (isMultilineActive()) {
    resetMultiline();
    currentInput = '';
    console.log(DIM('(cancelled)'));
    redrawInputWithPrompt('');
    return true;
  }

  if (isPanelVisible()) {
    hideCommandPanel();
    clearPendingCommand();
    currentInput = '';
    redrawInputWithPrompt('');
    return true;
  }

  if (isFileCompletionVisible()) {
    hideFileCompletion();
    currentInput = getBaseInput() + '@' + getFileQuery();
    redrawInputWithPrompt(currentInput);
    return true;
  }

  if (resumePickerState?.visible) {
    hideResumePicker();
    redrawInputWithPrompt(currentInput);
    return true;
  }

  if (historyMode !== 'none') {
    historyMode = 'none';
    searchQuery = '';
    historyIndex = -1;
    redrawInputWithPrompt(currentInput);
    return true;
  }

  return false;
}

async function shutdownCli(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // 保存会话摘要后退出
  if (currentSession) {
    const messages = readSessionMessages(currentSession.id);
    if (messages.length > 0) {
      updateSessionSummary(currentSession.id, messages);
    }
    endSession(currentSession.id);
  }

  // 关闭 stdin raw mode 并退出
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();

  console.log();
  console.log(DIM('Shutting down...'));
  mcpManager.disconnectAll();
  await runtime.shutdown();
  console.log(SUCCESS('Goodbye! 🐴'));
  process.exit(0);
}

async function handleCtrlC(): Promise<void> {
  if (cancelActiveInputMode()) {
    turnController.clearExitIntent();
    return;
  }

  if (turnController.hasActiveTurn()) {
    const shouldExit = turnController.registerExitIntent();
    turnController.interruptActiveTurn();

    if (shouldExit) {
      await shutdownCli();
      return;
    }

    writeLinePreservingInput(DIM('Interrupted. Press Ctrl+C again to exit.'));
    redrawInputWithPrompt(currentInput);
    return;
  }

  if (turnController.registerExitIntent()) {
    await shutdownCli();
    return;
  }

  writeLinePreservingInput(DIM('Press Ctrl+C again to exit.'));
  redrawInputWithPrompt(currentInput);
}

// ============================================================================
// Banner
// ============================================================================

function showBanner() {
  const config = store.getSnapshot().config;
  const baseUrl = config.apiBaseUrl || '';
  const provider = baseUrl.includes('anthropic') ? 'Anthropic'
    : baseUrl.includes('openai') ? 'OpenAI'
    : baseUrl.includes('dashscope') ? 'Alibaba Cloud'
    : 'Custom';

  if (config.ui?.renderer === 'v2') {
    console.log();
    console.log(renderV2ShellHeader({
      provider,
      model: config.model,
      projectPath: process.cwd(),
      status: llm ? 'ready' : 'loading',
      statusText: llm ? 'ready' : 'Set OPENHORSE_API_KEY',
      version: VERSION,
    }));
    return;
  }

  console.log();
  console.log(renderHeaderBox({
    provider,
    model: config.model,
    endpoint: baseUrl,
    status: llm ? 'ready' : 'loading',
    statusText: llm ? undefined : 'Set OPENHORSE_API_KEY in .env',
    version: VERSION,
  }));
}

// ============================================================================
// 输入处理
// ============================================================================

function getPrompt(): string {
  const mode = store.getSnapshot().permissionMode;
  const modeText = getModeDisplayText(mode);
  const modeIndicator = modeText ? `[${modeText}] ` : '';
  return ACCENT('❯ ') + DIM(modeIndicator);
}

interface HandleInputOptions {
  redrawPrompt?: boolean;
  updateStatus?: boolean;
}

async function handleInput(input: string, abortSignal?: AbortSignal, options: HandleInputOptions = {}) {
  const redrawPrompt = options.redrawPrompt !== false;
  const shouldUpdateStatus = options.updateStatus !== false;
  const text = input.trim();
  if (!text) return;

  // 不在这里打印输入，readline 已经显示了
  // 直接交给 executeChat 处理，它有自己的 spinner 和流式输出

  const ctx: CommandContext = {
    cwd: process.cwd(),
    config: store.getSnapshot().config,
    store,
    llm,
    runtime,
    sessionId: currentSession?.id,
    ensureSession: ensureCurrentSession,
    setSession: setCurrentSession,
    getSession: getCurrentSession,
    abortSignal,
    writeOutput: writeOutputPreservingInput,
    writeLine: writeLinePreservingInput,
  };

  let pendingSessionPicker: CommandResult['sessionPicker'] | undefined;

  try {
    const parsed = parseInput(text);

    if (parsed.isCommand) {
      const cmd = findCommand(parsed.name);
      if (cmd) {
        const result = await cmd.execute(ctx, parsed.args);
        pendingSessionPicker = result.sessionPicker;
        // executeChat 会被 cmd.execute 调用，如果需要
        if (!result.continueAsChat) {
          // 命令完成后的输出已经在 cmd.execute 中处理
        }
      } else {
        console.log();
        console.log(ERROR(`Unknown command: /${parsed.name}`));
        const suggestions = buildCommandSuggestions(parsed.name);
        if (suggestions.length > 0) {
          console.log(DIM(`Did you mean: ${suggestions.map(s => `/${s}`).join(', ')}?`));
        }
        console.log();
      }
    } else {
      // 直接 chat - executeChat 有自己的 spinner 和流式输出
      await executeChat(ctx, text);
    }
  } catch (err: any) {
    console.log(ERROR(`Error: ${err.message || String(err)}`));
  }

  // 显示状态栏
  if (shouldUpdateStatus) {
    updateStatusBar();
  }

  // 重新显示 prompt
  if (redrawPrompt) {
    redrawInputWithPrompt(currentInput);
  }
  if (pendingSessionPicker) {
    showResumePicker(pendingSessionPicker);
  }
}

/**
 * 更新状态栏显示
 */
function updateStatusBar(): void {
  const snapshot = store.getSnapshot();
  const usage = snapshot.tokenUsage;
  const costStats = snapshot.costTracker.getSessionStats();
  const mcpStatus = mcpManager.getStatus();

  const stats: StatusBarStats = {
    model: snapshot.currentModel,
    tokens: usage ? usage.promptTokens + usage.completionTokens : 0,
    promptTokens: usage?.promptTokens || 0,
    completionTokens: usage?.completionTokens || 0,
    cost: costStats.totalCost,
    ctxPercent: calculateCtxPercent(
      usage ? usage.promptTokens + usage.completionTokens : 0,
      snapshot.currentModel || 'gpt-4o'
    ),
    mcpConnected: mcpStatus.filter(s => s.connected).length,
    mcpTotal: mcpStatus.length,
  };

  // 在 prompt 上一行显示状态栏
  if (snapshot.config.ui?.renderer === 'v2') {
    setInputStatusText(renderV2StatusBadge({
      ...stats,
      sessionId: currentSession?.id,
      modeText: getModeDisplayText(snapshot.permissionMode) || undefined,
      width: process.stdout.columns || 80,
    }));
  } else {
    console.log(renderStatusBar(stats));
  }
}

// 接口变量（用于兼容性，主要逻辑通过 keypress 处理）
let rl: readline.Interface | null = null;

// ============================================================================
// 主入口
// ============================================================================

async function main(): Promise<void> {
  // Parse command line arguments
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    showCliHelp();
    process.exit(0);
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(`openhorse v${VERSION}`);
    process.exit(0);
  }

  ensureConfigDir();
  recordFirstStartTime();

  const projectPath = process.cwd();
  const uiRenderer = parseCliUIRenderer(args);
  const cliConfig = loadConfig(uiRenderer ? { ui: { renderer: uiRenderer } } : {});
  setInputPromptRenderer(cliConfig.ui?.renderer === 'v2' ? 'v2' : 'legacy');
  setInputRenderContextProvider(() => (
    cliConfig.ui?.renderer === 'v2' && isMultilineActive()
      ? { prefixLines: getMultilineLines() }
      : {}
  ));
  setFileCompletionPromptRenderer(cliConfig.ui?.renderer === 'v2' ? 'v2' : 'legacy');

  // Load project memory
  const memories = loadAllMemories(projectPath);
  const memoryContent = memories.length > 0
    ? memories.map(m => `## ${m.name} (${m.type})\n${m.content}`).join('\n\n')
    : '';

  // Load skills (builtin + user + project) and render the prompt section
  let skillsContent = '';
  try {
    const registry = getSkillsRegistry();
    skillsContent = registry.generateSystemPromptInjection();
  } catch (err: any) {
    console.error(WARN(`⚠ Skills load error: ${err.message}`));
  }

  store = new Store({
    config: cliConfig,
    tools: TOOLS,
    currentModel: cliConfig.model,
    memoryContent,
    skillsContent,
  });

  // Mirror tool-state (todos/plan) into Store so the UI can observe it
  resetToolState();
  subscribeToolState((s) => {
    store.setState({
      todos: s.todos,
      planMode: s.planMode,
      currentPlan: s.currentPlan,
    });
  });

  if (isConfigured(cliConfig)) {
    try {
      llm = new LLMService({
        apiKey: cliConfig.apiKey,
        baseUrl: cliConfig.apiBaseUrl,
        model: cliConfig.model,
        fallbackModel: cliConfig.fallbackModel,
      });

      // 动态发现模型上下文窗口（非阻塞）
      if (cliConfig.apiBaseUrl) {
        discoverModelContexts(cliConfig.apiBaseUrl, cliConfig.apiKey)
          .then(models => {
            if (models.length > 0) {
              console.log(`  Discovered ${models.length} models from API`);
            }
          })
          .catch(() => {}); // 静默失败，回退到内置数据库
      }
    } catch (err: any) {
      console.log(WARN(`⚠ LLM initialization warning: ${err.message}`));
    }
  }

  const config = store.getSnapshot().config;
  runtime = await init({
    name: config.name,
    mode: config.mode as any,
    logLevel: config.logLevel,
  });

  await runtime.start();

  // Auto-connect MCP servers from ~/.openhorse/mcp.json (non-blocking)
  mcpManager.connectAll().catch(err => {
    console.error(WARN(`⚠ MCP startup error: ${err.message}`));
  });

  // Banner
  showBanner();

  // 提示
  console.log(SUCCESS('✔ System initialized'));
  console.log(DIM('  Type /help for commands, /exit to quit'));
  if (cliConfig.ui?.renderer === 'v2') {
    console.log(DIM('  UI v2 preview enabled: command palette and session picker'));
    console.log(renderV2FooterHint(process.stdout.columns || 80));
  }
  if (!isConfigured(cliConfig)) {
    console.log(WARN('  ⚠ LLM not configured — set OPENHORSE_API_KEY'));
  }
  console.log();

  // 加载输入历史
  inputHistory = getInputHistory();

  // 启用 keypress 事件处理
  // 使用 emitKeypressEvents + setRawMode 实现交互式功能
  readline.emitKeypressEvents(process.stdin);

  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
    } catch (err: any) {
      console.error(ERROR(`setRawMode failed: ${err.message}`));
    }
  } else {
    console.log(WARN('⚠ stdin is not TTY - interactive features disabled'));
  }
  process.stdin.resume();

  // 监听 keypress 事件
  process.stdin.on('keypress', (char: string | undefined, key: any) => {
    try {
      handleKeypress(char, key);
    } catch (err: any) {
      console.error(ERROR(`Keypress error: ${err.message}`));
    }
  });

  // 初始 prompt
  if (cliConfig.ui?.renderer === 'v2') {
    updateStatusBar();
  }
  redrawInputWithPrompt('');
}

main().catch(err => {
  console.error(ERROR('[OpenHorse] Fatal error:'), err);
  process.exit(1);
});
