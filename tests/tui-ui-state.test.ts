import {
  createTuiUiEventSink,
  initialTuiUiState,
  liveTuiTranscriptEntries,
  staticTuiTranscriptEntries,
  tuiUiReducer,
  type TuiUiAction,
  type TuiUiState,
} from '../src/tui-ui/state';
import type { SessionMeta } from '../src/services/session-storage';

function reduce(actions: TuiUiAction[]): TuiUiState {
  return actions.reduce(tuiUiReducer, initialTuiUiState);
}

describe('tui-ui state', () => {
  it('keeps finalized transcript separate from live tool/activity entries', () => {
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'hello' } },
      { type: 'appendTranscript', entry: { id: 'a1', role: 'assistant', content: 'working', live: true } },
      { type: 'appendTranscript', entry: { id: 't1', role: 'tool', content: 'Running list_files' } },
    ]);

    expect(staticTuiTranscriptEntries(state).map(entry => entry.id)).toEqual(['u1']);
    expect(liveTuiTranscriptEntries(state).map(entry => entry.id)).toEqual(['a1', 't1']);
  });

  it('commits live entries when finalized without reordering transcript history', () => {
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'hello' } },
      { type: 'appendTranscript', entry: { id: 'a1', role: 'assistant', content: 'hel', live: true } },
      { type: 'updateTranscript', id: 'a1', patch: { content: 'hello back' } },
      { type: 'finalizeTranscript', id: 'a1' },
    ]);

    expect(staticTuiTranscriptEntries(state).map(entry => [entry.id, entry.content])).toEqual([
      ['u1', 'hello'],
      ['a1', 'hello back'],
    ]);
    expect(liveTuiTranscriptEntries(state)).toEqual([]);
  });

  it('stores status, prompt, processing, and picker outside transcript history', () => {
    const session: SessionMeta = {
      id: '12345678-aaaa-bbbb-cccc-123456789000',
      projectPath: '/tmp/project',
      model: 'glm-5',
      startTime: 1,
      tokenCount: 0,
      cost: 0,
      messageCount: 4,
      historySizeBytes: 1024,
    };
    const state = reduce([
      { type: 'setStatus', message: 'working' },
      { type: 'setPrompt', value: '开源小？事收到', cursor: 4 },
      { type: 'setProcessing', processing: true },
      { type: 'showSessionPicker', request: { title: 'Resume', sessions: [session] } },
    ]);

    expect(state.statusMessage).toBe('working');
    expect(state.prompt).toEqual({ value: '开源小？事收到', cursor: 4 });
    expect(state.processing).toBe(true);
    expect(state.overlay).toMatchObject({ type: 'sessions', selectedIndex: 0 });
    expect(state.transcript).toEqual([]);
  });

  it('moves session picker selection with clamping', () => {
    const sessions: SessionMeta[] = Array.from({ length: 3 }, (_, index) => ({
      id: `session-${index}`,
      projectPath: '/tmp/project',
      model: 'glm-5',
      startTime: index,
      tokenCount: 0,
      cost: 0,
      messageCount: 1,
    }));
    const state = reduce([
      { type: 'showSessionPicker', request: { title: 'Resume', sessions } },
      { type: 'moveOverlaySelection', delta: 2 },
      { type: 'moveOverlaySelection', delta: 10 },
    ]);

    expect(state.overlay).toMatchObject({ type: 'sessions', selectedIndex: 2 });

    const movedBack = tuiUiReducer(state, { type: 'moveOverlaySelection', delta: -10 });
    expect(movedBack.overlay).toMatchObject({ type: 'sessions', selectedIndex: 0 });
  });

  it('stores tool permission picker outside transcript history', () => {
    const state = reduce([
      { type: 'appendTranscript', entry: { id: 'u1', role: 'user', content: 'before permission' } },
      {
        type: 'showPermissionRequest',
        request: {
          id: 'permission-1',
          name: 'exec_command',
          args: { command: 'npm publish --dry-run' },
          reason: 'requires confirmation',
        },
      },
      { type: 'moveOverlaySelection', delta: 1 },
      { type: 'moveOverlaySelection', delta: 10 },
    ]);

    expect(state.overlay).toMatchObject({ type: 'permission', selectedIndex: 1 });
    expect(state.transcript.map(entry => entry.content)).toEqual(['before permission']);
  });

  it('records structured runtime tool events outside transcript history', () => {
    const state = reduce([
      {
        type: 'toolStarted',
        event: { callId: 'call-1', name: 'read_file', args: { path: 'src/index.ts' } },
      },
      {
        type: 'toolFinished',
        event: {
          callId: 'call-1',
          name: 'read_file',
          args: { path: 'src/index.ts' },
          success: true,
          duration: 12,
          summary: 'read ok',
        },
      },
    ]);

    expect(state.transcript).toEqual([]);
    expect(state.runtimeToolEvents).toEqual([
      { type: 'started', callId: 'call-1', name: 'read_file', args: { path: 'src/index.ts' } },
      {
        type: 'finished',
        callId: 'call-1',
        name: 'read_file',
        args: { path: 'src/index.ts' },
        success: true,
        duration: 12,
        summary: 'read ok',
      },
    ]);
  });

  it('keeps command, file, and shortcut overlays outside transcript history', () => {
    const state = reduce([
      { type: 'showCommandPalette', query: 's', items: [{ value: 'status', label: '/status' }] },
      { type: 'moveOverlaySelection', delta: 5 },
      { type: 'showFilePicker', base: 'open ', query: 'src/', items: [{ value: 'src/cli.ts', label: 'file src/cli.ts' }] },
      { type: 'showShortcuts' },
    ]);

    expect(state.overlay).toEqual({ type: 'shortcuts' });
    expect(state.transcript).toEqual([]);
  });

  it('moves generic picker overlays with clamping', () => {
    const state = reduce([
      {
        type: 'showCommandPalette',
        query: '',
        items: [
          { value: 'help', label: '/help' },
          { value: 'status', label: '/status' },
        ],
      },
      { type: 'moveOverlaySelection', delta: 5 },
    ]);

    expect(state.overlay).toMatchObject({ type: 'commands', selectedIndex: 1 });
  });

  it('keeps transcript scrollback as state and snaps to bottom on new output', () => {
    const scrolled = reduce([
      { type: 'appendTranscript', entry: { id: 'm1', role: 'assistant', content: 'one' } },
      { type: 'appendTranscript', entry: { id: 'm2', role: 'assistant', content: 'two' } },
      { type: 'scrollTranscript', delta: 10 },
    ]);

    expect(scrolled.transcriptScrollOffset).toBe(10);

    const withNewOutput = tuiUiReducer(scrolled, {
      type: 'appendTranscript',
      entry: { id: 'm3', role: 'assistant', content: 'three' },
    });
    expect(withNewOutput.transcriptScrollOffset).toBe(0);
  });

  it('adapts the existing UiEventSink contract to pure state actions', () => {
    let state = initialTuiUiState;
    const sink = createTuiUiEventSink(
      action => {
        state = tuiUiReducer(state, action);
      },
      { idFactory: () => `fixed-${state.transcript.length + 1}` }
    );

    const assistantId = sink.append({ role: 'assistant', content: 'partial', live: true });
    sink.update(assistantId, { content: 'done' });
    sink.finalize(assistantId);
    sink.setStatus('ready');
    sink.setProcessing(false);

    expect(assistantId).toBe('fixed-1');
    expect(staticTuiTranscriptEntries(state)).toEqual([
      { id: 'fixed-1', role: 'assistant', content: 'done' },
    ]);
    expect(state.statusMessage).toBe('ready');
    expect(state.processing).toBe(false);
  });
});
