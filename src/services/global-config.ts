/**
 * openhorse - 全局配置管理
 *
 * 配置存储在 ~/.openhorse/openhorse.json
 * 支持环境变量覆盖配置值。
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { ensureConfigDir, getGlobalConfigPath } from './config-dir';

// ============================================================================
// 类型定义
// ============================================================================

/** 项目级配置 */
export interface ProjectConfig {
  /** 允许的工具列表 */
  allowedTools?: string[];
  /** 最后会话 ID */
  lastSessionId?: string;
  /** 最后使用的模型 */
  lastModel?: string;
  /** 是否已接受信任对话框 */
  hasTrustDialogAccepted?: boolean;
}

/** 全局配置 */
export interface GlobalConfig {
  // ---- LLM 配置 ----
  /** API Key (可选，可由环境变量提供) */
  apiKey?: string;
  /** API Base URL */
  apiBaseUrl?: string;
  /** 默认模型 */
  defaultModel: string;
  /** 备用模型 */
  fallbackModel?: string;
  /** 最大输出 token */
  maxTokens: number;
  /** 温度 */
  temperature: number;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 重试基础延迟 (ms) */
  retryBaseDelay?: number;

  // ---- 预算 ----
  /** 预算限制 (USD) */
  budgetLimit?: number;

  // ---- 统计 ----
  /** 总会话数 */
  totalSessions: number;
  /** 总 token 数 */
  totalTokens: number;
  /** 总成本 (USD) */
  totalCost: number;

  // ---- 用户 ----
  /** 用户 ID */
  userId?: string;
  /** 首次启动时间 (ISO string) */
  firstStartTime?: string;

  // ---- 项目 ----
  /** 项目配置映射 (路径 -> 配置) */
  projects?: Record<string, ProjectConfig>;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: GlobalConfig = {
  defaultModel: 'gpt-4o',
  maxTokens: 4096,
  temperature: 0.7,
  totalSessions: 0,
  totalTokens: 0,
  totalCost: 0,
};

// ============================================================================
// 加载/保存
// ============================================================================

/**
 * 加载全局配置
 * 如果文件不存在，返回默认配置
 */
export function loadGlobalConfig(): GlobalConfig {
  ensureConfigDir();
  const path = getGlobalConfigPath();

  if (!existsSync(path)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(content);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    // 文件损坏时返回默认配置
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * 保存全局配置
 * 使用 0o600 权限（仅用户可读写）
 */
export function saveGlobalConfig(config: GlobalConfig): void {
  ensureConfigDir();
  const path = getGlobalConfigPath();
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * 更新全局配置（部分更新）
 */
export function updateGlobalConfig(updates: Partial<GlobalConfig>): GlobalConfig {
  const config = loadGlobalConfig();
  const newConfig = { ...config, ...updates };
  saveGlobalConfig(newConfig);
  return newConfig;
}

// ============================================================================
// 项目配置
// ============================================================================

/**
 * 获取项目配置
 * @param projectPath 项目路径
 */
export function getProjectConfig(projectPath: string): ProjectConfig {
  const config = loadGlobalConfig();
  return config.projects?.[projectPath] ?? {};
}

/**
 * 保存项目配置
 * @param projectPath 项目路径
 * @param projectConfig 项目配置
 */
export function saveProjectConfig(projectPath: string, projectConfig: ProjectConfig): void {
  const config = loadGlobalConfig();
  config.projects = {
    ...config.projects,
    [projectPath]: projectConfig,
  };
  saveGlobalConfig(config);
}

// ============================================================================
// 用户 ID
// ============================================================================

/**
 * 获取或创建用户 ID
 * 首次调用时生成并保存
 */
export function getOrCreateUserId(): string {
  const config = loadGlobalConfig();

  if (config.userId) {
    return config.userId;
  }

  const userId = randomBytes(16).toString('hex');
  updateGlobalConfig({ userId });
  return userId;
}

/**
 * 记录首次启动时间
 */
export function recordFirstStartTime(): void {
  const config = loadGlobalConfig();
  if (!config.firstStartTime) {
    updateGlobalConfig({ firstStartTime: new Date().toISOString() });
  }
}

// ============================================================================
// 统计更新
// ============================================================================

/**
 * 增加会话计数
 */
export function incrementSessionCount(): void {
  const config = loadGlobalConfig();
  updateGlobalConfig({ totalSessions: config.totalSessions + 1 });
}

/**
 * 更新 token 和成本统计
 */
export function updateTokenStats(tokens: number, cost: number): void {
  const config = loadGlobalConfig();
  updateGlobalConfig({
    totalTokens: config.totalTokens + tokens,
    totalCost: config.totalCost + cost,
  });
}