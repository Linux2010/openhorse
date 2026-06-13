import type { ContextCapsule, ContextLedgerEntry, PlanStep, TaskContract } from './types';

function metadataString(entry: ContextLedgerEntry, key: string): string | undefined {
  const value = entry.metadata?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

function metadataBool(entry: ContextLedgerEntry, key: string): boolean | undefined {
  const value = entry.metadata?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function compactLine(text: string, max = 160): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? normalized.slice(0, max - 3) + '...' : normalized;
}

export function createContextCapsule(
  contract: TaskContract | undefined,
  entries: ContextLedgerEntry[],
): ContextCapsule {
  const now = Date.now();
  const keyFacts = [...entries]
    .filter(entry => entry.importance >= 4 || entry.type === 'user_requirement')
    .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
    .slice(0, 12);

  const todoEntries = entries.filter(entry => entry.type === 'todo');
  const currentPlan: PlanStep[] = todoEntries.slice(0, 8).map((entry, index) => ({
    id: entry.id,
    title: compactLine(entry.content),
    status: index === 0 ? 'in_progress' : 'pending',
  }));

  const verificationEntries = entries.filter(entry => entry.type === 'verification' || entry.type === 'test_result');
  const passed = verificationEntries
    .filter(entry => metadataBool(entry, 'success') === true)
    .map(entry => compactLine(entry.content));
  const failed = verificationEntries
    .filter(entry => metadataBool(entry, 'success') === false)
    .map(entry => compactLine(entry.content));
  const commandsRun = unique(verificationEntries.map(entry => metadataString(entry, 'command') || '').filter(Boolean));
  const changedFiles = unique(entries.map(entry => metadataString(entry, 'changedFile') || metadataString(entry, 'path') || '').filter(Boolean));
  const completed = entries
    .filter(entry => entry.type === 'decision' || (entry.type === 'tool_result' && metadataBool(entry, 'success') === true))
    .slice(-8)
    .map(entry => compactLine(entry.content));
  const openTodos = currentPlan.length > 0
    ? currentPlan.filter(step => step.status !== 'completed').map(step => step.title)
    : (contract?.successCriteria ?? []).map(item => compactLine(item));

  return {
    contract,
    currentPlan,
    completed,
    openTodos,
    keyFacts,
    changedFiles,
    verification: {
      commandsRun,
      passed,
      failed,
      warnings: entries.filter(entry => entry.type === 'risk' || entry.type === 'blocker').slice(-5).map(entry => compactLine(entry.content)),
    },
    nextAction: openTodos[0] || (contract ? `Continue: ${contract.objective}` : 'Continue the current task.'),
    createdAt: now,
    updatedAt: now,
  };
}

export function renderContextCapsule(capsule: ContextCapsule): string {
  const contract = capsule.contract;
  const lines: string[] = ['## Context Capsule'];

  if (contract) {
    lines.push('', `Objective: ${contract.objective}`);
    if (contract.requirements.length > 0) {
      lines.push('Requirements:');
      lines.push(...contract.requirements.map(item => `- ${item}`));
    }
    if (contract.prohibitions.length > 0) {
      lines.push('Prohibitions:');
      lines.push(...contract.prohibitions.map(item => `- ${item}`));
    }
  }

  if (capsule.openTodos.length > 0) {
    lines.push('', 'Open todos:');
    lines.push(...capsule.openTodos.map(item => `- ${item}`));
  }

  if (capsule.keyFacts.length > 0) {
    lines.push('', 'Key facts:');
    lines.push(...capsule.keyFacts.slice(0, 8).map(entry => `- ${entry.content}`));
  }

  if (capsule.verification.passed.length > 0 || capsule.verification.failed.length > 0) {
    lines.push('', 'Verification:');
    lines.push(...capsule.verification.passed.map(item => `- Passed: ${item}`));
    lines.push(...capsule.verification.failed.map(item => `- Failed: ${item}`));
  }

  if (capsule.changedFiles.length > 0) {
    lines.push('', `Changed files: ${capsule.changedFiles.join(', ')}`);
  }

  lines.push('', `Next action: ${capsule.nextAction}`);
  return lines.join('\n');
}

