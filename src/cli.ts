/**
 * openhorse - 命令行交互入口
 *
 * 提供交互式终端体验：
 *   - 欢迎界面（Header Box with Provider/Model/Endpoint）
 *   - 系统初始化与状态展示
 *   - Slash 命令（/help, /status, /clear, /exit 等）
 *   - 非 `/` 前缀输入直接作为 chat 消息
 *   - Tab 补全命令名
 *   - Shift+Tab 模式切换
 */

import 'dotenv/config';
import chalk from 'chalk';
import figlet from 'figlet';
import { init, OpenHorseRuntime } from './init';
import { LLMService } from './services/llm';
import { TOOLS } from './tools';
import { loadConfig, isConfigured } from './services/config';
import { Store } from './framework';
import { findCommand, executeChat } from './commands';
import { parseInput, createCompleter, buildCommandSuggestions } from './commands/parser';
import type { CommandContext } from './commands/types';
import { getModeDisplayText } from './commands/types';
import { renderHeaderBox, renderFooterBar } from './ui/box';

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

// ============================================================================
// 欢迎界面
// ============================================================================

function printBanner(): void {
  // ASCII art banner
  const art = figlet.textSync('OPENHORSE', {
    font: 'standard',
    horizontalLayout: 'default',
    verticalLayout: 'default',
  });
  console.log(BRAND(art));
  console.log();

  // Header box with provider/model/endpoint info
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
    version: '0.1.0',
  });
  console.log(headerBox);
  console.log();
}

// ============================================================================
// 交互模式
// ============================================================================

async function interactiveMode(runtime: OpenHorseRuntime): Promise<void> {
  const rl = await import('readline');

  // Enable keypress events for shift+tab detection
  rl.emitKeypressEvents(process.stdin);

  const readline = rl.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: createCompleter(),
  });

  // Prevent double-processing while async commands run
  let busy = false;

  // Get mode display text for prompt
  const getModeIndicator = (): string => {
    const mode = store.getSnapshot().permissionMode;
    const modeText = getModeDisplayText(mode);
    return modeText ? `[${modeText}] ` : '';
  };

  // Build prompt string: ❯ + mode indicator
  const buildPromptString = (): string => {
    return ACCENT('❯ ') + DIM(getModeIndicator());
  };

  // Draw separator line
  const drawSeparator = () => {
    const width = process.stdout.columns || 80;
    console.log(DIM('─'.repeat(width)));
  };

  // Draw footer bar
  const drawFooter = () => {
    console.log(renderFooterBar());
  };

  // Show prompt with separator (used after command completion)
  const showPrompt = () => {
    drawSeparator();
    readline.setPrompt(buildPromptString());
    readline.prompt();
  };

  // Shift+Tab detection - cycle permission mode
  const handleCycleMode = (): void => {
    if (busy) return;
    store.cyclePermissionMode();
    // Clear current prompt line and redraw
    process.stdout.write('\x1b[2K\r');
    readline.setPrompt(buildPromptString());
    readline.prompt();
  };

  // Listen for keypress events (before readline processes them)
  process.stdin.on('keypress', (_str: string, key: any) => {
    // Shift+Tab: \x1b[Z sequence or key.name === 'tab' with shift
    if (key.sequence === '\x1b[Z' || (key.name === 'tab' && key.shift)) {
      handleCycleMode();
    }
  });

  // 构建命令上下文
  const ctx: CommandContext = {
    cwd: process.cwd(),
    config: store.getSnapshot().config,
    store,
    llm,
    runtime,
  };

  console.log(SUCCESS('✔ System initialized successfully'));
  console.log(DIM('  Type /help for available commands, /exit to quit'));
  console.log(DIM('  Press shift+tab to cycle permission modes'));
  if (!isConfigured(ctx.config)) {
    console.log(WARN('  ⚠ LLM not configured — chat mode unavailable'));
    console.log(DIM('  Set OPENHORSE_API_KEY in .env to enable chat'));
  }
  console.log();

  // Initial prompt
  showPrompt();

  /** Run handler and re-enable prompt after completion */
  async function runHandler(parsed: { isCommand: boolean; name: string; args: string }): Promise<void> {
    if (busy) return;
    busy = true;

    if (parsed.isCommand) {
      const cmd = findCommand(parsed.name);
      if (cmd) {
        const result = await cmd.execute(ctx, parsed.args);
        if (result.continueAsChat && result.chatInput) {
          await executeChat(ctx, result.chatInput);
        }
      } else {
        console.log(ERROR(`Unknown command: /${parsed.name}`));
        const suggestions = buildCommandSuggestions(parsed.name);
        if (suggestions.length > 0) {
          console.log(DIM(`Did you mean: ${suggestions.map(s => `/${s}`).join(', ')}?`));
        } else {
          console.log(DIM(`Type /help for available commands.`));
        }
        console.log();
      }
    } else {
      // 非 `/` 前缀 → 直接 chat
      await executeChat(ctx, parsed.args);
    }

    busy = false;
    showPrompt();
  }

  readline.on('line', (line: string) => {
    const parsed = parseInput(line);
    if (!parsed.isCommand && !parsed.args) {
      // 空输入（只有空格） → 重新打印 prompt
      showPrompt();
      return;
    }

    if (busy) {
      // 正在处理中，忽略输入
      return;
    }

    runHandler(parsed);
  });

  readline.on('close', () => {
    console.log();
    console.log(DIM('Shutting down...'));
    runtime.shutdown().then(() => {
      console.log(SUCCESS('Goodbye! 🐴'));
      process.exit(0);
    });
  });

  // 处理 Ctrl+C
  readline.on('SIGINT', () => {
    console.log();
    console.log(DIM('Shutting down...'));
    runtime.shutdown().then(() => {
      console.log(SUCCESS('Goodbye! 🐴'));
      process.exit(0);
    });
  });
}

// ============================================================================
// Commander 子命令模式
// ============================================================================

async function commandMode(runtime: OpenHorseRuntime): Promise<void> {
  const { Command } = await import('commander');

  const program = new Command();

  program
    .name('openhorse')
    .description('OpenHorse Framework - Universal Agent Harness')
    .version('0.1.0');

  program
    .command('status')
    .description('Show system status')
    .action(() => {
      const ctx: CommandContext = {
        cwd: process.cwd(),
        config: store.getSnapshot().config,
        store,
        llm,
        runtime,
      };
      findCommand('status')?.execute(ctx, '');
      process.exit(0);
    });

  program
    .command('agents')
    .description('List agents')
    .action(() => {
      const ctx: CommandContext = {
        cwd: process.cwd(),
        config: store.getSnapshot().config,
        store,
        llm,
        runtime,
      };
      findCommand('agents')?.execute(ctx, '');
      process.exit(0);
    });

  program
    .command('interactive', { isDefault: true })
    .description('Start interactive CLI (default)')
    .action(() => {
      interactiveMode(runtime);
    });

  program.parse(process.argv);
}

// ============================================================================
// 主入口
// ============================================================================

async function main(): Promise<void> {
  // 加载环境变量
  const cliConfig = loadConfig();

  // 创建 Store
  store = new Store({
    config: cliConfig,
    tools: TOOLS,
    currentModel: cliConfig.model,
  });

  // 检查 LLM 配置
  if (isConfigured(cliConfig)) {
    try {
      llm = new LLMService({
        apiKey: cliConfig.apiKey,
        baseUrl: cliConfig.apiBaseUrl,
        model: cliConfig.model,
        maxTokens: cliConfig.maxTokens,
        temperature: cliConfig.temperature,
      });
    } catch (err: any) {
      console.log(WARN(`⚠ LLM initialization warning: ${err.message}`));
    }
  }

  // 打印欢迎界面（LLM 已初始化，显示正确状态）
  printBanner();

  // 初始化系统
  const config = store.getSnapshot().config;
  const runtime = await init({
    name: config.name,
    mode: config.mode as any,
    logLevel: config.logLevel,
  });

  // 注册优雅关闭
  const gracefulShutdown = async (signal: string) => {
    console.log(`\n${WARN(`Received ${signal}`)}`);
    await runtime.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // 启动系统
  await runtime.start();

  // 判断模式：如果有命令行参数，走命令模式；否则走交互模式
  const hasCommandArgs = process.argv.some(arg =>
    ['status', 'agents'].includes(arg),
  );

  if (hasCommandArgs) {
    await commandMode(runtime);
  } else {
    await interactiveMode(runtime);
  }
}

// 执行主入口
main().catch(err => {
  console.error(ERROR('[OpenHorse] Fatal error:'), err);
  process.exit(1);
});