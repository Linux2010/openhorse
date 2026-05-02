/**
 * openhorse - 初始化配置与启动入口
 *
 * 统一初始化入口：配置加载 → Harness 驾驭系统 → Memory 记忆系统
 *              → Agent 注册 → Brain 决策引擎 → 启动
 */

import { EventEmitter } from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';
import { BaseAgent, AgentConfig, Task, TaskResult, AgentStatus } from './core/agent';
import { Brain, BrainConfig } from './core/brain';
import { LeaderAgent } from './agents/leader';
import { CoderAgent } from './agents/coder';
import { SafetyChecker, SafetyPolicy } from './harness/safety';
import { MemoryStore, MemoryStoreConfig } from './memory/store';

// ============================================================================
// 1. 配置类型定义
// ============================================================================

/** OpenHorse 全局配置 */
export interface OpenHorseConfig {
  /** 实例名称 */
  name: string;
  /** 运行模式 */
  mode: 'development' | 'production' | 'test';
  /** 日志级别 */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Brain 决策引擎配置 */
  brain: BrainConfig;
  /** Harness 驾驭层配置 */
  harness: HarnessConfig;
  /** Memory 记忆系统配置 */
  memory: MemoryConfig;
  /** 安全策略配置 */
  safety: SafetyConfig;
  /** Agent 注册表 */
  agents: AgentRegistryEntry[];
}

/** Harness 驾驭系统配置 */
export interface HarnessConfig {
  /** 是否启用目标约束 */
  goalConstraint: boolean;
  /** 最大执行步数 */
  maxSteps: number;
  /** 是否启用边界检查 */
  boundaryCheck: boolean;
  /** 允许的操作列表 */
  allowedActions: string[];
  /** 禁止的操作列表 */
  blockedActions: string[];
  /** 是否启用结果验证 */
  resultValidation: boolean;
  /** 是否启用安全沙箱 */
  sandbox: boolean;
  /** 超时时间 (ms) */
  timeout: number;
}

/** Memory 记忆系统配置 */
export interface MemoryConfig {
  /** 工作记忆容量 */
  workingCapacity: number;
  /** 短期记忆容量 */
  shortTermCapacity: number;
  /** 长期记忆后端类型 */
  longTermBackend: 'memory' | 'file';
  /** 长期记忆持久化路径 */
  longTermPath?: string;
}

/** 安全策略配置 */
export interface SafetyConfig {
  /** 是否启用安全检查 */
  enabled: boolean;
  /** 安全策略 */
  policy?: Partial<SafetyPolicy>;
}

/** Agent 注册条目 */
export interface AgentRegistryEntry {
  /** Agent 类型 */
  type: 'leader' | 'coder' | string;
  /** Agent 配置 */
  config?: Partial<AgentConfig>;
}

// ============================================================================
// 2. Harness 驾驭系统
// ============================================================================

/** Harness 验证结果 */
export interface HarnessVerdict {
  /** 是否通过 */
  passed: boolean;
  /** 验证阶段 */
  stage: 'pre-exec' | 'post-exec';
  /** 原因 */
  reason?: string;
}

/** Harness 驾驭系统 — 为 Agent 执行提供约束、检查与验证 */
export class Harness extends EventEmitter {
  private config: HarnessConfig;

  constructor(config: Partial<HarnessConfig> = {}) {
    super();
    this.config = {
      goalConstraint: true,
      maxSteps: 50,
      boundaryCheck: true,
      allowedActions: ['*'],
      blockedActions: ['rm -rf /', 'eval', 'exec'],
      resultValidation: true,
      sandbox: false,
      timeout: 60000,
      ...config,
    };
  }

  /** 执行前检查 — 验证任务是否在安全边界内 */
  preCheck(task: Task): HarnessVerdict {
    // 检查被禁止的操作
    if (this.config.blockedActions.length > 0 && task.params?.actions) {
      const actions: string[] = task.params.actions;
      const blocked = actions.filter(a => this.config.blockedActions.includes(a));
      if (blocked.length > 0) {
        return {
          passed: false,
          stage: 'pre-exec',
          reason: `Blocked actions detected: ${blocked.join(', ')}`,
        };
      }
    }

    // 检查 allowedActions 白名单
    if (
      this.config.allowedActions[0] !== '*' &&
      task.params?.actions
    ) {
      const actions: string[] = task.params.actions;
      const disallowed = actions.filter(a => !this.config.allowedActions.includes(a));
      if (disallowed.length > 0) {
        return {
          passed: false,
          stage: 'pre-exec',
          reason: `Actions not in whitelist: ${disallowed.join(', ')}`,
        };
      }
    }

    return { passed: true, stage: 'pre-exec' };
  }

  /** 执行后验证 — 验证结果是否符合预期约束 */
  postValidate(result: TaskResult, task: Task): HarnessVerdict {
    if (!this.config.resultValidation) {
      return { passed: true, stage: 'post-exec' };
    }

    // 超时检查
    if (result.duration && result.duration > this.config.timeout) {
      return {
        passed: false,
        stage: 'post-exec',
        reason: `Execution exceeded timeout: ${result.duration}ms > ${this.config.timeout}ms`,
      };
    }

    return { passed: true, stage: 'post-exec' };
  }

  /** 获取 Harness 配置摘要 */
  getConfig(): HarnessConfig {
    return { ...this.config };
  }
}

// ============================================================================
// 3. Memory 记忆系统
// ============================================================================

/** 记忆条目 */
export interface MemoryEntry {
  /** 唯一标识 */
  id: string;
  /** 内容 */
  content: any;
  /** 创建时间 */
  createdAt: number;
  /** 最后访问时间 */
  lastAccessedAt: number;
  /** 访问次数 */
  accessCount: number;
  /** 标签 */
  tags?: string[];
}

/** 记忆层级 */
export type MemoryTier = 'working' | 'short-term' | 'long-term';

/** Memory 记忆系统 — 三层记忆架构 */
export class MemorySystem extends EventEmitter {
  private workingMemory: MemoryEntry[] = [];
  private shortTermMemory: MemoryEntry[] = [];
  private longTermMemory: Map<string, MemoryEntry> = new Map();
  private config: MemoryConfig;

  constructor(config: Partial<MemoryConfig> = {}) {
    super();
    this.config = {
      workingCapacity: 10,
      shortTermCapacity: 100,
      longTermBackend: 'memory',
      ...config,
    };
  }

  /** 写入工作记忆（当前上下文） */
  writeToWorking(content: any, tags?: string[]): MemoryEntry {
    const entry = this.createEntry(content, tags);
    this.workingMemory.push(entry);

    // LRU 淘汰
    if (this.workingMemory.length > this.config.workingCapacity) {
      const evicted = this.workingMemory.shift();
      if (evicted) {
        this.addToShortTerm(evicted);
        this.emit('evicted', { tier: 'working', id: evicted.id });
      }
    }

    this.emit('write', { tier: 'working', id: entry.id });
    return entry;
  }

  /** 读取工作记忆 */
  readWorking(): MemoryEntry[] {
    this.touchEntries(this.workingMemory);
    return [...this.workingMemory];
  }

  /** 清空工作记忆 */
  clearWorking(): void {
    // 先将重要记忆转移到短期记忆
    const important = this.workingMemory.filter(e => e.accessCount >= 3);
    important.forEach(e => this.addToShortTerm(e));
    this.workingMemory = [];
    this.emit('cleared', { tier: 'working' });
  }

  /** 写入短期记忆 */
  writeToShortTerm(content: any, tags?: string[]): MemoryEntry {
    const entry = this.createEntry(content, tags);
    this.addToShortTerm(entry);
    this.emit('write', { tier: 'short-term', id: entry.id });
    return entry;
  }

  /** 读取短期记忆 */
  readShortTerm(): MemoryEntry[] {
    this.touchEntries(this.shortTermMemory);
    return [...this.shortTermMemory];
  }

  /** 写入长期记忆 */
  writeToLongTerm(content: any, tags?: string[]): MemoryEntry {
    const entry = this.createEntry(content, tags);
    this.longTermMemory.set(entry.id, entry);
    this.emit('write', { tier: 'long-term', id: entry.id });
    return entry;
  }

  /** 从长期记忆读取 */
  readLongTerm(id: string): MemoryEntry | undefined {
    const entry = this.longTermMemory.get(id);
    if (entry) {
      entry.lastAccessedAt = Date.now();
      entry.accessCount++;
    }
    return entry;
  }

  /** 搜索记忆（全层级） */
  search(query: string, tier?: MemoryTier): MemoryEntry[] {
    const results: MemoryEntry[] = [];
    const lowerQuery = query.toLowerCase();

    const searchTier = (entries: MemoryEntry[]) => {
      entries.forEach(e => {
        const content = JSON.stringify(e.content).toLowerCase();
        const tags = (e.tags ?? []).join(' ').toLowerCase();
        if (content.includes(lowerQuery) || tags.includes(lowerQuery)) {
          results.push(e);
        }
      });
    };

    if (!tier || tier === 'working') searchTier(this.workingMemory);
    if (!tier || tier === 'short-term') searchTier(this.shortTermMemory);
    if (!tier || tier === 'long-term') searchTier(Array.from(this.longTermMemory.values()));

    return results;
  }

  /** 获取记忆系统状态 */
  getStatus(): Record<MemoryTier, number> {
    return {
      working: this.workingMemory.length,
      'short-term': this.shortTermMemory.length,
      'long-term': this.longTermMemory.size,
    };
  }

  // ---- Internal ----

  private createEntry(content: any, tags?: string[]): MemoryEntry {
    const now = Date.now();
    return {
      id: uuidv4(),
      content,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      tags,
    };
  }

  private addToShortTerm(entry: MemoryEntry): void {
    entry.lastAccessedAt = Date.now();
    this.shortTermMemory.push(entry);

    if (this.shortTermMemory.length > this.config.shortTermCapacity) {
      const evicted = this.shortTermMemory.shift();
      if (evicted) {
        this.longTermMemory.set(evicted.id, evicted);
        this.emit('evicted', { tier: 'short-term', id: evicted.id });
      }
    }
  }

  private touchEntries(entries: MemoryEntry[]): void {
    entries.forEach(e => {
      e.lastAccessedAt = Date.now();
      e.accessCount++;
    });
  }
}

// ============================================================================
// 4. 默认配置
// ============================================================================

const DEFAULT_CONFIG: OpenHorseConfig = {
  name: 'openhorse',
  mode: (process.env.OPENHORSE_MODE as OpenHorseConfig['mode']) || 'development',
  logLevel: (process.env.OPENHORSE_LOG_LEVEL as OpenHorseConfig['logLevel']) || 'info',
  brain: {
    strategy: 'priority',
    maxConcurrent: 5,
  },
  harness: {
    goalConstraint: true,
    maxSteps: 50,
    boundaryCheck: true,
    allowedActions: ['*'],
    blockedActions: ['rm -rf /', 'eval', 'exec'],
    resultValidation: true,
    sandbox: false,
    timeout: 60000,
  },
  memory: {
    workingCapacity: 10,
    shortTermCapacity: 100,
    longTermBackend: 'memory',
  },
  safety: {
    enabled: true,
    policy: {
      sandboxMode: false,
      allowedFileSystemOps: ['read', 'write'],
    },
  },
  agents: [
    { type: 'leader' },
    { type: 'coder' },
  ],
};

// ============================================================================
// 5. 初始化入口
// ============================================================================

/** 初始化结果 */
export interface OpenHorseRuntime {
  /** Brain 决策引擎 */
  brain: Brain;
  /** Harness 驾驭系统 */
  harness: Harness;
  /** Memory 记忆系统（内联版） */
  memory: MemorySystem;
  /** Safety 安全检查器（模块化版） */
  safety: SafetyChecker;
  /** Memory Store 记忆存储（模块化版） */
  store: MemoryStore;
  /** 已注册的 Agent 列表 */
  agents: BaseAgent[];
  /** 当前配置 */
  config: OpenHorseConfig;
  /** 启动系统 */
  start: () => Promise<void>;
  /** 优雅关闭 */
  shutdown: () => Promise<void>;
}

/**
 * 初始化 OpenHorse 系统
 *
 * 初始化流程：
 * 1. 合并配置（默认 + 用户覆盖）
 * 2. 创建 Harness 驾驭系统
 * 3. 创建 Memory 记忆系统
 * 4. 创建并注册 Agent 到 Brain
 * 5. 建立 Harness ↔ Agent ↔ Memory 连接
 * 6. 返回运行时
 */
export async function init(userConfig: Partial<OpenHorseConfig> = {}): Promise<OpenHorseRuntime> {
  const logger = createLogger(userConfig.logLevel ?? DEFAULT_CONFIG.logLevel);

  // --- Step 1: 合并配置 ---
  const config: OpenHorseConfig = mergeConfig(DEFAULT_CONFIG, userConfig);

  // --- Step 2: 创建 Harness 驾驭系统 ---
  const harness = new Harness(config.harness);

  // --- Step 3: 创建 Memory 记忆系统 ---
  const memory = new MemorySystem(config.memory);

  // --- Step 3.5: 创建 Safety 安全检查器 ---
  const safety = new SafetyChecker(config.safety?.policy);

  // --- Step 3.6: 创建 Memory Store ---
  const store = new MemoryStore({
    workingCapacity: config.memory.workingCapacity,
    shortTermCapacity: config.memory.shortTermCapacity,
  });

  // --- Step 4: 创建 Brain 决策引擎 ---
  const brain = new Brain(config.brain);

  // --- Step 5: 注册 Agent ---
  const agents = await registerAgents(brain, config.agents, harness, memory, logger);

  // --- Step 6: 写入启动记忆 ---
  memory.writeToWorking({
    event: 'system-start',
    timestamp: new Date().toISOString(),
    mode: config.mode,
    agentCount: agents.length,
  }, ['system', 'startup']);

  // --- 构建运行时 ---
  const runtime: OpenHorseRuntime = {
    brain,
    harness,
    memory,
    safety,
    store,
    agents,
    config,

    async start() {
      memory.writeToWorking({
        event: 'system-started',
        timestamp: new Date().toISOString(),
      }, ['system']);

      // 监听未处理的 Agent 错误
      agents.forEach(agent => {
        agent.on('task-failed', ({ task, error }) => {
          logger.error(`[OpenHorse] Task "${task.name}" failed on ${agent.name}: ${error}`);
          memory.writeToShortTerm({
            event: 'task-failed',
            taskId: task.id,
            agent: agent.name,
            error,
          }, ['error', task.id]);
        });
      });
    },

    async shutdown() {
      // 停止所有 Agent
      agents.forEach(agent => agent.stop());

      // 持久化工作记忆到长期记忆
      const workingMemories = memory.readWorking();
      workingMemories.forEach(entry => {
        memory.writeToLongTerm(entry.content, entry.tags);
      });
      memory.clearWorking();
    },
  };

  return runtime;
}

// ============================================================================
// 6. 辅助函数
// ============================================================================

/** 简易日志器 */
function createLogger(level: OpenHorseConfig['logLevel']) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const current = levels[level];

  return {
    debug(msg: string) { if (current <= levels.debug) console.debug(msg); },
    info(msg: string)  { if (current <= levels.info)  console.log(msg); },
    warn(msg: string)  { if (current <= levels.warn)  console.warn(msg); },
    error(msg: string) { console.error(msg); },
  };
}

/** 深度合并配置 */
function mergeConfig(defaults: OpenHorseConfig, override: Partial<OpenHorseConfig>): OpenHorseConfig {
  const result = { ...defaults };

  if (override.name !== undefined) result.name = override.name;
  if (override.mode !== undefined) result.mode = override.mode;
  if (override.logLevel !== undefined) result.logLevel = override.logLevel;

  if (override.brain) {
    result.brain = { ...defaults.brain, ...override.brain };
  }
  if (override.harness) {
    result.harness = { ...defaults.harness, ...override.harness };
  }
  if (override.memory) {
    result.memory = { ...defaults.memory, ...override.memory };
  }
  if (override.safety) {
    result.safety = { ...defaults.safety, ...override.safety };
  }
  if (override.agents) {
    result.agents = override.agents;
  }

  return result;
}

/** Agent 构造函数注册表 */
const AGENT_FACTORY: Record<string, (config?: Partial<AgentConfig>) => BaseAgent> = {
  leader: (cfg) => new LeaderAgent(cfg),
  coder: (cfg) => new CoderAgent(cfg),
};

/**
 * 注册 Agent 到 Brain，并连接 Harness 和 Memory
 */
async function registerAgents(
  brain: Brain,
  entries: AgentRegistryEntry[],
  harness: Harness,
  memory: MemorySystem,
  logger: ReturnType<typeof createLogger>,
): Promise<BaseAgent[]> {
  const agents: BaseAgent[] = [];

  for (const entry of entries) {
    const factory = AGENT_FACTORY[entry.type];
    if (!factory) {
      logger.warn(`[OpenHorse] Unknown agent type: ${entry.type}, skipping.`);
      continue;
    }

    const agent = factory(entry.config);

    // 注册 Harness 前置检查钩子
    agent.on('task-started', (task: Task) => {
      const verdict = harness.preCheck(task);
      if (!verdict.passed) {
        logger.warn(`[OpenHorse] Harness blocked task "${task.name}": ${verdict.reason}`);
        agent.emit('task-blocked', { task, verdict });
      }
    });

    // 注册 Harness 后置验证钩子
    agent.on('task-completed', ({ task, result }: { task: Task; result: TaskResult }) => {
      const verdict = harness.postValidate(result, task);
      if (!verdict.passed) {
        logger.warn(`[OpenHorse] Harness validation failed for "${task.name}": ${verdict.reason}`);
      }
      // 记录执行结果到记忆
      memory.writeToShortTerm({
        event: 'task-completed',
        taskId: task.id,
        agent: agent.name,
        success: result.success,
        duration: result.duration,
      }, ['task', task.id]);
    });

    brain.registerAgent(agent);
    agents.push(agent);
  }

  return agents;
}

// ============================================================================
// 7. 启动入口
// ============================================================================

/** 主启动函数 */
async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║          OpenHorse Framework                    ║');
  console.log('║  "OpenHorse, Unleash the Potential."           ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  const runtime = await init({
    mode: 'development',
    logLevel: 'debug',
  });

  // 优雅关闭
  process.on('SIGINT', async () => {
    await runtime.shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await runtime.shutdown();
    process.exit(0);
  });

  await runtime.start();

  // 输出系统状态
  console.log('\n[OpenHorse] System Status:');
  console.log(JSON.stringify(runtime.brain.getStatus(), null, 2));
  console.log('\n[OpenHorse] Memory Status:');
  console.log(JSON.stringify(runtime.memory.getStatus(), null, 2));
  console.log('\n[OpenHorse] Harness Config:');
  console.log(JSON.stringify(runtime.harness.getConfig(), null, 2));

  // 提交示例任务
  console.log('\n[OpenHorse] Submitting demo task...');
  runtime.brain.submitTask({
    id: 'init-task-001',
    name: '初始化验证任务',
    description: '验证系统初始化是否成功',
    priority: 'P1',
    assignedTo: 'leader',
    status: 'pending',
  });
}

// 直接运行入口（仅作为入口文件时执行，被 import 时不执行）
if (require.main === module) {
  main().catch(err => {
    console.error('[OpenHorse] Fatal error:', err);
    process.exit(1);
  });
}

// ============================================================================
// 重新导出
// ============================================================================

export { SafetyChecker } from './harness/safety';
export { MemoryStore } from './memory/store';
export type { SafetyPolicy, SafetyCheck, SecurityLevel, AuditLogEntry } from './harness/safety';
export type { MemoryEntry as StoreMemoryEntry, MemoryTier as StoreMemoryTier, MemoryQuery, MemoryStoreConfig } from './memory/store';
