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

export interface SessionPickerRequest {
  sessions: SessionMeta[];
  title: string;
  showProject?: boolean;
  allProjects?: boolean;
  maxVisibleItems?: number;
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
  shutdown: () => Promise<void>;
}

export interface UiEventSink {
  append: (entry: Omit<TranscriptEntry, 'id'>) => string;
  update: (id: string, patch: Partial<Omit<TranscriptEntry, 'id'>>) => void;
  finalize: (id: string, patch?: Partial<Omit<TranscriptEntry, 'id'>>) => void;
  replaceTranscript: (entries: TranscriptEntry[]) => void;
  clearTranscript: () => void;
  setStatus: (message: string) => void;
  showSessionPicker: (request: SessionPickerRequest) => void;
  setProcessing: (processing: boolean) => void;
}
