import { findCommand } from '../commands';
import { parseInput, buildCommandSuggestions } from '../commands/parser';
import type { CommandContext, CommandResult } from '../commands/types';
import type { Message, StreamCallbacks } from '../services/llm';
import type { SessionMessage } from '../services/session-storage';
import {
  appendSessionMessage,
  appendSessionMessages,
  endSession,
  loadSessionHarnessState,
  loadSessionHistory,
  loadSessionMeta,
  removeLastIncompleteAssistantMessage,
  readSessionMessages,
  updateSessionHarnessState,
  updateSessionSkills,
  updateSessionSummary,
} from '../services/session-storage';
import { isConfigured } from '../services/config';
import { query, buildSystemPrompt, type PromptContext, type QueryEvent } from '../framework';
import { createContextHarness } from '../harness';
import { executeTool, getRuntimeTools } from '../tools';
import { resolveSkillsForTurn, hasMatchingSkill } from '../skills';
import { buildReferencedFilesPrompt } from '../services/file-context';
import { refreshProjectInstructions } from '../services/prompt-context';
import type { OpenHorseUiRuntime, TranscriptEntry, UiEventSink, UiRendererCapabilities } from './ui-events';
import { resolveUiRendererCapabilities } from './ui-events';

const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

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

function compactToolArgs(args: Record<string, unknown>): string {
  for (const key of ['path', 'file_path', 'file', 'cwd', 'command', 'pattern', 'query', 'url', 'target', 'sessionId']) {
    const value = args[key];
    if (typeof value === 'string') {
      return value.length > 56 ? `${value.slice(0, 53)}...` : value;
    }
  }
  const firstString = Object.values(args).find(value => typeof value === 'string');
  if (typeof firstString === 'string') {
    return firstString.length > 56 ? `${firstString.slice(0, 53)}...` : firstString;
  }
  return '';
}

function toolSummary(name: string, args: Record<string, unknown>, success: boolean, duration: number): string {
  const details = compactToolArgs(args);
  const suffix = details ? ` ${details}` : '';
  return `${success ? '✓' : '✗'} ${name}${suffix} (${duration}ms)`;
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
  };
}

type ToolCallEvent = Extract<QueryEvent, { type: 'tool_call' }>;
type ToolResultEvent = Extract<QueryEvent, { type: 'tool_result' }>;

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
      });
      const detail = compactToolArgs(event.args);
      const entryId = events.append({
        role: 'tool',
        title: 'tool',
        content: `Running ${event.name}${detail ? ` ${detail}` : ''}`,
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
      });
      const content = [
        event.summary || toolSummary(event.name, event.args, event.success, event.duration),
        event.error ? `Error: ${event.error}` : '',
      ].filter(Boolean).join('\n');
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
}

/** @deprecated Use AgentChatControllerOptions. Chat execution is renderer-independent. */
export type InkChatControllerOptions = AgentChatControllerOptions;

export class AgentChatController {
  constructor(
    private readonly runtime: OpenHorseUiRuntime,
    private readonly events: UiEventSink,
    private readonly controllerOptions: AgentChatControllerOptions = {},
  ) {}

  async runInput(input: string, options: RunInputOptions = {}): Promise<void> {
    const text = input.trim();
    if (!text) return;

    const parsed = parseInput(text);
    if (!parsed.isCommand) {
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
      uiCapabilities: resolveUiRendererCapabilities(this.controllerOptions.uiCapabilities),
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
    const turnId = options.turnId;
    const activeSession = this.runtime.getSession() ?? this.runtime.ensureSession() ?? loadSessionMeta(this.runtime.getSession()?.id ?? '');
    const sessionId = activeSession?.id;
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
    const sessionMessagesToRecord: SessionMessage[] = [];
    const assistantStream = createAssistantStreamPresenter(this.events, abortSignal);
    const toolEvents = createToolEventPresenter(this.events);

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
      })) {
        switch (event.type) {
          case 'request_start':
            assistantStream.discardSegment();
            this.events.setStatus(`Turn ${event.turn}...`);
            break;
          case 'assistant_tool_calls':
            assistantStream.ensureMessage(event.content || '');
            assistantStream.closeSegment();
            sessionMessagesToRecord.push({
              role: 'assistant',
              content: event.content || '',
              timestamp: Date.now(),
              tool_calls: event.toolCalls,
            });
            break;
          case 'tool_call':
            assistantStream.closeSegment();
            toolEvents.start(event);
            break;
          case 'tool_result': {
            toolEvents.finish(event);
            sessionMessagesToRecord.push({
              role: 'tool',
              content: event.result,
              timestamp: Date.now(),
              toolCallId: event.callId,
            });
            break;
          }
          case 'strategy_exhausted':
            this.events.append({ role: 'status', content: event.suggestion });
            break;
          case 'message':
            finalContent = event.content;
            assistantStream.ensureMessage(event.content);
            if (event.content) {
              sessionMessagesToRecord.push({
                role: 'assistant',
                content: event.content,
                timestamp: Date.now(),
              });
            }
            break;
          case 'complete':
            finalContent = event.content;
            finalUsage = event.usage;
            finalModel = event.model;
            break;
        }
      }

      const wasAborted = abortSignal?.aborted === true;
      if (wasAborted) {
        assistantStream.discardSegment();
        this.events.setStatus('Interrupted.');
        removeTrailingUserMessage(this.runtime);
        if (sessionId) {
          removeLastIncompleteAssistantMessage(sessionId);
        }
        return;
      }

      assistantStream.closeSegment();

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
      if (sessionId) {
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
          removeLastIncompleteAssistantMessage(sessionId);
        }
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.events.append({ role: 'error', content: message });
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
