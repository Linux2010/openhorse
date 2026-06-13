export { ContextHarness, createContextHarness } from './context-harness';
export type { ContextHarnessOptions } from './context-harness';
export { createTaskContract, updateTaskContract } from './contract';
export { ContextLedger } from './ledger';
export type { AddLedgerEntryInput } from './ledger';
export { createContextCapsule, renderContextCapsule } from './capsule';
export { assembleHarnessMessages, renderHarnessContext } from './assembler';
export { checkToolDrift, evaluateCompletionGate } from './drift-guard';
export type {
  CompletionGateResult,
  ContextCapsule,
  ContextLedgerEntry,
  DriftCheckResult,
  HarnessConfig,
  HarnessState,
  LedgerEntryType,
  LedgerSource,
  PlanStep,
  TaskContract,
} from './types';

