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
import { createStreamRenderer, type StreamMarkdownRenderer } from '../ui/stream-markdown';
import { showProgress, hideProgress, showToolProgress } from '../ui/progress';
import { query, getSystemPrompt, resetToolState, type QueryEvent, type PromptContext } from '../framework';
import { TOOLS, executeTool, getToolNames } from '../tools';
import { mcpManager } from '../tools/mcp';
import type { Message, StreamCallbacks } from '../services/llm';
import {
  listSessions,
  listProjectSessions,
  lookupSessionRef,
  loadSessionHistory,
  loadSessionMeta,
  appendSessionMessage,
  appendSessionMessages,
  endSession,
  updateSessionSummary,
  updateSessionHarnessState,
  resumeSession,
  renameSession,
  resolveProjectPath,
  readSessionMessages,
  type SessionMeta,
  type SessionMessage,
} from '../services/session-storage';
import { getAutoCompact } from '../services/compact/auto-compact';
import { createContextHarness } from '../harness';

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
// 工具参数摘要
// ============================================================================

function compactToolArgs(args: Record<string, unknown>): string {
  if (typeof args.path === 'string') {
    return args.path.length > 48 ? args.path.slice(0, 45) + '...' : args.path;
  }
  if (typeof args.command === 'string') {
    return args.command.length > 48 ? args.command.slice(0, 45) + '...' : args.command;
  }
  if (typeof args.pattern === 'string') {
    return args.pattern.length > 48 ? args.pattern.slice(0, 45) + '...' : args.pattern;
  }
  for (const val of Object.values(args)) {
    if (typeof val === 'string') {
      return val.length > 48 ? val.slice(0, 45) + '...' : val;
    }
  }
  return '';
}

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

  const harnessState = ctx.store.getSnapshot().harnessState;
  if (harnessState?.contract || harnessState?.capsule) {
    console.log();
    console.log(`  Harness:`);
    if (harnessState.contract) {
      console.log(`    Objective  ${ACCENT(harnessState.contract.objective)}`);
    }
    console.log(`    Ledger     ${DIM(`${harnessState.ledger.length} entries`)}`);
    if (harnessState.capsule) {
      console.log(`    Next       ${DIM(harnessState.capsule.nextAction)}`);
      const passed = harnessState.capsule.verification.passed.length;
      const failed = harnessState.capsule.verification.failed.length;
      console.log(`    Verify     ${SUCCESS(`${passed} passed`)} / ${failed > 0 ? ERROR(`${failed} failed`) : DIM('0 failed')}`);
    }
  }
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

async function handleMemoryReindex(ctx: CommandContext): Promise<CommandResult> {
  const { isSemanticEnabled, getSemanticSearchService } = require('../memory/semantic-search');

  if (!isSemanticEnabled()) {
    console.log();
    console.log(WARN('⚠ Semantic search is not enabled.'));
    console.log(DIM('  Set OPENHORSE_EMBEDDING_PROVIDER=ollama or openai to enable.'));
    console.log();
    return { success: false };
  }

  console.log();
  console.log(HEADER('Reindexing project memories...'));

  try {
    const service = getSemanticSearchService();
    const count = await service.indexExistingMemories(process.cwd());
    console.log(SUCCESS(`✔ Indexed ${count} memories`));
  } catch (err: any) {
    console.log(ERROR(`✗ Reindex failed: ${err.message}`));
    return { success: false };
  }

  console.log();
  return { success: true };
}

async function handleMemory(ctx: CommandContext, args: string): Promise<CommandResult> {
  const sub = args.trim().toLowerCase();
  if (sub === 'reindex') {
    return handleMemoryReindex(ctx);
  }
  return showMemory(ctx);
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
    // Bailian (coding.dashscope.aliyuncs.com) — OpenAI-compatible
    'qwen': 'qwen3.5-plus',
    'qwenplus': 'qwen3.5-plus',
    'qwen36': 'qwen3.6-plus',
    'qwenmax': 'qwen3-max-2026-01-23',
    'coder': 'qwen3-coder-plus',
    'codernext': 'qwen3-coder-next',
    'glm': 'glm-5',
    'glm47': 'glm-4.7',
    'kimi': 'kimi-k2.5',
    'minimax': 'MiniMax-M2.5',
  };

  // 可用模型列表
  const AVAILABLE_MODELS = [
    { name: 'claude-opus-4-7', alias: 'opus', provider: 'Anthropic' },
    { name: 'claude-sonnet-4-6', alias: 'sonnet', provider: 'Anthropic' },
    { name: 'claude-haiku-4-5-20251001', alias: 'haiku', provider: 'Anthropic' },
    { name: 'gpt-4o', alias: 'gpt4o', provider: 'OpenAI' },
    { name: 'gpt-3.5-turbo', alias: 'gpt35', provider: 'OpenAI' },
    { name: 'glm-5', alias: 'glm', provider: 'Bailian (Zhipu)' },
    { name: 'glm-4.7', alias: 'glm47', provider: 'Bailian (Zhipu)' },
    { name: 'qwen3.5-plus', alias: 'qwen', provider: 'Bailian (Alibaba)' },
    { name: 'qwen3.6-plus', alias: 'qwen36', provider: 'Bailian (Alibaba)' },
    { name: 'qwen3-max-2026-01-23', alias: 'qwenmax', provider: 'Bailian (Alibaba)' },
    { name: 'qwen3-coder-plus', alias: 'coder', provider: 'Bailian (Alibaba)' },
    { name: 'qwen3-coder-next', alias: 'codernext', provider: 'Bailian (Alibaba)' },
    { name: 'kimi-k2.5', alias: 'kimi', provider: 'Bailian (Moonshot)' },
    { name: 'MiniMax-M2.5', alias: 'minimax', provider: 'Bailian (MiniMax)' },
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

  const activeSession = ctx.getSession?.() ?? ctx.ensureSession?.() ?? (ctx.sessionId ? loadSessionMeta(ctx.sessionId) : null);
  const sessionId = activeSession?.id ?? ctx.sessionId;

  // Record user message to session
  if (sessionId) {
    appendSessionMessage(sessionId, {
      role: 'user',
      content: input,
      timestamp: Date.now(),
    });
  }

  ctx.store.addMessage({ role: 'user', content: input });
  const snapshot = ctx.store.getSnapshot();
  const harness = createContextHarness({
    cwd: ctx.cwd,
    modelId: ctx.llm.getModel(),
    state: snapshot.harnessState,
    config: {
      enabled: true,
      driftGuard: 'warn',
      completionGate: true,
    },
  });
  harness.updateContractFromUserInput(input);

  const promptCtx: PromptContext = {
    cwd: ctx.cwd,
    platform: process.platform,
    nodeVersion: process.version,
    tools: TOOLS,
    memoryContent: snapshot.memoryContent,
    skillsContent: snapshot.skillsContent,
  };
  const systemPrompt = getSystemPrompt(promptCtx);

  const spinner = createSpinner();
  spinner.start('Thinking');

  let finalContent = '';
  let finalModel = '';
  let finalUsage: { promptTokens: number; completionTokens: number } | undefined;
  let responseStarted = false;
  const sessionMessagesToRecord: SessionMessage[] = [];
  let lastToolCallId = '';
  let lastToolArgs: Record<string, unknown> = {};

  // Issue #22: 批量工具调用进度显示
  let toolCallCount = 0;
  let lastProgressUpdate = 0;

  // 流式 Markdown 渲染器
  let streamRenderer: StreamMarkdownRenderer | null = null;

  // Issue #32 #3.2: toolExecutor 支持 abortSignal
  const toolExecutor = async (name: string, args: Record<string, unknown>, abortSignal?: AbortSignal) => {
    const result = await executeTool(name, args, abortSignal);
    // 不在这里打印，让 tool_result 事件处理
    return result;
  };

  const streamCallbacks: StreamCallbacks = {
    onChunk: (chunk: string) => {
      if (!responseStarted) {
        responseStarted = true;
        spinner.stop();
        // 打印换行，让流式输出在新行开始
        console.log();
        // 初始化流式渲染器
        streamRenderer = createStreamRenderer();
      }
      // 使用流式渲染器处理 chunk
      if (streamRenderer) {
        const rendered = streamRenderer.feed(chunk);
        if (rendered) {
          process.stdout.write(rendered);
        }
      } else {
        process.stdout.write(chunk);
      }
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
      permissionMode: snapshot.permissionMode,
      toolContext: {
        cwd: ctx.cwd,
        config: {
          name: ctx.config.name,
          mode: ctx.config.mode,
        },
      },
      harness,
    })) {
      switch (event.type) {
        case 'request_start':
          // 停止 spinner，等待 LLM 响应
          spinner.stop();
          console.log();
          console.log(DIM(`Turn ${event.turn}...`));
          // 重置流式渲染器
          streamRenderer = createStreamRenderer();
          // Issue #22: 重置工具调用计数器
          toolCallCount = 0;
          lastProgressUpdate = 0;
          break;

        case 'assistant_tool_calls':
          sessionMessagesToRecord.push({
            role: 'assistant',
            content: event.content || '',
            timestamp: Date.now(),
            tool_calls: event.toolCalls,
          });
          break;

        case 'tool_call':
          // Issue #22: 批量工具调用进度显示
          toolCallCount++;
          if (toolCallCount >= 3 && Date.now() - lastProgressUpdate > 1000) {
            showToolProgress(toolCallCount, event.name);
            lastProgressUpdate = Date.now();
          }
          // 收集完整的 tool_call 信息
          lastToolCallId = event.callId;
          lastToolArgs = event.args;
          break;

        case 'tool_result':
          // Issue #22: 隐藏进度指示
          hideProgress();
          // 显示工具结果后，准备下一轮（不启动 spinner）
          const parsedResult = JSON.parse(event.result);
          const toolSuccess = parsedResult.success !== false;
          console.log(toolLine(event.name, lastToolArgs, toolSuccess, event.duration));
          // 显示错误详情
          if (!toolSuccess && parsedResult.error) {
            console.log(ERROR(`    Error: ${parsedResult.error}`));
          }
          // Debug: 显示接收到的参数
          if (!toolSuccess && Object.keys(lastToolArgs).length === 0) {
            console.log(WARN(`    ⚠ Tool received empty arguments - LLM may not be providing parameters correctly`));
            console.log(DIM(`    Try using /model qwen or /model gpt4o for better tool calling support`));
          }
          // Record tool result for session
          sessionMessagesToRecord.push({
            role: 'tool',
            content: event.result,
            timestamp: Date.now(),
            toolCallId: lastToolCallId,
          });
          break;

        case 'message':
          if (event.content) {
            sessionMessagesToRecord.push({
              role: 'assistant',
              content: event.content,
              timestamp: Date.now(),
            });
          }
          break;

        case 'strategy_exhausted':
          console.log(WARN(`⚠ ${event.suggestion}`));
          break;

        case 'complete':
          finalContent = event.content;
          finalModel = event.model;
          finalUsage = event.usage;
          break;
      }
    }

    // 刷新流式渲染器，输出剩余内容
    if (streamRenderer) {
      const remaining = streamRenderer.flush();
      if (remaining) {
        process.stdout.write(remaining);
      }
      streamRenderer = null;
    }

    if (finalContent) {
      ctx.store.addMessage({ role: 'assistant', content: finalContent });
    }

    if (sessionId && sessionMessagesToRecord.length > 0) {
      appendSessionMessages(sessionId, sessionMessagesToRecord);
    }

    if (finalUsage) {
      ctx.store.setTokenUsage(finalUsage);
    }

    const harnessState = harness.toJSON();
    ctx.store.setState({ harnessState });
    if (sessionId) {
      updateSessionHarnessState(sessionId, harnessState);
      const recordedMessages = readSessionMessages(sessionId);
      if (recordedMessages.length > 0) {
        updateSessionSummary(sessionId, recordedMessages);
      }
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

  // Update session summary before exit
  if (ctx.sessionId) {
    const messages = readSessionMessages(ctx.sessionId);
    if (messages.length > 0) {
      updateSessionSummary(ctx.sessionId, messages);
    }
    endSession(ctx.sessionId);
  }

  await ctx.runtime.shutdown();
  console.log(SUCCESS('Goodbye! 🐴'));
  process.exit(0);
}

function handleCost(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('Session Cost'));
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
  console.log();
  console.log(`  ${ACCENT('Total Tokens')}   ${stats.totalTokens}`);
  console.log(`  ${ACCENT('Prompt')}         ${stats.totalPromptTokens}`);
  console.log(`  ${ACCENT('Completion')}    ${stats.totalCompletionTokens}`);
  console.log(`  ${ACCENT('Est. Cost')}     ${costTracker.formatCost(stats.totalCost)}`);
  console.log(`  ${ACCENT('Requests')}       ${stats.recordCount}`);

  // By Model
  if (Object.keys(stats.byModel).length > 0) {
    console.log();
    console.log(HEADER('  By Model:'));
    for (const [model, data] of Object.entries(stats.byModel)) {
      console.log(`    ${BRAND(model.padEnd(20))} ${data.tokens} tokens, ${costTracker.formatCost(data.cost)}`);
    }
  }

  // Budget
  const budget = costTracker.getBudget();
  if (budget !== null) {
    const check = costTracker.checkBudget();
    console.log();
    console.log(HEADER('  Budget:'));
    console.log(`    ${ACCENT('Limit')}    ${costTracker.formatCost(budget)}`);
    console.log(`    ${ACCENT('Used')}     ${costTracker.formatCost(check.used)}`);
    console.log(`    ${check.ok ? SUCCESS('✓ Within budget') : WARN('⚠ Budget exceeded')}`);
  }

  console.log();
  return { success: true };
}

function handleSkills(ctx: CommandContext): CommandResult {
  const { getSkillsRegistry } = require('../skills');

  console.log();
  console.log(HEADER('Loaded Skills'));
  console.log(DIM('─'.repeat(40)));

  try {
    const registry = getSkillsRegistry();
    const summary = registry.getSummary();

    if (summary.count === 0) {
      console.log();
      console.log(DIM('  No skills loaded.'));
      console.log(DIM('  Place SKILL.md files in ~/.openhorse/skills/<name>/ or .openhorse/skills/<name>/'));
      console.log();
      return { success: true };
    }

    console.log();
    console.log(`  Total ${SUCCESS(summary.count)} skills (${WARN(summary.autoCount)} auto-trigger)`);
    console.log();
    for (const skill of registry.getAllSkills()) {
      const source = registry['loader']?.getSource(skill.name);
      const sourceType = source?.type || 'unknown';
      console.log(`  ${ACCENT(skill.name)} ${DIM(`(${sourceType})`)}`);
      console.log(`    ${DIM(skill.description || '(no description)')}`);
    }
    console.log();
  } catch (err: any) {
    console.log(ERROR(`✗ ${err.message}`));
    return { success: false };
  }

  return { success: true };
}

function handleMcp(ctx: CommandContext): CommandResult {
  console.log();
  console.log(HEADER('MCP Servers'));
  console.log(DIM('─'.repeat(40)));

  const status = mcpManager.getStatus();
  if (status.length === 0) {
    console.log();
    console.log(DIM('  No servers configured. Add to ~/.openhorse/mcp.json'));
    console.log();
    return { success: true };
  }

  console.log();
  for (const s of status) {
    const stateLabel = s.dead
      ? ERROR('dead')
      : s.connected
        ? SUCCESS('connected')
        : WARN('disconnected');
    console.log(`  ${ACCENT(s.name.padEnd(20))} ${stateLabel}  ${DIM(`${s.toolCount} tools`)}`);
  }
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
  resetToolState();
  console.log(SUCCESS(`✔ Cleared ${history.length} messages from conversation history`));
  console.log(DIM('  Configuration and system state preserved'));
  console.log();
  return { success: true };
}

async function handleCompact(ctx: CommandContext, args: string): Promise<CommandResult> {
  const history = ctx.store.getSnapshot().conversationHistory;

  if (history.length === 0) {
    console.log(DIM('Conversation history is empty, nothing to compact'));
    console.log();
    return { success: true };
  }

  // 解析参数
  const thresholdArg = parseInt(args.trim(), 10);
  const threshold = thresholdArg > 0 ? thresholdArg : 50;

  console.log();
  console.log(HEADER('Compacting Conversation'));
  console.log(DIM('─'.repeat(40)));
  console.log(`  Current messages: ${history.length}`);
  console.log(`  Threshold: ${threshold}`);
  console.log();

  if (history.length <= threshold) {
    console.log(DIM(`Conversation has ${history.length} messages, below compact threshold ${threshold}.`));
    console.log(DIM('Nothing compacted.'));
    console.log();
    return { success: true };
  }

  try {
    const autoCompact = getAutoCompact();
    autoCompact.configure({
      maxMessages: threshold,
      getContextCapsule: () => ctx.store.getSnapshot().harnessState?.capsule,
    });
    const compacted = await autoCompact.forceCompact(history);

    // 更新 store
    ctx.store.setState({ conversationHistory: compacted });

    const reduction = history.length - compacted.length;
    const percent = Math.round((reduction / history.length) * 100);

    console.log(SUCCESS(`✔ Compacted ${history.length} → ${compacted.length} messages`));
    console.log(DIM(`  Reduced by ${reduction} messages (${percent}%)`));
    console.log();
    return { success: true };
  } catch (err: any) {
    console.log(ERROR(`✗ Compact failed: ${err.message}`));
    console.log();
    return { success: false };
  }
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
// Session 命令
// ============================================================================

function parseSessionScopeArgs(args: string, cwd: string): { allProjects: boolean; projectPath: string; query: string; last: boolean } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let allProjects = false;
  let last = false;
  let projectPath = resolveProjectPath(cwd);
  const queryParts: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '--all' || part === '-a') {
      allProjects = true;
      continue;
    }
    if (part === '--last' || part === '-l') {
      last = true;
      continue;
    }
    if ((part === '--project' || part === '-p') && parts[i + 1]) {
      projectPath = resolveProjectPath(parts[i + 1]);
      i++;
      continue;
    }
    queryParts.push(part);
  }

  return {
    allProjects,
    projectPath,
    last,
    query: queryParts.join(' '),
  };
}

function sessionTitle(session: SessionMeta): string {
  return session.name || session.taskSummary || '(untitled)';
}

function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 3) + '...' : text;
}

function printSessionRows(sessions: SessionMeta[], options: { showProject?: boolean; indexed?: boolean } = {}): void {
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const startTime = new Date(session.startTime).toLocaleString();
    const updatedTime = new Date(session.updatedAt ?? session.startTime).toLocaleString();
    const duration = session.endTime
      ? Math.round((session.endTime - session.startTime) / 1000) + 's'
      : 'active';
    const status = session.endTime ? DIM('completed') : ACCENT('active');
    const index = options.indexed ? `${String(i + 1).padStart(2, ' ')}. ` : '  ';
    const name = session.name ? ` ${ACCENT(`"${session.name}"`)}` : '';

    console.log(`${index}${status} ${BRAND(session.id.slice(0, 8))}${name} ${DIM(session.model)}`);
    console.log(`    ${truncateText(sessionTitle(session), 96)}`);
    console.log(`    ${DIM(`Started: ${startTime}`)} ${DIM(`Updated: ${updatedTime}`)} ${DIM(`Duration: ${duration}`)}`);
    console.log(`    ${DIM(`Messages: ${session.messageCount ?? 0}`)} ${DIM(`Tokens: ${session.tokenCount}`)} ${DIM(`Cost: $${session.cost.toFixed(4)}`)}`);
    if (options.showProject) {
      console.log(`    ${DIM(`Project: ${session.projectPath}`)}`);
    }
    console.log();
  }
}

function parsePickerIndex(ref: string, max: number): number | null {
  const trimmed = ref.trim();
  const match = trimmed.match(/^#?(\d+)$/);
  if (!match) return null;

  const index = Number(match[1]);
  if (!Number.isInteger(index) || index < 1 || index > max) return null;
  return index - 1;
}

function printSessionConflict(ref: string, matches: SessionMeta[]): void {
  console.log(ERROR(`Session reference is ambiguous: ${ref}`));
  console.log(DIM('Use a longer id prefix, exact session name, or pick one of these:'));
  console.log();
  printSessionRows(matches.slice(0, 10), { indexed: true, showProject: true });
  console.log(DIM('Example: /resume <longer-session-id>'));
  console.log();
}

function handleSessions(ctx: CommandContext, args: string = ''): CommandResult {
  const scope = parseSessionScopeArgs(args, ctx.cwd);
  console.log();
  console.log(HEADER(scope.allProjects ? 'Sessions (all projects)' : 'Sessions'));
  console.log(DIM('─'.repeat(40)));

  const sessions = scope.allProjects
    ? listSessions(10)
    : listProjectSessions(scope.projectPath, 10);

  if (sessions.length === 0) {
    console.log(DIM(scope.allProjects ? '  No sessions found' : '  No sessions found for this project'));
    console.log();
    return { success: true };
  }

  console.log();
  printSessionRows(sessions, { indexed: true, showProject: scope.allProjects });

  console.log(DIM('Use /resume <number|session-id|name> to restore a session'));
  console.log(DIM('Use /session-rename <number|session-id|name> <new name> to rename'));
  console.log(DIM('Use /sessions --all to list sessions from every project'));
  console.log();
  return { success: true };
}

function handleResume(ctx: CommandContext, args: string): CommandResult {
  const scope = parseSessionScopeArgs(args, ctx.cwd);
  const sessionRef = scope.query;
  const scopedSessions = (scope.allProjects ? listSessions() : listProjectSessions(scope.projectPath))
    .filter(session => (session.messageCount ?? 0) > 0);

  if (!sessionRef) {
    const lastSession = scopedSessions[0];
    if (!lastSession) {
      console.log(ERROR('No previous session found for this project'));
      console.log(DIM('Use /sessions --all to list all sessions'));
      console.log();
      return { success: false };
    }

    if (scope.last || scopedSessions.length === 1) {
      return restoreSession(ctx, lastSession, true);
    }

    console.log();
    console.log(HEADER(scope.allProjects ? 'Pick a Session (all projects)' : 'Pick a Session'));
    console.log(DIM('─'.repeat(40)));
    console.log();
    printSessionRows(scopedSessions.slice(0, 10), { indexed: true, showProject: scope.allProjects });
    console.log(DIM('Use /resume <number> to restore, for example /resume 1'));
    console.log(DIM('Use /resume --last to skip the picker next time'));
    console.log();
    return { success: true };
  }

  const pickerIndex = parsePickerIndex(sessionRef, scopedSessions.length);
  if (pickerIndex !== null) {
    return restoreSession(ctx, scopedSessions[pickerIndex], false);
  }

  // Resume specific session
  const result = lookupSessionRef(sessionRef, scope.projectPath, { allProjects: scope.allProjects });

  if (result.status === 'ambiguous') {
    printSessionConflict(sessionRef, result.matches);
    return { success: false };
  }

  if (result.status === 'not_found') {
    console.log(ERROR(`Session not found: ${sessionRef}`));
    console.log(DIM(scope.allProjects ? 'Use /sessions --all to list sessions' : 'Use /sessions to list project sessions, or /resume <id> --all'));
    console.log();
    return { success: false };
  }

  return restoreSession(ctx, result.session, false);
}

function restoreSession(ctx: CommandContext, session: SessionMeta, isLast: boolean): CommandResult {
  const resumed = resumeSession(session.id) ?? session;

  console.log();
  console.log(HEADER(isLast ? 'Resuming last session' : `Resuming session ${resumed.id.slice(0, 8)}`));
  console.log(DIM(`  ID: ${resumed.id}`));
  console.log(DIM(`  Model: ${resumed.model}`));
  console.log(DIM(`  Project: ${resumed.projectPath}`));
  console.log(DIM(`  Started: ${new Date(resumed.startTime).toLocaleString()}`));
  ctx.setSession?.(resumed);

  // Load history and show summary
  const history = loadSessionHistory(resumed.id);
  if (history.length > 0) {
    const summary = generateHistorySummary(history);
    console.log(DIM(`  Summary: ${summary}`));
    console.log();

    ctx.store.setState({ conversationHistory: history });
    ctx.store.setState({ harnessState: resumed.harnessState });
    resetToolState();
    console.log(SUCCESS(`✔ Restored ${history.length} messages`));
  } else {
    console.log();
    console.log(DIM('  No messages in session'));
  }

  console.log();
  return { success: true };
}

function handleSessionRename(ctx: CommandContext, args: string): CommandResult {
  const scope = parseSessionScopeArgs(args, ctx.cwd);
  const parts = scope.query.split(/\s+/).filter(Boolean);
  const ref = parts.shift();
  const newName = parts.join(' ').trim();

  if (!ref || !newName) {
    console.log(ERROR('Usage: /session-rename <number|session-id|name> <new name>'));
    console.log(DIM('Run /sessions first to see picker numbers for this project.'));
    console.log();
    return { success: false };
  }

  const scopedSessions = scope.allProjects ? listSessions() : listProjectSessions(scope.projectPath);
  const pickerIndex = parsePickerIndex(ref, scopedSessions.length);
  let session: SessionMeta | null = pickerIndex !== null ? scopedSessions[pickerIndex] : null;

  if (!session) {
    const result = lookupSessionRef(ref, scope.projectPath, { allProjects: scope.allProjects });
    if (result.status === 'ambiguous') {
      printSessionConflict(ref, result.matches);
      return { success: false };
    }
    if (result.status === 'not_found') {
      console.log(ERROR(`Session not found: ${ref}`));
      console.log(DIM(scope.allProjects ? 'Use /sessions --all to list sessions' : 'Use /sessions to list project sessions'));
      console.log();
      return { success: false };
    }
    session = result.session;
  }

  const duplicate = scopedSessions.find(s => s.id !== session!.id && s.name === newName);
  const renamed = renameSession(session.id, newName);
  if (!renamed) {
    console.log(ERROR(`Session not found: ${ref}`));
    console.log();
    return { success: false };
  }

  if (ctx.getSession?.()?.id === renamed.id) {
    ctx.setSession?.(renamed);
  }

  console.log();
  console.log(SUCCESS(`✔ Renamed session ${renamed.id.slice(0, 8)} to "${newName}"`));
  if (duplicate) {
    console.log(WARN(`  Name already exists on ${duplicate.id.slice(0, 8)}; /resume "${newName}" will be ambiguous.`));
  }
  console.log();
  return { success: true };
}

/** Generate a brief summary of conversation history */
function generateHistorySummary(messages: Message[]): string {
  const userMsgs = messages.filter(m => m.role === 'user' && m.content);
  const assistantMsgsWithTools = messages.filter(m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0);

  // Extract topics from first few user messages
  const topics = userMsgs.slice(0, 3).map(m => {
    const content = m.content || '';
    return content.length > 40 ? content.slice(0, 40) + '...' : content;
  });

  // Extract tools used
  const toolsUsed = assistantMsgsWithTools.flatMap(m =>
    m.tool_calls?.map(tc => tc.function.name) || []
  );
  const uniqueTools = [...new Set(toolsUsed)];

  // Build summary
  const parts: string[] = [];

  if (topics.length > 0) {
    parts.push(`Topics: ${topics.join('; ')}`);
  }

  if (uniqueTools.length > 0) {
    parts.push(`Tools: ${uniqueTools.join(', ')}`);
  }

  if (parts.length === 0) {
    return 'No significant activity';
  }

  return parts.join('. ');
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
    name: 'compact',
    description: 'Compact conversation history to reduce context size',
    argumentHint: '[threshold]',
    type: 'builtin',
    execute: (ctx, args) => handleCompact(ctx, args),
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

  // Agent/Harness 命令
  {
    name: 'agents',
    description: 'List registered agents and their status',
    type: 'builtin',
    execute: (ctx) => showAgents(ctx),
  },
  {
    name: 'memory',
    description: 'Show memory status, or `/memory reindex` to rebuild semantic index',
    argumentHint: '[reindex]',
    type: 'builtin',
    execute: (ctx, args) => handleMemory(ctx, args),
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

  // Session 命令
  {
    name: 'sessions',
    description: 'List recent sessions',
    type: 'builtin',
    execute: (ctx, args) => handleSessions(ctx, args),
  },
  {
    name: 'resume',
    description: 'Resume a previous session',
    argumentHint: '[number|session-id|name]',
    type: 'builtin',
    execute: (ctx, args) => handleResume(ctx, args),
  },
  {
    name: 'session-rename',
    aliases: ['rename-session'],
    description: 'Rename a saved session',
    argumentHint: '<number|session-id|name> <new name>',
    type: 'builtin',
    execute: (ctx, args) => handleSessionRename(ctx, args),
  },

  // MCP
  {
    name: 'mcp',
    description: 'Show connected MCP servers and their status',
    type: 'builtin',
    execute: (ctx) => handleMcp(ctx),
  },

  // Skills
  {
    name: 'skills',
    description: 'List loaded skills (built-in / user / project)',
    type: 'builtin',
    execute: (ctx) => handleSkills(ctx),
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
