import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentRuntimeController, type AgentRuntimeRunner } from '../src/runtime/agent-runtime-controller';
import {
  type AgentRuntimeEvent,
  createAgentRuntimeEventSinkFromUiEvents,
  createUiEventSinkFromAgentRuntimeEvents,
} from '../src/runtime/agent-runtime-protocol';
import { AgentChatController, createToolEventPresenter } from '../src/runtime/chat-controller';
import {
  resolveUiRendererCapabilities,
  type OpenHorseUiRuntime,
  type TranscriptAppendEntry,
  type UiEventSink,
} from '../src/runtime/ui-events';
import { appendSessionMessage, createSession, type SessionMeta } from '../src/services/session-storage';
import { Store } from '../src/framework/store';
import { TOOLS } from '../src/tools';
import { loadConfig } from '../src/services/config';

function createRuntime(overrides: Partial<OpenHorseUiRuntime> = {}): OpenHorseUiRuntime {
  return {
    cwd: '/tmp/openhorse',
    version: 'test',
    config: { model: 'test-model' } as OpenHorseUiRuntime['config'],
    store: {
      setProcessing: jest.fn(),
    } as unknown as OpenHorseUiRuntime['store'],
    llm: null,
    runtime: {} as OpenHorseUiRuntime['runtime'],
    isConfigured: true,
    ensureSession: jest.fn(),
    setSession: jest.fn(),
    getSession: jest.fn(() => null),
    shutdown: jest.fn(),
    ...overrides,
  };
}

function createEvents() {
  const appended: TranscriptAppendEntry[] = [];
  const statuses: string[] = [];
  const processing: boolean[] = [];
  const events: UiEventSink = {
    append: jest.fn(entry => {
      appended.push(entry);
      return `entry-${appended.length}`;
    }),
    update: jest.fn(),
    finalize: jest.fn(),
    remove: jest.fn(),
    replaceTranscript: jest.fn(),
    clearTranscript: jest.fn(),
    setStatus: jest.fn(message => statuses.push(message)),
    showSessionPicker: jest.fn(),
    showEditPreview: jest.fn(),
    toolStarted: jest.fn(),
    toolFinished: jest.fn(),
    setProcessing: jest.fn(value => processing.push(value)),
  };

  return { events, appended, statuses, processing };
}

function createDeferredRunner(): AgentRuntimeRunner & {
  calls: Array<{ input: string; signal?: AbortSignal; resolve: () => void; reject: (error: unknown) => void }>;
} {
  const calls: Array<{ input: string; signal?: AbortSignal; resolve: () => void; reject: (error: unknown) => void }> = [];
  return {
    calls,
    runInput: jest.fn((input, options) => new Promise<void>((resolve, reject) => {
      calls.push({ input, signal: options?.abortSignal, resolve, reject });
    })),
  };
}

async function withTempConfig<T>(fn: (paths: { configDir: string; projectDir: string }) => Promise<T> | T): Promise<T> {
  const previousConfigDir = process.env.OPENHORSE_CONFIG_DIR;
  const root = mkdtempSync(join(tmpdir(), 'openhorse-runtime-test-'));
  const configDir = join(root, 'config');
  const projectDir = join(root, 'project');

  process.env.OPENHORSE_CONFIG_DIR = configDir;
  try {
    return await fn({ configDir, projectDir });
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.OPENHORSE_CONFIG_DIR;
    } else {
      process.env.OPENHORSE_CONFIG_DIR = previousConfigDir;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function createRestorableSession(projectDir: string, content: string): SessionMeta {
  const session = createSession(projectDir, 'test-model');
  appendSessionMessage(session.id, {
    role: 'user',
    content,
    timestamp: Date.now(),
  });
  return session;
}

describe('AgentRuntimeController', () => {
  it('resolves UI renderer capabilities from runtime renderer names and adapter overrides', () => {
    expect(resolveUiRendererCapabilities()).toEqual({
      structuredPickers: true,
      inlineProgress: true,
      suppressLegacyTokenMeta: true,
      extraAssistantSpacing: true,
      suppressAbortNotice: true,
    });
    expect(resolveUiRendererCapabilities(undefined, 'terminal')).toEqual({
      structuredPickers: true,
      inlineProgress: true,
      suppressLegacyTokenMeta: true,
      extraAssistantSpacing: true,
      suppressAbortNotice: true,
    });
    expect(resolveUiRendererCapabilities(undefined, 'legacy')).toEqual(expect.objectContaining({
      structuredPickers: true,
      inlineProgress: true,
    }));
    expect(resolveUiRendererCapabilities(undefined, 'v2')).toEqual(expect.objectContaining({
      structuredPickers: true,
      inlineProgress: true,
    }));
    expect(resolveUiRendererCapabilities(undefined, 'print')).toEqual({
      structuredPickers: false,
      inlineProgress: false,
      suppressLegacyTokenMeta: false,
      extraAssistantSpacing: false,
      suppressAbortNotice: false,
    });
    expect(resolveUiRendererCapabilities({ structuredPickers: false }, 'terminal')).toEqual(expect.objectContaining({
      structuredPickers: false,
      inlineProgress: true,
    }));
  });

  it('uses structured resume pickers when the renderer adapter supports them', async () => {
    await withTempConfig(async ({ projectDir }) => {
      createRestorableSession(projectDir, 'older task');
      createRestorableSession(projectDir, 'newer task');

      const runtime = createRuntime({ cwd: projectDir });
      const { events, appended } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await controller.runInput('/resume');

      expect(events.showSessionPicker).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Pick a Session',
        sessions: expect.arrayContaining([
          expect.objectContaining({ projectPath: projectDir }),
        ]),
        maxVisibleItems: 10,
      }));
      expect(appended).toEqual([]);
    });
  });

  it('falls back to textual resume instructions when structured pickers are disabled', async () => {
    await withTempConfig(async ({ projectDir }) => {
      createRestorableSession(projectDir, 'older task');
      createRestorableSession(projectDir, 'newer task');

      const runtime = createRuntime({ cwd: projectDir });
      const { events, appended } = createEvents();
      const controller = new AgentChatController(runtime, events, {
        uiCapabilities: { structuredPickers: false },
      });

      await controller.runInput('/resume');

      expect(events.showSessionPicker).not.toHaveBeenCalled();
      expect(appended).toEqual([
        expect.objectContaining({
          role: 'system',
          title: '/resume',
          content: expect.stringContaining('Use /resume <number|session-id|name> or /resume --last.'),
        }),
      ]);
    });
  });

  it('routes /skill commands through chat with active skill injection', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn(async (
          messages: Array<{ role: string; content: string }>,
          callbacks?: { onChunk?: (chunk: string) => void },
          tools?: Array<{ function: { name: string } }>,
        ) => {
          callbacks?.onChunk?.('done');
          return {
            content: 'done',
            model: 'test-model',
            usage: { promptTokens: 10, completionTokens: 2 },
          };
        }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, appended } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('/skill code-review inspect src')).resolves.toBeUndefined();

      expect(llm.chatStream).toHaveBeenCalled();
      const [messages, , scopedTools] = llm.chatStream.mock.calls[0];
      const systemPrompt = messages
        .filter((message: { role: string }) => message.role === 'system')
        .map((message: { content: string }) => message.content)
        .join('\n');
      expect(systemPrompt).toContain('## Active Skills');
      expect(systemPrompt).toContain('# Code Review Skill');
      expect(scopedTools).toBeDefined();
      expect(scopedTools!.map((tool: { function: { name: string } }) => tool.function.name).sort())
        .toEqual(['glob', 'grep', 'read_file']);
      expect(appended).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'error', content: expect.stringContaining('Unknown command') }),
      ]));
    });
  });

  it('passes renderer capabilities from the runtime controller boundary into commands', async () => {
    await withTempConfig(async ({ projectDir }) => {
      createRestorableSession(projectDir, 'older task');
      createRestorableSession(projectDir, 'newer task');

      const runtime = createRuntime({ cwd: projectDir });
      const { events, appended } = createEvents();
      const controller = new AgentRuntimeController({
        runtime,
        events,
        uiCapabilities: { structuredPickers: false },
      });

      expect(controller.submit('/resume')).toEqual({ type: 'started' });
      await controller.waitForIdle();

      expect(events.showSessionPicker).not.toHaveBeenCalled();
      expect(appended).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          title: '/resume',
          content: expect.stringContaining('Use /resume <number|session-id|name> or /resume --last.'),
        }),
      ]));
    });
  });

  it('runs a submitted input through the shared runner and processing lifecycle', async () => {
    const runtime = createRuntime();
    const { events, appended, processing } = createEvents();
    const runner: AgentRuntimeRunner & { calls: string[] } = {
      calls: [],
      runInput: jest.fn(async (input, options) => {
        runner.calls.push(input);
        expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
      }),
    };
    const controller = new AgentRuntimeController({ runtime, events, runner });

    expect(controller.submit('hello')).toEqual({ type: 'started' });
    await controller.waitForIdle();

    expect(runner.calls).toEqual(['hello']);
    expect(appended).toEqual([
      expect.objectContaining({ role: 'user', content: 'hello' }),
    ]);
    expect(processing).toEqual([true, false]);
    expect(runtime.store.setProcessing).toHaveBeenCalledWith(true);
    expect(runtime.store.setProcessing).toHaveBeenCalledWith(false);
  });

  it('keeps the runtime alive when a runner throws', async () => {
    const runtime = createRuntime();
    const { events, appended, statuses, processing } = createEvents();
    const runner: AgentRuntimeRunner = {
      runInput: jest.fn(async () => {
        throw new Error('Xunfei request failed with Sid: sid code: 11210, msg: NotEnoughCvError');
      }),
    };
    const controller = new AgentRuntimeController({
      runtime,
      events,
      runner,
      readyStatus: 'ready',
    });

    expect(controller.submit('hello')).toEqual({ type: 'started' });
    await expect(controller.waitForIdle()).resolves.toBeUndefined();

    expect(appended).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'error', content: expect.stringContaining('NotEnoughCvError') }),
    ]));
    expect(processing).toEqual([true, false]);
    expect(statuses).toContain('ready');
    expect(controller.hasActiveTurn()).toBe(false);
  });

  it('aborts an active turn and restarts only the latest revision', async () => {
    const runtime = createRuntime();
    const { events, statuses } = createEvents();
    const runner = createDeferredRunner();
    const controller = new AgentRuntimeController({ runtime, events, runner });

    expect(controller.submit('first goal')).toEqual({ type: 'started' });
    expect(runner.calls).toHaveLength(1);

    expect(controller.submit('older revision')).toEqual({ type: 'revision_requested' });
    expect(controller.submit('latest revision')).toEqual({ type: 'revision_requested' });
    expect(runner.calls[0].signal?.aborted).toBe(true);

    runner.calls[0].resolve();
    await Promise.resolve();
    expect(runner.calls.map(call => call.input)).toEqual(['first goal', 'latest revision']);

    runner.calls[1].resolve();
    await controller.waitForIdle();

    expect(statuses).toContain('Revision received. Interrupting current response...');
    expect(statuses).toContain('Restarting with latest instruction...');
  });

  it('does not run slash commands concurrently during an active turn', () => {
    const runtime = createRuntime();
    const { events, statuses } = createEvents();
    const runner = createDeferredRunner();
    const controller = new AgentRuntimeController({ runtime, events, runner });

    expect(controller.submit('long task')).toEqual({ type: 'started' });
    expect(controller.submit('/status')).toEqual({ type: 'command_ignored' });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].signal?.aborted).toBe(false);
    expect(statuses).toContain('Command ignored while agent is running. Press Ctrl+C to interrupt first.');
  });

  it('uses double Ctrl+C semantics while running', () => {
    const runtime = createRuntime();
    const { events } = createEvents();
    const runner = createDeferredRunner();
    const controller = new AgentRuntimeController({
      runtime,
      events,
      runner,
      exitConfirmWindowMs: 2000,
    });

    controller.submit('long task');
    expect(controller.interrupt()).toEqual({ type: 'interrupted' });
    expect(runner.calls[0].signal?.aborted).toBe(true);
    expect(controller.interrupt()).toEqual({ type: 'exit_requested' });
  });

  it('can suppress submitted input echo for terminal-style renderers', async () => {
    const runtime = createRuntime();
    const { events, appended } = createEvents();
    const runner: AgentRuntimeRunner = {
      runInput: jest.fn(async () => undefined),
    };
    const controller = new AgentRuntimeController({
      runtime,
      events,
      runner,
      echoSubmittedInput: false,
    });

    controller.submit('terminal already echoed this');
    await controller.waitForIdle();

    expect(appended).toEqual([]);
    expect(runner.runInput).toHaveBeenCalledTimes(1);
  });

  it('accepts protocol inputs so renderers do not call lifecycle methods directly', async () => {
    const runtime = createRuntime();
    const { events } = createEvents();
    const runner = createDeferredRunner();
    const controller = new AgentRuntimeController({ runtime, events, runner });

    expect(controller.handle({ type: 'submit', text: 'protocol task', source: 'composer' })).toEqual({ type: 'started' });
    expect(controller.handle({ type: 'clear_exit_intent' })).toEqual({ type: 'exit_intent_cleared' });
    expect(controller.handle({ type: 'interrupt', source: 'keyboard' })).toEqual({ type: 'interrupted' });
    expect(runner.calls[0].signal?.aborted).toBe(true);
  });

  it('accepts session picker selections as protocol inputs', async () => {
    const runtime = createRuntime();
    const { events } = createEvents();
    const runner: AgentRuntimeRunner & { calls: string[] } = {
      calls: [],
      runInput: jest.fn(async input => {
        runner.calls.push(input);
      }),
    };
    const controller = new AgentRuntimeController({ runtime, events, runner });

    expect(controller.handle({
      type: 'select_session',
      sessionId: 'session-123',
      allProjects: true,
      source: 'picker',
    })).toEqual({ type: 'started' });
    await controller.waitForIdle();

    expect(runner.calls).toEqual(['/resume session-123 --all']);
  });

  it('requests tool permission through runtime events and records a decision input', async () => {
    const runtime = createRuntime();
    const emitted: AgentRuntimeEvent[] = [];
    const controller = new AgentRuntimeController({
      runtime,
      runner: { runInput: jest.fn(async () => undefined) },
      eventSink: {
        emit: event => {
          emitted.push(event);
        },
      },
    });

    const decision = controller.requestToolPermission({
      name: 'git_push',
      args: { remote: 'origin' },
      reason: 'updates remote repository',
    });
    const request = emitted.find((event): event is Extract<AgentRuntimeEvent, { type: 'permission_requested' }> =>
      event.type === 'permission_requested'
    );

    expect(request).toEqual(expect.objectContaining({
      type: 'permission_requested',
      request: expect.objectContaining({
        name: 'git_push',
        args: { remote: 'origin' },
        reason: 'updates remote repository',
      }),
    }));
    expect(controller.handle({
      type: 'permission_decision',
      requestId: request!.request.id,
      approved: true,
      source: 'keyboard',
    })).toEqual({ type: 'permission_decision_recorded' });
    await expect(decision).resolves.toBe(true);
  });

  it('ignores unknown permission decisions', () => {
    const runtime = createRuntime();
    const { events } = createEvents();
    const controller = new AgentRuntimeController({
      runtime,
      events,
      runner: { runInput: jest.fn(async () => undefined) },
    });

    expect(controller.handle({
      type: 'permission_decision',
      requestId: 'missing',
      approved: true,
    })).toEqual({ type: 'permission_decision_ignored' });
  });

  it('denies pending tool permission when its abort signal fires', async () => {
    const runtime = createRuntime();
    const emitted: AgentRuntimeEvent[] = [];
    const controller = new AgentRuntimeController({
      runtime,
      runner: { runInput: jest.fn(async () => undefined) },
      eventSink: {
        emit: event => {
          emitted.push(event);
        },
      },
    });
    const abortController = new AbortController();

    const decision = controller.requestToolPermission({
      name: 'exec_command',
      args: { command: 'npm publish' },
      abortSignal: abortController.signal,
    });
    abortController.abort();

    await expect(decision).resolves.toBe(false);
    const request = emitted.find((event): event is Extract<AgentRuntimeEvent, { type: 'permission_requested' }> =>
      event.type === 'permission_requested'
    );
    expect(controller.handle({
      type: 'permission_decision',
      requestId: request!.request.id,
      approved: true,
    })).toEqual({ type: 'permission_decision_ignored' });
  });

  it('can run with only a structured runtime event sink', async () => {
    const runtime = createRuntime();
    const emitted: AgentRuntimeEvent[] = [];
    const runner: AgentRuntimeRunner = {
      runInput: jest.fn(async () => undefined),
    };
    const controller = new AgentRuntimeController({
      runtime,
      runner,
      eventSink: {
        emit: event => {
          emitted.push(event);
          return event.type === 'transcript_append' ? `event-${emitted.length}` : undefined;
        },
      },
    });

    expect(controller.handle({ type: 'submit', text: 'event protocol task' })).toEqual({ type: 'started' });
    await controller.waitForIdle();

    expect(runner.runInput).toHaveBeenCalledWith('event protocol task', expect.objectContaining({
      abortSignal: expect.any(AbortSignal),
    }));
    expect(emitted.map(event => event.type)).toEqual([
      'transcript_append',
      'processing_changed',
      'processing_changed',
    ]);
  });

  it('renders provider request failures without throwing from chat runtime', async () => {
    await withTempConfig(async ({ projectDir }) => {
      const config = loadConfig({
        apiKey: 'test-key',
        model: 'xopglm51',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'xopglm51',
      });
      const llm = {
        getModel: jest.fn(() => 'xopglm51'),
        chatStream: jest.fn(async () => {
          throw new Error('Xunfei request failed with Sid: cht000d6760 code: 11210, msg: NotEnoughCvError');
        }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'xopglm51');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, appended, statuses } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('hello')).resolves.toBeUndefined();

      expect(llm.chatStream).toHaveBeenCalledTimes(1);
      expect(appended).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'error',
          content: expect.stringContaining('Provider quota or credit appears insufficient'),
        }),
      ]));
      expect(statuses).toContain('Turn failed. Ready for the next input.');
    });
  });

  it('emits intentful statuses for model thinking and batched tool phases', async () => {
    await withTempConfig(async ({ projectDir }) => {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'a.txt'), 'alpha', 'utf-8');
      writeFileSync(join(projectDir, 'b.txt'), 'bravo', 'utf-8');

      const config = loadConfig({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const store = new Store({
        config,
        tools: TOOLS,
        currentModel: 'test-model',
      });
      const toolCalls = [
        {
          id: 'call-a',
          type: 'function' as const,
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
        },
        {
          id: 'call-b',
          type: 'function' as const,
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'b.txt' }) },
        },
      ];
      const llm = {
        getModel: jest.fn(() => 'test-model'),
        chatStream: jest.fn()
          .mockResolvedValueOnce({
            content: '',
            model: 'test-model',
            toolCalls,
            usage: { promptTokens: 10, completionTokens: 1 },
          })
          .mockResolvedValueOnce({
            content: 'done',
            model: 'test-model',
            usage: { promptTokens: 12, completionTokens: 2 },
          }),
      };
      let session: SessionMeta | null = null;
      const runtime = createRuntime({
        cwd: projectDir,
        config,
        store,
        llm: llm as any,
        isConfigured: true,
        ensureSession: jest.fn(() => {
          session ??= createSession(projectDir, 'test-model');
          return session;
        }),
        getSession: jest.fn(() => session),
        setSession: jest.fn(nextSession => {
          session = nextSession;
        }),
      });
      const { events, statuses } = createEvents();
      const controller = new AgentChatController(runtime, events);

      await expect(controller.runInput('read both files')).resolves.toBeUndefined();

      expect(statuses).toEqual(expect.arrayContaining([
        'Thinking...',
        'Running 2 tools...',
        'Reading tool results...',
      ]));
      expect(llm.chatStream).toHaveBeenCalledTimes(2);
    });
  });

  it('bridges structured runtime events to the legacy UI event sink contract', () => {
    const { events, appended, statuses, processing } = createEvents();
    const runtimeSink = createAgentRuntimeEventSinkFromUiEvents(events);

    expect(runtimeSink.emit({
      type: 'transcript_append',
      entry: { role: 'assistant', content: 'hello' },
    })).toBe('entry-1');
    runtimeSink.emit({ type: 'status_changed', message: 'ready' });
    runtimeSink.emit({ type: 'processing_changed', processing: true });
    runtimeSink.emit({
      type: 'tool_started',
      event: { callId: 'call-1', name: 'read_file', args: { path: 'src/index.ts' } },
    });
    runtimeSink.emit({
      type: 'tool_finished',
      event: {
        callId: 'call-1',
        name: 'read_file',
        args: { path: 'src/index.ts' },
        success: true,
        duration: 12,
        summary: 'read file ok',
      },
    });

    expect(appended).toEqual([expect.objectContaining({ role: 'assistant', content: 'hello' })]);
    expect(statuses).toEqual(['ready']);
    expect(processing).toEqual([true]);
    expect(events.toolStarted).toHaveBeenCalledWith({ callId: 'call-1', name: 'read_file', args: { path: 'src/index.ts' } });
    expect(events.toolFinished).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call-1', success: true }));
  });

  it('prints full exec_command text in tool transcript entries', () => {
    const { events, appended } = createEvents();
    const presenter = createToolEventPresenter(events);
    const command = 'cd /Users/hope/ai-project/a2a-python && export PATH="$HOME/.local/bin:$PATH" && ./scripts/lint.sh --all';

    presenter.start({
      type: 'tool_call',
      callId: 'call-exec',
      name: 'exec_command',
      args: { command },
      batchCount: 1,
      batchIndex: 0,
    });

    expect(appended[0].content).toBe(`Running exec_command\n  $ ${command}`);
  });

  it('adapts a protocol event sink back into UiEventSink for renderer compatibility', () => {
    const emitted: Array<{ type: string }> = [];
    const uiEvents = createUiEventSinkFromAgentRuntimeEvents({
      emit: event => {
        emitted.push(event);
        return event.type === 'transcript_append' ? 'runtime-entry-1' : undefined;
      },
    });

    expect(uiEvents.append({ role: 'user', content: 'hello' })).toBe('runtime-entry-1');
    uiEvents.setStatus('working');
    uiEvents.toolStarted?.({ callId: 'call-1', name: 'grep', args: { pattern: 'TODO' } });
    uiEvents.toolFinished?.({
      callId: 'call-1',
      name: 'grep',
      args: { pattern: 'TODO' },
      success: false,
      duration: 34,
      error: 'not found',
    });
    uiEvents.setProcessing(false);

    expect(emitted.map(event => event.type)).toEqual([
      'transcript_append',
      'status_changed',
      'tool_started',
      'tool_finished',
      'processing_changed',
    ]);
  });
});
