import type {
  SessionPickerRequest,
  ToolPermissionRequest,
  TranscriptAppendEntry,
  TranscriptEntry,
  UiEventSink,
} from '../runtime/ui-events';
import type { TuiPickerItem } from './pickers';

export interface TuiPromptState {
  value: string;
  cursor: number;
}

export interface TuiTranscriptRecord extends TranscriptEntry {
  finalized: boolean;
}

export type TuiOverlayState =
  | { type: 'sessions'; request: SessionPickerRequest; selectedIndex: number }
  | { type: 'permission'; request: ToolPermissionRequest; selectedIndex: number }
  | { type: 'commands'; query: string; items: TuiPickerItem[]; selectedIndex: number }
  | { type: 'files'; base: string; query: string; items: TuiPickerItem[]; selectedIndex: number }
  | { type: 'shortcuts' }
  | null;

export interface TuiUiState {
  transcript: TuiTranscriptRecord[];
  staticTranscriptCount: number;
  transcriptGeneration: number;
  transcriptScrollOffset: number;
  prompt: TuiPromptState;
  statusMessage: string;
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
  | { type: 'setProcessing'; processing: boolean }
  | { type: 'showSessionPicker'; request: SessionPickerRequest }
  | { type: 'showPermissionRequest'; request: ToolPermissionRequest }
  | { type: 'showCommandPalette'; query: string; items: TuiPickerItem[] }
  | { type: 'showFilePicker'; base: string; query: string; items: TuiPickerItem[] }
  | { type: 'showShortcuts' }
  | { type: 'moveOverlaySelection'; delta: number }
  | { type: 'closeOverlay' };

export const initialTuiUiState: TuiUiState = {
  transcript: [],
  staticTranscriptCount: 0,
  transcriptGeneration: 0,
  transcriptScrollOffset: 0,
  prompt: { value: '', cursor: 0 },
  statusMessage: '',
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
          },
        ],
      });
    }

    case 'updateTranscript':
      return {
        ...state,
        transcriptScrollOffset: 0,
        transcript: state.transcript.map(entry => (
          entry.id === action.id ? { ...entry, ...action.patch } : entry
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
        transcript: action.entries.map(entry => ({ ...entry, finalized: true })),
        staticTranscriptCount: action.entries.length,
        transcriptGeneration: state.transcriptGeneration + 1,
        transcriptScrollOffset: 0,
      };

    case 'clearTranscript':
      return {
        ...state,
        transcript: [],
        staticTranscriptCount: 0,
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
      return {
        ...state,
        prompt: {
          value: action.value,
          cursor: clampCursor(action.value, action.cursor ?? action.value.length),
        },
      };

    case 'setStatus':
      return { ...state, statusMessage: action.message };

    case 'setProcessing':
      return { ...state, processing: action.processing };

    case 'showSessionPicker':
      return {
        ...state,
        overlay: { type: 'sessions', request: action.request, selectedIndex: 0 },
      };

    case 'showPermissionRequest':
      return {
        ...state,
        overlay: { type: 'permission', request: action.request, selectedIndex: 0 },
      };

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
  return state.transcript.slice(0, state.staticTranscriptCount).map(stripRecord);
}

export function liveTuiTranscriptEntries(state: TuiUiState): TranscriptEntry[] {
  return state.transcript.slice(state.staticTranscriptCount).map(stripRecord);
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
    showPermissionRequest: request => dispatch({ type: 'showPermissionRequest', request }),
    setProcessing: processing => dispatch({ type: 'setProcessing', processing }),
  };
}

function isLiveTranscriptAppend(entry: TranscriptAppendEntry): boolean {
  return entry.live === true || entry.role === 'tool';
}

function commitStaticTranscriptPrefix(state: TuiUiState): TuiUiState {
  let staticTranscriptCount = state.staticTranscriptCount;
  while (
    staticTranscriptCount < state.transcript.length
    && state.transcript[staticTranscriptCount]?.finalized
  ) {
    staticTranscriptCount += 1;
  }
  return staticTranscriptCount === state.staticTranscriptCount
    ? state
    : { ...state, staticTranscriptCount };
}

function recomputeStaticTranscriptPrefix(state: TuiUiState): TuiUiState {
  let staticTranscriptCount = 0;
  while (
    staticTranscriptCount < state.transcript.length
    && state.transcript[staticTranscriptCount]?.finalized
  ) {
    staticTranscriptCount += 1;
  }
  return { ...state, staticTranscriptCount };
}

function stripRecord(entry: TuiTranscriptRecord): TranscriptEntry {
  const { finalized: _finalized, ...rest } = entry;
  return rest;
}

function overlayItemCount(overlay: Exclude<TuiOverlayState, null | { type: 'shortcuts' }>): number {
  if (overlay.type === 'sessions') return overlay.request.sessions.length;
  if (overlay.type === 'permission') return 2;
  return overlay.items.length;
}

function clampCursor(value: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return value.length;
  return Math.min(Math.max(0, Math.floor(cursor)), value.length);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
