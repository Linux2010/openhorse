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
import { loadConfig, isConfigured } from './services/config';
import { ensureConfigDir } from './services/config-dir';
import { recordFirstStartTime, incrementSessionCount, addToInputHistory, getInputHistory } from './services/global-config';
import { calculateCtxPercent } from './services/model-context';
import { createSession, type SessionMeta, readSessionMessages, updateSessionSummary, endSession } from './services/session-storage';
import { loadAllMemories } from './memory/storage';
import { getSkillsRegistry } from './skills';
import { Store, subscribeToolState, resetToolState } from './framework';
import { findCommand, executeChat, getCommandNames } from './commands';
import { parseInput, buildCommandSuggestions } from './commands/parser';
import type { CommandContext } from './commands/types';
import { getModeDisplayText } from './commands/types';
import { renderHeaderBox, createSpinner, toolLine } from './ui/box';
import {
  showCommandPanel,
  hideCommandPanel,
  navigatePanel,
  selectCommand,
  updatePanelFilter,
  isPanelVisible,
  getPendingCommand,
  clearPendingCommand,
  redrawInputWithPrompt,
  resetRenderLength,
} from './ui/command-panel';
import {
  shouldEnterMultiline,
  enterMultiline,
  addMultilineLine,
  getMultilineInput,
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
} from './ui/file-completion';
import { renderStatusBar, type StatusBarStats } from './ui/status-bar';

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
  console.log();
  console.log(ACCENT('Options:'));
  console.log('  -h, --help     Show help');
  console.log('  -v, --version  Show version');
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

// ============================================================================
// 全局状态
// ============================================================================

let llm: LLMService | null = null;
let store: Store;
let currentSession: SessionMeta | null = null;
let runtime: OpenHorseRuntime;

// 输入状态
let currentInput: string = '';
let inputHistory: { content: string; timestamp: number }[] = [];
let historyIndex: number = -1;
let historyMode: 'none' | 'navigate' | 'search' = 'none';
let searchQuery: string = '';

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

  // 如果 key.name 为空，使用 char 作为 name
  if (!key.name && char) {
    key.name = char;
  }

  return key;
}

function handleKeypress(char: string | undefined, key: KeyInfo | undefined): void {
  const k = parseKey(char, key);

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
    case 'enter':
      const cmd = selectCommand();
      if (cmd) {
        currentInput = cmd;
        redrawInputWithPrompt(currentInput);
        // 直接执行命令
        handleInput(currentInput).catch(err => {
          console.log(ERROR(`Command error: ${err.message || String(err)}`));
        });
        currentInput = '';
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
        updatePanelFilter(currentInput.slice(1));
        redrawInputWithPrompt(currentInput);
      }
      break;
    default:
      // 添加字符到过滤
      if (char && char.length === 1 && !k.ctrl) {
        currentInput += char;
        updatePanelFilter(currentInput.slice(1));
        redrawInputWithPrompt(currentInput);
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

function handleNormalKeypress(k: KeyInfo, char: string | undefined): void {
  switch (k.name) {
    case 'enter':
      // 多行模式：添加行
      if (isMultilineActive()) {
        if (shouldEnterMultiline(currentInput)) {
          addMultilineLine(currentInput.slice(0, -1));
          currentInput = '';
          process.stdout.write('\r\x1b[2K');
          process.stdout.write(renderContinuationPrompt());
        } else {
          // 结束多行，发送完整输入
          addMultilineLine(currentInput);
          const fullInput = getMultilineInput();
          resetMultiline();
          if (fullInput.trim()) {
            // 回显多行输入
            process.stdout.write('\x1b[2K\r');
            const lines = fullInput.split('\n');
            for (const line of lines) {
              console.log(DIM('  ') + line);
            }

            // Issue #32 fix: 重置渲染长度，防止后续 redrawInputWithPrompt 清除用户输入
            resetRenderLength();
            handleInput(fullInput).catch(err => {
              console.log(ERROR(`Input error: ${err.message || String(err)}`));
            });
            addToInputHistory(fullInput);
            inputHistory = getInputHistory();
          }
          currentInput = '';
          redrawInputWithPrompt('');
        }
        return;
      }

      // 检查是否进入多行模式
      if (shouldEnterMultiline(currentInput)) {
        enterMultiline(currentInput);
        currentInput = '';
        process.stdout.write('\r\x1b[2K');
        process.stdout.write(renderContinuationPrompt());
        return;
      }

      // 正常发送输入
      if (currentInput.trim()) {
        // 先清除输入行的 prompt，然后打印用户输入（保存到终端历史）
        process.stdout.write('\x1b[2K\r');  // 清除当前 prompt 行
        console.log(ACCENT('❯ ') + currentInput);  // 回显用户输入

        // Issue #32 fix: 重置渲染长度，防止后续 redrawInputWithPrompt 清除用户输入行
        // 因为 console.log 打印后光标在新行，redrawInputWithPrompt 会从当前位置向上清除
        resetRenderLength();

        handleInput(currentInput);
        addToInputHistory(currentInput);
        inputHistory = getInputHistory();
        currentInput = '';
        redrawInputWithPrompt('');
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
        handleCtrlC();
      } else if (char) {
        currentInput += char;
        redrawInputWithPrompt(currentInput);
      }
      break;
    case '/':
      // Issue #30 fix: 只在输入为空时触发命令面板（即 `/` 是第一个字符）
      // 避免在 URL（http://）、路径（src/）、正则等场景误触发
      if (currentInput === '') {
        currentInput = '/';
        showCommandPanel('');
        // 命令面板已渲染，光标已在正确位置
        // 重置渲染长度并写入 `/` 符号
        resetRenderLength();
        process.stdout.write('/');
      } else {
        // 正常添加 `/` 到输入
        currentInput += '/';
        redrawInputWithPrompt(currentInput);
      }
      break;
    case '@':
      // 显示文件补全
      const baseInput = currentInput;
      currentInput += '@';
      showFileCompletion('', baseInput);
      redrawInputWithPrompt(currentInput);
      break;
    default:
      // 普通字符
      if (char && char.length === 1 && !k.ctrl && !k.meta) {
        currentInput += char;
        redrawInputWithPrompt(currentInput);
      }
  }
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
  process.stdout.write('\r\x1b[2K');
  process.stdout.write(ACCENT('❯ ') + DIM('[Search: ]'));
}

async function handleCtrlC(): Promise<void> {
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

// ============================================================================
// Banner
// ============================================================================

function showBanner() {
  const config = store.getSnapshot().config;
  const baseUrl = config.apiBaseUrl || '';

  console.log();
  console.log(renderHeaderBox({
    provider: baseUrl.includes('anthropic') ? 'Anthropic'
      : baseUrl.includes('openai') ? 'OpenAI'
      : baseUrl.includes('dashscope') ? 'Alibaba Cloud'
      : 'Custom',
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

async function handleInput(input: string) {
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
  };

  try {
    const parsed = parseInput(text);

    if (parsed.isCommand) {
      const cmd = findCommand(parsed.name);
      if (cmd) {
        const result = await cmd.execute(ctx, parsed.args);
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
  updateStatusBar();

  // 重新显示 prompt
  redrawInputWithPrompt(currentInput);
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
  console.log(renderStatusBar(stats));
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
  const cliConfig = loadConfig();

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

  currentSession = createSession(projectPath, cliConfig.model);
  incrementSessionCount();

  if (isConfigured(cliConfig)) {
    try {
      llm = new LLMService({
        apiKey: cliConfig.apiKey,
        baseUrl: cliConfig.apiBaseUrl,
        model: cliConfig.model,
        fallbackModel: cliConfig.fallbackModel,
      });
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
  redrawInputWithPrompt('');
}

main().catch(err => {
  console.error(ERROR('[OpenHorse] Fatal error:'), err);
  process.exit(1);
});