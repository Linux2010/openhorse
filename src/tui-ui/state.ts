import type {
  EditPreviewRequest,
  RuntimeSubtaskEvent,
  RuntimeToolFinishedEvent,
  RuntimeToolStartedEvent,
  SessionPickerRequest,
  ToolPermissionRequest,
  TranscriptAppendEntry,
  TranscriptEntry,
  UiEventSink,
} from '../runtime/ui-events';
import {
  createPromptState,
  subtaskEventToTimelineEntry,
  type PromptState,
  type StatusSnapshot,
  type SubtaskTimelineEntry,
} from '../runtime/ui-view-model';
import type { TuiPickerItem } from './pickers';

/** Maximum subtask timeline entries (bounded for long-session safety). */
const MAX_SUBTASK_TIMELINE = 100;

export type TuiPromptState = Pick<PromptState, 'value' | 'cursor'>;

export interface TuiTranscriptRecord extends TranscriptEntry {
  finalized: boolean;
  revision: number;
}

/** Structured status state (replaces renderer-local string concatenation). */
export interface TuiStatusState {
  phase: 'ready' | 'running' | 'error' | 'interrupted';
  snapshot: StatusSnapshot | null;
  message?: string;
  activeTools: number;
  activeSubtasks: number;
  committedTranscriptEntries: number;
}

export type TuiRuntimeToolEvent =
  | ({ type: 'started' } & RuntimeToolStartedEvent)
  | ({ type: 'finished' } & RuntimeToolFinishedEvent);

export type TuiOverlayState =
  | { type: 'sessions'; request: SessionPickerRequest; selectedIndex: number }
  | { type: 'edit'; request: EditPreviewRequest; selectedIndex: number }
  | { type: 'permission'; request: ToolPermissionRequest; selectedIndex: number }
  | { type: 'commands'; query: string; items: TuiPickerItem[]; selectedIndex: number }
  | { type: 'files'; base: string; query: string; items: TuiPickerItem[]; selectedIndex: number }
  | { type: 'shortcuts' }
  | null;

export interface TuiUiState {
  transcript: TuiTranscriptRecord[];
  runtimeToolEvents: TuiRuntimeToolEvent[];
  /** R8: typed subagent timeline, keyed by taskId (last write wins). */
  subtaskTimeline: SubtaskTimelineEntry[];
  committableTranscriptCount: number;
  queuedTranscriptCount: number;
  committedTranscriptCount: number;
  transcriptGeneration: number;
  transcriptScrollOffset: number;
  prompt: TuiPromptState;
  statusMessage: string;
  /** Structured status (v0.2.21 slice 5). */
  statusState: TuiStatusState;
  processing: boolean;
  overlay: TuiOverlayState;
}

export type TuiUiAction =
  | { type: 'appendTranscript'; entry: TranscriptAppendEntry & { id: string } }
  | { type: 'updateTranscript'; id: string; patch: Partial<Omit<TranscriptEntry, 'id'>> }
  | { type: 'finalizeTranscript'; id: string; patch?: Partial<Omit<TranscriptEntry, 'id'>> }
  | { type: 'removeTranscript'; id: string }
  | { type: 'replaceTranscript'; entries: TranscriptEntry[] }
  | { type: 'clearTranscript' }
  | { type: 'scrollTranscript'; delta: number }
  | { type: 'setPrompt'; value: string; cursor?: number }
  | { type: 'setStatus'; message: string }
  | { type: 'setStatusSnapshot'; snapshot: StatusSnapshot; phase?: TuiStatusState['phase']; message?: string }
  | { type: 'setProcessing'; processing: boolean }
  | { type: 'showSessionPicker'; request: SessionPickerRequest }
  | { type: 'showEditPreview'; request: EditPreviewRequest }
  | { type: 'showPermissionRequest'; request: ToolPermissionRequest }
  | { type: 'toolStarted'; event: RuntimeToolStartedEvent }
  | { type: 'toolFinished'; event: RuntimeToolFinishedEvent }
  | { type: 'subtaskEvent'; event: RuntimeSubtaskEvent }
  | { type: 'showCommandPalette'; query: string; items: TuiPickerItem[] }
  | { type: 'showFilePicker'; base: string; query: string; items: TuiPickerItem[] }
  | { type: 'showShortcuts' }
  | { type: 'moveOverlaySelection'; delta: number }
  | { type: 'closeOverlay' };

export const initialTuiUiState: TuiUiState = {
  transcript: [],
  runtimeToolEvents: [],
  subtaskTimeline: [],
  committableTranscriptCount: 0,
  queuedTranscriptCount: 0,
  committedTranscriptCount: 0,
  transcriptGeneration: 0,
  transcriptScrollOffset: 0,
  prompt: { value: '', cursor: 0 },
  statusMessage: '',
  statusState: {
    phase: 'ready',
    snapshot: null,
    activeTools: 0,
    activeSubtasks: 0,
    committedTranscriptEntries: 0,
  },
  processing: false,
  overlay: null,
};

export function tuiUiReducer(state: TuiUiState, action: TuiUiAction): TuiUiState {
  switch (action.type) {
    case 'appendTranscript': {
      const { live: _live, ...entry } = action.entry;
      return commitStaticTranscriptPrefix({
        ...state,
        transcriptScrollOffset: 0,
        transcript: [
          ...state.transcript,
          {
            ...entry,
            finalized: !isLiveTranscriptAppend(action.entry),
            revision: 1,
          },
        ],
      });
    }

    case 'updateTranscript':
      return {
        ...state,
        transcriptScrollOffset: 0,
        transcript: state.transcript.map(entry => (
          entry.id === action.id
            ? { ...entry, ...action.patch, revision: entry.revision + 1 }
            : entry
        )),
      };

    case 'finalizeTranscript':
      return commitStaticTranscriptPrefix({
        ...state,
        transcriptScrollOffset: 0,
        transcript: state.transcript.map(entry => (
          entry.id === action.id
            ? { ...entry, ...action.patch, finalized: true }
            : entry
        )),
      });

    case 'removeTranscript':
      return recomputeStaticTranscriptPrefix({
        ...state,
        transcriptScrollOffset: 0,
        transcript: state.transcript.filter(entry => entry.id !== action.id),
      });

    case 'replaceTranscript':
      return {
        ...state,
        transcript: action.entries.map(entry => ({ ...entry, finalized: true, revision: 1 })),
        committableTranscriptCount: action.entries.length,
        queuedTranscriptCount: 0,
        committedTranscriptCount: 0,
        transcriptGeneration: state.transcriptGeneration + 1,
        transcriptScrollOffset: 0,
      };

    case 'clearTranscript':
      return {
        ...state,
        transcript: [],
        committableTranscriptCount: 0,
        queuedTranscriptCount: 0,
        committedTranscriptCount: 0,
        transcriptGeneration: state.transcriptGeneration + 1,
        transcriptScrollOffset: 0,
      };

    case 'scrollTranscript':
      return {
        ...state,
        transcriptScrollOffset: clampNumber(
          state.transcriptScrollOffset + action.delta,
          0,
          Number.MAX_SAFE_INTEGER
        ),
      };

    case 'setPrompt':
      {
        const prompt = createPromptState({
          value: action.value,
          cursor: action.cursor ?? action.value.length,
        });
        return {
          ...state,
          prompt: {
            value: prompt.value,
            cursor: prompt.cursor,
          },
        };
      }

    case 'setStatus':
      return {
        ...state,
        statusMessage: action.message,
        statusState: { ...state.statusState, message: action.message },
      };

    case 'setStatusSnapshot': {
      const activeTools = countActiveTools(state.runtimeToolEvents);
      const activeSubtasks = countActiveSubtasks(state.subtaskTimeline);
      return {
        ...state,
        statusState: {
          phase: action.phase ?? state.statusState.phase,
          snapshot: action.snapshot,
          message: action.message ?? state.statusState.message,
          activeTools,
          activeSubtasks,
          committedTranscriptEntries: state.committedTranscriptCount,
        },
      };
    }

    case 'setProcessing':
      return {
        ...state,
        processing: action.processing,
        statusState: {
          ...state.statusState,
          phase: action.processing ? 'running' : 'ready',
        },
      };

    case 'showSessionPicker':
      return {
        ...state,
        overlay: { type: 'sessions', request: action.request, selectedIndex: 0 },
      };

    case 'showEditPreview':
      return {
        ...state,
        overlay: { type: 'edit', request: action.request, selectedIndex: 0 },
      };

    case 'showPermissionRequest':
      return {
        ...state,
        overlay: { type: 'permission', request: action.request, selectedIndex: 0 },
      };

    case 'toolStarted': {
      const next = appendRuntimeToolEvent(state, { type: 'started', ...action.event });
      return updateStatusCounts(next);
    }

    case 'toolFinished': {
      const next = appendRuntimeToolEvent(state, { type: 'finished', ...action.event });
      return updateStatusCounts(next);
    }

    case 'subtaskEvent': {
      // R8: update the typed timeline, keyed by taskId (last write wins so
      // state advances queued -> running -> terminal without duplicates).
      const entry = subtaskEventToTimelineEntry(action.event);
      const existing = state.subtaskTimeline.filter(e => e.taskId !== entry.taskId);
      let timeline = [...existing, entry];
      // Cap to prevent unbounded growth in long sessions.
      if (timeline.length > MAX_SUBTASK_TIMELINE) {
        timeline = timeline.slice(timeline.length - MAX_SUBTASK_TIMELINE);
      }
      const next = { ...state, subtaskTimeline: timeline };
      return updateStatusCounts(next);
    }

    case 'showCommandPalette':
      return {
        ...state,
        overlay: {
          type: 'commands',
          query: action.query,
          items: action.items,
          selectedIndex: clampNumber(
            state.overlay?.type === 'commands' ? state.overlay.selectedIndex : 0,
            0,
            Math.max(0, action.items.length - 1)
          ),
        },
      };

    case 'showFilePicker':
      return {
        ...state,
        overlay: {
          type: 'files',
          base: action.base,
          query: action.query,
          items: action.items,
          selectedIndex: clampNumber(
            state.overlay?.type === 'files' ? state.overlay.selectedIndex : 0,
            0,
            Math.max(0, action.items.length - 1)
          ),
        },
      };

    case 'showShortcuts':
      return { ...state, overlay: { type: 'shortcuts' } };

    case 'moveOverlaySelection': {
      if (!state.overlay || state.overlay.type === 'shortcuts') return state;
      const lastIndex = Math.max(0, overlayItemCount(state.overlay) - 1);
      const selectedIndex = clampNumber(state.overlay.selectedIndex + action.delta, 0, lastIndex);
      return {
        ...state,
        overlay: { ...state.overlay, selectedIndex },
      };
    }

    case 'closeOverlay':
      return { ...state, overlay: null };
  }
}

export function staticTuiTranscriptEntries(state: TuiUiState): TranscriptEntry[] {
  return state.transcript.slice(0, state.committableTranscriptCount).map(stripRecord);
}

export function liveTuiTranscriptEntries(state: TuiUiState): TranscriptEntry[] {
  return state.transcript.slice(state.committableTranscriptCount).map(stripRecord);
}

/** Entries ready to commit (committable but not yet queued). */
export function pendingCommitEntries(state: TuiUiState): TranscriptEntry[] {
  return state.transcript.slice(state.queuedTranscriptCount, state.committableTranscriptCount).map(stripRecord);
}

/** Advance the queued boundary after enqueueing a commit batch. */
export function markTranscriptQueued(state: TuiUiState, count: number): TuiUiState {
  return { ...state, queuedTranscriptCount: state.queuedTranscriptCount + count };
}

/** Advance the committed boundary after successful surface write. */
export function markTranscriptCommitted(state: TuiUiState, count: number): TuiUiState {
  return { ...state, committedTranscriptCount: state.committedTranscriptCount + count };
}

export function createTuiUiEventSink(
  dispatch: (action: TuiUiAction) => void,
  options: { idFactory?: () => string } = {}
): UiEventSink {
  let nextId = 1;
  const idFactory = options.idFactory ?? (() => `tui-${nextId++}`);

  return {
    append: entry => {
      const id = idFactory();
      dispatch({ type: 'appendTranscript', entry: { id, ...entry } });
      return id;
    },
    update: (id, patch) => dispatch({ type: 'updateTranscript', id, patch }),
    finalize: (id, patch) => dispatch({ type: 'finalizeTranscript', id, patch }),
    remove: id => dispatch({ type: 'removeTranscript', id }),
    replaceTranscript: entries => dispatch({ type: 'replaceTranscript', entries }),
    clearTranscript: () => dispatch({ type: 'clearTranscript' }),
    setStatus: message => dispatch({ type: 'setStatus', message }),
    showSessionPicker: request => dispatch({ type: 'showSessionPicker', request }),
    showEditPreview: request => dispatch({ type: 'showEditPreview', request }),
    showPermissionRequest: request => dispatch({ type: 'showPermissionRequest', request }),
    toolStarted: event => dispatch({ type: 'toolStarted', event }),
    toolFinished: event => dispatch({ type: 'toolFinished', event }),
    subtaskEvent: event => dispatch({ type: 'subtaskEvent', event }),
    setProcessing: processing => dispatch({ type: 'setProcessing', processing }),
  };
}

function appendRuntimeToolEvent(state: TuiUiState, event: TuiRuntimeToolEvent): TuiUiState {
  return {
    ...state,
    runtimeToolEvents: [...state.runtimeToolEvents, event].slice(-100),
  };
}

/** Count tools with a 'started' event but no matching 'finished' event. */
function countActiveTools(events: TuiRuntimeToolEvent[]): number {
  const finished = new Set<string>();
  let active = 0;
  for (const ev of events) {
    if (ev.type === 'finished') {
      finished.add(ev.callId);
    }
  }
  for (const ev of events) {
    if (ev.type === 'started' && !finished.has(ev.callId)) {
      active += 1;
    }
  }
  return active;
}

/** Count subtasks in a non-terminal state (queued/running). */
function countActiveSubtasks(timeline: SubtaskTimelineEntry[]): number {
  return timeline.filter(e => e.state === 'queued' || e.state === 'running').length;
}

/** Recompute status counts after tool/subtask state changes. */
function updateStatusCounts(state: TuiUiState): TuiUiState {
  return {
    ...state,
    statusState: {
      ...state.statusState,
      activeTools: countActiveTools(state.runtimeToolEvents),
      activeSubtasks: countActiveSubtasks(state.subtaskTimeline),
      committedTranscriptEntries: state.committedTranscriptCount,
    },
  };
}

function isLiveTranscriptAppend(entry: TranscriptAppendEntry): boolean {
  return entry.live === true || entry.role === 'tool';
}

function commitStaticTranscriptPrefix(state: TuiUiState): TuiUiState {
  let committableTranscriptCount = state.committableTranscriptCount;
  while (
    committableTranscriptCount < state.transcript.length
    && state.transcript[committableTranscriptCount]?.finalized
  ) {
    committableTranscriptCount += 1;
  }
  return committableTranscriptCount === state.committableTranscriptCount
    ? state
    : { ...state, committableTranscriptCount };
}

function recomputeStaticTranscriptPrefix(state: TuiUiState): TuiUiState {
  let committableTranscriptCount = 0;
  while (
    committableTranscriptCount < state.transcript.length
    && state.transcript[committableTranscriptCount]?.finalized
  ) {
    committableTranscriptCount += 1;
  }
  return { ...state, committableTranscriptCount };
}

function stripRecord(entry: TuiTranscriptRecord): TranscriptEntry {
  const { finalized: _finalized, revision: _revision, ...rest } = entry;
  return rest;
}

function overlayItemCount(overlay: Exclude<TuiOverlayState, null | { type: 'shortcuts' }>): number {
  if (overlay.type === 'sessions') return overlay.request.sessions.length;
  if (overlay.type === 'permission') return 2;
  if (overlay.type === 'edit') return overlay.request.candidates.length;
  return overlay.items.length;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
