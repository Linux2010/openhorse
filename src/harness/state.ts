import { createContextCapsule } from './capsule';
import { createTaskContract } from './contract';
import { buildEvidenceIndex } from './evidence';
import type { HarnessState } from './types';

interface TranscriptMessage {
  role: string;
  content: string;
}

function unique(items: string[]): string[] {
  return [...new Set(items.map(item => item.trim()).filter(Boolean))];
}

function latestRealUserMessage(messages?: TranscriptMessage[]): string | undefined {
  const users = (messages ?? [])
    .filter(message => message.role === 'user' && message.content.trim())
    .filter(message => !message.content.startsWith('[Context Summary]'))
    .filter(message => !message.content.startsWith('[OpenHorse Context State v2]'))
    .filter(message => !message.content.startsWith('## Context Capsule'));
  return users[users.length - 1]?.content;
}

function firstRealUserMessage(messages?: TranscriptMessage[]): string | undefined {
  return (messages ?? [])
    .filter(message => message.role === 'user' && message.content.trim())
    .filter(message => !message.content.startsWith('[Context Summary]'))
    .filter(message => !message.content.startsWith('[OpenHorse Context State v2]'))
    .filter(message => !message.content.startsWith('## Context Capsule'))[0]?.content;
}

export function upgradeHarnessState(
  state?: Partial<HarnessState> | null,
  options: { cwd?: string; messages?: TranscriptMessage[] } = {},
): HarnessState {
  const now = Date.now();
  const ledger = state?.ledger ?? [];
  const diagnostics = [...(state?.diagnostics ?? [])];
  const firstUser = firstRealUserMessage(options.messages);
  const lastUser = latestRealUserMessage(options.messages);
  const contract = state?.contract ?? (firstUser ? createTaskContract(firstUser, options.cwd ?? process.cwd()) : undefined);
  const taskEpoch = Math.max(1, state?.taskEpoch ?? (contract ? 1 : 1));
  const rootObjective = state?.rootObjective ?? contract?.objective ?? (firstUser ? firstUser.trim().slice(0, 180) : undefined);
  const activeInstruction = state?.activeInstruction ?? contract?.userIntent ?? lastUser ?? rootObjective;
  const turnSummaries = state?.turnSummaries ?? [];
  const evidenceIndex = buildEvidenceIndex({
    ledger,
    turnSummaries,
    existing: state?.evidenceIndex,
  });
  const capsule = state?.capsule ?? (contract || ledger.length > 0 ? createContextCapsule(contract, ledger) : undefined);

  if (state && state.version !== 2) {
    diagnostics.push('upgraded legacy harness state to v2');
  }
  if (lastUser && activeInstruction && lastUser !== activeInstruction && !lastUser.includes(activeInstruction) && !activeInstruction.includes(lastUser)) {
    diagnostics.push('latest transcript user message differs from active instruction; using stored active instruction');
  }
  if (rootObjective && firstUser && !firstUser.includes(rootObjective) && !rootObjective.includes(firstUser.slice(0, 40))) {
    diagnostics.push('root objective does not exactly match the first transcript user message; preserving harness root objective');
  }

  return {
    version: 2,
    contract,
    ledger,
    capsule,
    completionBlockCount: state?.completionBlockCount ?? 0,
    taskEpoch,
    rootObjective,
    activeInstruction,
    intentHistory: state?.intentHistory ?? [],
    activeConstraints: unique([...(state?.activeConstraints ?? []), ...(contract?.constraints ?? [])]),
    nonGoals: unique([...(state?.nonGoals ?? []), ...(contract?.prohibitions ?? [])]),
    openQuestions: state?.openQuestions ?? [],
    evidenceIndex,
    turnSummaries,
    promptAssemblyStats: state?.promptAssemblyStats,
    diagnostics: unique(diagnostics).slice(-20),
    reconciledAt: options.messages ? now : state?.reconciledAt,
    updatedAt: state?.updatedAt ?? now,
  };
}

export function summarizeHarnessStateForMeta(state: HarnessState): HarnessState {
  const upgraded = upgradeHarnessState(state);
  return {
    ...upgraded,
    ledger: upgraded.ledger.slice(-30),
    evidenceIndex: upgraded.evidenceIndex?.slice(0, 30),
    intentHistory: upgraded.intentHistory?.slice(-10),
    turnSummaries: upgraded.turnSummaries?.slice(-10),
    updatedAt: Date.now(),
  };
}
