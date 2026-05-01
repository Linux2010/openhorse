/**
 * rein-agent - 通用 Agent 智能体框架
 *
 * 公共 API 导出入口
 */

// 核心
export { Brain } from './core/brain';
export type { BrainConfig } from './core/brain';

export { BaseAgent } from './core/agent';
export type { AgentConfig, Task, TaskResult, AgentStatus } from './core/agent';

// Agent 实现
export { LeaderAgent } from './agents/leader';
export { CoderAgent } from './agents/coder';

// 初始化与运行时
export { init, Harness, MemorySystem } from './init';
export type {
  ReinConfig,
  ReinRuntime,
  HarnessConfig,
  MemoryConfig,
  SafetyConfig,
  HarnessVerdict,
  AgentRegistryEntry,
  MemoryEntry as InitMemoryEntry,
  MemoryTier as InitMemoryTier,
} from './init';

// Harness 安全模块
export { SafetyChecker } from './harness/safety';
export type { SafetyPolicy, SafetyCheck, SecurityLevel, AuditLogEntry } from './harness/safety';

// Memory 存储模块
export { MemoryStore } from './memory/store';
export type {
  MemoryStoreConfig,
  MemoryEntry as StoreMemoryEntry,
  MemoryTier as StoreMemoryTier,
  MemoryQuery,
} from './memory/store';

// LLM 服务模块
export { LLMService } from './services/llm';
export type {
  LLMConfig,
  Message,
  LLMResponse,
  StreamCallback,
} from './services/llm';

// Agent Runner 模块
export { AgentRunner } from './services/agent-runner';
export type {
  AgentRunnerConfig,
  AgentRunnerResult,
} from './services/agent-runner';

// Harness Engine 模块
export { HarnessEngine } from './harness/harness';
export type {
  HarnessConfig as HarnessEngineConfig,
  HarnessVerdict as HarnessEngineVerdict,
  HarnessContext,
  HarnessExecutionResult,
} from './harness/harness';

// Task Manager 模块
export { TaskManager } from './services/task-manager';
export type {
  TaskRecord,
  CreateTaskOptions,
  UpdateTaskOptions,
  TaskFilter,
  TaskStats,
  TaskStatus,
  Priority,
} from './services/task-manager';

// 配置模块
export { loadConfig, isConfigured, getConfigErrors, getConfigSummary } from './services/config';
export type { ReinCLIConfig } from './services/config';
