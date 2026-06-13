import type { Message } from '../services/llm';
import { getModelContextWindow } from '../services/model-context';
import { renderContextCapsule } from './capsule';
import type { HarnessConfig, HarnessState } from './types';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateByChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 80)) + '\n[truncated by Context Harness]';
}

export function renderHarnessContext(state: HarnessState, modelId: string, config: HarnessConfig = {}): string {
  const contract = state.contract;
  if (!contract && state.ledger.length === 0 && !state.capsule) return '';

  const contextWindow = getModelContextWindow(modelId);
  const evidenceBudgetRatio = config.evidenceBudgetRatio ?? 0.3;
  const maxChars = Math.max(2000, Math.floor(contextWindow * evidenceBudgetRatio * 4 * 0.08));

  const lines: string[] = ['[OpenHorse Context Harness]'];
  if (contract) {
    lines.push('', 'Task Contract:');
    lines.push(`- Objective: ${contract.objective}`);
    for (const req of contract.requirements.slice(0, 8)) {
      lines.push(`- Requirement: ${req}`);
    }
    for (const item of contract.successCriteria.slice(0, 6)) {
      lines.push(`- Success: ${item}`);
    }
    for (const item of contract.prohibitions.slice(0, 6)) {
      lines.push(`- Prohibition: ${item}`);
    }
  }

  if (state.capsule) {
    lines.push('', renderContextCapsule(state.capsule));
  }

  const evidence = [...state.ledger]
    .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
    .slice(0, 10);
  if (evidence.length > 0) {
    lines.push('', 'Relevant Evidence:');
    for (const entry of evidence) {
      lines.push(`- [${entry.type}] ${entry.content}`);
    }
  }

  lines.push('', 'Use this context to stay on the current task. Do not claim verification unless it is listed above or produced by a tool result in this turn.');
  const rendered = lines.join('\n');
  return truncateByChars(rendered, Math.max(maxChars, estimateTokens(rendered) * 2));
}

export function assembleHarnessMessages(
  messages: Message[],
  state: HarnessState,
  modelId: string,
  config: HarnessConfig = {},
): Message[] {
  if (config.enabled === false) return messages;

  const harnessContext = renderHarnessContext(state, modelId, config);
  if (!harnessContext.trim()) return messages;

  const cloned = messages.map(message => ({ ...message }));
  const systemIndex = cloned.findIndex(message => message.role === 'system');
  if (systemIndex >= 0) {
    cloned[systemIndex] = {
      ...cloned[systemIndex],
      content: `${cloned[systemIndex].content}\n\n---\n${harnessContext}`,
    };
  } else {
    cloned.unshift({ role: 'system', content: harnessContext });
  }

  return cloned;
}

