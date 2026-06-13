export type LedgerEntryType =
  | 'user_requirement'
  | 'decision'
  | 'file_fact'
  | 'tool_result'
  | 'test_result'
  | 'risk'
  | 'todo'
  | 'blocker'
  | 'verification';

export interface TaskContract {
  id: string;
  objective: string;
  userIntent: string;
  requirements: string[];
  successCriteria: string[];
  constraints: string[];
  prohibitions: string[];
  allowedScope: {
    cwd: string;
    files?: string[];
    commands?: string[];
  };
  createdAt: number;
  updatedAt: number;
}

export interface LedgerSource {
  kind: 'user' | 'file' | 'tool' | 'test' | 'agent' | 'system';
  ref?: string;
}

export interface ContextLedgerEntry {
  id: string;
  type: LedgerEntryType;
  content: string;
  source: LedgerSource;
  importance: 1 | 2 | 3 | 4 | 5;
  ttl: 'turn' | 'task' | 'session' | 'persistent';
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface PlanStep {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
  evidence?: string[];
}

export interface ContextCapsule {
  contract?: TaskContract;
  currentPlan: PlanStep[];
  completed: string[];
  openTodos: string[];
  keyFacts: ContextLedgerEntry[];
  changedFiles: string[];
  verification: {
    commandsRun: string[];
    passed: string[];
    failed: string[];
    warnings: string[];
  };
  nextAction: string;
  createdAt: number;
  updatedAt: number;
}

export interface HarnessState {
  contract?: TaskContract;
  ledger: ContextLedgerEntry[];
  capsule?: ContextCapsule;
  completionBlockCount?: number;
  updatedAt: number;
}

export interface HarnessConfig {
  enabled?: boolean;
  preCompactThreshold?: number;
  compactThreshold?: number;
  maxRecentTurns?: number;
  evidenceBudgetRatio?: number;
  driftGuard?: 'off' | 'warn' | 'block';
  completionGate?: boolean | 'off' | 'warn' | 'block';
}

export interface DriftCheckResult {
  status: 'ok' | 'warn' | 'block';
  reason?: string;
  correction?: string;
}

export interface CompletionGateResult {
  canComplete: boolean;
  missing: string[];
  evidence: string[];
}

