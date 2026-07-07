import { findCommand } from '../commands';
import { parseInput, buildCommandSuggestions } from '../commands/parser';
import * as path from 'path';
import type { CommandContext, CommandResult, CommandUiRenderer } from '../commands/types';
import type { LLMRequestDiagnostics, Message, StreamCallbacks } from '../services/llm';
import type { SessionMessage, SessionTraceEvent } from '../services/session-storage';
import {
  appendSessionMessage,
  appendSessionMessages,
  appendSessionTraceEvent,
  endSession,
  loadSessionHarnessState,
  loadSessionHistory,
  loadSessionMeta,
  removeLastIncompleteAssistantMessage,
  readSessionMessages,
  redactTraceText,
  updateSessionHarnessState,
  updateSessionSkills,
  updateSessionSummary,
} from '../services/session-storage';
import { isConfigured } from '../services/config';
import { query, buildSystemPrompt, QueryLoopError, createFailedLoopStats, createLocalFastPathLoopStats, type LoopFinishReason, type LoopStats, type PromptContext, type QueryEvent } from '../framework';
import { createContextHarness } from '../harness';
import type { HarnessState } from '../harness/types';
import { executeTool, getRuntimeTools } from '../tools';
import { parseToolResultEnvelope } from '../framework/tool-serializer';
import { storeArtifact, truncateForContext } from '../core/tool-artifacts';
import { createCheckpoint } from '../core/checkpoint';
import { resolveSkillsForTurn, hasMatchingSkill } from '../skills';
import { buildReferencedFilesPrompt } from '../services/file-context';
import { refreshProjectInstructions } from '../services/prompt-context';
import { formatBytes } from '../services/format';
import { captureWorkspaceSnapshot, diffWorkspaceSnapshots, type WorkspaceSnapshot } from '../services/workspace-state';
import {
  collectVerificationCommandResult,
  formatVerificationGateNotice,
  selectVerificationProfile,
  shouldGateCompletion,
  summarizeVerificationState,
  type VerificationCommandResult,
  type VerificationProfile,
  type VerificationSummary,
} from '../services/verification-profile';
import type {
  OpenHorseUiRuntime,
  RuntimeHarnessDiagnostics,
  TranscriptEntry,
  UiEventSink,
  UiRendererCapabilities,
} from './ui-events';
import { resolveUiRendererCapabilities } from './ui-events';
import {
  formatToolActivityTranscript,
  toolActivityFromFinished,
  toolActivityFromStarted,
} from './ui-view-model';
import { agentStepStatus, runningToolsStatus } from './agent-status';
import { resolveRuntimeLoopBudget } from './loop-budget';

const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;
const LOCAL_FAST_PATH_INLINE_OUTPUT_BYTES = 2048;
const TRACE_ARGS_ARTIFACT_THRESHOLD_BYTES = 160;
const TOOL_TRANSCRIPT_ARG_BUDGET = 512;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function isAbortError(error: unknown, abortSignal?: AbortSignal): boolean {
  if (abortSignal?.aborted) return true;
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.message.toLowerCase().includes('aborted');
  }
  return false;
}

function formatChatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/NotEnoughCvError|code:\s*11210/i.test(message)) {
    return [
      message,
      '',
      'Provider quota or credit appears insufficient. The OpenHorse session is still active; switch model/provider or recharge the provider account, then continue.',
    ].join('\n');
  }
  return message;
}

function compactMiddle(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  if (maxLength <= 3) return compact.slice(0, maxLength);

  const headLength = Math.ceil((maxLength - 3) * 0.55);
  const tailLength = Math.floor((maxLength - 3) * 0.45);
  return `${compact.slice(0, headLength)}...${compact.slice(-tailLength)}`;
}

function compactToolArgs(args: Record<string, unknown>, maxLength = 160): string {
  for (const key of ['path', 'file_path', 'file', 'cwd', 'command', 'pattern', 'query', 'url', 'target', 'sessionId']) {
    const value = args[key];
    if (typeof value === 'string') {
      return compactMiddle(value, maxLength);
    }
  }
  const firstString = Object.values(args).find(value => typeof value === 'string');
  if (typeof firstString === 'string') {
    return compactMiddle(firstString, maxLength);
  }
  return '';
}

interface TraceArgsDetails {
  argsSummary: string;
  argsArtifactId?: string;
  argsBytes?: number;
}

function fullToolArgsForTrace(name: string, args: Record<string, unknown>): string {
  if (name === 'exec_command' && typeof args.command === 'string') {
    return `$ ${args.command}`;
  }

  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return compactToolArgs(args, 2048);
  }
}

function buildTraceArgsDetails(
  projectPath: string | undefined,
  name: string,
  args: Record<string, unknown>,
): TraceArgsDetails {
  const argsSummary = compactToolArgs(args);
  const fullArgs = redactTraceText(fullToolArgsForTrace(name, args)).trim();
  const argsBytes = byteLength(fullArgs);

  if (
    !projectPath
    || !fullArgs
    || fullArgs === redactTraceText(argsSummary)
    || argsBytes <= TRACE_ARGS_ARTIFACT_THRESHOLD_BYTES
  ) {
    return { argsSummary };
  }

  const artifact = storeArtifact(projectPath, `${name}-args`, fullArgs, argsBytes);
  return artifact
    ? { argsSummary, argsArtifactId: artifact.id, argsBytes }
    : { argsSummary };
}

function parseToolCallArgsForRuntime(
  toolCall: NonNullable<Message['tool_calls']>[number],
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(toolCall.function.arguments || '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function resolveProjectScopedPath(cwd: string, filePath: string): string | null {
  const absolute = path.resolve(cwd, filePath);
  const relative = path.relative(cwd, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return absolute;
}

function checkpointTargetsFromToolCalls(
  cwd: string,
  toolCalls: NonNullable<Message['tool_calls']>,
): string[] {
  const targets = new Set<string>();
  for (const toolCall of toolCalls) {
    const name = toolCall.function.name;
    if (name !== 'write_file' && name !== 'edit_file') continue;

    const args = parseToolCallArgsForRuntime(toolCall);
    if (!args || typeof args.path !== 'string') continue;
    if (name === 'edit_file' && args.preview === true) continue;

    const target = resolveProjectScopedPath(cwd, args.path);
    if (target) targets.add(target);
  }
  return Array.from(targets);
}

function createPreToolCheckpoint(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  checkpointId: string,
  cwd: string,
  toolCalls: NonNullable<Message['tool_calls']>,
): boolean {
  const targets = checkpointTargetsFromToolCalls(cwd, toolCalls);
  if (targets.length === 0) return false;

  const checkpoint = createCheckpoint(cwd, checkpointId, targets);
  if (!sessionId) return true;

  const relativeTargets = targets.map(target => path.relative(cwd, target));
  recordTraceEvent(events, sessionId, {
    turnId,
    type: 'checkpoint',
    checkpointId,
    checkpointFileCount: checkpoint?.files.length ?? 0,
    checkpointFiles: checkpoint?.files.map(file => file.path) ?? [],
    workspaceFiles: relativeTargets,
    note: checkpoint
      ? 'pre_edit_checkpoint'
      : 'pre_edit_checkpoint_skipped',
  });
  return true;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function traceTurnId(turnId: number | string | undefined): string {
  return turnId == null ? `turn-${Date.now()}` : String(turnId);
}

function compactTraceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return compactMiddle(message, 240);
}

function getLastRequestDiagnostics(llm: OpenHorseUiRuntime['llm']): LLMRequestDiagnostics | undefined {
  if (!llm) return undefined;
  const reader = (llm as unknown as {
    getLastRequestDiagnostics?: () => LLMRequestDiagnostics;
  }).getLastRequestDiagnostics;
  return typeof reader === 'function' ? reader.call(llm) : undefined;
}

function compactPathList(paths: string[], maxItems = 40): string[] {
  return paths.slice(0, maxItems);
}

function formatWorkspaceFileForTrace(file: WorkspaceSnapshot['files'][number]): string {
  const metadata = [
    typeof file.sizeBytes === 'number' ? `${file.sizeBytes}B` : '',
    typeof file.mtimeMs === 'number' ? `mtime=${file.mtimeMs}` : '',
  ].filter(Boolean).join(' ');
  return `${file.status} ${file.path}${metadata ? ` (${metadata})` : ''}`;
}

function appendWorkspaceSnapshotTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  phase: 'pre_turn' | 'post_turn',
  snapshot: WorkspaceSnapshot,
): void {
  if (!sessionId) return;
  recordTraceEvent(events, sessionId, {
    turnId,
    type: 'workspace_snapshot',
    workspacePhase: phase,
    workspaceGitAvailable: snapshot.gitAvailable,
    workspaceDirty: snapshot.dirty,
    workspaceBranch: snapshot.branch,
    workspaceFileCount: snapshot.fileCount,
    workspaceFiles: compactPathList(snapshot.files.map(formatWorkspaceFileForTrace)),
    error: snapshot.error ? compactMiddle(snapshot.error, 240) : undefined,
  });
}

function appendWorkspaceDeltaTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): ReturnType<typeof diffWorkspaceSnapshots> {
  const delta = diffWorkspaceSnapshots(before, after);
  if (sessionId) {
    recordTraceEvent(events, sessionId, {
      turnId,
      type: 'workspace_delta',
      workspaceFileCount: delta.filesAfterTurn.length,
      workspaceFiles: compactPathList(delta.filesAfterTurn),
      workspaceNewByTurn: compactPathList(delta.newFilesByTurn),
      workspaceChangedByTurn: compactPathList(delta.changedByTurn),
      workspaceModifiedPreExistingByTurn: compactPathList(delta.modifiedPreExistingByTurn),
      workspaceResolvedByTurn: compactPathList(delta.resolvedByTurn),
      note: `pre_existing=${delta.preExistingFiles.length}`,
    });
  }
  return delta;
}

function workspaceDeltaHasTurnChanges(delta: ReturnType<typeof diffWorkspaceSnapshots>): boolean {
  return delta.newFilesByTurn.length > 0
    || delta.changedByTurn.length > 0
    || delta.resolvedByTurn.length > 0;
}

function formatFailureRecoveryNotice(
  turnId: string,
  delta: ReturnType<typeof diffWorkspaceSnapshots>,
  checkpointIds: string[],
): string {
  const files = compactPathList([
    ...delta.newFilesByTurn,
    ...delta.changedByTurn,
    ...delta.resolvedByTurn,
  ], 8);
  const fileText = files.length > 0
    ? files.join(', ')
    : 'workspace changes recorded';
  const checkpointText = checkpointIds.length > 0
    ? ` Checkpoints: ${checkpointIds.join(', ')}. Preview rollback with /checkpoint restore <id>; restore each listed checkpoint if multiple.`
    : '';
  return `Turn failed after modifying files: ${fileText}. Inspect /trace ${turnId}.${checkpointText}`;
}

function appendVerificationProfileTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  profile: VerificationProfile,
): void {
  if (!sessionId || profile.changedFiles.length === 0) return;
  recordTraceEvent(events, sessionId, {
    turnId,
    type: 'verification_profile',
    verificationProfile: profile.profile,
    verificationRequired: profile.required,
    verificationCommands: compactPathList(profile.commands, 8),
    verificationChangedFiles: compactPathList(profile.changedFiles),
    note: profile.reason,
  });
}

function appendVerificationResultTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  result: VerificationCommandResult,
): void {
  if (!sessionId) return;
  recordTraceEvent(events, sessionId, {
    turnId,
    type: 'verification_result',
    verificationCommand: result.command,
    verificationPassed: result.success,
    outputBytes: result.outputBytes,
    error: result.error ? compactMiddle(result.error, 240) : undefined,
  });
}

function appendVerificationSummaryTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  summary: VerificationSummary,
  changedFiles: string[],
): void {
  if (!sessionId || changedFiles.length === 0) return;
  recordTraceEvent(events, sessionId, {
    turnId,
    type: 'verification_summary',
    verificationProfile: summary.profile,
    verificationRequired: summary.required,
    verificationCommands: compactPathList(summary.commandsRun, 12),
    verificationPassedCommands: compactPathList(summary.passedCommands, 12),
    verificationFailedCommands: compactPathList(summary.failedCommands, 12),
    verificationMissingCommands: compactPathList(summary.missingCommands, 12),
    verificationChangedFiles: compactPathList(changedFiles),
    verificationClaimAllowed: summary.claimAllowed,
    note: summary.skippedReason,
  });
}

function compactVerificationCommands(commands: string[], maxItems = 12): string[] {
  return commands.slice(0, maxItems).map(redactTraceText);
}

function withVerificationLoopStats(stats: LoopStats, summary: VerificationSummary): LoopStats {
  return {
    ...stats,
    verificationProfile: summary.profile,
    verificationRequired: summary.required,
    verificationClaimAllowed: summary.claimAllowed,
    verificationPassedCommands: compactVerificationCommands(summary.passedCommands),
    verificationFailedCommands: compactVerificationCommands(summary.failedCommands),
    verificationMissingCommands: compactVerificationCommands(summary.missingCommands),
    verificationSkippedReason: summary.skippedReason ? redactTraceText(summary.skippedReason) : undefined,
  };
}

function shouldRecordVerificationLoopStats(profile: VerificationProfile, summary: VerificationSummary): boolean {
  return profile.changedFiles.length > 0
    || summary.commandsRun.length > 0
    || summary.passedCommands.length > 0
    || summary.failedCommands.length > 0
    || summary.missingCommands.length > 0;
}

function appendPostWorkspaceTrace(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  cwd: string,
  before: WorkspaceSnapshot,
  verificationResults: VerificationCommandResult[] = [],
): {
  delta: ReturnType<typeof diffWorkspaceSnapshots>;
  profile: VerificationProfile;
  summary: VerificationSummary;
} {
  const postWorkspace = captureWorkspaceSnapshot(cwd);
  appendWorkspaceSnapshotTrace(events, sessionId, turnId, 'post_turn', postWorkspace);
  const delta = appendWorkspaceDeltaTrace(events, sessionId, turnId, before, postWorkspace);
  const profile = selectVerificationProfile(cwd, delta.changedByTurn);
  const summary = summarizeVerificationState(profile, verificationResults);
  appendVerificationProfileTrace(events, sessionId, turnId, profile);
  appendVerificationSummaryTrace(
    events,
    sessionId,
    turnId,
    summary,
    profile.changedFiles,
  );
  return { delta, profile, summary };
}

function appendAssistantNotice(messages: SessionMessage[], notice: string): void {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant' && !message.tool_calls) {
      message.content = message.content ? `${message.content}\n\n${notice}` : notice;
      return;
    }
  }
  messages.push({
    role: 'assistant',
    content: notice,
    timestamp: Date.now(),
  });
}

function recordTraceEvent(
  events: UiEventSink,
  sessionId: string | undefined,
  event: Omit<SessionTraceEvent, 'sessionId' | 'timestamp'> & { timestamp?: number },
): SessionTraceEvent | null {
  if (!sessionId) return null;
  const traceEvent = appendSessionTraceEvent(sessionId, event);
  if (traceEvent) {
    events.traceEventRecorded?.(traceEvent);
  }
  return traceEvent;
}

function recordProviderTraceEvents(
  events: UiEventSink,
  sessionId: string | undefined,
  turnId: string,
  stats: LoopStats,
): void {
  if ((stats.providerRetryCount ?? 0) > 0) {
    recordTraceEvent(events, sessionId, {
      turnId,
      type: 'provider_retry',
      providerRetryCount: stats.providerRetryCount,
      providerRetryDelayMs: stats.providerRetryDelayMs,
      providerRetryErrorTypes: stats.providerRetryErrorTypes,
      providerLastRetryErrorType: stats.providerLastRetryErrorType,
      providerLastRetryStatus: stats.providerLastRetryStatus,
      providerFinalModel: stats.providerFinalModel,
      providerUsingFallback: stats.providerUsingFallback,
    });
  }

  if ((stats.providerFallbackCount ?? 0) > 0 || stats.providerUsingFallback) {
    recordTraceEvent(events, sessionId, {
      turnId,
      type: 'provider_fallback',
      providerFallbackCount: stats.providerFallbackCount,
      providerFallbackFromModel: stats.providerFallbackFromModel,
      providerFallbackToModel: stats.providerFallbackToModel,
      providerFinalModel: stats.providerFinalModel,
      providerUsingFallback: stats.providerUsingFallback,
    });
  }
}

function toHarnessDiagnostics(state: HarnessState): RuntimeHarnessDiagnostics {
  const stats = state.promptAssemblyStats;
  const redactOptional = (value: string | undefined): string | undefined =>
    typeof value === 'string' ? redactTraceText(value) : undefined;
  const redactList = (values: string[] | undefined): string[] | undefined =>
    values?.slice(0, 6).map(redactTraceText);
  return {
    taskEpoch: state.taskEpoch,
    rootObjective: redactOptional(state.rootObjective ?? state.contract?.objective),
    activeInstruction: redactOptional(state.activeInstruction ?? state.contract?.userIntent),
    openQuestions: redactList(state.openQuestions),
    diagnostics: redactList(state.diagnostics?.slice(-6)),
    ledgerSize: state.ledger?.length ?? 0,
    evidenceSize: state.evidenceIndex?.length ?? 0,
    turnSummaryCount: state.turnSummaries?.length ?? 0,
    promptAssembly: stats
      ? {
          modelId: stats.modelId,
          estimatedTokens: stats.estimatedTokens,
          budgetTokens: stats.budgetTokens,
          sections: stats.sections.slice(0, 12),
          includedEvidence: stats.includedEvidence.length,
          omittedEvidence: stats.omittedEvidence.length,
        }
      : undefined,
  };
}

function emitHarnessDiagnostics(events: UiEventSink, state: HarnessState): void {
  events.harnessDiagnosticsUpdated?.(toHarnessDiagnostics(state));
}

function toolStartContent(event: ToolCallEvent): string {
  return formatToolActivityTranscript(
    toolActivityFromStarted(event, compactToolArgs(event.args, TOOL_TRANSCRIPT_ARG_BUDGET))
  );
}

function toolFinishContent(event: ToolResultEvent): string {
  return formatToolActivityTranscript(
    toolActivityFromFinished(event, compactToolArgs(event.args, TOOL_TRANSCRIPT_ARG_BUDGET))
  );
}

function isSyntheticCompactContext(content: string): boolean {
  return content.startsWith('[OpenHorse Context State v2]')
    || content.startsWith('[Context Summary]')
    || content.startsWith('I will continue from this OpenHorse Context State')
    || content.startsWith('I understand the context. I will continue the conversation with this background information.');
}

function sessionToolCallSummaries(message: SessionMessage): Array<{ id: string; content: string }> {
  return (message.tool_calls ?? []).map(call => {
    const args = parseToolCallArgs(call.function.arguments);
    const detail = compactToolArgs(args);
    return {
      id: call.id,
      content: `Requested ${call.function.name}${detail ? ` ${detail}` : ''}`,
    };
  });
}

function parseToolCallArgs(rawArgs: string | undefined): Record<string, unknown> {
  try {
    return rawArgs ? JSON.parse(rawArgs) as Record<string, unknown> : {};
  } catch {
    return rawArgs ? { arguments: rawArgs } : {};
  }
}

function parseSessionToolResult(content: string): { success: boolean; error?: string; summary?: string } {
  try {
    const parsed = JSON.parse(content) as { success?: unknown; error?: unknown; summary?: unknown };
    return {
      success: parsed.success === true,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
    };
  } catch {
    return { success: false, error: 'Invalid JSON result' };
  }
}

function removeTrailingUserMessage(runtime: OpenHorseUiRuntime): void {
  const history = runtime.store.getSnapshot().conversationHistory;
  if (history.length === 0) return;

  const lastMsg = history[history.length - 1];
  if (lastMsg?.role === 'user') {
    runtime.store.setState({ conversationHistory: history.slice(0, -1) });
  }
}

function sessionToolResultSummary(
  message: SessionMessage,
  toolCallsById: Map<string, NonNullable<SessionMessage['tool_calls']>[number]>
): string | null {
  if (!message.toolCallId) return null;
  const call = toolCallsById.get(message.toolCallId);
  if (!call) return null;

  const args = parseToolCallArgs(call.function.arguments);
  const detail = compactToolArgs(args);
  const parsed = parseSessionToolResult(message.content);
  const firstLine = parsed.summary || `${parsed.success ? '✓' : '✗'} ${call.function.name}${detail ? ` ${detail}` : ''}`;
  return parsed.error ? `${firstLine}\nError: ${parsed.error}` : firstLine;
}

export function sessionMessagesToTranscriptEntries(sessionId: string): TranscriptEntry[] {
  const session = loadSessionMeta(sessionId);
  const displayStartTime = session?.transcriptDisplayStartTime;
  const messages = readSessionMessages(sessionId).filter(message =>
    typeof displayStartTime !== 'number' || (message.timestamp ?? 0) >= displayStartTime
  );
  const entries: TranscriptEntry[] = [];
  const toolCallsById = new Map<string, NonNullable<SessionMessage['tool_calls']>[number]>();
  const completedToolCallIds = new Set<string>();

  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      toolCallsById.set(call.id, call);
    }
    if (message.role === 'tool' && message.toolCallId) {
      completedToolCallIds.add(message.toolCallId);
    }
  }

  messages.forEach((message, index) => {
    if (isSyntheticCompactContext(message.content)) return;

    const idBase = `session-${sessionId.slice(0, 8)}-${index}`;
    if (message.role === 'user') {
      entries.push({ id: `${idBase}-user`, role: 'user', content: message.content });
      return;
    }

    if (message.role === 'assistant') {
      if (message.content.trim()) {
        entries.push({ id: `${idBase}-assistant`, role: 'assistant', content: message.content });
      }
      for (const summary of sessionToolCallSummaries(message)) {
        if (!completedToolCallIds.has(summary.id)) {
          entries.push({ id: `${idBase}-tool-call-${entries.length}`, role: 'tool', content: summary.content });
        }
      }
      return;
    }

    if (message.role === 'tool') {
      const summary = sessionToolResultSummary(message, toolCallsById);
      entries.push({
        id: `${idBase}-tool`,
        role: 'tool',
        content: summary ?? (message.toolCallId ? `Tool result ${message.toolCallId}\n${message.content}` : message.content),
      });
      return;
    }

    if (message.role === 'system') {
      entries.push({ id: `${idBase}-system`, role: 'system', content: message.content });
    }
  });

  return entries;
}

export interface AssistantStreamPresenter {
  appendChunk(chunk: string): void;
  closeSegment(): void;
  discardSegment(): void;
  ensureMessage(content: string): void;
  replaceMessage(content: string): void;
}

export function createAssistantStreamPresenter(events: UiEventSink, abortSignal?: AbortSignal): AssistantStreamPresenter {
  let activeSegmentText = '';
  let activeEntryId: string | null = null;

  const ensureLiveEntry = (): string | null => {
    if (abortSignal?.aborted || !activeSegmentText) return null;
    if (activeEntryId) {
      events.update(activeEntryId, { content: activeSegmentText });
      return activeEntryId;
    }

    activeEntryId = events.append({
      role: 'assistant',
      content: activeSegmentText,
      live: true,
    });
    return activeEntryId;
  };

  const flushSegment = (): void => {
    if (abortSignal?.aborted) {
      if (activeEntryId) events.remove(activeEntryId);
      activeEntryId = null;
      activeSegmentText = '';
      return;
    }

    const entryId = ensureLiveEntry();
    if (!entryId) return;
    events.finalize(entryId);
    activeEntryId = null;
    activeSegmentText = '';
  };

  return {
    appendChunk(chunk: string): void {
      if (abortSignal?.aborted || !chunk) return;
      activeSegmentText += chunk;
      ensureLiveEntry();
    },

    closeSegment(): void {
      flushSegment();
    },

    discardSegment(): void {
      if (activeEntryId) events.remove(activeEntryId);
      activeEntryId = null;
      activeSegmentText = '';
    },

    ensureMessage(content: string): void {
      if (abortSignal?.aborted || !content || activeSegmentText.length > 0) return;
      activeSegmentText = content;
      ensureLiveEntry();
    },

    replaceMessage(content: string): void {
      if (abortSignal?.aborted || !content) return;
      activeSegmentText = content;
      ensureLiveEntry();
    },
  };
}

type ToolCallEvent = Extract<QueryEvent, { type: 'tool_call' }>;
type ToolResultEvent = Extract<QueryEvent, { type: 'tool_result' }>;

interface LocalFastPathAction {
  tool: string;
  args: Record<string, unknown>;
  label: string;
}

class LocalFastPathBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalFastPathBlockedError';
  }
}

function parseLocalFastPath(input: string): LocalFastPathAction | null {
  const text = input.trim();
  if (/^git\s+status$/i.test(text)) {
    return { tool: 'git_status', args: {}, label: 'git status' };
  }

  const readMatch = /^(?:read|读取)\s+(.+)$/i.exec(text);
  const readTarget = readMatch?.[1]?.trim();
  const looksLikePath = Boolean(readTarget)
    && !/\s/.test(readTarget!)
    && (/[/\\.]/.test(readTarget!) || readTarget!.startsWith('~'));
  if (readTarget && looksLikePath) {
    return { tool: 'read_file', args: { path: readTarget }, label: `read ${readTarget}` };
  }

  const grepMatch = /^(?:grep|搜索)\s+(.+)$/i.exec(text);
  if (grepMatch?.[1]?.trim()) {
    return { tool: 'grep', args: { pattern: grepMatch[1].trim() }, label: `grep ${grepMatch[1].trim()}` };
  }

  const runTestMatch = /^(?:run\s+test|运行测试)\s*[:：]\s*(.+)$/i.exec(text);
  if (runTestMatch?.[1]?.trim()) {
    return { tool: 'exec_command', args: { command: runTestMatch[1].trim() }, label: `run test: ${runTestMatch[1].trim()}` };
  }

  return null;
}

function formatLocalFastPathAssistantContent(
  action: LocalFastPathAction,
  rawResult: string,
  projectPath: string,
): { content: string; artifactRef?: { id: string; outputBytes: number } } {
  const envelope = parseToolResultEnvelope(rawResult);
  const rawOutput = typeof envelope.output === 'string' ? envelope.output : '';
  const output = rawOutput.trim();
  const summary = envelope.summary || `${action.tool} ${envelope.success ? 'completed' : 'failed'}`;
  const lines = [
    envelope.success
      ? `Local fast path completed ${action.label}.`
      : `Local fast path failed ${action.label}.`,
    '',
    summary,
  ];
  if (!envelope.success && envelope.error) {
    lines.push(`Error: ${envelope.error}`);
  }

  if (!output) {
    return { content: lines.join('\n'), artifactRef: envelope.artifactRef };
  }

  let artifactRef = envelope.artifactRef;
  let preview = output;
  const outputBytes = envelope.outputBytes ?? byteLength(rawOutput);
  if (byteLength(rawOutput) > LOCAL_FAST_PATH_INLINE_OUTPUT_BYTES) {
    if (!artifactRef) {
      const artifact = storeArtifact(projectPath, action.tool, rawOutput, outputBytes);
      artifactRef = artifact ? { id: artifact.id, outputBytes: artifact.outputBytes } : undefined;
    }
    preview = truncateForContext(output, LOCAL_FAST_PATH_INLINE_OUTPUT_BYTES);
  }

  if (artifactRef) {
    lines.push('', `Full output: /artifacts show ${artifactRef.id} --full (${formatBytes(artifactRef.outputBytes)})`);
  }
  lines.push('', 'Preview:', preview);
  return { content: lines.join('\n'), artifactRef };
}

export interface ToolEventPresenter {
  start(event: ToolCallEvent): void;
  finish(event: ToolResultEvent): void;
}

export function createToolEventPresenter(events: UiEventSink): ToolEventPresenter {
  const runningToolEntries = new Map<string, string>();

  return {
    start(event: ToolCallEvent): void {
      events.toolStarted?.({
        callId: event.callId,
        name: event.name,
        args: event.args,
        batchCount: event.batchCount,
        batchIndex: event.batchIndex,
      });
      const entryId = events.append({
        role: 'tool',
        title: 'tool',
        content: toolStartContent(event),
      });
      runningToolEntries.set(event.callId, entryId);
    },

    finish(event: ToolResultEvent): void {
      events.toolFinished?.({
        callId: event.callId,
        name: event.name,
        args: event.args,
        success: event.success,
        duration: event.duration,
        summary: event.summary,
        error: event.error,
        outputBytes: event.outputBytes,
        artifactRef: event.artifactRef,
        batchCount: event.batchCount,
        batchIndex: event.batchIndex,
      });
      const content = toolFinishContent(event);
      const existingEntryId = runningToolEntries.get(event.callId);

      if (existingEntryId) {
        events.finalize(existingEntryId, {
          role: event.success ? 'tool' : 'error',
          title: 'tool',
          content,
        });
        runningToolEntries.delete(event.callId);
        return;
      }

      const entryId = events.append({
        role: event.success ? 'tool' : 'error',
        title: 'tool',
        content,
      });
      events.finalize(entryId);
    },
  };
}

async function captureConsoleOutput(fn: () => Promise<CommandResult> | CommandResult): Promise<{ result: CommandResult; output: string }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const capture = (...args: unknown[]) => {
    lines.push(stripAnsi(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')));
  };

  console.log = capture;
  console.error = capture;
  console.warn = capture;
  try {
    const result = await fn();
    return { result, output: lines.join('\n').trim() };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

export interface RunInputOptions {
  abortSignal?: AbortSignal;
  turnId?: number | string;
}

export interface AgentChatControllerOptions {
  confirmToolUse?: Parameters<typeof query>[0]['confirmToolUse'];
  uiCapabilities?: UiRendererCapabilities;
  uiRenderer?: CommandUiRenderer;
}

/** @deprecated Use AgentChatControllerOptions. Chat execution is renderer-independent. */
export type InkChatControllerOptions = AgentChatControllerOptions;

export class AgentChatController {
  constructor(
    private readonly runtime: OpenHorseUiRuntime,
    private readonly events: UiEventSink,
    private readonly controllerOptions: AgentChatControllerOptions = {},
  ) {}

  private setLoopStats(stats: LoopStats): void {
    this.runtime.store.setLastLoopStats(stats);
    this.events.loopStatsUpdated?.(stats);
  }

  async runInput(input: string, options: RunInputOptions = {}): Promise<void> {
    const text = input.trim();
    if (!text) return;

    const parsed = parseInput(text);
    if (!parsed.isCommand) {
      const localFastPath = parseLocalFastPath(text);
      if (localFastPath) {
        await this.runLocalFastPath(text, localFastPath, options);
        return;
      }
      await this.runChat(text, options);
      return;
    }

    if (parsed.name === 'clear') {
      this.events.clearTranscript();
      this.events.setStatus('View cleared. Conversation context is preserved.');
      return;
    }

    if (parsed.name === 'exit' || parsed.name === 'quit' || parsed.name === 'q') {
      await this.runtime.shutdown();
      return;
    }

    const command = findCommand(parsed.name);
    if (!command) {
      if (hasMatchingSkill(text)) {
        await this.runChat(text, options);
        return;
      }

      const suggestions = buildCommandSuggestions(parsed.name);
      this.events.append({
        role: 'error',
        title: 'unknown command',
        content: suggestions.length > 0
          ? `Unknown command: /${parsed.name}\nDid you mean: ${suggestions.map(item => `/${item}`).join(', ')}?`
          : `Unknown command: /${parsed.name}`,
      });
      return;
    }

    const ctx = this.createCommandContext(options.abortSignal, options.turnId);
    const { result, output } = await captureConsoleOutput(() => command.execute(ctx, parsed.args));

    if (output) {
      this.events.append({
        role: result.success ? 'system' : 'error',
        title: `/${command.name}`,
        content: output,
      });
    }

    if (result.output) {
      this.events.append({
        role: result.success ? 'system' : 'error',
        title: `/${command.name}`,
        content: result.output,
      });
    }

    if (result.error) {
      this.events.append({
        role: 'error',
        title: `/${command.name}`,
        content: result.error,
      });
    }

    if (result.sessionPicker) {
      this.events.showSessionPicker(result.sessionPicker);
      return;
    }

    if (result.editPreview) {
      this.events.showEditPreview(result.editPreview);
      return;
    }

    if (result.continueAsChat) {
      await this.runChat(result.chatInput ?? parsed.args, options);
    }
  }

  private async runLocalFastPath(
    input: string,
    action: LocalFastPathAction,
    options: RunInputOptions = {},
  ): Promise<void> {
    const activeSession = this.runtime.getSession() ?? this.runtime.ensureSession() ?? loadSessionMeta(this.runtime.getSession()?.id ?? '');
    const sessionId = activeSession?.id;
    const turnId = traceTurnId(options.turnId);
    const localCallId = `local-${turnId}`;
    const start = Date.now();
    const preWorkspace = captureWorkspaceSnapshot(this.runtime.cwd);
    const traceArgs = buildTraceArgsDetails(this.runtime.cwd, action.tool, action.args);

    if (sessionId) {
      appendSessionMessage(sessionId, {
        role: 'user',
        content: input,
        timestamp: Date.now(),
      });
      recordTraceEvent(this.events, sessionId, {
        turnId,
        type: 'turn_start',
        inputBytes: byteLength(input),
        localFastPathUsed: true,
      });
      appendWorkspaceSnapshotTrace(this.events, sessionId, turnId, 'pre_turn', preWorkspace);
      recordTraceEvent(this.events, sessionId, {
        turnId,
        type: 'local_fast_path',
        name: action.tool,
        ...traceArgs,
        note: compactMiddle(action.label, 160),
      });
    }
    this.runtime.store.addMessage({ role: 'user', content: input });
    this.events.setStatus(`Running local ${action.label}...`);

    try {
      const tool = getRuntimeTools().find(candidate => candidate.name === action.tool);
      const toolContext = {
        cwd: this.runtime.cwd,
        config: {
          name: this.runtime.config.name,
          mode: this.runtime.config.mode,
        },
        sessionId,
        turnId,
      };
      const permission = tool?.checkPermissions?.(action.args, toolContext);
      if (permission?.behavior === 'deny' || tool?.isDestructive?.(action.args) === true) {
        const reason = permission?.reason || 'Local fast path blocked a destructive tool request.';
        throw new LocalFastPathBlockedError(reason);
      }
      if (permission?.behavior === 'ask') {
        throw new LocalFastPathBlockedError(permission.reason || 'Local fast path requires an allow-safe command.');
      }

      if (sessionId) {
        recordTraceEvent(this.events, sessionId, {
          turnId,
          type: 'tool_call',
          name: action.tool,
          callId: localCallId,
          ...traceArgs,
        });
      }
      const result = await executeTool(action.tool, action.args, options.abortSignal, {
        ...toolContext,
        sessionId,
        turnId,
      });
      const duration = Date.now() - start;
      const envelope = parseToolResultEnvelope(result);
      const outputBytes = typeof envelope.outputBytes === 'number'
        ? envelope.outputBytes
        : Buffer.byteLength(result, 'utf8');
      const formattedLocalResult = formatLocalFastPathAssistantContent(action, result, this.runtime.cwd);
      const assistantContent = formattedLocalResult.content;
      const stats = createLocalFastPathLoopStats({
        finishReason: envelope.success ? 'completed' : 'failed',
        toolCalls: 1,
        readOnlyToolCalls: action.tool === 'exec_command' ? 0 : 1,
        unsafeToolCalls: action.tool === 'exec_command' ? 1 : 0,
        toolResultBytes: outputBytes,
        modelVisibleToolBytes: 0,
        summarizedBytes: outputBytes,
      });

      this.events.append({
        role: envelope.success ? 'tool' : 'error',
        title: 'local',
        content: toolFinishContent({
          type: 'tool_result',
          name: action.tool,
          args: action.args,
          callId: localCallId,
          result,
          modelVisibleResult: result,
          duration,
          success: envelope.success,
          error: envelope.error,
          summary: envelope.summary,
          outputBytes,
          artifactRef: formattedLocalResult.artifactRef,
        }),
      });

      this.runtime.store.addMessage({ role: 'assistant', content: assistantContent });
      this.setLoopStats(stats);

      if (sessionId) {
        recordTraceEvent(this.events, sessionId, {
          turnId,
          type: 'tool_result',
          name: action.tool,
          callId: localCallId,
          argsSummary: traceArgs.argsSummary,
          argsArtifactId: traceArgs.argsArtifactId,
          argsBytes: traceArgs.argsBytes,
          success: envelope.success,
          duration,
          outputBytes,
          modelVisibleBytes: 0,
          artifactId: formattedLocalResult.artifactRef?.id,
          error: envelope.error ? compactMiddle(envelope.error, 240) : undefined,
        });
        appendPostWorkspaceTrace(this.events, sessionId, turnId, this.runtime.cwd, preWorkspace);
        recordTraceEvent(this.events, sessionId, {
          turnId,
          type: 'complete',
          finishReason: stats.finishReason,
          llmRequests: stats.llmRequests,
          toolCalls: stats.toolCalls,
          readOnlyToolCalls: stats.readOnlyToolCalls,
          unsafeToolCalls: stats.unsafeToolCalls,
          localFastPathUsed: true,
        });
        appendSessionMessage(sessionId, {
          role: 'assistant',
          content: assistantContent,
          timestamp: Date.now(),
        });
        const recordedMessages = readSessionMessages(sessionId);
        if (recordedMessages.length > 0) {
          updateSessionSummary(sessionId, recordedMessages);
        }
      }

      this.events.setStatus(envelope.success ? `Completed local ${action.label}` : `Failed local ${action.label}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.events.append({ role: 'error', title: 'local', content: message });
      this.events.setStatus('Local command failed. Ready for the next input.');
      const assistantContent = `Local fast path failed for ${action.label}.\n\n${message}`;
      this.runtime.store.addMessage({ role: 'assistant', content: assistantContent });
      const finishReason: LoopFinishReason = error instanceof LocalFastPathBlockedError ? 'blocked' : 'failed';
      const stats = createLocalFastPathLoopStats({
        finishReason,
        toolCalls: 0,
      });
      this.setLoopStats(stats);
      if (sessionId) {
        recordTraceEvent(this.events, sessionId, {
          turnId,
          type: 'error',
          name: action.tool,
          error: compactTraceError(error),
        });
        appendPostWorkspaceTrace(this.events, sessionId, turnId, this.runtime.cwd, preWorkspace);
        recordTraceEvent(this.events, sessionId, {
          turnId,
          type: 'complete',
          finishReason: stats.finishReason,
          llmRequests: stats.llmRequests,
          toolCalls: stats.toolCalls,
          localFastPathUsed: true,
          note: 'local_fast_path_failed',
        });
        appendSessionMessage(sessionId, {
          role: 'assistant',
          content: assistantContent,
          timestamp: Date.now(),
        });
      }
    }
  }

  private createCommandContext(abortSignal?: AbortSignal, turnId?: number | string): CommandContext {
    return {
      cwd: this.runtime.cwd,
      config: this.runtime.config,
      store: this.runtime.store,
      llm: this.runtime.llm,
      runtime: this.runtime.runtime,
      sessionId: this.runtime.getSession()?.id,
      turnId,
      ensureSession: this.runtime.ensureSession,
      setSession: session => {
        this.runtime.setSession(session);
        this.events.replaceTranscript(sessionMessagesToTranscriptEntries(session.id));
      },
      sessionRestored: event => {
        this.events.sessionRestored?.(event);
      },
      getSession: this.runtime.getSession,
      abortSignal,
      writeOutput: text => {
        if (text.trim()) {
          this.events.append({ role: 'system', content: text });
        }
      },
      writeLine: text => {
        if (text?.trim()) {
          this.events.append({ role: 'system', content: text });
        }
      },
      uiRenderer: this.controllerOptions.uiRenderer ?? this.runtime.config.ui?.renderer ?? 'terminal',
      uiCapabilities: resolveUiRendererCapabilities(
        this.controllerOptions.uiCapabilities,
        this.controllerOptions.uiRenderer ?? this.runtime.config.ui?.renderer
      ),
    };
  }

  private async runChat(
    input: string,
    options: { abortSignal?: AbortSignal; turnId?: number | string } = {}
  ): Promise<void> {
    if (!input) {
      this.events.append({ role: 'error', content: 'Usage: /chat <message>' });
      return;
    }

    if (!this.runtime.llm || !isConfigured(this.runtime.config)) {
      this.events.append({
        role: 'error',
        content: 'LLM is not configured. Set OPENHORSE_API_KEY in ~/.openhorse/openhorse.json or environment.',
      });
      return;
    }

    const abortSignal = options.abortSignal;
    const turnId = traceTurnId(options.turnId);
    const activeSession = this.runtime.getSession() ?? this.runtime.ensureSession() ?? loadSessionMeta(this.runtime.getSession()?.id ?? '');
    const sessionId = activeSession?.id;
    const preWorkspace = captureWorkspaceSnapshot(this.runtime.cwd);
    const runtimeTools = getRuntimeTools();
    const skillResolution = resolveSkillsForTurn({
      cwd: this.runtime.cwd,
      input,
      tools: runtimeTools,
      projectPath: activeSession?.projectPath,
      sessionId,
    });
    const appliedSkillNames = skillResolution.skills.map(skill => skill.name);

    if (sessionId) {
      appendSessionMessage(sessionId, {
        role: 'user',
        content: input,
        timestamp: Date.now(),
        appliedSkills: appliedSkillNames.length > 0 ? appliedSkillNames : undefined,
      });
      recordTraceEvent(this.events, sessionId, {
        turnId,
        type: 'turn_start',
        inputBytes: byteLength(input),
        note: appliedSkillNames.length > 0 ? `skills=${appliedSkillNames.join(',')}` : undefined,
      });
      appendWorkspaceSnapshotTrace(this.events, sessionId, turnId, 'pre_turn', preWorkspace);
    }

    this.runtime.store.addMessage({ role: 'user', content: input });
    refreshProjectInstructions(this.runtime.store, this.runtime.cwd);
    const snapshot = this.runtime.store.getSnapshot();
    const harness = createContextHarness({
      cwd: this.runtime.cwd,
      modelId: this.runtime.llm.getModel(),
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
      cwd: this.runtime.cwd,
      platform: process.platform,
      nodeVersion: process.version,
      tools: skillResolution.tools,
      memoryContent: snapshot.memoryContent,
      skillsContent: snapshot.skillsContent,
      projectInstructionsContent: snapshot.projectInstructionsContent,
      activeSkillsContent: skillResolution.promptInjection,
      referencedFilesContent: buildReferencedFilesPrompt(input, this.runtime.cwd),
    };
    const systemPrompt = buildSystemPrompt(promptCtx);
    const messages: Message[] = [
      { role: 'system', content: systemPrompt.static, cacheControl: { type: 'ephemeral' } },
      ...(systemPrompt.dynamic ? [{ role: 'system' as const, content: systemPrompt.dynamic }] : []),
      ...snapshot.conversationHistory,
    ];

    let finalContent = '';
    let finalUsage: { promptTokens: number; completionTokens: number } | undefined;
    let finalModel = '';
    let pendingCompleteTrace: Omit<SessionTraceEvent, 'sessionId' | 'timestamp'> | null = null;
    let pendingCompleteStats: LoopStats | undefined;
    const verificationResults: VerificationCommandResult[] = [];
    const sessionMessagesToRecord: SessionMessage[] = [];
    const assistantStream = createAssistantStreamPresenter(this.events, abortSignal);
    const toolEvents = createToolEventPresenter(this.events);
    let checkpointSequence = 0;
    const checkpointIds: string[] = [];

    const streamCallbacks: StreamCallbacks = {
      onChunk: chunk => {
        assistantStream.appendChunk(chunk);
      },
    };

    const toolExecutor = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      if (!skillResolution.tools.some(tool => tool.name === name)) {
        return JSON.stringify({
          success: false,
          error: skillResolution.toolScopeActive
            ? `Tool ${name} is not available for the active skill scope. Available tools: ${skillResolution.tools.map(tool => tool.name).join(', ') || 'none'}`
            : `Tool ${name} is not available.`,
        });
      }
      return executeTool(name, args, signal, {
        cwd: this.runtime.cwd,
        config: {
          name: this.runtime.config.name,
          mode: this.runtime.config.mode,
        },
        sessionId,
        turnId,
      });
    };

    const loopBudget = resolveRuntimeLoopBudget(input, this.runtime.config, harness.toJSON());
    let observedTurnsStarted = 0;
    let observedLlmRequests = 0;
    let observedToolCalls = 0;
    let observedReadOnlyToolCalls = 0;
    let observedUnsafeToolCalls = 0;
    let observedToolResultBytes = 0;
    let observedModelVisibleToolBytes = 0;

    try {
      for await (const event of query({
        messages,
        tools: skillResolution.tools,
        toolExecutor,
        llm: this.runtime.llm,
        streamCallbacks,
        costTracker: snapshot.costTracker,
        permissionMode: snapshot.permissionMode,
        toolConfirmation: this.runtime.config.toolConfirmation,
        confirmToolUse: this.controllerOptions.confirmToolUse,
        toolContext: {
          cwd: this.runtime.cwd,
          config: {
            name: this.runtime.config.name,
            mode: this.runtime.config.mode,
          },
          sessionId,
          turnId,
        },
        abortSignal,
        harness,
        input,
        loopBudget,
      })) {
        switch (event.type) {
          case 'request_start':
            observedTurnsStarted = Math.max(observedTurnsStarted, event.turn);
            observedLlmRequests++;
            assistantStream.discardSegment();
            this.events.setStatus(agentStepStatus(event.turn));
            if (sessionId) {
              recordTraceEvent(this.events, sessionId, {
                turnId,
                type: 'request_start',
                model: event.model,
                turn: event.turn,
              });
            }
            break;
          case 'prompt_assembly':
            if (sessionId) {
              recordTraceEvent(this.events, sessionId, {
                turnId,
                type: 'prompt_assembly',
                promptModelId: event.modelId,
                promptEstimatedTokens: event.estimatedTokens,
                promptBudgetTokens: event.budgetTokens,
                promptCoreTokens: event.coreTokens,
                promptEvidenceBudgetTokens: event.evidenceBudgetTokens,
                promptRecentTurnBudgetTokens: event.recentTurnBudgetTokens,
                promptSections: event.sections,
                promptIncludedEvidence: event.includedEvidence,
                promptOmittedEvidence: event.omittedEvidence,
                promptIncludedEvidenceCount: event.includedEvidenceCount,
                promptOmittedEvidenceCount: event.omittedEvidenceCount,
              });
            }
            break;
          case 'assistant_tool_calls':
            assistantStream.ensureMessage(event.content || '');
            assistantStream.closeSegment();
            this.events.setStatus(runningToolsStatus(event.toolCalls.length));
            const checkpointId = checkpointSequence === 0
              ? turnId
              : `${turnId}-checkpoint-${checkpointSequence + 1}`;
            if (createPreToolCheckpoint(
              this.events,
              sessionId,
              turnId,
              checkpointId,
              this.runtime.cwd,
              event.toolCalls,
            )) {
              checkpointIds.push(checkpointId);
              checkpointSequence++;
            }
            if (sessionId) {
              recordTraceEvent(this.events, sessionId, {
                turnId,
                type: 'assistant_tool_calls',
                toolCallCount: event.toolCalls.length,
                contentBytes: byteLength(event.content || ''),
              });
            }
            sessionMessagesToRecord.push({
              role: 'assistant',
              content: event.content || '',
              timestamp: Date.now(),
              tool_calls: event.toolCalls,
            });
            break;
          case 'tool_call':
            observedToolCalls++;
            {
              const toolDefinition = skillResolution.tools.find(tool => tool.name === event.name);
              if (toolDefinition?.isReadOnly?.(event.args) === true) {
                observedReadOnlyToolCalls++;
              } else {
                observedUnsafeToolCalls++;
              }
            }
            assistantStream.closeSegment();
            toolEvents.start(event);
            if (sessionId) {
              const traceArgs = buildTraceArgsDetails(this.runtime.cwd, event.name, event.args);
              recordTraceEvent(this.events, sessionId, {
                turnId,
                type: 'tool_call',
                name: event.name,
                callId: event.callId,
                ...traceArgs,
                batchCount: event.batchCount,
                batchIndex: event.batchIndex,
              });
            }
            break;
          case 'permission_decision':
            if (sessionId) {
              recordTraceEvent(this.events, sessionId, {
                turnId,
                type: 'permission_decision',
                name: event.name,
                callId: event.callId,
                argsSummary: compactToolArgs(event.args),
                permissionBehavior: event.decision.behavior,
                permissionApproved: event.decision.approved,
                permissionSource: event.decision.source,
                permissionReason: event.decision.reason
                  ? compactMiddle(event.decision.reason, 240)
                  : undefined,
                permissionDuration: event.decision.duration,
                batchCount: event.batchCount,
                batchIndex: event.batchIndex,
              });
            }
            break;
          case 'tool_result': {
            observedToolResultBytes += event.outputBytes ?? byteLength(event.result);
            observedModelVisibleToolBytes += byteLength(event.modelVisibleResult);
            toolEvents.finish(event);
            if (sessionId) {
              recordTraceEvent(this.events, sessionId, {
                turnId,
                type: 'tool_result',
                name: event.name,
                callId: event.callId,
                argsSummary: compactToolArgs(event.args),
                success: event.success,
                duration: event.duration,
                outputBytes: event.outputBytes,
                modelVisibleBytes: byteLength(event.modelVisibleResult),
                artifactId: event.artifactRef?.id,
                error: event.error ? compactMiddle(event.error, 240) : undefined,
                batchCount: event.batchCount,
                batchIndex: event.batchIndex,
              });
            }
            const verificationResult = collectVerificationCommandResult({
              toolName: event.name,
              args: event.args,
              success: event.success,
              outputBytes: event.outputBytes,
              error: event.error,
            });
            if (verificationResult) {
              verificationResults.push(verificationResult);
              appendVerificationResultTrace(this.events, sessionId, turnId, verificationResult);
            }
            sessionMessagesToRecord.push({
              role: 'tool',
              content: event.result,
              modelVisibleContent: event.modelVisibleResult,
              timestamp: Date.now(),
              toolCallId: event.callId,
            });
            break;
          }
          case 'strategy_exhausted':
            this.events.append({ role: 'status', content: event.suggestion });
            if (sessionId) {
              recordTraceEvent(this.events, sessionId, {
                turnId,
                type: 'strategy_exhausted',
                note: compactMiddle(event.suggestion, 240),
              });
            }
            break;
          case 'message':
            finalContent = event.content;
            assistantStream.ensureMessage(event.content);
            if (sessionId) {
              recordTraceEvent(this.events, sessionId, {
                turnId,
                type: 'message',
                contentBytes: byteLength(event.content),
              });
            }
            if (event.content) {
              sessionMessagesToRecord.push({
                role: 'assistant',
                content: event.content,
                timestamp: Date.now(),
              });
            }
            break;
          case 'complete':
            if (event.content && !finalContent) {
              if (event.stats?.finishReason === 'budget_exceeded') {
                assistantStream.replaceMessage(event.content);
              } else {
                assistantStream.ensureMessage(event.content);
              }
              sessionMessagesToRecord.push({
                role: 'assistant',
                content: event.content,
                timestamp: Date.now(),
              });
            }
            finalContent = event.content;
            finalUsage = event.usage;
            finalModel = event.model;
            if (event.stats) {
              pendingCompleteStats = event.stats;
              recordProviderTraceEvents(this.events, sessionId, turnId, event.stats);
              pendingCompleteTrace = {
                turnId,
                type: 'complete',
                model: event.model,
                contentBytes: byteLength(event.content || ''),
                finishReason: event.stats.finishReason,
                llmRequests: event.stats.llmRequests,
                toolCalls: event.stats.toolCalls,
                readOnlyToolCalls: event.stats.readOnlyToolCalls,
                unsafeToolCalls: event.stats.unsafeToolCalls,
                loopBudgetSource: event.stats.loopBudgetSource,
                loopBudgetBaseProfile: event.stats.loopBudgetBaseProfile,
                loopBudgetMaxLlmRequests: event.stats.loopBudgetMaxLlmRequests,
                loopBudgetMaxToolCalls: event.stats.loopBudgetMaxToolCalls,
                loopBudgetMaxReadOnlyFragmentation: event.stats.loopBudgetMaxReadOnlyFragmentation,
                loopBudgetMaxModelVisibleBytes: event.stats.loopBudgetMaxModelVisibleBytes,
                loopBudgetConfigOverride: event.stats.loopBudgetConfigOverride,
                budgetExceededReason: event.stats.budgetExceededReason,
                continuationActions: event.stats.continuationActions,
                continuationHint: event.stats.continuationHint,
                localFastPathUsed: event.stats.localFastPathUsed,
              };
            } else {
              pendingCompleteTrace = {
                turnId,
                type: 'complete',
                model: event.model,
                contentBytes: byteLength(event.content || ''),
              };
            }
            break;
        }
      }

      const wasAborted = abortSignal?.aborted === true;
      if (wasAborted) {
        assistantStream.discardSegment();
        this.events.setStatus('Interrupted.');
        removeTrailingUserMessage(this.runtime);
        if (sessionId) {
          appendPostWorkspaceTrace(this.events, sessionId, turnId, this.runtime.cwd, preWorkspace, verificationResults);
          recordTraceEvent(this.events, sessionId, {
            turnId,
            type: 'aborted',
            note: 'aborted_after_query',
          });
          removeLastIncompleteAssistantMessage(sessionId);
        }
        return;
      }

      assistantStream.closeSegment();

      if (sessionId) {
        const { profile, summary } = appendPostWorkspaceTrace(
          this.events,
          sessionId,
          turnId,
          this.runtime.cwd,
          preWorkspace,
          verificationResults,
        );
        if (shouldRecordVerificationLoopStats(profile, summary)) {
          const stats = pendingCompleteStats ?? this.runtime.store.getSnapshot().lastLoopStats;
          if (stats) {
            pendingCompleteStats = withVerificationLoopStats(stats, summary);
          }
        }
        if (shouldGateCompletion(summary)) {
          const notice = formatVerificationGateNotice(summary);
          this.events.append({
            role: 'status',
            title: 'verification',
            content: notice,
          });
          finalContent = finalContent ? `${finalContent}\n\n${notice}` : notice;
          appendAssistantNotice(sessionMessagesToRecord, notice);
          if (pendingCompleteTrace) {
            pendingCompleteTrace.finishReason = 'completion_gate';
            pendingCompleteTrace.contentBytes = byteLength(finalContent);
            pendingCompleteTrace.note = 'verification_incomplete';
          }
          const stats = pendingCompleteStats ?? this.runtime.store.getSnapshot().lastLoopStats;
          if (stats) {
            pendingCompleteStats = {
              ...withVerificationLoopStats(stats, summary),
              finishReason: 'completion_gate',
            };
          }
        }
      }

      if (pendingCompleteStats) {
        this.setLoopStats(pendingCompleteStats);
      }

      if (finalContent) {
        this.runtime.store.addMessage({ role: 'assistant', content: finalContent });
      }

      if (sessionId && sessionMessagesToRecord.length > 0) {
        appendSessionMessages(sessionId, sessionMessagesToRecord);
      }

      if (finalUsage) {
        this.runtime.store.setTokenUsage(finalUsage);
      }

      harness.ingestTurn({
        userInput: input,
        assistantContent: finalContent,
        sessionMessages: sessionMessagesToRecord,
        intent,
      });
      const harnessState = harness.toJSON();
      this.runtime.store.setState({ harnessState });
      emitHarnessDiagnostics(this.events, harnessState);
      if (sessionId) {
        if (pendingCompleteTrace) {
          recordTraceEvent(this.events, sessionId, pendingCompleteTrace);
        }
        updateSessionSkills(sessionId, appliedSkillNames);
        updateSessionHarnessState(sessionId, harnessState);
        const recordedMessages = readSessionMessages(sessionId);
        if (recordedMessages.length > 0) {
          updateSessionSummary(sessionId, recordedMessages);
        }
      }
      this.events.setStatus(finalModel ? `Completed with ${finalModel}` : 'Completed');
    } catch (error: unknown) {
      if (isAbortError(error, abortSignal)) {
        assistantStream.discardSegment();
        this.events.setStatus('Interrupted.');
        removeTrailingUserMessage(this.runtime);
        if (sessionId) {
          appendPostWorkspaceTrace(this.events, sessionId, turnId, this.runtime.cwd, preWorkspace, verificationResults);
          recordTraceEvent(this.events, sessionId, {
            turnId,
            type: 'aborted',
            note: 'abort_error',
          });
          removeLastIncompleteAssistantMessage(sessionId);
        }
        return;
      }

      assistantStream.discardSegment();
      this.events.append({ role: 'error', content: formatChatError(error) });
      this.events.setStatus('Turn failed. Ready for the next input.');
      const failedStats = error instanceof QueryLoopError
        ? error.stats
        : createFailedLoopStats({
            loopBudget,
            diagnostics: observedLlmRequests > 0 ? getLastRequestDiagnostics(this.runtime.llm) : undefined,
            turnsStarted: observedTurnsStarted,
            llmRequests: observedLlmRequests,
            toolCalls: observedToolCalls,
            readOnlyToolCalls: observedReadOnlyToolCalls,
            unsafeToolCalls: observedUnsafeToolCalls,
            toolResultBytes: observedToolResultBytes,
            modelVisibleToolBytes: observedModelVisibleToolBytes,
          });
      this.setLoopStats(failedStats);
      if (sessionId) {
        recordProviderTraceEvents(this.events, sessionId, turnId, failedStats);
        const { delta } = appendPostWorkspaceTrace(
          this.events,
          sessionId,
          turnId,
          this.runtime.cwd,
          preWorkspace,
          verificationResults,
        );
        const recoveryNotice = workspaceDeltaHasTurnChanges(delta)
          ? formatFailureRecoveryNotice(turnId, delta, checkpointIds)
          : undefined;
        if (recoveryNotice) {
          this.events.append({
            role: 'status',
            title: 'recovery',
            content: recoveryNotice,
          });
        }
        recordTraceEvent(this.events, sessionId, {
          turnId,
          type: 'error',
          error: compactTraceError(error),
          note: recoveryNotice,
        });
        recordTraceEvent(this.events, sessionId, {
          turnId,
          type: 'complete',
          model: failedStats.providerFinalModel ?? this.runtime.llm.getModel(),
          contentBytes: 0,
          finishReason: failedStats.finishReason,
          llmRequests: failedStats.llmRequests,
          toolCalls: failedStats.toolCalls,
          readOnlyToolCalls: failedStats.readOnlyToolCalls,
          unsafeToolCalls: failedStats.unsafeToolCalls,
          loopBudgetSource: failedStats.loopBudgetSource,
          loopBudgetBaseProfile: failedStats.loopBudgetBaseProfile,
          loopBudgetMaxLlmRequests: failedStats.loopBudgetMaxLlmRequests,
          loopBudgetMaxToolCalls: failedStats.loopBudgetMaxToolCalls,
          loopBudgetMaxReadOnlyFragmentation: failedStats.loopBudgetMaxReadOnlyFragmentation,
          loopBudgetMaxModelVisibleBytes: failedStats.loopBudgetMaxModelVisibleBytes,
          loopBudgetConfigOverride: failedStats.loopBudgetConfigOverride,
          localFastPathUsed: failedStats.localFastPathUsed,
        });
        removeLastIncompleteAssistantMessage(sessionId);
      }
      const history = this.runtime.store.getSnapshot().conversationHistory;
      if (history.length > 0) {
        this.runtime.store.setState({ conversationHistory: history.slice(0, -1) });
      }
    }
  }
}

/** @deprecated Use AgentChatController. Chat execution is renderer-independent. */
export { AgentChatController as InkChatController };

export function loadSessionIntoRuntime(runtime: OpenHorseUiRuntime, sessionId: string): string {
  const history = loadSessionHistory(sessionId);
  runtime.store.setState({ conversationHistory: history });
  runtime.store.setState({ harnessState: loadSessionHarnessState(sessionId) ?? loadSessionMeta(sessionId)?.harnessState });
  return `Restored ${history.length} messages`;
}

export function closeSession(runtime: OpenHorseUiRuntime): void {
  const session = runtime.getSession();
  if (!session) return;
  const messages = readSessionMessages(session.id);
  if (messages.length > 0) {
    updateSessionSummary(session.id, messages);
  }
  endSession(session.id);
}
