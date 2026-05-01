/**
 * rein-agent - 命令行交互入口
 *
 * 提供交互式终端体验：
 *   - 欢迎界面（ASCII Art）
 *   - 系统初始化与状态展示
 *   - 交互式命令（help, status, agents, memory, safety, task, clear, exit）
 *   - 支持 Commander 子命令模式
 */

import 'dotenv/config';
import chalk from 'chalk';
import figlet from 'figlet';
import { init, ReinRuntime } from './init';
import { Task } from './core/agent';
import { LLMService, Message, LLMResponse } from './services/llm';
import { AgentRunner } from './services/agent-runner';
import { TaskManager, CreateTaskOptions } from './services/task-manager';
import { loadConfig, ReinCLIConfig, isConfigured, getConfigSummary, getConfigErrors } from './services/config';

// ============================================================================
// 颜色常量
// ============================================================================

const BRAND = chalk.hex('#FF6B35');
const ACCENT = chalk.hex('#00D4AA');
const DIM = chalk.dim;
const ERROR = chalk.red;
const WARN = chalk.yellow;
const SUCCESS = chalk.green;
const HEADER = chalk.cyan.bold;

// ============================================================================
// 系统提示词
// ============================================================================

const SYSTEM_PROMPT = `You are Rein, an AI assistant powered by the Rein Agent Framework.
You are helpful, concise, and accurate.
Respond in the same language as the user.
If asked about your capabilities, explain that you are an AI assistant that can help with various tasks.`;

// ============================================================================
// LLM 状态
// ============================================================================

let llm: LLMService | null = null;
let cliConfig: ReinCLIConfig | null = null;
let conversationHistory: Message[] = [];
let taskManager: TaskManager | null = null;

// ============================================================================
// 欢迎界面
// ============================================================================

function printBanner(): void {
  const art = figlet.textSync('REIN', {
    font: 'standard',
    horizontalLayout: 'default',
    verticalLayout: 'default',
  });

  console.log(BRAND(art));
  console.log();
  console.log(`${ACCENT('Rein the AI, Unleash the Potential.')}`);
  console.log(DIM('  通用 Agent 驾驭框架  |  Universal Agent Harness Framework'));
  console.log();
  console.log(`${DIM('├')} ${DIM('v')} ${chalk.bold('0.1.0')}  ${DIM('│')}  Node ${process.version}  ${DIM('│')}  ${process.platform} ${process.arch}`);
  console.log();
}

/** 打印 LLM 状态 */
function printLLMStatus(): void {
  if (!cliConfig || !isConfigured(cliConfig)) {
    console.log(`${DIM('├')} ${WARN('LLM not configured')} ${DIM('| Set REIN_API_KEY in .env')}`);
  } else if (llm) {
    console.log(`${DIM('├')} ${SUCCESS('LLM ready')} ${DIM('|')} ${BRAND(llm.getModel())}`);
  }
  console.log();
}

// ============================================================================
// 交互模式
// ============================================================================

async function interactiveMode(runtime: ReinRuntime): Promise<void> {
  const rl = await import('readline');

  const readline = rl.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    process.stdout.write(`${ACCENT('rein')}${DIM(' > ')} `);
  };

  console.log(SUCCESS('✔ System initialized successfully'));
  console.log(DIM('  Type "help" for available commands, "exit" to quit'));
  if (!isConfigured(cliConfig!)) {
    console.log(WARN('  ⚠ LLM not configured — chat mode unavailable'));
    console.log(DIM('  Set REIN_API_KEY in .env to enable chat'));
  }
  console.log();

  printPrompt();

  // --- 命令映射 ---

  const commands: Record<string, (args: string) => void> = {
    help: () => printHelp(),
    status: () => printStatus(runtime),
    agents: () => printAgents(runtime),
    memory: () => printMemory(runtime),
    safety: () => printSafety(runtime),
    harness: () => printHarness(runtime),
    task: (args) => handleTaskCommand(runtime, args),
    run: (args) => handleRun(runtime, args),
    chat: (args) => handleChat(args),
    model: (args) => handleModel(args),
    config: () => printConfig(),
    clear: () => process.stdout.write('\x1Bc'),
    exit: () => handleExit(runtime),
    quit: () => handleExit(runtime),
  };

  // 别名
  commands['h'] = commands.help;
  commands['s'] = commands.status;
  commands['q'] = commands.quit;

  function printPrompt(): void {
    prompt();
  }

  readline.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      printPrompt();
      return;
    }

    const [cmd, ...rest] = trimmed.split(/\s+/);
    const args = rest.join(' ');
    const handler = commands[cmd.toLowerCase()];

    if (handler) {
      handler(args);
    } else {
      // 非命令输入 → 作为对话消息
      handleChat(trimmed);
    }

    printPrompt();
  });

  readline.on('close', () => {
    handleExit(runtime);
  });

  // 处理 Ctrl+C
  readline.on('SIGINT', () => {
    console.log();
    console.log(WARN('⚠ Type "exit" to quit'));
    printPrompt();
  });
}

// ============================================================================
// 命令实现
// ============================================================================

/** 处理对话消息（流式输出） */
async function handleChat(input: string): Promise<void> {
  if (!llm || !isConfigured(cliConfig!)) {
    console.log(WARN('⚠ LLM not configured. Set REIN_API_KEY in .env to enable chat.'));
    return;
  }

  if (!input) {
    console.log(ERROR('Usage: chat <message>'));
    return;
  }

  // 添加到对话历史
  conversationHistory.push({ role: 'user', content: input });

  // 初始化 system prompt
  if (conversationHistory.length === 1) {
    conversationHistory.unshift({ role: 'system', content: SYSTEM_PROMPT });
  }

  // 流式输出
  console.log();
  let currentLine = '';

  try {
    const response = await llm.chatStream(conversationHistory, (chunk: string) => {
      process.stdout.write(chunk);
      currentLine += chunk;
    });

    // 保存助手回复到历史
    conversationHistory.push({ role: 'assistant', content: response.content });

    console.log();

    // 显示 token 用量
    if (response.usage) {
      console.log(
        DIM(
          `  └─ tokens: ${response.usage.promptTokens} in / ${response.usage.completionTokens} out | model: ${response.model}`,
        ),
      );
    }
  } catch (error: any) {
    console.log();
    console.log(ERROR(`✗ Error: ${error.message || String(error)}`));
    // 移除用户消息（因为没有收到回复）
    conversationHistory.pop();
  }

  console.log();
}

/** 切换模型 */
function handleModel(modelName: string): void {
  if (!modelName) {
    if (llm) {
      console.log(DIM(`Current model: ${BRAND(llm.getModel())}`));
    } else {
      console.log(ERROR('LLM not initialized. Set REIN_API_KEY first.'));
    }
    return;
  }

  if (!llm) {
    console.log(ERROR('LLM not initialized. Set REIN_API_KEY first.'));
    return;
  }

  llm.setModel(modelName);
  console.log(SUCCESS(`✔ Model changed to ${BRAND(modelName)}`));
  console.log();
}

/** 显示配置 */
function printConfig(): void {
  console.log();
  console.log(HEADER('Configuration'));
  console.log(DIM('─'.repeat(40)));

  if (cliConfig) {
    const summary = getConfigSummary(cliConfig);
    const llmSummary = llm?.getConfigSummary() ?? {};

    for (const [key, val] of Object.entries(summary)) {
      console.log(`  ${ACCENT(key.padEnd(16))} ${DIM(val)}`);
    }
    console.log();
    console.log(HEADER('  LLM Settings:'));
    for (const [key, val] of Object.entries(llmSummary)) {
      console.log(`  ${ACCENT(key.padEnd(16))} ${DIM(val)}`);
    }
  } else {
    console.log(ERROR('  Config not loaded'));
  }

  console.log();
}

function printHelp(): void {
  console.log();
  console.log(HEADER('Commands:'));
  console.log();
  const cmds: [string, string][] = [
    ['help',      'Show this help message'],
    ['status',    'Show system status overview'],
    ['agents',    'List registered agents and their status'],
    ['memory',    'Show memory system status'],
    ['safety',    'Show safety checker status and audit summary'],
    ['harness',   'Show harness configuration'],
    ['task <n>',  'Submit a demo task (e.g., "task code" or "task review")'],
    ['task list', 'List all tasks and show statistics'],
    ['run <m>',   'Create and run a task through Agent + LLM'],
    ['chat <m>',  'Send a message to the LLM (also works as free text)'],
    ['model [m]', 'Show or change the current model (e.g., "model gpt-4o")'],
    ['config',    'Show current configuration'],
    ['clear',     'Clear the terminal screen'],
    ['exit',      'Shutdown and exit'],
  ];
  for (const [name, desc] of cmds) {
    console.log(`  ${ACCENT(name.padEnd(12))} ${DIM(desc)}`);
  }
  console.log();
}

function printStatus(runtime: ReinRuntime): void {
  console.log();
  console.log(HEADER('System Status'));
  console.log(DIM('─'.repeat(40)));

  const brainStatus = runtime.brain.getStatus();
  const memStatus = runtime.memory.getStatus();
  const storeStats = runtime.store.getStats();

  console.log(`  Mode       ${BRAND(runtime.config.mode)}`);
  console.log(`  Log level  ${DIM(runtime.config.logLevel)}`);
  console.log();
  console.log(`  Agents     ${SUCCESS(brainStatus.agents.length)} registered`);
  console.log(`  Tasks      ${brainStatus.pendingTasks} pending (${brainStatus.strategy} strategy)`);
  console.log();
  console.log(`  Memory (inline):`);
  console.log(`    Working    ${memStatus.working} entries`);
  console.log(`    Short-term ${memStatus['short-term']} entries`);
  console.log(`    Long-term  ${memStatus['long-term']} entries`);
  console.log();
  console.log(`  Memory (store):`);
  console.log(`    Working    ${storeStats.working} entries`);
  console.log(`    Short-term ${storeStats['short-term']} entries`);
  console.log(`    Long-term  ${storeStats['long-term']} entries`);
  console.log();
}

function printAgents(runtime: ReinRuntime): void {
  console.log();
  console.log(HEADER('Registered Agents'));
  console.log(DIM('─'.repeat(40)));

  for (const agent of runtime.agents) {
    const status = agent.getStatus();
    const statusColor = status.status === 'idle' ? SUCCESS : WARN;
    console.log();
    console.log(`  ${ACCENT(status.name)} ${DIM(`(${status.id})`)}`);
    console.log(`    Status:    ${statusColor(status.status)}`);
    console.log(`    Capabilities: ${status.capabilities.join(', ')}`);
  }
  console.log();
}

function printMemory(runtime: ReinRuntime): void {
  console.log();
  console.log(HEADER('Memory Status'));
  console.log(DIM('─'.repeat(40)));

  const memStatus = runtime.memory.getStatus();
  const storeStats = runtime.store.getStats();

  console.log();
  console.log(HEADER('  Inline MemorySystem:'));
  console.log(`    Working    ${memStatus.working} / ${runtime.config.memory.workingCapacity}`);
  console.log(`    Short-term ${memStatus['short-term']} / ${runtime.config.memory.shortTermCapacity}`);
  console.log(`    Long-term  ${memStatus['long-term']} entries`);

  console.log();
  console.log(HEADER('  Modular MemoryStore:'));
  console.log(`    Working    ${storeStats.working}`);
  console.log(`    Short-term ${storeStats['short-term']}`);
  console.log(`    Long-term  ${storeStats['long-term']} entries`);
  console.log();
}

function printSafety(runtime: ReinRuntime): void {
  console.log();
  console.log(HEADER('Safety Checker'));
  console.log(DIM('─'.repeat(40)));

  const policy = runtime.safety.getPolicy();
  const summary = runtime.safety.getAuditSummary();

  console.log();
  console.log(`  Enabled    ${policy.enabled ? SUCCESS('yes') : ERROR('no')}`);
  console.log(`  Sandbox    ${policy.sandboxMode ? WARN('on') : DIM('off')}`);
  console.log();
  console.log(`  Blocked patterns:`);
  for (const pattern of policy.blocked) {
    console.log(`    ${ERROR('✗')} ${DIM(pattern)}`);
  }
  console.log();
  console.log(`  Dangerous patterns:`);
  for (const pattern of policy.dangerousPatterns) {
    console.log(`    ${WARN('⚠')} ${DIM(pattern)}`);
  }
  console.log();
  console.log(`  Audit summary: ${summary.total} checks | ${SUCCESS(`${summary.passed} passed`)} | ${ERROR(`${summary.blocked} blocked`)}`);
  console.log();
}

function printHarness(runtime: ReinRuntime): void {
  console.log();
  console.log(HEADER('Harness Config'));
  console.log(DIM('─'.repeat(40)));

  const cfg = runtime.harness.getConfig();
  console.log();
  console.log(`  Max steps       ${cfg.maxSteps}`);
  console.log(`  Boundary check  ${cfg.boundaryCheck ? SUCCESS('on') : ERROR('off')}`);
  console.log(`  Goal constraint ${cfg.goalConstraint ? SUCCESS('on') : ERROR('off')}`);
  console.log(`  Result validate ${cfg.resultValidation ? SUCCESS('on') : ERROR('off')}`);
  console.log(`  Sandbox         ${cfg.sandbox ? WARN('on') : DIM('off')}`);
  console.log(`  Timeout         ${cfg.timeout}ms`);
  console.log();
  console.log(`  Blocked actions: ${cfg.blockedActions.join(', ')}`);
  console.log();
}

function submitTask(runtime: ReinRuntime, name: string): void {
  const taskName = name.trim() || 'demo-task';
  const task: Task = {
    id: `cli-${Date.now()}`,
    name: taskName,
    description: `Task submitted from CLI: ${taskName}`,
    priority: 'P1',
    assignedTo: 'leader',
    status: 'pending',
  };

  console.log();
  runtime.brain.submitTask(task);
  console.log(SUCCESS(`✔ Task "${taskName}" submitted`));
  console.log();
}

/** 处理 task 子命令 (list, submit) */
function handleTaskCommand(runtime: ReinRuntime, args: string): void {
  const [sub, ...rest] = args.trim().split(/\s+/);

  if (sub === 'list' || sub === 'ls') {
    printTaskList();
    return;
  }

  // 默认行为: 作为任务名提交
  const taskName = args.trim() || 'demo-task';
  const task: Task = {
    id: `cli-${Date.now()}`,
    name: taskName,
    description: `Task submitted from CLI: ${taskName}`,
    priority: 'P1',
    assignedTo: 'leader',
    status: 'pending',
  };

  console.log();
  runtime.brain.submitTask(task);
  console.log(SUCCESS(`✔ Task "${taskName}" submitted`));
  console.log();
}

/** 打印任务列表 */
function printTaskList(): void {
  if (!taskManager) {
    console.log(WARN('⚠ Task manager not initialized'));
    return;
  }

  console.log();
  console.log(HEADER('Task List'));
  console.log(DIM('─'.repeat(40)));

  const stats = taskManager.getStats();
  console.log(`  Total      ${stats.total}`);
  console.log(`  Pending    ${stats.pending}`);
  console.log(`  Running    ${stats.running}`);
  console.log(`  Completed  ${SUCCESS(stats.completed)}`);
  console.log(`  Failed     ${ERROR(stats.failed)}`);
  console.log(`  Cancelled  ${DIM(stats.cancelled)}`);

  const tasks = taskManager.list();
  if (tasks.length > 0) {
    console.log();
    for (const t of tasks) {
      const statusIcon = t.status === 'completed' ? SUCCESS('✓')
        : t.status === 'failed' ? ERROR('✗')
        : t.status === 'running' ? WARN('◌')
        : t.status === 'cancelled' ? DIM('⊘')
        : DIM('○');
      console.log(`  ${statusIcon} ${ACCENT(t.name)} ${DIM(`(${t.id.slice(0, 8)})`)}`);
      console.log(`    ${DIM(`[${t.priority}]`)} ${t.description.slice(0, 60)}`);
    }
  }

  console.log();
}

/** 通过 Agent + LLM 创建并执行任务 */
async function handleRun(runtime: ReinRuntime, description: string): Promise<void> {
  if (!description.trim()) {
    console.log(ERROR('Usage: run <task description>'));
    console.log(DIM('  Creates a task and executes it through the Agent + LLM pipeline.'));
    return;
  }

  if (!llm || !isConfigured(cliConfig!)) {
    console.log(WARN('⚠ LLM not configured. Set REIN_API_KEY in .env to enable run mode.'));
    return;
  }

  // 初始化 TaskManager（如果尚未初始化）
  if (!taskManager) {
    taskManager = new TaskManager();
  }

  // 创建任务
  const taskOptions: CreateTaskOptions = {
    name: description.slice(0, 80),
    description,
    priority: 'P1',
    assignedTo: 'leader',
    tags: ['cli', 'interactive'],
  };

  const record = taskManager.create(taskOptions);
  console.log();
  console.log(SUCCESS(`✔ Task created: ${ACCENT(record.name)}`));
  console.log(DIM(`  ID: ${record.id} | Tags: ${record.tags.join(', ')}`));

  // 启动任务
  taskManager.start(record.id);
  console.log(WARN('◌ Running task through Agent + LLM...'));

  try {
    // 找到第一个 Agent 来执行
    const agent = runtime.agents[0];
    if (!agent) {
      throw new Error('No agents registered');
    }

    // 创建 AgentRunner 并执行
    const runner = new AgentRunner(agent, llm);
    const task = taskManager.toTask(record);
    const result = await runner.run(task);

    // 更新任务结果
    if (result.success) {
      taskManager.complete(record.id, result);
      console.log(SUCCESS(`✓ Task completed in ${result.duration}ms`));
      if (result.tokenUsage) {
        console.log(DIM(`  Tokens: ${result.tokenUsage.promptTokens} in / ${result.tokenUsage.completionTokens} out`));
      }
      if (result.data?.summary) {
        console.log();
        console.log(ACCENT('  Summary:'));
        console.log(`  ${result.data.summary}`);
      }
    } else {
      taskManager.fail(record.id, result.error, result);
      console.log(ERROR(`✗ Task failed: ${result.error}`));
    }
  } catch (error: any) {
    taskManager.fail(record.id, error.message);
    console.log(ERROR(`✗ Task error: ${error.message}`));
  }

  console.log();
}

async function handleExit(runtime: ReinRuntime): Promise<void> {
  console.log();
  console.log(DIM('Shutting down...'));
  await runtime.shutdown();
  console.log(SUCCESS('Goodbye! 🐴'));
  process.exit(0);
}

// ============================================================================
// Commander 子命令模式
// ============================================================================

async function commandMode(runtime: ReinRuntime): Promise<void> {
  const { Command } = await import('commander');

  const program = new Command();

  program
    .name('rein')
    .description('Rein Agent Framework - Universal Agent Harness')
    .version('0.1.0');

  program
    .command('status')
    .description('Show system status')
    .action(() => {
      printStatus(runtime);
      process.exit(0);
    });

  program
    .command('agents')
    .description('List agents')
    .action(() => {
      printAgents(runtime);
      process.exit(0);
    });

  program
    .command('safety')
    .description('Show safety status')
    .action(() => {
      printSafety(runtime);
      process.exit(0);
    });

  program
    .command('task <name>')
    .description('Submit a demo task')
    .action((name: string) => {
      submitTask(runtime, name);
      process.exit(0);
    });

  program
    .command('run <description>')
    .description('Create and run a task through Agent + LLM')
    .action(async (description: string) => {
      if (!taskManager) {
        taskManager = new TaskManager();
      }
      await handleRun(runtime, description);
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
  printBanner();

  // 加载环境变量
  cliConfig = loadConfig();

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

  // 打印 LLM 状态
  printLLMStatus();

  // 初始化系统
  const runtime = await init({
    name: cliConfig.name,
    mode: cliConfig.mode,
    logLevel: cliConfig.logLevel,
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
    ['status', 'agents', 'safety', 'task', 'run'].includes(arg),
  );

  if (hasCommandArgs) {
    await commandMode(runtime);
  } else {
    await interactiveMode(runtime);
  }
}

// 执行主入口
main().catch(err => {
  console.error(ERROR('[Rein] Fatal error:'), err);
  process.exit(1);
});
