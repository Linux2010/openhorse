import type {
  EditPreviewRequest,
  RuntimeToolFinishedEvent,
  RuntimeToolStartedEvent,
  SessionPickerRequest,
  ToolPermissionRequest,
  TranscriptAppendEntry,
  TranscriptEntry,
  UiEventSink,
} from './ui-events';

export type AgentRuntimeInput =
  | {
      type: 'submit';
      text: string;
      source?: 'composer' | 'picker' | 'programmatic';
      metadata?: Record<string, unknown>;
    }
  | {
      type: 'select_session';
      sessionId: string;
      allProjects?: boolean;
      source?: 'picker' | 'programmatic';
      metadata?: Record<string, unknown>;
    }
  | {
      type: 'permission_decision';
      requestId: string;
      approved: boolean;
      source?: 'picker' | 'keyboard' | 'programmatic';
      metadata?: Record<string, unknown>;
    }
  | {
      type: 'interrupt';
      source?: 'keyboard' | 'command' | 'programmatic';
      metadata?: Record<string, unknown>;
    }
  | {
      type: 'clear_exit_intent';
      metadata?: Record<string, unknown>;
    };

export type AgentRuntimeSubmitResult =
  | { type: 'empty' }
  | { type: 'exit_requested' }
  | { type: 'started' }
  | { type: 'revision_requested' }
  | { type: 'command_ignored' };

export type AgentRuntimeInterruptResult =
  | { type: 'exit_requested' }
  | { type: 'interrupted' }
  | { type: 'exit_prompt' };

export type AgentRuntimeInputResult =
  | AgentRuntimeSubmitResult
  | AgentRuntimeInterruptResult
  | { type: 'exit_intent_cleared' }
  | { type: 'permission_decision_recorded' }
  | { type: 'permission_decision_ignored' };

export type AgentRuntimeEvent =
  | { type: 'transcript_append'; entry: TranscriptAppendEntry }
  | { type: 'transcript_update'; id: string; patch: Partial<Omit<TranscriptEntry, 'id'>> }
  | { type: 'transcript_finalize'; id: string; patch?: Partial<Omit<TranscriptEntry, 'id'>> }
  | { type: 'transcript_remove'; id: string }
  | { type: 'transcript_replace'; entries: TranscriptEntry[] }
  | { type: 'transcript_clear' }
  | { type: 'status_changed'; message: string }
  | { type: 'session_picker_requested'; request: SessionPickerRequest }
  | { type: 'edit_preview_requested'; request: EditPreviewRequest }
  | { type: 'permission_requested'; request: ToolPermissionRequest }
  | { type: 'tool_started'; event: RuntimeToolStartedEvent }
  | { type: 'tool_finished'; event: RuntimeToolFinishedEvent }
  | { type: 'processing_changed'; processing: boolean };

export interface AgentRuntimeEventSink {
  emit(event: AgentRuntimeEvent): string | void;
}

export function emitToUiEventSink(events: UiEventSink, event: AgentRuntimeEvent): string | void {
  switch (event.type) {
    case 'transcript_append':
      return events.append(event.entry);
    case 'transcript_update':
      events.update(event.id, event.patch);
      return undefined;
    case 'transcript_finalize':
      events.finalize(event.id, event.patch);
      return undefined;
    case 'transcript_remove':
      events.remove(event.id);
      return undefined;
    case 'transcript_replace':
      events.replaceTranscript(event.entries);
      return undefined;
    case 'transcript_clear':
      events.clearTranscript();
      return undefined;
    case 'status_changed':
      events.setStatus(event.message);
      return undefined;
    case 'session_picker_requested':
      events.showSessionPicker(event.request);
      return undefined;
    case 'edit_preview_requested':
      events.showEditPreview(event.request);
      return undefined;
    case 'permission_requested':
      events.showPermissionRequest?.(event.request);
      return undefined;
    case 'tool_started':
      events.toolStarted?.(event.event);
      return undefined;
    case 'tool_finished':
      events.toolFinished?.(event.event);
      return undefined;
    case 'processing_changed':
      events.setProcessing(event.processing);
      return undefined;
  }
}

export function createUiEventSinkFromAgentRuntimeEvents(sink: AgentRuntimeEventSink): UiEventSink {
  let nextSyntheticId = 1;

  return {
    append: entry => {
      const id = sink.emit({ type: 'transcript_append', entry });
      return typeof id === 'string' && id ? id : `runtime-entry-${nextSyntheticId++}`;
    },
    update: (id, patch) => {
      sink.emit({ type: 'transcript_update', id, patch });
    },
    finalize: (id, patch) => {
      sink.emit({ type: 'transcript_finalize', id, patch });
    },
    remove: id => {
      sink.emit({ type: 'transcript_remove', id });
    },
    replaceTranscript: entries => {
      sink.emit({ type: 'transcript_replace', entries });
    },
    clearTranscript: () => {
      sink.emit({ type: 'transcript_clear' });
    },
    setStatus: message => {
      sink.emit({ type: 'status_changed', message });
    },
    showSessionPicker: request => {
      sink.emit({ type: 'session_picker_requested', request });
    },
    showEditPreview: request => {
      sink.emit({ type: 'edit_preview_requested', request });
    },
    showPermissionRequest: request => {
      sink.emit({ type: 'permission_requested', request });
    },
    toolStarted: event => {
      sink.emit({ type: 'tool_started', event });
    },
    toolFinished: event => {
      sink.emit({ type: 'tool_finished', event });
    },
    setProcessing: processing => {
      sink.emit({ type: 'processing_changed', processing });
    },
  };
}

export function createAgentRuntimeEventSinkFromUiEvents(events: UiEventSink): AgentRuntimeEventSink {
  return {
    emit: event => emitToUiEventSink(events, event),
  };
}
