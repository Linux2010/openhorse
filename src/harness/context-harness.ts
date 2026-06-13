import type { LLMResponse, Message } from '../services/llm';
import { assembleHarnessMessages } from './assembler';
import { createContextCapsule } from './capsule';
import { createTaskContract, updateTaskContract } from './contract';
import { checkToolDrift, evaluateCompletionGate } from './drift-guard';
import { ContextLedger } from './ledger';
import type {
  CompletionGateResult,
  ContextCapsule,
  DriftCheckResult,
  HarnessConfig,
  HarnessState,
} from './types';

const DEFAULT_CONFIG: Required<Pick<HarnessConfig, 'enabled' | 'preCompactThreshold' | 'compactThreshold' | 'maxRecentTurns' | 'evidenceBudgetRatio' | 'driftGuard'>> & {
  completionGate: HarnessConfig['completionGate'];
} = {
  enabled: true,
  preCompactThreshold: 0.8,
  compactThreshold: 0.95,
  maxRecentTurns: 8,
  evidenceBudgetRatio: 0.3,
  driftGuard: 'warn',
  completionGate: 'warn',
};

export interface ContextHarnessOptions {
  cwd: string;
  modelId: string;
  state?: HarnessState;
  config?: HarnessConfig;
}

export class ContextHarness {
  private readonly cwd: string;
  private readonly modelId: string;
  private readonly config: HarnessConfig;
  private contract: HarnessState['contract'];
  private ledger: ContextLedger;
  private capsule?: ContextCapsule;
  private completionBlockCount: number;

  constructor(options: ContextHarnessOptions) {
    this.cwd = options.cwd;
    this.modelId = options.modelId;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.contract = options.state?.contract;
    this.ledger = new ContextLedger(options.state?.ledger ?? []);
    this.capsule = options.state?.capsule;
    this.completionBlockCount = options.state?.completionBlockCount ?? 0;
  }

  updateContractFromUserInput(input: string): void {
    if (this.config.enabled === false) return;
    this.contract = this.contract
      ? updateTaskContract(this.contract, input, this.cwd)
      : createTaskContract(input, this.cwd);
    this.ledger.recordUserRequirement(input);
    this.refreshCapsule();
  }

  assembleMessages(messages: Message[]): Message[] {
    return assembleHarnessMessages(messages, this.toJSON(), this.modelId, this.config);
  }

  recordAssistantResponse(response: LLMResponse): void {
    if (this.config.enabled === false) return;
    if (response.content.trim()) {
      this.ledger.recordAssistantDecision(response.content);
    }
    this.refreshCapsule();
  }

  beforeToolUse(params: { name: string; args: Record<string, unknown> }): DriftCheckResult {
    const mode = this.config.driftGuard ?? 'warn';
    const result = checkToolDrift({
      contract: this.contract,
      toolName: params.name,
      args: params.args,
      mode,
    });
    if (result.status !== 'ok') {
      this.ledger.add({
        type: result.status === 'block' ? 'blocker' : 'risk',
        content: result.reason || `Tool ${params.name} may drift from the current task.`,
        source: { kind: 'system', ref: params.name },
        importance: result.status === 'block' ? 5 : 4,
        ttl: 'task',
        metadata: { toolName: params.name, status: result.status },
      });
      this.refreshCapsule();
    }
    return result;
  }

  recordToolResult(params: {
    name: string;
    args: Record<string, unknown>;
    result: string;
    duration: number;
    success: boolean;
    error?: string;
  }): void {
    if (this.config.enabled === false) return;
    this.ledger.recordToolResult(params);
    this.refreshCapsule();
  }

  beforeComplete(): CompletionGateResult {
    const result = evaluateCompletionGate({
      contract: this.contract,
      ledger: this.ledger.getEntries(),
    });

    const mode = this.config.completionGate === true
      ? 'block'
      : this.config.completionGate === false
        ? 'off'
        : (this.config.completionGate ?? 'warn');

    if (!result.canComplete && mode !== 'off') {
      this.ledger.add({
        type: mode === 'block' ? 'blocker' : 'risk',
        content: `Completion gate missing: ${result.missing.join('; ')}`,
        source: { kind: 'system', ref: 'completion_gate' },
        importance: 5,
        ttl: 'task',
        metadata: { missing: result.missing, mode },
      });
      this.refreshCapsule();
    }

    if (!result.canComplete && mode === 'block' && this.completionBlockCount < 1) {
      this.completionBlockCount++;
      return result;
    }

    return { ...result, canComplete: true };
  }

  asCompletionBlockedMessage(result: CompletionGateResult): Message {
    return {
      role: 'user',
      content: `[Harness Completion Gate]\nThe task is not ready to finish.\nMissing:\n${result.missing.map(item => `- ${item}`).join('\n')}\nContinue working or explicitly explain why verification cannot be run.`,
    };
  }

  asToolBlockedResult(result: DriftCheckResult): string {
    return JSON.stringify({
      success: false,
      error: result.reason || 'Blocked by Context Harness',
      suggestion: result.correction,
    });
  }

  getCapsule(): ContextCapsule | undefined {
    this.refreshCapsule();
    return this.capsule;
  }

  toJSON(): HarnessState {
    return {
      contract: this.contract,
      ledger: this.ledger.toJSON(),
      capsule: this.capsule,
      completionBlockCount: this.completionBlockCount,
      updatedAt: Date.now(),
    };
  }

  private refreshCapsule(): void {
    if (!this.contract && this.ledger.getEntries().length === 0) return;
    this.capsule = createContextCapsule(this.contract, this.ledger.getEntries());
  }
}

export function createContextHarness(options: ContextHarnessOptions): ContextHarness {
  return new ContextHarness(options);
}

