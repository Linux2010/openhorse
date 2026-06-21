import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { getConfigHome, getGlobalConfigPath, getProjectSessionsDir } from './config-dir';
import { isConfigured, type OpenHorseCLIConfig } from './config';
import { getMcpConfigPath, mcpManager } from '../tools/mcp';
import { getRuntimeTools } from '../tools';
import { loadProjectInstructionFiles } from './project-instructions';
import { refreshProjectInstructions } from './prompt-context';
import { listProjectSessions, resolveProjectPath, type SessionMeta } from './session-storage';
import { getSkillsRegistry } from '../skills';
import type { Store } from '../framework/store';
import type { LLMService } from './llm';
import type { OpenHorseRuntime } from '../init';
import { getWarningState } from '../core/warn-dedup';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  label: string;
  summary: string;
  detail?: string;
}

export interface DoctorReport {
  generatedAt: string;
  cwd: string;
  projectPath: string;
  configHome: string;
  checks: DoctorCheck[];
  totals: Record<DoctorStatus, number>;
}

export interface DoctorContext {
  cwd: string;
  config: OpenHorseCLIConfig;
  store: Store;
  llm: LLMService | null;
  runtime: OpenHorseRuntime;
  getSession?: () => SessionMeta | null;
}

function countStatuses(checks: DoctorCheck[]): Record<DoctorStatus, number> {
  return checks.reduce<Record<DoctorStatus, number>>(
    (totals, check) => {
      totals[check.status] += 1;
      return totals;
    },
    { ok: 0, warn: 0, fail: 0 }
  );
}

function summarizeMcpStatus(): DoctorCheck {
  const configPath = getMcpConfigPath();
  const hasConfig = existsSync(configPath);
  const status = mcpManager.getStatus();

  if (!hasConfig && status.length === 0) {
    return {
      id: 'mcp',
      status: 'ok',
      label: 'MCP',
      summary: 'No MCP servers configured',
      detail: configPath,
    };
  }

  if (hasConfig && status.length === 0) {
    return {
      id: 'mcp',
      status: 'warn',
      label: 'MCP',
      summary: 'MCP config exists but no servers are active',
      detail: configPath,
    };
  }

  const connected = status.filter(server => server.connected).length;
  const dead = status.filter(server => server.dead).length;
  const disconnected = status.filter(server => !server.connected && !server.dead).length;
  const tools = status.reduce((sum, server) => sum + server.toolCount, 0);
  const detail = status
    .map(server => `${server.name}: ${server.dead ? 'dead' : server.connected ? 'connected' : 'disconnected'} (${server.toolCount} tools)`)
    .join('\n');

  return {
    id: 'mcp',
    status: dead > 0 || disconnected > 0 ? 'fail' : 'ok',
    label: 'MCP',
    summary: `${connected}/${status.length} connected, ${tools} tools`,
    detail,
  };
}

function summarizeSkills(): DoctorCheck {
  try {
    const registry = getSkillsRegistry();
    const summary = registry.getSummary();
    return {
      id: 'skills',
      status: summary.count > 0 ? 'ok' : 'warn',
      label: 'Skills',
      summary: `${summary.count} loaded, ${summary.autoCount} auto-trigger`,
      detail: summary.names.slice(0, 20).join(', ') || 'No skills loaded',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: 'skills',
      status: 'fail',
      label: 'Skills',
      summary: 'Failed to load skills',
      detail: message,
    };
  }
}

function summarizeProjectInstructions(ctx: DoctorContext): DoctorCheck {
  const files = loadProjectInstructionFiles(ctx.cwd);
  refreshProjectInstructions(ctx.store, ctx.cwd);
  const promptChars = ctx.store.getSnapshot().projectInstructionsContent.length;

  return {
    id: 'project-instructions',
    status: files.length > 0 ? 'ok' : 'warn',
    label: 'Project Rules',
    summary: files.length > 0
      ? `${files.length} files, ${promptChars} prompt chars`
      : 'No AGENTS.md / CLAUDE.md / .openhorse instructions found',
    detail: files.map(file => `${file.path}${file.truncated ? ' (truncated)' : ''}`).join('\n') || undefined,
  };
}

function summarizeSessions(ctx: DoctorContext, projectPath: string): DoctorCheck {
  const active = ctx.getSession?.() ?? null;
  const sessions = listProjectSessions(projectPath, 20);
  return {
    id: 'sessions',
    status: active || sessions.length > 0 ? 'ok' : 'warn',
    label: 'Sessions',
    summary: active
      ? `Active ${active.id.slice(0, 8)}, ${sessions.length} recent project sessions`
      : `${sessions.length} recent project sessions, no active session`,
    detail: sessions.slice(0, 5).map(session =>
      `${session.id.slice(0, 8)} ${session.name || session.taskSummary || '(untitled)'} ${session.messageCount ?? 0} msgs`
    ).join('\n') || undefined,
  };
}

function summarizeHarness(ctx: DoctorContext): DoctorCheck {
  const harnessState = ctx.store.getSnapshot().harnessState;
  const objective = harnessState?.rootObjective || harnessState?.contract?.objective;
  const epoch = harnessState?.taskEpoch;
  return {
    id: 'harness',
    status: objective || harnessState?.capsule ? 'ok' : 'warn',
    label: 'Harness',
    summary: objective
      ? `epoch ${epoch ?? 0}: ${objective}`
      : 'No active objective captured yet',
    detail: harnessState?.capsule?.nextAction ? `Next: ${harnessState.capsule.nextAction}` : undefined,
  };
}

function summarizeArtifacts(projectPath: string): DoctorCheck {
  const sessionsDir = getProjectSessionsDir(projectPath);
  const artifactDir = join(sessionsDir, '_artifacts');
  if (!existsSync(artifactDir)) {
    return { id: 'artifacts', status: 'ok', label: 'Artifacts', summary: 'No artifacts directory' };
  }
  const entries = readdirSync(artifactDir);
  let totalBytes = 0;
  for (const entry of entries) {
    try { totalBytes += statSync(join(artifactDir, entry)).size; } catch { /* skip */ }
  }
  const status = entries.length > 100 || totalBytes > 50_000_000 ? 'warn' : 'ok';
  return {
    id: 'artifacts',
    status,
    label: 'Artifacts',
    summary: `${entries.length} files, ${(totalBytes / 1024).toFixed(0)}KB`,
    detail: status === 'warn' ? 'Consider running cleanupArtifacts()' : undefined,
  };
}

function summarizePromptCache(ctx: DoctorContext): DoctorCheck {
  const snapshot = ctx.store.getSnapshot();
  const history = snapshot.conversationHistory;
  const hasCacheMarked = history.some(m => m.role === 'system' && (m as any).cacheControl);
  return {
    id: 'prompt-cache',
    status: hasCacheMarked ? 'ok' : 'warn',
    label: 'Prompt Cache',
    summary: hasCacheMarked ? 'Static system prefix marked for caching' : 'No cache-marked messages yet (starts on first turn)',
  };
}

function summarizeWarningDedup(): DoctorCheck {
  const state = getWarningState();
  if (state.size === 0) {
    return { id: 'warn-dedup', status: 'ok', label: 'Warning Dedup', summary: 'No warnings recorded' };
  }
  let suppressed = 0;
  for (const [, wc] of state) {
    if (wc.count > 1) suppressed += wc.count - 1;
  }
  const status = suppressed > 10 ? 'warn' : 'ok';
  return {
    id: 'warn-dedup',
    status,
    label: 'Warning Dedup',
    summary: `${state.size} unique warnings, ${suppressed} duplicates suppressed`,
    detail: suppressed > 0 ? [...state.values()].map(wc => `[x${wc.count}] ${wc.message}`).join('\n') : undefined,
  };
}

export function collectDoctorReport(ctx: DoctorContext): DoctorReport {
  const projectPath = resolveProjectPath(ctx.cwd);
  const snapshot = ctx.store.getSnapshot();
  const tools = snapshot.tools.length > 0 ? snapshot.tools : getRuntimeTools();
  const staticTools = tools.filter(tool => !tool.name.startsWith('mcp__')).length;
  const mcpTools = tools.length - staticTools;
  const terminalToolConfirmations = ctx.config.ui?.renderer === 'terminal';

  const checks: DoctorCheck[] = [
    {
      id: 'config',
      status: isConfigured(ctx.config) ? 'ok' : 'fail',
      label: 'Config',
      summary: isConfigured(ctx.config)
        ? `API key present, model ${ctx.config.model}`
        : 'Missing API key',
      detail: `config=${getGlobalConfigPath()}\nbaseUrl=${ctx.config.apiBaseUrl || '(default OpenAI-compatible endpoint)'}`,
    },
    {
      id: 'llm',
      status: ctx.llm && isConfigured(ctx.config) ? 'ok' : 'fail',
      label: 'LLM',
      summary: ctx.llm ? `Initialized ${ctx.llm.getModel()}` : 'LLM service is not initialized',
    },
    {
      id: 'permissions',
      status: ctx.config.toolConfirmation === 'ask' && !terminalToolConfirmations ? 'warn' : 'ok',
      label: 'Permissions',
      summary: `toolConfirmation=${ctx.config.toolConfirmation}, ui=${ctx.config.ui?.renderer}/${ctx.config.ui?.confirmations}`,
      detail: ctx.config.toolConfirmation === 'ask' && !terminalToolConfirmations
        ? 'Interactive tool confirmation is currently wired in the stable terminal renderer. Use --ui terminal or configure toolConfirmation=allow/deny for non-terminal renderers.'
        : undefined,
    },
    {
      id: 'tools',
      status: tools.length > 0 ? 'ok' : 'fail',
      label: 'Tools',
      summary: `${tools.length} available (${staticTools} built-in, ${mcpTools} MCP)`,
    },
    summarizeMcpStatus(),
    summarizeSkills(),
    summarizeProjectInstructions(ctx),
    summarizeSessions(ctx, projectPath),
    summarizeHarness(ctx),
    summarizeArtifacts(projectPath),
    summarizePromptCache(ctx),
    summarizeWarningDedup(),
    {
      id: 'context-size',
      status: snapshot.projectInstructionsContent.length > 120_000 || snapshot.skillsContent.length > 120_000 ? 'warn' : 'ok',
      label: 'Context Size',
      summary: `project rules ${snapshot.projectInstructionsContent.length} chars, skills index ${snapshot.skillsContent.length} chars, memory ${snapshot.memoryContent.length} chars`,
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    cwd: ctx.cwd,
    projectPath,
    configHome: getConfigHome(),
    checks,
    totals: countStatuses(checks),
  };
}

export function hasDoctorFailures(report: DoctorReport): boolean {
  return report.totals.fail > 0;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    'OpenHorse Doctor',
    '─'.repeat(40),
    `Generated  ${report.generatedAt}`,
    `Project    ${report.projectPath}`,
    `CWD        ${report.cwd}`,
    `Config     ${report.configHome}`,
    '',
    `Summary    ${report.totals.ok} ok, ${report.totals.warn} warn, ${report.totals.fail} fail`,
    '',
  ];

  const statusIcon: Record<DoctorStatus, string> = {
    ok: '✓',
    warn: '!',
    fail: '✗',
  };

  for (const check of report.checks) {
    lines.push(`${statusIcon[check.status]} ${check.label}: ${check.summary}`);
    if (check.detail) {
      for (const line of check.detail.split('\n')) {
        lines.push(`  ${line}`);
      }
    }
  }

  return lines.join('\n');
}
