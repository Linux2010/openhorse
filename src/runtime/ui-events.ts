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
}

export interface ToolPermissionRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
  reason?: string;
  abortSignal?: AbortSignal;
}

export interface RuntimeSessionAccessors {
  ensureSession: () => SessionMeta;
  setSession: (session: SessionMeta | null) => void;
  getSession: () => SessionMeta | null;
}

export interface OpenHorseInkRuntime extends RuntimeSessionAccessors {
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

export type OpenHorseUiRuntime = OpenHorseInkRuntime;

export interface UiEventSink {
  append: (entry: TranscriptAppendEntry) => string;
  update: (id: string, patch: Partial<Omit<TranscriptEntry, 'id'>>) => void;
  finalize: (id: string, patch?: Partial<Omit<TranscriptEntry, 'id'>>) => void;
  remove: (id: string) => void;
  replaceTranscript: (entries: TranscriptEntry[]) => void;
  clearTranscript: () => void;
  setStatus: (message: string) => void;
  showSessionPicker: (request: SessionPickerRequest) => void;
  showPermissionRequest?: (request: ToolPermissionRequest) => void;
  setProcessing: (processing: boolean) => void;
}
