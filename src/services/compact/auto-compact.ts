/**
 * openhorse - 自动压缩触发器
 *
 * 监控对话长度，自动触发压缩。
 */

import type { Message } from '../llm';
import { compactMessages, needsCompact, type CompactOptions } from './compact';

// ============================================================================
// 类型定义
// ============================================================================

export interface AutoCompactConfig {
  /** 触发阈值 */
  threshold?: number;
  /** 压缩后保留消息数 */
  maxMessages?: number;
  /** 是否启用自动压缩 */
  enabled?: boolean;
  /** 压缩回调（通知用户） */
  onCompact?: (result: { originalCount: number; compactedCount: number }) => void;
}

// ============================================================================
// 自动压缩器
// ============================================================================

export class AutoCompact {
  private config: AutoCompactConfig;
  private lastCompactTime: number = 0;
  private compactCount: number = 0;

  constructor(config?: AutoCompactConfig) {
    this.config = {
      threshold: config?.threshold || 50,
      maxMessages: config?.maxMessages || 20,
      enabled: config?.enabled ?? true,
      onCompact: config?.onCompact,
    };
  }

  /**
   * 检查并触发自动压缩
   */
  async checkAndCompact(messages: Message[]): Promise<Message[]> {
    if (!this.config.enabled) {
      return messages;
    }

    // 检查是否需要压缩
    if (!needsCompact(messages, this.config.threshold)) {
      return messages;
    }

    // 避免频繁压缩（至少间隔 30 秒）
    const now = Date.now();
    if (now - this.lastCompactTime < 30000) {
      return messages;
    }

    // 执行压缩
    const result = await compactMessages(messages, {
      threshold: this.config.threshold,
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
      });
    }

    return result.messages;
  }

  /**
   * 强制压缩
   */
  async forceCompact(messages: Message[]): Promise<Message[]> {
    const result = await compactMessages(messages, {
      threshold: this.config.threshold,
      maxMessages: this.config.maxMessages,
    });

    this.compactCount++;

    if (this.config.onCompact) {
      this.config.onCompact({
        originalCount: result.originalCount,
        compactedCount: result.compactedCount,
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
  } {
    return {
      compactCount: this.compactCount,
      lastCompactTime: this.lastCompactTime,
      threshold: this.config.threshold || 50,
      enabled: this.config.enabled ?? true,
    };
  }

  /**
   * 启用/禁用自动压缩
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /**
   * 更新阈值
   */
  setThreshold(threshold: number): void {
    this.config.threshold = threshold;
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