import { AgentRuntimeController, type AgentRuntimeRunner } from '../src/runtime/agent-runtime-controller';
import {
  type AgentRuntimeEvent,
  createAgentRuntimeEventSinkFromUiEvents,
  createUiEventSinkFromAgentRuntimeEvents,
} from '../src/runtime/agent-runtime-protocol';
import type { OpenHorseInkRuntime, TranscriptAppendEntry, UiEventSink } from '../src/runtime/ui-events';

function createRuntime(): OpenHorseInkRuntime {
  return {
    cwd: '/tmp/openhorse',
    version: 'test',
    config: { model: 'test-model' } as OpenHorseInkRuntime['config'],
    store: {
      setProcessing: jest.fn(),
    } as unknown as OpenHorseInkRuntime['store'],
    llm: null,
    runtime: {} as OpenHorseInkRuntime['runtime'],
    isConfigured: true,
    ensureSession: jest.fn(),
    setSession: jest.fn(),
    getSession: jest.fn(() => null),
    shutdown: jest.fn(),
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

describe('AgentRuntimeController', () => {
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

  it('bridges structured runtime events to the legacy UI event sink contract', () => {
    const { events, appended, statuses, processing } = createEvents();
    const runtimeSink = createAgentRuntimeEventSinkFromUiEvents(events);

    expect(runtimeSink.emit({
      type: 'transcript_append',
      entry: { role: 'assistant', content: 'hello' },
    })).toBe('entry-1');
    runtimeSink.emit({ type: 'status_changed', message: 'ready' });
    runtimeSink.emit({ type: 'processing_changed', processing: true });

    expect(appended).toEqual([expect.objectContaining({ role: 'assistant', content: 'hello' })]);
    expect(statuses).toEqual(['ready']);
    expect(processing).toEqual([true]);
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
    uiEvents.setProcessing(false);

    expect(emitted.map(event => event.type)).toEqual([
      'transcript_append',
      'status_changed',
      'processing_changed',
    ]);
  });
});
