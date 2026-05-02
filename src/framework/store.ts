/**
 * openhorse - Centralized State Store
 *
 * Simple publish-subscribe state management.
 * No React dependency — just state + listeners.
 */

import type { Message } from '../services/llm';
import type { OpenHorseTool } from './tool';
import type { OpenHorseCLIConfig } from '../services/config';

// ============================================================================
// 状态结构
// ============================================================================

export interface AppState {
  config: OpenHorseCLIConfig;
  tools: OpenHorseTool[];
  conversationHistory: Message[];
  isProcessing: boolean;
  currentModel: string;
  tokenUsage: { promptTokens: number; completionTokens: number } | null;
}

// ============================================================================
// Store 类
// ============================================================================

type Listener = (state: AppState) => void;

export class Store {
  private state: AppState;
  private listeners: Set<Listener> = new Set();

  constructor(initial: Omit<AppState, 'conversationHistory' | 'isProcessing' | 'tokenUsage'> & Partial<AppState>) {
    this.state = {
      conversationHistory: [],
      isProcessing: false,
      tokenUsage: null,
      ...initial,
    } as AppState;
  }

  /** Get the current state snapshot */
  getSnapshot(): AppState {
    return this.state;
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Update state with a partial object and notify listeners */
  setState(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  /** Convenience: reset conversation history */
  resetConversation(): void {
    this.setState({
      conversationHistory: [],
      tokenUsage: null,
    });
  }

  /** Convenience: set processing state */
  setProcessing(val: boolean): void {
    this.setState({ isProcessing: val });
  }

  /** Convenience: append a message to conversation history */
  addMessage(msg: Message): void {
    this.setState({
      conversationHistory: [...this.state.conversationHistory, msg],
    });
  }

  /** Convenience: update token usage */
  setTokenUsage(usage: { promptTokens: number; completionTokens: number }): void {
    this.setState({ tokenUsage: usage });
  }
}
