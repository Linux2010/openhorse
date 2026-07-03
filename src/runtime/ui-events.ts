import type { OpenHorseRuntime } from '../init';
import type { Store } from '../framework/store';
import type { LLMService } from '../services/llm';
import type { OpenHorseCLIConfig } from '../services/config';
import type { SessionMeta } from '../services/session-storage';

export type TranscriptRole = 'user' | 'assistant' | 'tool' | 'system' | 'command' | 'error' | 'status';

export interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  content: string;
  title?: string;
}

export interface TranscriptAppendEntry extends Omit<TranscriptEntry, 'id'> {
  live?: boolean;
}

export interface SessionPickerRequest {
  sessions: SessionMeta[];
  title: string;
  showProject?: boolean;
  allProjects?: boolean;
  maxVisibleItems?: number;
  moreCount?: number;
}

export interface EditPreviewCandidate {
  index: number;
  line: number;
  match: string;
  contextBefore: string;
  contextAfter: string;
  isReplaceAll: boolean;
}

export interface EditPreviewRequest {
  path: string;
  newString: string;
  kind: 'exact' | 'fuzzy';
  strategy?: string;
  candidates: EditPreviewCandidate[];
  width?: number;
}

export interface UiRendererCapabilities {
  structuredPickers?: boolean;
  inlineProgress?: boolean;
  suppressLegacyTokenMeta?: boolean;
  extraAssistantSpacing?: boolean;
  suppressAbortNotice?: boolean;
}

export type ResolvedUiRendererCapabilities = Required<UiRendererCapabilities>;

const INTERACTIVE_RENDERER_CAPABILITIES: ResolvedUiRendererCapabilities = {
  structuredPickers: true,
  inlineProgress: true,
  suppressLegacyTokenMeta: true,
  extraAssistantSpacing: true,
  suppressAbortNotice: true,
};

const NON_INTERACTIVE_RENDERER_CAPABILITIES: ResolvedUiRendererCapabilities = {
  structuredPickers: false,
  inlineProgress: false,
  suppressLegacyTokenMeta: false,
  extraAssistantSpacing: false,
  suppressAbortNotice: false,
};

export function resolveUiRendererCapabilities(
  capabilities?: UiRendererCapabilities,
  renderer?: unknown
): ResolvedUiRendererCapabilities {
  const defaults = renderer == null || isInteractiveRendererName(renderer)
    ? INTERACTIVE_RENDERER_CAPABILITIES
    : NON_INTERACTIVE_RENDERER_CAPABILITIES;

  return {
    structuredPickers: capabilities?.structuredPickers ?? defaults.structuredPickers,
    inlineProgress: capabilities?.inlineProgress ?? defaults.inlineProgress,
    suppressLegacyTokenMeta: capabilities?.suppressLegacyTokenMeta ?? defaults.suppressLegacyTokenMeta,
    extraAssistantSpacing: capabilities?.extraAssistantSpacing ?? defaults.extraAssistantSpacing,
    suppressAbortNotice: capabilities?.suppressAbortNotice ?? defaults.suppressAbortNotice,
  };
}

function isInteractiveRendererName(renderer: unknown): boolean {
  return renderer === 'terminal'
    || renderer === 'tui'
    || renderer === 'ink'
    || renderer === 'legacy'
    || renderer === 'v2';
}

export interface ToolPermissionRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
  reason?: string;
  abortSignal?: AbortSignal;
}

export interface RuntimeToolStartedEvent {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface RuntimeToolFinishedEvent {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  success: boolean;
  duration: number;
  summary?: string;
  error?: string;
  outputBytes?: number;
  artifactRef?: { id: string; outputBytes: number };
}

export interface RuntimeSessionAccessors {
  ensureSession: () => SessionMeta;
  setSession: (session: SessionMeta | null) => void;
  getSession: () => SessionMeta | null;
}

export interface OpenHorseUiRuntime extends RuntimeSessionAccessors {
  cwd: string;
  version: string;
  config: OpenHorseCLIConfig;
  store: Store;
  llm: LLMService | null;
  runtime: OpenHorseRuntime;
  isConfigured: boolean;
  mcpReady?: Promise<void>;
  shutdown: () => Promise<void>;
}

/** @deprecated Use OpenHorseUiRuntime. Runtime context is shared by every renderer. */
export type OpenHorseInkRuntime = OpenHorseUiRuntime;

export interface UiEventSink {
  append: (entry: TranscriptAppendEntry) => string;
  update: (id: string, patch: Partial<Omit<TranscriptEntry, 'id'>>) => void;
  finalize: (id: string, patch?: Partial<Omit<TranscriptEntry, 'id'>>) => void;
  remove: (id: string) => void;
  replaceTranscript: (entries: TranscriptEntry[]) => void;
  clearTranscript: () => void;
  setStatus: (message: string) => void;
  showSessionPicker: (request: SessionPickerRequest) => void;
  showEditPreview: (request: EditPreviewRequest) => void;
  showPermissionRequest?: (request: ToolPermissionRequest) => void;
  toolStarted?: (event: RuntimeToolStartedEvent) => void;
  toolFinished?: (event: RuntimeToolFinishedEvent) => void;
  setProcessing: (processing: boolean) => void;
}
