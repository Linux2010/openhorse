/**
 * openhorse - Command Registry
 *
 * 注册所有 slash 命令，提供查找和列表功能。
 */

import chalk from 'chalk';
import type { SlashCommand, CommandContext, CommandResult } from './types';
import type { Task } from '../core/agent';
import { TaskManager, CreateTaskOptions } from '../services/task-manager';
import { AgentRunner } from '../services/agent-runner';
import { isConfigured } from '../services/config';
import { createSpinner, toolLine } from '../ui/box';
import { query, getSystemPrompt, type QueryEvent, type PromptContext } from '../framework';
import { TOOLS, executeTool, getToolNames } from '../tools';
import type { Message, StreamCallbacks } from '../services/llm';

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
// 命令实现
// ============================================================================

let taskManager: TaskManager | null = null;

function showHelp(): CommandResult {
  console.log();
  console.log(HEADER('Commands:'));
  console.log();
  for (const cmd of COMMANDS) {
    const aliases = cmd.aliases ? ` (${cmd.aliases.join(', ')})` : '';
    const params = cmd.params?.map(p => `<${p.name}>`).join(' ') || '';
    console.log(`  ${ACCENT(`/${cmd.name}`)}${aliases} ${DIM(params)}`);
    console.log(`    ${DIM(cmd.description)}`);
  }
  console.log();
  console.log(DIM('Type any text without / prefix to chat with the LLM.'));
  console.log();
  return { success: true };
}

function showStatus(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('System Status'));
  console.log(DIM('─'.repeat(40)));

  const brainStatus = ctx.runtime.brain.getStatus();
  const memStatus = ctx.runtime.memory.getStatus();
  const storeStats = ctx.runtime.store.getStats();

  console.log(`  Mode       ${BRAND(ctx.config.mode)}`);
  console.log(`  Log level  ${DIM(ctx.config.logLevel)}`);
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
  return { success: true };
}

function showAgents(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Registered Agents'));
  console.log(DIM('─'.repeat(40)));

  for (const agent of ctx.runtime.agents) {
    const status = agent.getStatus();
    const statusColor = status.status === 'idle' ? SUCCESS : WARN;
    console.log();
    console.log(`  ${ACCENT(status.name)} ${DIM(`(${status.id})`)}`);
    console.log(`    Status:    ${statusColor(status.status)}`);
    console.log(`    Capabilities: ${status.capabilities.join(', ')}`);
  }
  console.log();
  return { success: true };
}

function showMemory(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Memory Status'));
  console.log(DIM('─'.repeat(40)));

  const memStatus = ctx.runtime.memory.getStatus();
  const storeStats = ctx.runtime.store.getStats();

  console.log();
  console.log(HEADER('  Inline MemorySystem:'));
  console.log(`    Working    ${memStatus.working} / ${ctx.runtime.config.memory.workingCapacity}`);
  console.log(`    Short-term ${memStatus['short-term']} / ${ctx.runtime.config.memory.shortTermCapacity}`);
  console.log(`    Long-term  ${memStatus['long-term']} entries`);

  console.log();
  console.log(HEADER('  Modular MemoryStore:'));
  console.log(`    Working    ${storeStats.working}`);
  console.log(`    Short-term ${storeStats['short-term']}`);
  console.log(`    Long-term  ${storeStats['long-term']} entries`);
  console.log();
  return { success: true };
}

function showSafety(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Safety Checker'));
  console.log(DIM('─'.repeat(40)));

  const policy = ctx.runtime.safety.getPolicy();
  const summary = ctx.runtime.safety.getAuditSummary();

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
  return { success: true };
}

function showHarness(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Harness Config'));
  console.log(DIM('─'.repeat(40)));

  const cfg = ctx.runtime.harness.getConfig();
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
  return { success: true };
}

function showConfig(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Configuration'));
  console.log(DIM('─'.repeat(40)));

  const summary = {
    name: ctx.config.name,
    model: ctx.config.model,
    apiBaseUrl: ctx.config.apiBaseUrl || '(default OpenAI)',
    apiKey: ctx.config.apiKey ? `${ctx.config.apiKey.slice(0, 7)}***` : '(not set)',
    maxTokens: String(ctx.config.maxTokens),
    temperature: String(ctx.config.temperature),
    mode: ctx.config.mode,
    logLevel: ctx.config.logLevel,
  };

  const llmSummary = ctx.llm?.getConfigSummary() ?? {};

  for (const [key, val] of Object.entries(summary)) {
    console.log(`  ${ACCENT(key.padEnd(16))} ${DIM(val)}`);
  }
  console.log();
  console.log(HEADER('  LLM Settings:'));
  for (const [key, val] of Object.entries(llmSummary)) {
    console.log(`  ${ACCENT(key.padEnd(16))} ${DIM(val)}`);
  }
  console.log();
  return { success: true };
}

function showCost(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Token Usage & Cost'));
  console.log(DIM('─'.repeat(40)));

  const costTracker = ctx.store.getSnapshot().costTracker;
  const stats = costTracker.getSessionStats();

  if (stats.recordCount === 0) {
    console.log(DIM('  No usage recorded yet.'));
    console.log(DIM('  Use /run or /chat to interact with LLM.'));
    console.log();
    return { success: true };
  }

  // Summary
  console.log(HEADER('  Session Summary:'));
  console.log(`  ${ACCENT('Total Tokens')}   ${stats.totalTokens}`);
  console.log(`  ${ACCENT('Prompt')}         ${stats.totalPromptTokens}`);
  console.log(`  ${ACCENT('Completion')}    ${stats.totalCompletionTokens}`);
  console.log(`  ${ACCENT('Est. Cost')}     ${costTracker.formatCost(stats.totalCost)}`);
  console.log(`  ${ACCENT('Requests')}       ${stats.recordCount}`);
  console.log();

  // By Model
  if (Object.keys(stats.byModel).length > 0) {
    console.log(HEADER('  By Model:'));
    for (const [model, data] of Object.entries(stats.byModel)) {
      console.log(`    ${BRAND(model.padEnd(20))} ${data.tokens} tokens, ${costTracker.formatCost(data.cost)}`);
    }
    console.log();
  }

  // Budget
  const budget = costTracker.getBudget();
  if (budget !== null) {
    const check = costTracker.checkBudget();
    console.log(HEADER('  Budget:'));
    console.log(`    ${ACCENT('Limit')}    ${costTracker.formatCost(budget)}`);
    console.log(`    ${ACCENT('Used')}     ${costTracker.formatCost(check.used)}`);
    console.log(`    ${ACCENT('Remaining')} ${costTracker.formatCost(check.remaining)}`);
    console.log(`    ${check.ok ? SUCCESS('✓ Within budget') : WARN('⚠ Budget exceeded')}`);
    console.log();
  }

  return { success: true };
}

function handleModel(ctx: CommandContext, args: string): CommandResult {
  // 模型别名映射
  const MODEL_ALIASES: Record<string, string> = {
    'opus': 'claude-opus-4-7',
    'sonnet': 'claude-sonnet-4-6',
    'haiku': 'claude-haiku-4-5-20251001',
    'claude': 'claude-sonnet-4-6',
    'gpt4': 'gpt-4o',
    'gpt4o': 'gpt-4o',
    'gpt35': 'gpt-3.5-turbo',
    'qwen': 'qwen3.5-plus',
  };

  // 可用模型列表
  const AVAILABLE_MODELS = [
    { name: 'claude-opus-4-7', alias: 'opus', provider: 'Anthropic' },
    { name: 'claude-sonnet-4-6', alias: 'sonnet', provider: 'Anthropic' },
    { name: 'claude-haiku-4-5-20251001', alias: 'haiku', provider: 'Anthropic' },
    { name: 'gpt-4o', alias: 'gpt4o', provider: 'OpenAI' },
    { name: 'gpt-3.5-turbo', alias: 'gpt35', provider: 'OpenAI' },
    { name: 'qwen3.5-plus', alias: 'qwen', provider: 'Alibaba Cloud' },
    { name: 'glm-5', alias: 'glm', provider: 'Zhipu' },
  ];

  const trimmedArgs = args.trim().toLowerCase();

  // 显示当前模型
  if (!args || trimmedArgs === '?' || trimmedArgs === 'info') {
    console.log();
    if (ctx.llm) {
      const currentModel = ctx.llm.getModel();
      const aliasEntry = AVAILABLE_MODELS.find(m => m.name === currentModel || m.alias === currentModel);
      console.log(HEADER('Current Model'));
      console.log(DIM('─'.repeat(40)));
      console.log(`  Model    ${BRAND(currentModel)}`);
      if (aliasEntry) {
        console.log(`  Alias    ${ACCENT(aliasEntry.alias)}`);
        console.log(`  Provider ${DIM(aliasEntry.provider)}`);
      }
    } else {
      console.log(ERROR('LLM not initialized. Set OPENHORSE_API_KEY first.'));
    }
    console.log();
    return { success: true };
  }

  // 显示模型列表
  if (trimmedArgs === 'list' || trimmedArgs === 'ls') {
    console.log();
    console.log(HEADER('Available Models'));
    console.log(DIM('─'.repeat(40)));
    const currentModel = ctx.llm?.getModel() || '';
    for (const m of AVAILABLE_MODELS) {
      const isCurrent = m.name === currentModel || m.alias === currentModel;
      const marker = isCurrent ? SUCCESS('●') : DIM('○');
      console.log(`  ${marker} ${ACCENT(m.name)} ${DIM(`(${m.alias})`)} ${isCurrent ? BRAND('(current)') : ''}`);
      console.log(`      ${DIM(m.provider)}`);
    }
    console.log();
    console.log(DIM('Use /model <name|alias> to switch, e.g. /model sonnet'));
    console.log();
    return { success: true };
  }

  // 显示帮助
  if (trimmedArgs === 'help') {
    console.log();
    console.log(HEADER('/model Command Help'));
    console.log(DIM('─'.repeat(40)));
    console.log();
    console.log(`  ${ACCENT('/model')}           Show current model`);
    console.log(`  ${ACCENT('/model list')}      Show available models`);
    console.log(`  ${ACCENT('/model <name>')}    Switch to specific model`);
    console.log(`  ${ACCENT('/model <alias>')}   Switch using alias (opus, sonnet, haiku)`);
    console.log();
    console.log(DIM('Aliases: opus, sonnet, haiku, gpt4o, qwen, glm'));
    console.log();
    return { success: true };
  }

  // 设置模型
  if (!ctx.llm) {
    console.log(ERROR('LLM not initialized. Set OPENHORSE_API_KEY first.'));
    console.log();
    return { success: false };
  }

  // 解析别名
  const resolvedModel = MODEL_ALIASES[trimmedArgs] || args.trim();

  ctx.llm.setModel(resolvedModel);
  ctx.store.setState({ currentModel: resolvedModel });
  console.log(SUCCESS(`✔ Model changed to ${BRAND(resolvedModel)}`));
  console.log();
  return { success: true };
}

function handleTask(ctx: CommandContext, args: string): CommandResult {
  const [sub, ...rest] = args.trim().split(/\s+/);

  if (sub === 'list' || sub === 'ls') {
    if (!taskManager) {
      taskManager = new TaskManager();
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
    return { success: true };
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
  ctx.runtime.brain.submitTask(task);
  console.log(SUCCESS(`✔ Task "${taskName}" submitted`));
  console.log();
  return { success: true };
}

async function handleRun(ctx: CommandContext, args: string): Promise<CommandResult> {
  if (!args.trim()) {
    console.log(ERROR('Usage: /run <task description>'));
    console.log(DIM('  Creates a task and executes it through the Agent + LLM pipeline.'));
    console.log();
    return { success: false };
  }

  if (!ctx.llm || !isConfigured(ctx.config)) {
    console.log(WARN('⚠ LLM not configured. Set OPENHORSE_API_KEY in .env to enable run mode.'));
    console.log();
    return { success: false };
  }

  if (!taskManager) {
    taskManager = new TaskManager();
  }

  const taskOptions: CreateTaskOptions = {
    name: args.slice(0, 80),
    description: args,
    priority: 'P1',
    assignedTo: 'leader',
    tags: ['cli', 'interactive'],
  };

  const record = taskManager.create(taskOptions);
  console.log();
  console.log(SUCCESS(`✔ Task created: ${ACCENT(record.name)}`));
  console.log(DIM(`  ID: ${record.id} | Tags: ${record.tags.join(', ')}`));

  taskManager.start(record.id);
  console.log(WARN('◌ Running task through Agent + LLM...'));

  try {
    const agent = ctx.runtime.agents[0];
    if (!agent) {
      throw new Error('No agents registered');
    }

    const runner = new AgentRunner(agent, ctx.llm);
    const task = taskManager.toTask(record);
    const result = await runner.run(task);

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
  return { success: true };
}

async function handleChat(ctx: CommandContext, input: string): Promise<CommandResult> {
  if (!input) {
    console.log(ERROR('Usage: /chat <message>'));
    console.log();
    return { success: false };
  }

  if (!ctx.llm || !isConfigured(ctx.config)) {
    console.log(WARN('⚠ LLM not configured. Set OPENHORSE_API_KEY in .env to enable chat.'));
    console.log();
    return { success: false };
  }

  ctx.store.addMessage({ role: 'user', content: input });
  const snapshot = ctx.store.getSnapshot();

  const promptCtx: PromptContext = {
    cwd: ctx.cwd,
    platform: process.platform,
    nodeVersion: process.version,
    tools: TOOLS,
  };
  const systemPrompt = getSystemPrompt(promptCtx);

  const spinner = createSpinner();
  spinner.start('Thinking');

  let finalContent = '';
  let finalModel = '';
  let finalUsage: { promptTokens: number; completionTokens: number } | undefined;
  let responseStarted = false;

  const toolExecutor = async (name: string, args: Record<string, unknown>) => {
    const start = Date.now();
    const result = await executeTool(name, args);
    const duration = Date.now() - start;
    const parsed = JSON.parse(result);
    spinner.stop();
    console.log(toolLine(name, args, parsed.success !== false, duration));
    return result;
  };

  const streamCallbacks: StreamCallbacks = {
    onChunk: (chunk: string) => {
      if (!responseStarted) {
        responseStarted = true;
        spinner.stop();
      }
      process.stdout.write(chunk);
    },
  };

  try {
    const messages: Message[] = [{ role: 'system', content: systemPrompt }, ...snapshot.conversationHistory];

    for await (const event of query({
      messages,
      tools: TOOLS,
      toolExecutor,
      llm: ctx.llm,
      streamCallbacks,
      costTracker: snapshot.costTracker,
    })) {
      switch (event.type) {
        case 'request_start':
          spinner.update(`Turn ${event.turn}...`);
          break;

        case 'tool_result':
          spinner.start('Thinking');
          break;

        case 'complete':
          spinner.stop();
          finalContent = event.content;
          finalModel = event.model;
          finalUsage = event.usage;
          break;
      }
    }

    if (finalContent) {
      ctx.store.addMessage({ role: 'assistant', content: finalContent });
    }

    if (finalUsage) {
      ctx.store.setTokenUsage(finalUsage);
    }

    if (responseStarted) {
      console.log();
    }
    const stats = [
      finalUsage ? `tokens: ${finalUsage.promptTokens}+${finalUsage.completionTokens}` : '',
      finalModel ? finalModel : '',
    ].filter(Boolean).join('  ');
    if (stats) {
      console.log(DIM(stats));
    }
  } catch (error: any) {
    spinner.stop();
    console.log();
    console.log(ERROR(`✗ ${error.message || String(error)}`));
    const hist = ctx.store.getSnapshot().conversationHistory;
    if (hist.length > 0) {
      ctx.store.setState({ conversationHistory: hist.slice(0, -1) });
    }
  }

  return { success: true };
}

async function handleExit(ctx: CommandContext): Promise<CommandResult> {
  console.log();
  console.log(DIM('Shutting down...'));
  await ctx.runtime.shutdown();
  console.log(SUCCESS('Goodbye! 🐴'));
  process.exit(0);
}

function handleCost(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Session Cost'));
  console.log(DIM('─'.repeat(40)));

  const usage = ctx.store.getSnapshot().tokenUsage;
  const history = ctx.store.getSnapshot().conversationHistory;

  console.log();
  if (usage) {
    console.log(`  Input tokens    ${ACCENT(usage.promptTokens.toLocaleString())}`);
    console.log(`  Output tokens   ${ACCENT(usage.completionTokens.toLocaleString())}`);
    console.log(`  Total tokens    ${DIM((usage.promptTokens + usage.completionTokens).toLocaleString())}`);
  } else {
    console.log(DIM('  No token usage recorded yet'));
  }

  console.log();
  console.log(`  Messages        ${DIM(history.length.toString())}`);
  console.log(`  Turns           ${DIM(Math.floor(history.length / 2).toString())}`);
  console.log();
  console.log(DIM('Note: Cost estimates depend on provider pricing'));
  console.log();
  return { success: true };
}

function handleClearHistory(ctx: CommandContext): CommandResult {
  const history = ctx.store.getSnapshot().conversationHistory;

  if (history.length === 0) {
    console.log(DIM('Conversation history is already empty'));
    console.log();
    return { success: true };
  }

  ctx.store.resetConversation();
  console.log(SUCCESS(`✔ Cleared ${history.length} messages from conversation history`));
  console.log(DIM('  Configuration and system state preserved'));
  console.log();
  return { success: true };
}

function handleUsage(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Usage Statistics'));
  console.log(DIM('─'.repeat(40)));

  const snapshot = ctx.store.getSnapshot();
  const usage = snapshot.tokenUsage;
  const history = snapshot.conversationHistory;

  console.log();

  // Token usage
  console.log(HEADER('  Tokens:'));
  if (usage) {
    console.log(`    Input       ${ACCENT(usage.promptTokens.toLocaleString())}`);
    console.log(`    Output      ${ACCENT(usage.completionTokens.toLocaleString())}`);
    const total = usage.promptTokens + usage.completionTokens;
    console.log(`    Total       ${DIM(total.toLocaleString())}`);
    const ratio = usage.completionTokens / usage.promptTokens;
    console.log(`    Ratio       ${DIM(ratio.toFixed(2))} (output/input)`);
  } else {
    console.log(DIM('    No token usage recorded'));
  }

  console.log();

  // Conversation stats
  console.log(HEADER('  Conversation:'));
  console.log(`    Messages    ${DIM(history.length.toString())}`);
  console.log(`    Turns       ${DIM(Math.floor(history.length / 2).toString())}`);

  // Count by role
  const byRole = { user: 0, assistant: 0, system: 0, tool: 0 };
  for (const msg of history) {
    byRole[msg.role] = (byRole[msg.role] || 0) + 1;
  }
  console.log(`    User msgs   ${DIM(byRole.user.toString())}`);
  console.log(`    Assistant   ${DIM(byRole.assistant.toString())}`);

  console.log();

  // Model info
  console.log(HEADER('  Model:'));
  console.log(`    Current     ${BRAND(snapshot.currentModel)}`);
  if (ctx.llm) {
    console.log(`    Active      ${ACCENT(ctx.llm.getModel())}`);
  }

  console.log();
  return { success: true };
}

// ============================================================================
// 命令注册表
// ============================================================================

const COMMANDS: SlashCommand[] = [
  // 系统命令
  {
    name: 'help',
    aliases: ['h'],
    description: 'Show available commands',
    type: 'builtin',
    execute: () => showHelp(),
  },
  {
    name: 'status',
    aliases: ['s'],
    description: 'Show system status overview',
    type: 'builtin',
    execute: (ctx) => showStatus(ctx),
  },
  {
    name: 'clear',
    description: 'Clear the terminal screen',
    type: 'builtin',
    execute: () => {
      process.stdout.write('\x1Bc');
      return { success: true };
    },
  },
  {
    name: 'clear-history',
    aliases: ['reset'],
    description: 'Clear conversation history (keep config)',
    type: 'builtin',
    execute: (ctx) => handleClearHistory(ctx),
  },
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Shutdown and exit',
    type: 'builtin',
    execute: (ctx) => handleExit(ctx),
  },

  // 成本/用量命令
  {
    name: 'cost',
    description: 'Show session token usage',
    type: 'builtin',
    execute: (ctx) => handleCost(ctx),
  },
  {
    name: 'usage',
    aliases: ['stats'],
    description: 'Show detailed usage statistics',
    type: 'builtin',
    execute: (ctx) => handleUsage(ctx),
  },

  // 配置命令
  {
    name: 'model',
    description: 'Show or change the current model',
    argumentHint: '[model|list|help]',
    type: 'builtin',
    execute: (ctx, args) => handleModel(ctx, args),
  },
  {
    name: 'config',
    description: 'Show current configuration',
    type: 'builtin',
    execute: (ctx) => showConfig(ctx),
  },
  {
    name: 'cost',
    aliases: ['usage'],
    description: 'Show token usage and estimated cost',
    type: 'builtin',
    execute: (ctx) => showCost(ctx),
  },

  // Agent/Harness 命令
  {
    name: 'agents',
    description: 'List registered agents and their status',
    type: 'builtin',
    execute: (ctx) => showAgents(ctx),
  },
  {
    name: 'memory',
    description: 'Show memory system status',
    type: 'builtin',
    execute: (ctx) => showMemory(ctx),
  },
  {
    name: 'safety',
    description: 'Show safety checker status and audit summary',
    type: 'builtin',
    execute: (ctx) => showSafety(ctx),
  },
  {
    name: 'harness',
    description: 'Show harness configuration',
    type: 'builtin',
    execute: (ctx) => showHarness(ctx),
  },

  // Task 命令
  {
    name: 'task',
    description: 'Submit or list tasks',
    params: [{ name: 'action', description: 'list | <task-name>', required: false }],
    type: 'builtin',
    execute: (ctx, args) => handleTask(ctx, args),
  },
  {
    name: 'run',
    description: 'Create and run a task through Agent + LLM',
    params: [{ name: 'description', description: 'Task description', required: true }],
    type: 'builtin',
    execute: (ctx, args) => handleRun(ctx, args),
  },

  // Chat 命令
  {
    name: 'chat',
    description: 'Send a message to the LLM',
    params: [{ name: 'message', description: 'Message to send', required: true }],
    type: 'chat',
    execute: (ctx, args) => ({ success: true, continueAsChat: true, chatInput: args }),
  },
];

// ============================================================================
// 导出
// ============================================================================

export function getCommands(): SlashCommand[] {
  return COMMANDS;
}

export function findCommand(name: string): SlashCommand | undefined {
  return COMMANDS.find(c => c.name === name || c.aliases?.includes(name));
}

export function getCommandNames(): string[] {
  return COMMANDS.map(c => c.name);
}

export { handleChat as executeChat };