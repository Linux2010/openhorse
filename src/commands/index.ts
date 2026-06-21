/**
 * openhorse - Command Registry
 *
 * 注册所有 slash 命令，提供查找和列表功能。
 */

import chalk from 'chalk';
import {
  PERMISSION_MODES,
  getModeDisplayText,
  getNextPermissionMode,
  type SlashCommand,
  type CommandCategory,
  type CommandContext,
  type CommandResult,
  type PermissionMode,
} from './types';
import type { Task } from '../core/agent';
import { TaskManager, CreateTaskOptions } from '../services/task-manager';
import { AgentRunner } from '../services/agent-runner';
import { isConfigured } from '../services/config';
import { createSpinner, toolLine } from '../ui/box';
import { createStreamRenderer, type StreamMarkdownRenderer } from '../ui/stream-markdown';
import { showProgress, hideProgress, showToolProgress } from '../ui/progress';
import { renderSessionPicker } from '../ui-v2';
import { formatBytes } from '../ui-v2/state/sessions';
import { query, getSystemPrompt, resetToolState, getToolState, type QueryEvent, type PromptContext } from '../framework';
import { executeTool, getRuntimeTools, getToolNames } from '../tools';
import { mcpManager } from '../tools/mcp';
import type { Message, StreamCallbacks } from '../services/llm';
import {
  listSessions,
  listProjectSessions,
  lookupSessionRef,
  loadSessionHistory,
  loadSessionMeta,
  markSessionTranscriptDisplayStart,
  appendSessionMessage,
  appendSessionMessages,
  endSession,
  updateSessionSummary,
  updateSessionHarnessState,
  loadSessionHarnessState,
  updateSessionSkills,
  resumeSession,
  renameSession,
  resolveProjectPath,
  readSessionMessages,
  type SessionMeta,
  type SessionMessage,
} from '../services/session-storage';
import { loadSessionIndex, searchSessions } from '../services/session-index';
import { getAutoCompact } from '../services/compact/auto-compact';
import { createContextHarness } from '../harness';
import { resolveSkillsForTurn } from '../skills';
import { buildReferencedFilesPrompt } from '../services/file-context';
import { loadProjectInstructionFiles } from '../services/project-instructions';
import { refreshProjectInstructions } from '../services/prompt-context';
import { collectDoctorReport, formatDoctorReport, hasDoctorFailures } from '../services/doctor';
import { collectWorkspaceDiff, formatWorkspaceDiff } from '../services/workspace-diff';
import { createCommitPlan, formatCommitPlan } from '../services/commit-plan';

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

const CATEGORY_ORDER: CommandCategory[] = [
  'workflow',
  'session',
  'context',
  'tools',
  'model',
  'system',
  'diagnostics',
  'legacy',
];

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  workflow: 'Workflow',
  session: 'Session',
  context: 'Context',
  tools: 'Tools',
  model: 'Model',
  system: 'System',
  diagnostics: 'Diagnostics',
  legacy: 'Legacy',
};

function commandCategory(command: SlashCommand): CommandCategory {
  return command.category ?? 'system';
}

export function getCommandCategoryLabel(category: CommandCategory | undefined): string {
  return CATEGORY_LABELS[category ?? 'system'];
}

export function sortCommands(commands: SlashCommand[]): SlashCommand[] {
  return [...commands].sort((a, b) => {
    const categoryDelta = CATEGORY_ORDER.indexOf(commandCategory(a)) - CATEGORY_ORDER.indexOf(commandCategory(b));
    if (categoryDelta !== 0) return categoryDelta;
    const priorityDelta = (a.priority ?? 100) - (b.priority ?? 100);
    if (priorityDelta !== 0) return priorityDelta;
    return a.name.localeCompare(b.name);
  });
}

function isAbortError(error: unknown, abortSignal?: AbortSignal): boolean {
  if (abortSignal?.aborted) return true;
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.message.toLowerCase().includes('aborted');
  }
  return false;
}

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

  const visible = getVisibleCommands();
  for (const category of CATEGORY_ORDER) {
    const items = visible.filter(cmd => commandCategory(cmd) === category);
    if (items.length === 0) continue;

    console.log(DIM(getCommandCategoryLabel(category)));
    for (const cmd of items) {
      const aliases = cmd.aliases ? ` (${cmd.aliases.join(', ')})` : '';
      const params = cmd.argumentHint || cmd.params?.map(p => `<${p.name}>`).join(' ') || '';
      console.log(`  ${ACCENT(`/${cmd.name}`)}${aliases} ${DIM(params)}`);
      console.log(`    ${DIM(cmd.description)}`);
    }
    console.log();
  }

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

  refreshProjectInstructions(ctx.store, ctx.cwd);
  const snapshot = ctx.store.getSnapshot();
  const instructionFiles = loadProjectInstructionFiles(ctx.cwd);
  console.log();
  console.log(`  Context:`);
  console.log(`    Project rules ${instructionFiles.length > 0 ? SUCCESS(`${instructionFiles.length} files`) : DIM('none')}`);
  for (const file of instructionFiles.slice(0, 8)) {
    console.log(`      ${DIM(file.path)}${file.truncated ? ` ${WARN('(truncated)')}` : ''}`);
  }
  if (instructionFiles.length > 8) {
    console.log(`      ${DIM(`... ${instructionFiles.length - 8} more`)}`);
  }
  console.log(`    Prompt rules  ${snapshot.projectInstructionsContent ? SUCCESS(`${snapshot.projectInstructionsContent.length} chars`) : DIM('none')}`);
  console.log(`    Project memory ${snapshot.memoryContent ? SUCCESS(`${snapshot.memoryContent.length} chars`) : DIM('none')}`);
  console.log(`    Skills index   ${snapshot.skillsContent ? SUCCESS(`${snapshot.skillsContent.length} chars`) : DIM('none')}`);

  const harnessState = snapshot.harnessState;
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

function showHarness(ctx: CommandContext, args: string = ''): CommandResult {
  const explain = args.trim().toLowerCase() === 'explain';
  console.log();
  console.log(HEADER(explain ? 'Harness Explain' : 'Harness'));
  console.log(DIM('─'.repeat(40)));

  const cfg = ctx.runtime.harness.getConfig();
  console.log();
  if (!explain) {
    console.log(`  Max steps       ${cfg.maxSteps}`);
    console.log(`  Boundary check  ${cfg.boundaryCheck ? SUCCESS('on') : ERROR('off')}`);
    console.log(`  Goal constraint ${cfg.goalConstraint ? SUCCESS('on') : ERROR('off')}`);
    console.log(`  Result validate ${cfg.resultValidation ? SUCCESS('on') : ERROR('off')}`);
    console.log(`  Sandbox         ${cfg.sandbox ? WARN('on') : DIM('off')}`);
    console.log(`  Timeout         ${cfg.timeout}ms`);
    console.log(`  Blocked actions ${DIM(cfg.blockedActions.join(', ') || 'none')}`);
  }

  const state = ctx.store.getSnapshot().harnessState;
  if (!state) {
    console.log();
    console.log(DIM('  No Context Harness state for this session yet.'));
    console.log();
    return { success: true };
  }

  if (explain) {
    // Build explain output from harnessState in store
    const contract = state.contract;

    // Contract section
    console.log(HEADER('  Contract'));
    if (contract) {
      console.log(`    Objective   ${ACCENT(contract.objective || '(none)')}`);
      if (contract.requirements?.length) {
        console.log(`    Requires    ${DIM(contract.requirements.slice(0, 3).join(' | '))}`);
      }
      if (contract.prohibitions?.length) {
        console.log(`    Prohibits   ${WARN(contract.prohibitions.slice(0, 3).join(' | '))}`);
      }
      if (contract.successCriteria?.length) {
        console.log(`    Success     ${DIM(contract.successCriteria.slice(0, 3).join(' | '))}`);
      }
    } else {
      console.log(DIM('    (no contract established)'));
    }
    console.log();

    // Intent history
    console.log(HEADER('  Recent Intents'));
    const intents = state.intentHistory?.slice(-5) ?? [];
    if (intents.length > 0) {
      for (const intent of intents) {
        const conf = intent.confidence != null ? ` (${Math.round(intent.confidence * 100)}%)` : '';
        console.log(`    ${ACCENT(intent.kind)}${DIM(conf)} ${DIM(intent.summary?.slice(0, 50) || '')}`);
      }
    } else {
      console.log(DIM('    (no intents recorded)'));
    }
    console.log();

    // Capsule snapshot
    console.log(HEADER('  Capsule'));
    const capsule = state.capsule;
    if (capsule) {
      console.log(`    Next        ${DIM(capsule.nextAction)}`);
      if (capsule.completed?.length) {
        console.log(`    Done        ${SUCCESS(`${capsule.completed.length} steps`)}`);
      }
      if (capsule.openTodos?.length) {
        console.log(`    Open        ${WARN(`${capsule.openTodos.length} todos`)}`);
      }
      if (capsule.changedFiles?.length) {
        console.log(`    Files       ${DIM(capsule.changedFiles.slice(0, 5).join(', '))}`);
      }
      const passed = capsule.verification?.passed?.length ?? 0;
      const failed = capsule.verification?.failed?.length ?? 0;
      console.log(`    Verify      ${SUCCESS(`${passed} passed`)} / ${failed > 0 ? ERROR(`${failed} failed`) : DIM('0 failed')}`);
    } else {
      console.log(DIM('    (no capsule yet)'));
    }
    console.log();

    // Prompt assembly stats
    const stats = state.promptAssemblyStats;
    console.log(HEADER('  Prompt Assembly'));
    if (stats) {
      console.log(`    Model       ${ACCENT(stats.modelId)}`);
      console.log(`    Budget      ${DIM(`${stats.estimatedTokens}/${stats.budgetTokens} tokens`)}`);
      console.log(`    Sections    ${DIM(stats.sections.join(', ') || 'none')}`);
      console.log(`    Ledger      ${DIM(`${state.ledger?.length ?? 0} entries`)}`);
      console.log(`    Evidence    ${DIM(`${state.evidenceIndex?.length ?? 0} records`)}`);
      console.log(`    Turns       ${DIM(`${state.turnSummaries?.length ?? 0} summaries`)}`);
      console.log();
      console.log(HEADER('    Included Evidence'));
      for (const item of stats.includedEvidence.slice(0, 10)) {
        console.log(`      ${ACCENT(item.id)} ${DIM(`[${item.kind}] score=${item.score} tokens=${item.tokens}`)}`);
        console.log(`        ${DIM(item.reason)}`);
      }
      if (stats.includedEvidence.length === 0) {
        console.log(DIM('      none'));
      }
      if (stats.omittedEvidence.length > 0) {
        console.log();
        console.log(HEADER('    Omitted Evidence'));
        for (const item of stats.omittedEvidence.slice(0, 8)) {
          console.log(`      ${DIM(item.id)} ${DIM(`[${item.kind}] score=${item.score} tokens=${item.tokens}`)}`);
          console.log(`        ${DIM(item.reason)}`);
        }
      }
    } else {
      console.log(DIM('    No prompt assembly stats recorded yet. Run a chat turn first.'));
    }
    console.log();
    return { success: true };
  }

  console.log();
  console.log(HEADER('  Context State'));
  console.log(`    Version     ${ACCENT(String(state.version ?? 1))}`);
  console.log(`    Epoch       ${ACCENT(String(state.taskEpoch ?? 1))}`);
  console.log(`    Objective   ${ACCENT(state.rootObjective ?? state.contract?.objective ?? '(none)')}`);
  console.log(`    Active      ${DIM(state.activeInstruction ?? state.contract?.userIntent ?? '(none)')}`);
  console.log(`    Ledger      ${DIM(`${state.ledger.length} entries`)}`);
  console.log(`    Evidence    ${DIM(`${state.evidenceIndex?.length ?? 0} records`)}`);
  console.log(`    Turns       ${DIM(`${state.turnSummaries?.length ?? 0} summaries`)}`);
  if (state.activeConstraints && state.activeConstraints.length > 0) {
    console.log(`    Constraints ${DIM(state.activeConstraints.slice(0, 3).join(' | '))}`);
  }
  if (state.capsule) {
    console.log(`    Next        ${DIM(state.capsule.nextAction)}`);
    const passed = state.capsule.verification.passed.length;
    const failed = state.capsule.verification.failed.length;
    console.log(`    Verify      ${SUCCESS(`${passed} passed`)} / ${failed > 0 ? ERROR(`${failed} failed`) : DIM('0 failed')}`);
  }
  if (state.diagnostics && state.diagnostics.length > 0) {
    console.log(`    Diagnostics ${WARN(state.diagnostics.slice(-2).join(' | '))}`);
  }
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
    toolConfirmation: ctx.config.toolConfirmation,
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

function normalizePermissionMode(raw: string): PermissionMode | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value === 'accept' || value === 'acceptedits' || value === 'accept-edits' || value === 'edit') {
    return 'acceptEdits';
  }
  if (value === 'default' || value === 'ask') return 'default';
  if (value === 'plan' || value === 'readonly' || value === 'read-only') return 'plan';
  if (value === 'auto' || value === 'full-auto') return 'auto';
  return null;
}

function handleMode(ctx: CommandContext, args: string): CommandResult {
  const current = ctx.store.getSnapshot().permissionMode;
  const trimmed = args.trim();

  if (!trimmed || trimmed === '?' || trimmed === 'help') {
    console.log();
    console.log(HEADER('Permission Mode'));
    console.log(DIM('─'.repeat(40)));
    console.log(`  Current  ${ACCENT(current)} ${DIM(getModeDisplayText(current) || 'ask before sensitive actions')}`);
    console.log();
    console.log(`  ${ACCENT('/mode next')}           Cycle to the next mode`);
    console.log(`  ${ACCENT('/mode default')}        Ask before sensitive actions`);
    console.log(`  ${ACCENT('/mode accept-edits')}   Auto-accept file edits`);
    console.log(`  ${ACCENT('/mode plan')}           Plan first, avoid executing edits`);
    console.log(`  ${ACCENT('/mode auto')}           Auto-run allowed actions`);
    console.log();
    return { success: true };
  }

  const next = trimmed === 'next'
    ? getNextPermissionMode(current)
    : normalizePermissionMode(trimmed);

  if (!next || !PERMISSION_MODES.includes(next)) {
    return {
      success: false,
      error: `Unknown mode: ${trimmed}. Use one of: default, accept-edits, plan, auto, next.`,
    };
  }

  ctx.store.setPermissionMode(next);
  const display = getModeDisplayText(next);
  return {
    success: true,
    output: `Mode changed to ${next}${display ? ` (${display})` : ''}.`,
  };
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
  const writeOutput = ctx.writeOutput ?? ((text: string) => process.stdout.write(text));
  const writeLine = ctx.writeLine ?? ((text: string = '') => console.log(text));

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
  const runtimeTools = getRuntimeTools();
  const skillResolution = resolveSkillsForTurn({
    cwd: ctx.cwd,
    input,
    tools: runtimeTools,
    projectPath: activeSession?.projectPath,
    sessionId,
  });
  const appliedSkillNames = skillResolution.skills.map(skill => skill.name);

  // Record user message to session
  if (sessionId) {
    appendSessionMessage(sessionId, {
      role: 'user',
      content: input,
      timestamp: Date.now(),
      appliedSkills: appliedSkillNames.length > 0 ? appliedSkillNames : undefined,
    });
  }

  ctx.store.addMessage({ role: 'user', content: input });
  refreshProjectInstructions(ctx.store, ctx.cwd);
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
  const intent = harness.updateContractFromUserInput(input);
  harness.recordAppliedSkills(skillResolution.skills);

  const promptCtx: PromptContext = {
    cwd: ctx.cwd,
    platform: process.platform,
    nodeVersion: process.version,
    tools: skillResolution.tools,
    memoryContent: snapshot.memoryContent,
    skillsContent: snapshot.skillsContent,
    projectInstructionsContent: snapshot.projectInstructionsContent,
    activeSkillsContent: skillResolution.promptInjection,
    referencedFilesContent: buildReferencedFilesPrompt(input, ctx.cwd),
  };
  const systemPrompt = getSystemPrompt(promptCtx);

  const spinner = createSpinner();
  const useSpinner = ctx.config.ui?.renderer !== 'v2';
  if (useSpinner) {
    spinner.start('Thinking');
  }

  let finalContent = '';
  let finalModel = '';
  let finalUsage: { promptTokens: number; completionTokens: number } | undefined;
  let responseStarted = false;
  const sessionMessagesToRecord: SessionMessage[] = [];

  // Issue #22: 批量工具调用进度显示
  let toolCallCount = 0;
  let lastProgressUpdate = 0;

  // 流式 Markdown 渲染器
  let streamRenderer: StreamMarkdownRenderer | null = null;

  // Issue #32 #3.2: toolExecutor 支持 abortSignal
  const toolExecutor = async (name: string, args: Record<string, unknown>, abortSignal?: AbortSignal) => {
    if (!skillResolution.tools.some(tool => tool.name === name)) {
      return JSON.stringify({
        success: false,
        error: skillResolution.toolScopeActive
          ? `Tool ${name} is not available for the active skill scope. Available tools: ${skillResolution.tools.map(tool => tool.name).join(', ') || 'none'}`
          : `Tool ${name} is not available.`,
      });
    }
    const result = await executeTool(name, args, abortSignal, {
      cwd: ctx.cwd,
      config: {
        name: ctx.config.name,
        mode: ctx.config.mode,
      },
      sessionId,
      turnId: ctx.turnId,
    });
    // 不在这里打印，让 tool_result 事件处理
    return result;
  };

  const streamCallbacks: StreamCallbacks = {
    onChunk: (chunk: string) => {
      if (ctx.abortSignal?.aborted) {
        return;
      }

      if (!responseStarted) {
        responseStarted = true;
        spinner.stop();
        // 打印换行，让流式输出在新行开始
        writeLine();
        // 初始化流式渲染器
        streamRenderer = createStreamRenderer();
      }
      // 使用流式渲染器处理 chunk
      if (streamRenderer) {
        const rendered = streamRenderer.feed(chunk);
        if (rendered) {
          writeOutput(rendered);
        }
      } else {
        writeOutput(chunk);
      }
    },
  };

  try {
    const messages: Message[] = [{ role: 'system', content: systemPrompt }, ...snapshot.conversationHistory];

    for await (const event of query({
      messages,
      tools: skillResolution.tools,
      toolExecutor,
      llm: ctx.llm,
      streamCallbacks,
      costTracker: snapshot.costTracker,
      permissionMode: snapshot.permissionMode,
      toolConfirmation: ctx.config.toolConfirmation,
      toolContext: {
        cwd: ctx.cwd,
        config: {
          name: ctx.config.name,
          mode: ctx.config.mode,
        },
        sessionId,
        turnId: ctx.turnId,
      },
      abortSignal: ctx.abortSignal,
      harness,
      input,
    })) {
      switch (event.type) {
        case 'request_start':
          // 停止 spinner，等待 LLM 响应
          spinner.stop();
          writeLine();
          writeLine(DIM(`Turn ${event.turn}...`));
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
          break;

        case 'tool_result':
          // Issue #22: 隐藏进度指示
          hideProgress();
          // 显示工具结果后，准备下一轮（不启动 spinner）
          writeLine(event.summary || toolLine(event.name, event.args, event.success, event.duration));
          // 显示错误详情
          if (!event.success && event.error) {
            writeLine(ERROR(`    Error: ${event.error}`));
          }
          // Debug: 显示接收到的参数
          if (!event.success && Object.keys(event.args).length === 0) {
            writeLine(WARN(`    ⚠ Tool received empty arguments - LLM may not be providing parameters correctly`));
            writeLine(DIM(`    Try using /model qwen or /model gpt4o for better tool calling support`));
          }
          // Record tool result for session
          sessionMessagesToRecord.push({
            role: 'tool',
            content: event.result,
            timestamp: Date.now(),
            toolCallId: event.callId,
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
          writeLine(WARN(`⚠ ${event.suggestion}`));
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
        writeOutput(remaining);
      }
      streamRenderer = null;
    }

    const wasAborted = ctx.abortSignal?.aborted === true;

    if (finalContent && !wasAborted) {
      ctx.store.addMessage({ role: 'assistant', content: finalContent });
    }

    if (sessionId && sessionMessagesToRecord.length > 0 && !wasAborted) {
      appendSessionMessages(sessionId, sessionMessagesToRecord);
    }

    if (finalUsage && !wasAborted) {
      ctx.store.setTokenUsage(finalUsage);
    }

    if (!wasAborted) {
      harness.ingestTurn({
        userInput: input,
        assistantContent: finalContent,
        sessionMessages: sessionMessagesToRecord,
        intent,
      });
      const harnessState = harness.toJSON();
      ctx.store.setState({ harnessState });
      if (sessionId) {
        updateSessionSkills(sessionId, appliedSkillNames);
        updateSessionHarnessState(sessionId, harnessState);
        const recordedMessages = readSessionMessages(sessionId);
        if (recordedMessages.length > 0) {
          updateSessionSummary(sessionId, recordedMessages);
        }
      }
    }

    if (responseStarted) {
      writeLine();
      if (ctx.config.ui?.renderer === 'v2') {
        writeLine();
      }
    }
    if (ctx.config.ui?.renderer !== 'v2') {
      const stats = [
        finalUsage ? `tokens: ${finalUsage.promptTokens}+${finalUsage.completionTokens}` : '',
        finalModel ? finalModel : '',
      ].filter(Boolean).join('  ');
      if (stats) {
        writeLine(DIM(stats));
      }
    }
  } catch (error: any) {
    spinner.stop();
    writeLine();
    if (isAbortError(error, ctx.abortSignal)) {
      hideProgress();
      if (ctx.config.ui?.renderer !== 'v2') {
        writeLine(DIM('Interrupted.'));
      }
    } else {
      writeLine(ERROR(`✗ ${error.message || String(error)}`));
      const hist = ctx.store.getSnapshot().conversationHistory;
      if (hist.length > 0) {
        ctx.store.setState({ conversationHistory: hist.slice(0, -1) });
      }
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

function handleDoctor(ctx: CommandContext): CommandResult {
  const report = collectDoctorReport(ctx);
  console.log();
  console.log(formatDoctorReport(report));
  console.log();
  return { success: !hasDoctorFailures(report) };
}

function handleDiff(ctx: CommandContext, args: string): CommandResult {
  const maxFilesMatch = args.match(/--max-files(?:=|\s+)(\d+)/);
  const maxFiles = maxFilesMatch ? Number(maxFilesMatch[1]) : 40;
  const report = collectWorkspaceDiff({ cwd: ctx.cwd, maxFiles });
  console.log();
  console.log(formatWorkspaceDiff(report, { maxFiles }));
  console.log();
  return { success: report.isGitRepo };
}

function handleCommitPlan(ctx: CommandContext, args: string): CommandResult {
  const maxFilesMatch = args.match(/--max-files(?:=|\s+)(\d+)/);
  const maxFiles = maxFilesMatch ? Number(maxFilesMatch[1]) : 20;
  const plan = createCommitPlan({ cwd: ctx.cwd, maxFiles });
  console.log();
  console.log(formatCommitPlan(plan));
  console.log();
  return { success: plan.diff.isGitRepo };
}

function handleTools(ctx: CommandContext): CommandResult {
  const tools = ctx.store.getSnapshot().tools.length > 0
    ? ctx.store.getSnapshot().tools
    : getRuntimeTools();
  const staticTools = tools.filter(tool => !tool.name.startsWith('mcp__'));
  const mcpTools = tools.filter(tool => tool.name.startsWith('mcp__'));

  console.log();
  console.log(HEADER('Available Tools'));
  console.log(DIM('─'.repeat(40)));
  console.log(`  Static tools  ${ACCENT(String(staticTools.length))}`);
  console.log(`  MCP tools     ${ACCENT(String(mcpTools.length))}`);
  console.log();

  const visible = [...staticTools, ...mcpTools].slice(0, 28);
  for (const tool of visible) {
    const label = tool.name.startsWith('mcp__') ? 'mcp' : 'tool';
    console.log(`  ${ACCENT(tool.name)} ${DIM(`[${label}]`)}`);
    console.log(`    ${DIM(tool.description.slice(0, 96))}`);
  }

  if (tools.length > visible.length) {
    console.log();
    console.log(DIM(`  ... ${tools.length - visible.length} more tools hidden`));
  }
  console.log();
  return { success: true };
}

function handleTodos(ctx: CommandContext): CommandResult {
  const todos = ctx.store.getSnapshot().todos;
  console.log();
  console.log(HEADER('Todos'));
  console.log(DIM('─'.repeat(40)));

  if (todos.length === 0) {
    console.log(DIM('  No active todos yet.'));
    console.log();
    return { success: true };
  }

  for (const todo of todos) {
    const marker = todo.status === 'completed' ? SUCCESS('✓')
      : todo.status === 'in_progress' ? WARN('›')
      : DIM('○');
    console.log(`  ${marker} ${todo.content}`);
    if (todo.activeForm && todo.activeForm !== todo.content) {
      console.log(`    ${DIM(todo.activeForm)}`);
    }
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
      getHarnessState: () => ctx.store.getSnapshot().harnessState,
      llm: ctx.llm,
    });
    const compacted = await autoCompact.forceCompact(history);

    // 更新 store
    ctx.store.setState({ conversationHistory: compacted });

    const reduction = history.length - compacted.length;
    const percent = Math.round((reduction / history.length) * 100);
    const sessionId = ctx.getSession?.()?.id ?? ctx.sessionId;
    if (sessionId) {
      markSessionTranscriptDisplayStart(sessionId);
    }

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

function printSessionRows(sessions: SessionMeta[], options: { showProject?: boolean; indexed?: boolean; showIndexSummary?: boolean } = {}): void {
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
    console.log(`    ${DIM(`Messages: ${session.messageCount ?? 0}`)} ${DIM(`Size: ${formatBytes(session.historySizeBytes ?? 0)}`)} ${DIM(`Tokens: ${session.tokenCount}`)} ${DIM(`Cost: $${session.cost.toFixed(4)}`)}`);
    if (options.showIndexSummary) {
      const indexSummary = loadSessionIndex(session.id, session.projectPath);
      if (indexSummary) {
        const toolCount = Object.values(indexSummary.tools).reduce((total, count) => total + count, 0);
        console.log(`    ${DIM(`Index: ${indexSummary.files.length} files, ${toolCount} tool calls, ${indexSummary.topics.length} topics`)}`);
      } else {
        console.log(`    ${DIM('Index: not built')}`);
      }
    }
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

function printSessionPicker(sessions: SessionMeta[], options: { title: string; showProject?: boolean; moreCount?: number }): void {
  const lines = renderSessionPicker({
    title: options.title,
    sessions,
    width: process.stdout.columns || 80,
    showProject: options.showProject,
    moreCount: options.moreCount,
    footer: '  Use /resume <number|session-id|name>  /resume --last',
    theme: {
      accent: ACCENT,
      dim: DIM,
      selected: text => chalk.bgHex('#1E293B').hex('#E2E8F0')(text),
    },
  });

  for (const line of lines) {
    console.log(line);
  }
}

function handleSessions(ctx: CommandContext, args: string = ''): CommandResult {
  const scope = parseSessionScopeArgs(args, ctx.cwd);
  const query = scope.query?.trim();

  // If there's a search query, use the session index
  if (query && !query.startsWith('--')) {
    const allSessions = scope.allProjects
      ? listSessions()
      : listProjectSessions(scope.projectPath);
    const matchedIds = searchSessions(query, allSessions.map(session => ({
      id: session.id,
      projectPath: session.projectPath,
    })));

    if (matchedIds.length === 0) {
      console.log();
      console.log(HEADER(`Sessions (search: "${query}")`));
      console.log(DIM('─'.repeat(40)));
      console.log(DIM('  No matching sessions found'));
      console.log();
      console.log(DIM('Tip: search by file path, tool name, or topic keyword'));
      console.log();
      return { success: true };
    }

    // Rebuild session list in matched order
    const sessionMap = new Map(allSessions.map(s => [s.id, s]));
    const matchedSessions = matchedIds.map(id => sessionMap.get(id)).filter(Boolean) as SessionMeta[];

    console.log();
    console.log(HEADER(`Sessions (search: "${query}") — ${matchedSessions.length} matches`));
    console.log(DIM('─'.repeat(40)));
    console.log();
    printSessionRows(matchedSessions, { indexed: true, showProject: scope.allProjects, showIndexSummary: true });
    console.log();
    console.log(DIM(`Searched ${allSessions.length} sessions, found ${matchedSessions.length} matches`));
    console.log(DIM('Use /resume <number|session-id|name> to restore a session'));
    console.log();
    return { success: true };
  }

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
  console.log(DIM('Use /sessions <query> to search by file, tool, or keyword'));
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

    const picker = {
      title: scope.allProjects ? 'Pick a Session (all projects)' : 'Pick a Session',
      showProject: scope.allProjects,
      moreCount: 0,
      sessions: scopedSessions,
      allProjects: scope.allProjects,
      maxVisibleItems: 10,
    };

    if (ctx.config.ui?.renderer === 'v2' || ctx.config.ui?.renderer === 'ink' || ctx.config.ui?.renderer === 'terminal' || ctx.config.ui?.renderer === 'tui') {
      return { success: true, sessionPicker: picker };
    }

    const visibleSessions = scopedSessions.slice(0, 10);
    console.log();
    printSessionPicker(visibleSessions, {
      title: picker.title,
      showProject: picker.showProject,
      moreCount: Math.max(0, scopedSessions.length - visibleSessions.length),
    });
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
    ctx.store.setState({ harnessState: loadSessionHarnessState(resumed.id) ?? resumed.harnessState });
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

async function handleEditPreview(ctx: CommandContext): Promise<CommandResult> {
  const lastEdit = getToolState().lastEditFileArgs;

  if (!lastEdit) {
    console.log(ERROR('No previous edit_file call found for preview'));
    console.log(DIM('Run an edit_file tool call first, then use /edit-preview to inspect the match candidates.'));
    console.log();
    return { success: false };
  }

  const hasMetadata = Boolean(lastEdit.sessionId || lastEdit.turnId);
  if (!hasMetadata) {
    console.log(WARN('Using legacy edit-preview state without session/turn tags. Running preview as best-effort.'));
  }

  const staleBySession = Boolean(lastEdit.sessionId && ctx.sessionId && lastEdit.sessionId !== ctx.sessionId);
  const staleByTurn = Boolean(lastEdit.turnId != null && ctx.turnId != null && String(lastEdit.turnId) !== String(ctx.turnId));
  if (staleBySession || staleByTurn) {
    const mismatch = [];
    if (staleBySession) mismatch.push(`session ${lastEdit.sessionId} vs ${ctx.sessionId}`);
    if (staleByTurn) mismatch.push(`turn ${String(lastEdit.turnId)} vs ${String(ctx.turnId)}`);
    console.log(ERROR('Edit preview target does not match current context.'));
    console.log(DIM(`Stale edit target: ${mismatch.join(', ')}.`));
    console.log();
    return { success: false };
  }

  if (hasMetadata && !(ctx.sessionId || ctx.turnId)) {
    console.log(WARN('Edit preview context is available, but current command context is missing session/turn metadata.'));
    console.log(DIM('Preview is allowed, but stale checks cannot be fully validated.'));
  }

  const rawResult = await executeTool('edit_file', {
    ...lastEdit,
    preview: true,
  }, ctx.abortSignal, {
    cwd: ctx.cwd,
    config: {
      name: ctx.config.name,
      mode: ctx.config.mode,
    },
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
  });

  let parsed: { success?: boolean; output?: string; error?: string; metadata?: { candidates?: unknown[] } };
  try {
    parsed = JSON.parse(rawResult);
  } catch {
    parsed = { success: false, error: rawResult };
  }

  console.log();
  console.log(HEADER('Edit Preview'));
  console.log(DIM('─'.repeat(40)));
  if (parsed.success) {
    console.log(parsed.output || DIM('No preview output'));
  } else {
    console.log(ERROR(parsed.error || 'Preview failed'));
  }
  console.log();

  // Return structured data for v2/TUI/Ink picker rendering
  if (parsed.success && parsed.metadata?.candidates && Array.isArray(parsed.metadata.candidates)) {
    return {
      success: true,
      editPreview: {
        path: lastEdit.path as string,
        newString: lastEdit.new_string as string,
        kind: (lastEdit.fuzzy_match ? 'fuzzy' : 'exact') as 'exact' | 'fuzzy',
        candidates: parsed.metadata.candidates as Array<{ index: number; line: number; match: string; contextBefore: string; contextAfter: string; isReplaceAll: boolean }>,
      },
    };
  }

  return { success: parsed.success === true };
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

function continueAsSlashChat(name: string, args: string): CommandResult {
  const trimmed = args.trim();
  return {
    success: true,
    continueAsChat: true,
    chatInput: `/${name}${trimmed ? ` ${trimmed}` : ''}`,
  };
}

// ============================================================================
// 命令注册表
// ============================================================================

const COMMANDS: SlashCommand[] = [
  // Coding workflows
  {
    name: 'diff',
    description: 'Summarize current git workspace changes and touched files',
    argumentHint: '[--max-files N]',
    category: 'workflow',
    priority: 5,
    type: 'builtin',
    execute: (ctx, args) => handleDiff(ctx, args),
  },
  {
    name: 'commit',
    description: 'Create a read-only commit plan and suggested message for current changes',
    argumentHint: '[--max-files N]',
    category: 'workflow',
    priority: 8,
    type: 'builtin',
    execute: (ctx, args) => handleCommitPlan(ctx, args),
  },
  {
    name: 'review',
    description: 'Review the current change or requested files',
    argumentHint: '[scope]',
    category: 'workflow',
    priority: 10,
    type: 'chat',
    execute: (_ctx, args) => continueAsSlashChat('review', args),
  },
  {
    name: 'security',
    aliases: ['audit'],
    description: 'Review code or dependencies for security risks',
    argumentHint: '[scope]',
    category: 'workflow',
    priority: 20,
    type: 'chat',
    execute: (_ctx, args) => continueAsSlashChat('security', args),
  },
  {
    name: 'test-gen',
    aliases: ['tests'],
    description: 'Generate or improve tests for a target area',
    argumentHint: '[scope]',
    category: 'workflow',
    priority: 30,
    type: 'chat',
    execute: (_ctx, args) => continueAsSlashChat('test-gen', args),
  },
  {
    name: 'todos',
    aliases: ['todo'],
    description: 'Show current agent todo state',
    category: 'workflow',
    priority: 40,
    type: 'builtin',
    execute: (ctx) => handleTodos(ctx),
  },

  // Sessions and context lifecycle
  {
    name: 'resume',
    description: 'Resume a previous session',
    argumentHint: '[number|session-id|name]',
    category: 'session',
    priority: 10,
    type: 'builtin',
    execute: (ctx, args) => handleResume(ctx, args),
  },
  {
    name: 'sessions',
    description: 'List recent sessions, or search by file/tool/keyword',
    argumentHint: '[<query>|--all]',
    category: 'session',
    priority: 20,
    type: 'builtin',
    execute: (ctx, args) => handleSessions(ctx, args),
  },
  {
    name: 'session-rename',
    aliases: ['rename-session'],
    description: 'Rename a saved session',
    argumentHint: '<number|session-id|name> <new name>',
    category: 'session',
    priority: 30,
    type: 'builtin',
    execute: (ctx, args) => handleSessionRename(ctx, args),
  },
  {
    name: 'compact',
    description: 'Compact conversation history to reduce context size',
    argumentHint: '[threshold]',
    category: 'session',
    priority: 40,
    type: 'builtin',
    execute: (ctx, args) => handleCompact(ctx, args),
  },
  {
    name: 'clear-history',
    aliases: ['reset'],
    description: 'Clear conversation history (keep config)',
    category: 'session',
    priority: 50,
    type: 'builtin',
    execute: (ctx) => handleClearHistory(ctx),
  },

  // Harness, memory, and skills
  {
    name: 'harness',
    description: 'Show Context Harness state, or `/harness explain` for prompt assembly details',
    argumentHint: '[explain]',
    category: 'context',
    priority: 10,
    type: 'builtin',
    execute: (ctx, args) => showHarness(ctx, args),
  },
  {
    name: 'skills',
    description: 'List loaded skills (built-in / user / project)',
    category: 'context',
    priority: 20,
    type: 'builtin',
    execute: (ctx) => handleSkills(ctx),
  },
  {
    name: 'memory',
    description: 'Show memory status, or `/memory reindex` to rebuild semantic index',
    argumentHint: '[reindex]',
    category: 'context',
    priority: 30,
    type: 'builtin',
    execute: (ctx, args) => handleMemory(ctx, args),
  },

  // Tools and safety
  {
    name: 'tools',
    aliases: ['tool'],
    description: 'List available built-in and MCP tools',
    category: 'tools',
    priority: 10,
    type: 'builtin',
    execute: (ctx) => handleTools(ctx),
  },
  {
    name: 'edit-preview',
    description: 'Preview the last edit_file match candidates without writing',
    category: 'tools',
    priority: 15,
    type: 'builtin',
    execute: (ctx) => handleEditPreview(ctx),
  },
  {
    name: 'mcp',
    description: 'Show connected MCP servers and their status',
    category: 'tools',
    priority: 20,
    type: 'builtin',
    execute: (ctx) => handleMcp(ctx),
  },
  {
    name: 'safety',
    description: 'Show safety checker status and audit summary',
    category: 'tools',
    priority: 30,
    type: 'builtin',
    execute: (ctx) => showSafety(ctx),
  },

  // Model and runtime configuration
  {
    name: 'model',
    description: 'Show or change the current model',
    argumentHint: '[model|list|help]',
    category: 'model',
    priority: 10,
    type: 'builtin',
    execute: (ctx, args) => handleModel(ctx, args),
  },
  {
    name: 'mode',
    aliases: ['permissions', 'perm'],
    description: 'Show or change tool permission mode',
    argumentHint: '[default|accept-edits|plan|auto|next]',
    category: 'model',
    priority: 20,
    type: 'builtin',
    execute: (ctx, args) => handleMode(ctx, args),
  },
  {
    name: 'config',
    description: 'Show current configuration',
    category: 'model',
    priority: 30,
    type: 'builtin',
    execute: (ctx) => showConfig(ctx),
  },

  // System commands
  {
    name: 'help',
    aliases: ['h'],
    description: 'Show available commands',
    category: 'system',
    priority: 10,
    type: 'builtin',
    execute: () => showHelp(),
  },
  {
    name: 'status',
    aliases: ['s'],
    description: 'Show system status overview',
    category: 'system',
    priority: 20,
    type: 'builtin',
    execute: (ctx) => showStatus(ctx),
  },
  {
    name: 'clear',
    description: 'Clear the terminal screen',
    category: 'system',
    priority: 30,
    type: 'builtin',
    execute: () => {
      process.stdout.write('\x1Bc');
      return { success: true };
    },
  },
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Shutdown and exit',
    category: 'system',
    priority: 40,
    type: 'builtin',
    execute: (ctx) => handleExit(ctx),
  },

  // Diagnostics
  {
    name: 'doctor',
    aliases: ['diag', 'diagnose'],
    description: 'Run configuration, tools, MCP, skills, session, and harness diagnostics',
    category: 'diagnostics',
    priority: 5,
    type: 'builtin',
    execute: (ctx) => handleDoctor(ctx),
  },
  {
    name: 'usage',
    aliases: ['stats'],
    description: 'Show detailed usage statistics',
    category: 'diagnostics',
    priority: 10,
    type: 'builtin',
    execute: (ctx) => handleUsage(ctx),
  },
  {
    name: 'cost',
    description: 'Show session token usage',
    category: 'diagnostics',
    priority: 20,
    type: 'builtin',
    execute: (ctx) => handleCost(ctx),
  },
  {
    name: 'agents',
    description: 'List registered agents and their status',
    category: 'diagnostics',
    priority: 30,
    type: 'builtin',
    execute: (ctx) => showAgents(ctx),
  },

  // Legacy commands kept executable for compatibility, but not shown in Ink help/palette.
  {
    name: 'task',
    description: 'Submit or list tasks',
    params: [{ name: 'action', description: 'list | <task-name>', required: false }],
    category: 'legacy',
    type: 'builtin',
    isHidden: true,
    execute: (ctx, args) => handleTask(ctx, args),
  },
  {
    name: 'run',
    description: 'Create and run a task through Agent + LLM',
    params: [{ name: 'description', description: 'Task description', required: true }],
    category: 'legacy',
    type: 'builtin',
    isHidden: true,
    execute: (ctx, args) => handleRun(ctx, args),
  },
  {
    name: 'chat',
    description: 'Send a message to the LLM',
    params: [{ name: 'message', description: 'Message to send', required: true }],
    category: 'legacy',
    type: 'chat',
    isHidden: true,
    execute: (ctx, args) => ({ success: true, continueAsChat: true, chatInput: args }),
  },
];

// ============================================================================
// 导出
// ============================================================================

export function getCommands(): SlashCommand[] {
  return sortCommands(COMMANDS);
}

export function getVisibleCommands(): SlashCommand[] {
  return sortCommands(COMMANDS.filter(command => !command.isHidden));
}

export function findCommand(name: string): SlashCommand | undefined {
  return COMMANDS.find(c => c.name === name || c.aliases?.includes(name));
}

export function getCommandNames(): string[] {
  return getVisibleCommands().map(c => c.name);
}

export { handleChat as executeChat };
