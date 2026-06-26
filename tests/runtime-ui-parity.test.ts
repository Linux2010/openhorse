import { AgentRuntimeController, type AgentRuntimeRunner } from '../src/runtime/agent-runtime-controller';
import type { AgentRuntimeEvent, AgentRuntimeEventSink } from '../src/runtime/agent-runtime-protocol';
import type {
  OpenHorseUiRuntime,
  RuntimeToolFinishedEvent,
  RuntimeToolStartedEvent,
  ToolPermissionRequest,
  TranscriptAppendEntry,
  UiEventSink,
} from '../src/runtime/ui-events';

type SinkMode = 'ui-events' | 'runtime-events';

function createRuntime(): OpenHorseUiRuntime {
  return {
    cwd: '/tmp/openhorse-parity',
    version: 'test',
    config: { model: 'test-model', ui: { renderer: 'terminal' } } as OpenHorseUiRuntime['config'],
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
  };
}

function createDeferredRunner(): AgentRuntimeRunner & {
  calls: Array<{ input: string; signal?: AbortSignal; resolve: () => void }>;
} {
  const calls: Array<{ input: string; signal?: AbortSignal; resolve: () => void }> = [];
  return {
    calls,
    runInput: jest.fn((input, options) => new Promise<void>(resolve => {
      calls.push({ input, signal: options?.abortSignal, resolve });
    })),
  };
}

function normalizeEvent(event: AgentRuntimeEvent): string {
  switch (event.type) {
    case 'transcript_append':
      return `append:${event.entry.role}:${event.entry.content}`;
    case 'status_changed':
      return `status:${event.message}`;
    case 'processing_changed':
      return `processing:${event.processing}`;
    case 'permission_requested':
      return `permission:${event.request.name}:${event.request.reason ?? ''}`;
    case 'tool_started':
      return `tool_started:${event.event.callId}:${event.event.name}`;
    case 'tool_finished':
      return `tool_finished:${event.event.callId}:${event.event.name}:${event.event.success}`;
    case 'session_picker_requested':
      return `session_picker:${event.request.title}:${event.request.sessions.length}`;
    case 'edit_preview_requested':
      return `edit_preview:${event.request.path}:${event.request.candidates.length}`;
    case 'transcript_update':
      return `update:${event.id}:${event.patch.content ?? ''}`;
    case 'transcript_finalize':
      return `finalize:${event.id}`;
    case 'transcript_remove':
      return `remove:${event.id}`;
    case 'transcript_replace':
      return `replace:${event.entries.length}`;
    case 'transcript_clear':
      return 'clear';
  }
}

function createRecordingController(mode: SinkMode): {
  controller: AgentRuntimeController;
  runner: ReturnType<typeof createDeferredRunner>;
  events: string[];
} {
  const runtime = createRuntime();
  const runner = createDeferredRunner();
  const events: string[] = [];

  if (mode === 'runtime-events') {
    const eventSink: AgentRuntimeEventSink = {
      emit: event => {
        events.push(normalizeEvent(event));
        return event.type === 'transcript_append' ? `event-${events.length}` : undefined;
      },
    };
    return {
      controller: new AgentRuntimeController({ runtime, eventSink, runner }),
      runner,
      events,
    };
  }

  const uiEvents: UiEventSink = {
    append: (entry: TranscriptAppendEntry) => {
      events.push(normalizeEvent({ type: 'transcript_append', entry }));
      return `ui-${events.length}`;
    },
    update: (id, patch) => events.push(normalizeEvent({ type: 'transcript_update', id, patch })),
    finalize: (id, patch) => events.push(normalizeEvent({ type: 'transcript_finalize', id, patch })),
    remove: id => events.push(normalizeEvent({ type: 'transcript_remove', id })),
    replaceTranscript: entries => events.push(normalizeEvent({ type: 'transcript_replace', entries })),
    clearTranscript: () => events.push(normalizeEvent({ type: 'transcript_clear' })),
    setStatus: message => events.push(normalizeEvent({ type: 'status_changed', message })),
    showSessionPicker: request => events.push(normalizeEvent({ type: 'session_picker_requested', request })),
    showEditPreview: request => events.push(normalizeEvent({ type: 'edit_preview_requested', request })),
    showPermissionRequest: request => events.push(normalizeEvent({ type: 'permission_requested', request })),
    toolStarted: (event: RuntimeToolStartedEvent) => events.push(normalizeEvent({ type: 'tool_started', event })),
    toolFinished: (event: RuntimeToolFinishedEvent) => events.push(normalizeEvent({ type: 'tool_finished', event })),
    setProcessing: processing => events.push(normalizeEvent({ type: 'processing_changed', processing })),
  };

  return {
    controller: new AgentRuntimeController({ runtime, events: uiEvents, runner }),
    runner,
    events,
  };
}

async function runRevisionScenario(mode: SinkMode): Promise<{ runnerInputs: string[]; firstAborted: boolean; events: string[] }> {
  const { controller, runner, events } = createRecordingController(mode);

  expect(controller.handle({ type: 'submit', text: 'first goal', source: 'composer' })).toEqual({ type: 'started' });
  expect(controller.handle({ type: 'submit', text: 'latest revision', source: 'composer' })).toEqual({ type: 'revision_requested' });
  const firstAborted = runner.calls[0].signal?.aborted === true;

  runner.calls[0].resolve();
  await Promise.resolve();
  runner.calls[1].resolve();
  await controller.waitForIdle();

  return {
    runnerInputs: runner.calls.map(call => call.input),
    firstAborted,
    events,
  };
}

async function runPermissionScenario(mode: SinkMode): Promise<{ result: boolean; events: string[] }> {
  const { controller, events } = createRecordingController(mode);
  const decision = controller.requestToolPermission({
    name: 'exec_command',
    args: { command: 'npm publish' },
    reason: 'publishing changes external state',
  });

  expect(controller.handle({
    type: 'permission_decision',
    requestId: 'permission-1',
    approved: false,
    source: 'programmatic',
  })).toEqual({ type: 'permission_decision_recorded' });

  return { result: await decision, events };
}

describe('runtime/UI renderer parity contract', () => {
  it('preserves live revision turn semantics through both renderer event adapters', async () => {
    const ui = await runRevisionScenario('ui-events');
    const runtime = await runRevisionScenario('runtime-events');

    expect(ui).toEqual(runtime);
    expect(ui.runnerInputs).toEqual(['first goal', 'latest revision']);
    expect(ui.firstAborted).toBe(true);
    expect(ui.events).toEqual([
      'append:user:first goal',
      'processing:true',
      'status:Revision received. Interrupting current response...',
      'status:Restarting with latest instruction...',
      'append:user:latest revision',
      'processing:true',
      'processing:false',
    ]);
  });

  it('routes permission requests and decisions through the same runtime contract', async () => {
    const ui = await runPermissionScenario('ui-events');
    const runtime = await runPermissionScenario('runtime-events');

    expect(ui).toEqual(runtime);
    expect(ui.result).toBe(false);
    expect(ui.events).toEqual([
      'permission:exec_command:publishing changes external state',
    ]);
  });

  it('maps session picker selections to identical runtime command input', async () => {
    const ui = createRecordingController('ui-events');
    const runtime = createRecordingController('runtime-events');

    expect(ui.controller.handle({
      type: 'select_session',
      sessionId: 'session-abc',
      allProjects: true,
      source: 'picker',
    })).toEqual({ type: 'started' });
    expect(runtime.controller.handle({
      type: 'select_session',
      sessionId: 'session-abc',
      allProjects: true,
      source: 'picker',
    })).toEqual({ type: 'started' });

    ui.runner.calls[0].resolve();
    runtime.runner.calls[0].resolve();
    await ui.controller.waitForIdle();
    await runtime.controller.waitForIdle();

    expect(ui.runner.calls.map(call => call.input)).toEqual(runtime.runner.calls.map(call => call.input));
    expect(ui.runner.calls.map(call => call.input)).toEqual(['/resume session-abc --all']);
    expect(ui.events).toEqual(runtime.events);
  });
});
