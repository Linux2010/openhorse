/**
 * openhorse - 命令行交互入口
 *
 * 简洁版 REPL，使用 readline 标准方式
 */

import 'dotenv/config';
import chalk from 'chalk';
import figlet from 'figlet';
import readline from 'readline';
import { readFileSync } from 'fs';
import { join } from 'path';
import { init, OpenHorseRuntime } from './init';
import { LLMService } from './services/llm';
import { TOOLS } from './tools';
import { mcpManager } from './tools/mcp';
import { loadConfig, isConfigured } from './services/config';
import { ensureConfigDir } from './services/config-dir';
import { recordFirstStartTime, incrementSessionCount } from './services/global-config';
import { createSession, type SessionMeta, readSessionMessages, updateSessionSummary, endSession } from './services/session-storage';
import { loadAllMemories } from './memory/storage';
import { getSkillsRegistry } from './skills';
import { Store, subscribeToolState, resetToolState } from './framework';
import { findCommand, executeChat, getCommandNames } from './commands';
import { parseInput, buildCommandSuggestions } from './commands/parser';
import type { CommandContext } from './commands/types';
import { getModeDisplayText } from './commands/types';
import { renderHeaderBox } from './ui/box';

// Get version from package.json
const VERSION = (() => {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.1.3';
  } catch {
    return '0.1.3';
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
// 全局状态
// ============================================================================

let llm: LLMService | null = null;
let store: Store;
let currentSession: SessionMeta | null = null;
let runtime: OpenHorseRuntime;

// ============================================================================
// Banner
// ============================================================================

function showBanner() {
  const art = figlet.textSync('OPENHORSE', { font: 'standard' });
  console.log(BRAND(art));
  console.log();

  const config = store.getSnapshot().config;
  const baseUrl = config.apiBaseUrl || '';
  const headerBox = renderHeaderBox({
    provider: baseUrl.includes('anthropic') ? 'Anthropic'
      : baseUrl.includes('openai') ? 'OpenAI'
      : baseUrl.includes('dashscope') ? 'Alibaba Cloud'
      : 'Custom',
    model: config.model,
    endpoint: baseUrl,
    status: llm ? 'ready' : 'loading',
    statusText: llm ? undefined : 'Set OPENHORSE_API_KEY in .env',
    version: VERSION,
  });
  console.log(headerBox);
  console.log();
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
        console.log(ERROR(`Unknown command: /${parsed.name}`));
        const suggestions = buildCommandSuggestions(parsed.name);
        if (suggestions.length > 0) {
          console.log(DIM(`Did you mean: ${suggestions.map(s => `/${s}`).join(', ')}?`));
        }
      }
    } else {
      // 直接 chat - executeChat 有自己的 spinner 和流式输出
      await executeChat(ctx, text);
    }
  } catch (err: any) {
    console.log(ERROR(`Error: ${err.message || String(err)}`));
  }

  // 重新显示 prompt
  rl.setPrompt(getPrompt());
  rl.prompt();
}

let rl: readline.Interface;

// ============================================================================
// 主入口
// ============================================================================

async function main(): Promise<void> {
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
        maxTokens: cliConfig.maxTokens,
        temperature: cliConfig.temperature,
        maxRetries: cliConfig.maxRetries,
        retryBaseDelay: cliConfig.retryBaseDelay,
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

  // 创建 readline
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: getPrompt(),
  });

  rl.on('line', handleInput);

  rl.on('close', async () => {
    console.log();
    console.log(DIM('Shutting down...'));
    mcpManager.disconnectAll();
    await runtime.shutdown();
    console.log(SUCCESS('Goodbye! 🐴'));
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    // Save session summary before exit
    if (currentSession) {
      const messages = readSessionMessages(currentSession.id);
      if (messages.length > 0) {
        updateSessionSummary(currentSession.id, messages);
      }
      endSession(currentSession.id);
    }
    rl.close();
  });

  // 显示初始 prompt
  rl.prompt();
}

main().catch(err => {
  console.error(ERROR('[OpenHorse] Fatal error:'), err);
  process.exit(1);
});