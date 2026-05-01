/**
 * openhorse - Harness 引擎（模块化）
 *
 * 为 Agent 执行提供完整的约束、检查与验证：
 *   - preCheck: 执行前安全检查（安全策略 + 目标约束）
 *   - postValidate: 执行后结果验证（超时 + 约束检查）
 *   - execute: 包装完整的执行生命周期
 *   - 步骤限制、超时管理、事件驱动
 */

import { EventEmitter } from 'eventemitter3';
import { Task, TaskResult, BaseAgent } from '../core/agent';
import { SafetyChecker, SafetyPolicy } from './safety';

// ============================================================================
// 类型定义
// ============================================================================

/** Harness 配置 */
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
  /** 安全策略（可选） */
  safetyPolicy?: Partial<SafetyPolicy>;
}

/** Harness 验证结果 */
export interface HarnessVerdict {
  /** 是否通过 */
  passed: boolean;
  /** 验证阶段 */
  stage: 'pre-exec' | 'post-exec';
  /** 原因 */
  reason?: string;
  /** 建议 */
  suggestion?: string;
}

/** Harness 执行上下文 */
export interface HarnessContext {
  /** 当前任务 */
  task: Task;
  /** Agent ID */
  agentId: string;
  /** 已执行步数 */
  steps: number;
  /** 开始时间 */
  startedAt: number;
  /** 自定义元数据 */
  metadata?: Record<string, unknown>;
}

/** Harness 执行结果 */
export interface HarnessExecutionResult {
  /** 是否通过 Harness 验证 */
  harnessPassed: boolean;
  /** preCheck 结果 */
  preCheck: HarnessVerdict | null;
  /** postValidate 结果 */
  postValidate: HarnessVerdict | null;
  /** Agent 执行结果 */
  taskResult: TaskResult;
  /** 执行上下文 */
  context: HarnessContext;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: HarnessConfig = {
  goalConstraint: true,
  maxSteps: 50,
  boundaryCheck: true,
  allowedActions: ['*'],
  blockedActions: ['rm -rf /', 'eval', 'exec'],
  resultValidation: true,
  sandbox: false,
  timeout: 60000,
};

// ============================================================================
// HarnessEngine - Harness 引擎
// ============================================================================

export class HarnessEngine extends EventEmitter {
  private config: HarnessConfig;
  private safetyChecker: SafetyChecker | null;

  constructor(config?: Partial<HarnessConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.safetyChecker = this.config.sandbox
      ? new SafetyChecker(this.config.safetyPolicy)
      : null;
  }

  // ========================================================================
  // 核心 API
  // ========================================================================

  /**
   * 执行前检查 — 验证任务是否在安全边界内
   */
  preCheck(task: Task): HarnessVerdict {
    // 1. 安全策略检查
    if (this.safetyChecker) {
      const safety = this.safetyChecker.check(task.name, {
        path: task.params?.path,
        output: task.description,
      });
      if (!safety.passed) {
        return {
          passed: false,
          stage: 'pre-exec',
          reason: safety.reason,
          suggestion: safety.suggestion,
        };
      }
    }

    // 2. 检查被禁止的操作
    if (this.config.blockedActions.length > 0 && task.params?.actions) {
      const actions: string[] = task.params.actions;
      const blocked = actions.filter(a => this.config.blockedActions.includes(a));
      if (blocked.length > 0) {
        return {
          passed: false,
          stage: 'pre-exec',
          reason: `Blocked actions detected: ${blocked.join(', ')}`,
          suggestion: 'Remove blocked actions or update harness policy.',
        };
      }
    }

    // 3. 白名单检查
    if (this.config.allowedActions[0] !== '*' && task.params?.actions) {
      const actions: string[] = task.params.actions;
      const disallowed = actions.filter(a => !this.config.allowedActions.includes(a));
      if (disallowed.length > 0) {
        return {
          passed: false,
          stage: 'pre-exec',
          reason: `Actions not in whitelist: ${disallowed.join(', ')}`,
          suggestion: 'Add actions to allowed list or use wildcard "*".',
        };
      }
    }

    // 4. 目标约束检查
    if (this.config.goalConstraint && !task.description) {
      return {
        passed: false,
        stage: 'pre-exec',
        reason: 'Task has no description — goal constraint violated',
        suggestion: 'Provide a task description to define the goal.',
      };
    }

    return { passed: true, stage: 'pre-exec' };
  }

  /**
   * 执行后验证 — 验证结果是否符合预期约束
   */
  postValidate(result: TaskResult, task: Task): HarnessVerdict {
    if (!this.config.resultValidation) {
      return { passed: true, stage: 'post-exec' };
    }

    // 1. 超时检查
    if (result.duration && result.duration > this.config.timeout) {
      return {
        passed: false,
        stage: 'post-exec',
        reason: `Execution exceeded timeout: ${result.duration}ms > ${this.config.timeout}ms`,
        suggestion: 'Increase timeout or optimize task execution.',
      };
    }

    // 2. 步数限制检查
    if (result.data?.steps && (result.data.steps as number) > this.config.maxSteps) {
      return {
        passed: false,
        stage: 'post-exec',
        reason: `Execution exceeded max steps: ${result.data.steps} > ${this.config.maxSteps}`,
        suggestion: 'Reduce complexity or increase maxSteps.',
      };
    }

    // 3. 边界检查
    if (this.config.boundaryCheck && task.params?.boundary) {
      const boundary = task.params.boundary as Record<string, number>;
      if (result.data?.metrics) {
        const metrics = result.data.metrics as Record<string, number>;
        for (const [key, max] of Object.entries(boundary)) {
          if (metrics[key] !== undefined && metrics[key] > max) {
            return {
              passed: false,
              stage: 'post-exec',
              reason: `Metric "${key}" exceeded boundary: ${metrics[key]} > ${max}`,
              suggestion: `Ensure ${key} stays within ${max}.`,
            };
          }
        }
      }
    }

    return { passed: true, stage: 'post-exec' };
  }

  /**
   * 完整执行流程 — 包装 preCheck → execute → postValidate
   */
  async execute(
    agent: BaseAgent,
    task: Task,
    metadata?: Record<string, unknown>,
  ): Promise<HarnessExecutionResult> {
    const context: HarnessContext = {
      task,
      agentId: agent.id,
      steps: 0,
      startedAt: Date.now(),
      metadata,
    };

    this.emit('pre-check', { task, agentId: agent.id });

    // Step 1: preCheck
    const preCheck = this.preCheck(task);
    if (!preCheck.passed) {
      this.emit('blocked', { task, verdict: preCheck });
      return {
        harnessPassed: false,
        preCheck,
        postValidate: null,
        taskResult: { success: false, error: preCheck.reason, duration: 0 },
        context,
      };
    }

    this.emit('execute-start', { task, agentId: agent.id });

    // Step 2: 执行任务（带超时控制）
    let taskResult: TaskResult;
    try {
      taskResult = await this.executeWithTimeout(agent.execute(task), this.config.timeout);
      context.steps++;
    } catch (error: any) {
      taskResult = {
        success: false,
        error: error.message ?? 'Execution failed',
        duration: Date.now() - context.startedAt,
      };
    }

    this.emit('execute-complete', { task, result: taskResult });

    // Step 3: postValidate
    const postValidate = this.postValidate(taskResult, task);

    const harnessPassed = postValidate.passed;
    this.emit('post-validate', { task, verdict: postValidate });

    return {
      harnessPassed,
      preCheck,
      postValidate,
      taskResult,
      context,
    };
  }

  // ========================================================================
  // 配置管理
  // ========================================================================

  /** 获取当前配置 */
  getConfig(): HarnessConfig {
    return { ...this.config };
  }

  /** 更新配置 */
  updateConfig(patch: Partial<HarnessConfig>): void {
    this.config = { ...this.config, ...patch };

    // 重新初始化安全检查器
    if (patch.sandbox !== undefined) {
      this.safetyChecker = patch.sandbox
        ? new SafetyChecker(this.config.safetyPolicy)
        : null;
    }
  }

  /** 获取安全检查器 */
  getSafetyChecker(): SafetyChecker | null {
    return this.safetyChecker;
  }

  // ---- Internal ----

  /** 带超时的执行 */
  private executeWithTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Execution timed out after ${timeout}ms`)), timeout),
      ),
    ]);
  }
}
