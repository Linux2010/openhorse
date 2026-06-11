/**
 * openhorse - 自动压缩触发器
 *
 * 监控对话 token 使用量，当上下文达到模型限制的 95% 时自动触发压缩。
 * 每个模型自动感知其上下文窗口大小。
 */

import type { Message } from '../llm';
import { compactMessages, type CompactOptions } from './compact';
import { getModelContextWindow, AUTO_COMPACT_THRESHOLD } from '../model-context';

// ============================================================================
// 类型定义
// ============================================================================

export interface AutoCompactConfig {
  /** 触发阈值（0-1，默认 0.95 即 95%） */
  threshold?: number;
  /** 模型 ID（用于获取上下文窗口） */
  modelId?: string;
  /** 压缩后保留消息数 */
  maxMessages?: number;
  /** 是否启用自动压缩 */
  enabled?: boolean;
  /** 压缩回调（通知用户） */
  onCompact?: (result: { originalCount: number; compactedCount: number; ctxPercent: number }) => void;
}

// ============================================================================
// 自动压缩器
// ============================================================================

export class AutoCompact {
  private config: Required<Pick<AutoCompactConfig, 'threshold' | 'modelId' | 'maxMessages' | 'enabled'>> & {
    onCompact?: AutoCompactConfig['onCompact'];
  };
  private lastCompactTime: number = 0;
  private compactCount: number = 0;
  /** 最后一次计算的 token 使用量 */
  private lastTokenCount: number = 0;

  constructor(config?: AutoCompactConfig) {
    this.config = {
      threshold: config?.threshold ?? AUTO_COMPACT_THRESHOLD,
      modelId: config?.modelId ?? 'gpt-4o',
      maxMessages: config?.maxMessages ?? 20,
      enabled: config?.enabled ?? true,
      onCompact: config?.onCompact,
    };
  }

  /**
   * 更新模型（切换模型时调用）
   */
  setModel(modelId: string): void {
    this.config.modelId = modelId;
  }

  /**
   * 检查并触发自动压缩（基于 token 百分比）
   * @param messages 当前对话消息列表
   * @param usedTokens 当前已使用的 token 数（来自 API usage 响应）
   */
  async checkAndCompact(messages: Message[], usedTokens?: number): Promise<Message[]> {
    if (!this.config.enabled) {
      return messages;
    }

    const ctxPercent = this.calculateCtxPercent(usedTokens);

    // 达到阈值才触发
    if (ctxPercent < this.config.threshold * 100) {
      return messages;
    }

    // 避免频繁压缩（至少间隔 30 秒）
    const now = Date.now();
    if (now - this.lastCompactTime < 30000) {
      return messages;
    }

    // 执行压缩
    const result = await compactMessages(messages, {
      maxMessages: this.config.maxMessages,
    });

    // 更新状态
    this.lastCompactTime = now;
    this.compactCount++;

    // 通知回调
    if (this.config.onCompact) {
      this.config.onCompact({
        originalCount: result.originalCount,
        compactedCount: result.compactedCount,
        ctxPercent,
      });
    }

    return result.messages;
  }

  /**
   * 计算上下文使用百分比
   */
  private calculateCtxPercent(usedTokens?: number, messages?: Message[]): number {
    const contextWindow = getModelContextWindow(this.config.modelId);
    if (usedTokens) {
      this.lastTokenCount = usedTokens;
      return Math.min(100, Math.round((usedTokens / contextWindow) * 100));
    }
    // Fallback: 估算 token 数（平均每个消息 ~200 tokens）
    const estimated = (messages?.length ?? 0) * 200;
    this.lastTokenCount = estimated;
    return Math.min(100, Math.round((estimated / contextWindow) * 100));
  }

  /**
   * 获取当前上下文百分比
   */
  getCtxPercent(usedTokens?: number, messages?: Message[]): number {
    return this.calculateCtxPercent(usedTokens, messages);
  }

  /**
   * 强制压缩
   */
  async forceCompact(messages: Message[]): Promise<Message[]> {
    const result = await compactMessages(messages, {
      maxMessages: this.config.maxMessages,
    });

    this.compactCount++;

    if (this.config.onCompact) {
      this.config.onCompact({
        originalCount: result.originalCount,
        compactedCount: result.compactedCount,
        ctxPercent: this.getCtxPercent(),
      });
    }

    return result.messages;
  }

  /**
   * 获取压缩统计
   */
  getStats(): {
    compactCount: number;
    lastCompactTime: number;
    threshold: number;
    enabled: boolean;
    modelId: string;
    ctxPercent: number;
  } {
    return {
      compactCount: this.compactCount,
      lastCompactTime: this.lastCompactTime,
      threshold: this.config.threshold,
      enabled: this.config.enabled,
      modelId: this.config.modelId,
      ctxPercent: this.getCtxPercent(),
    };
  }

  /**
   * 启用/禁用自动压缩
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }
}

// ============================================================================
// 单例
// ============================================================================

let autoCompactInstance: AutoCompact | null = null;

export function getAutoCompact(config?: AutoCompactConfig): AutoCompact {
  if (!autoCompactInstance) {
    autoCompactInstance = new AutoCompact(config);
  }
  return autoCompactInstance;
}

export function resetAutoCompact(): void {
  autoCompactInstance = null;
}
