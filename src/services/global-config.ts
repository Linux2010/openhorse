/**
 * openhorse - 全局配置管理
 *
 * 用户只需配置少量核心项，其他参数由 Agent 内部智能控制。
 * 配置存储在 ~/.openhorse/openhorse.json
 * 支持环境变量覆盖配置值。
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { ensureConfigDir, getGlobalConfigPath, getConfigDir } from './config-dir';

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

/** How to handle tool permission checks that request interactive confirmation. */
export type ToolConfirmationPolicy = 'ask' | 'allow' | 'deny';

/** Remote MCP service used by the built-in web_search tool. */
export interface WebSearchMcpConfig {
  /** Provider profile id. Use "auto" or omit to infer from apiBaseUrl/model. */
  provider?: string;
  /** Streamable HTTP MCP endpoint. */
  endpoint?: string;
  /** API key for the WebSearch MCP service. */
  apiKey?: string;
  /** Optional tool name override when the MCP exposes multiple tools. */
  toolName?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** How to apply apiKey. Defaults to bearer Authorization. */
  authType?: 'bearer' | 'header' | 'query' | 'none';
  /** Header name for authType "bearer" or "header". Defaults to Authorization. */
  apiKeyHeader?: string;
  /** Query parameter name for authType "query". */
  apiKeyQueryParam?: string;
  /** Extra HTTP headers for the MCP endpoint. */
  headers?: Record<string, string>;
}

/**
 * 全局配置 — 用户只需关注少量核心项
 * maxTokens/temperature/retries 等由 Agent 智能控制
 */
export interface GlobalConfig {
  /** LLM API Key */
  apiKey?: string;
  /** API Base URL */
  apiBaseUrl?: string;
  /** 默认模型 */
  defaultModel: string;
  /** 备用模型（主模型过载时自动切换） */
  fallbackModel?: string;
  /** Tool confirmation fallback while the current CLI cannot show prompts. */
  toolConfirmation?: ToolConfirmationPolicy;
  /** WebSearch MCP configuration. */
  webSearch?: WebSearchMcpConfig;

  // ---- 内部统计 (自动生成，不由用户配置) ----
  totalSessions: number;
  totalTokens: number;
  totalCost: number;

  // ---- 内部标识 ----
  userId?: string;
  firstStartTime?: string;

  // ---- 项目配置 ----
  projects?: Record<string, ProjectConfig>;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: GlobalConfig = {
  defaultModel: 'gpt-4o',
  toolConfirmation: 'allow',
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
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * 保存全局配置
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

export function getProjectConfig(projectPath: string): ProjectConfig {
  const config = loadGlobalConfig();
  return config.projects?.[projectPath] ?? {};
}

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

export function getOrCreateUserId(): string {
  const config = loadGlobalConfig();

  if (config.userId) {
    return config.userId;
  }

  const userId = randomBytes(16).toString('hex');
  updateGlobalConfig({ userId });
  return userId;
}

export function recordFirstStartTime(): void {
  const config = loadGlobalConfig();
  if (!config.firstStartTime) {
    updateGlobalConfig({ firstStartTime: new Date().toISOString() });
  }
}

// ============================================================================
// 统计更新
// ============================================================================

export function incrementSessionCount(): void {
  const config = loadGlobalConfig();
  updateGlobalConfig({ totalSessions: config.totalSessions + 1 });
}

export function updateTokenStats(tokens: number, cost: number): void {
  const config = loadGlobalConfig();
  updateGlobalConfig({
    totalTokens: config.totalTokens + tokens,
    totalCost: config.totalCost + cost,
  });
}

// ============================================================================
// 输入历史
// ============================================================================

const MAX_INPUT_HISTORY = 1000;

export interface InputHistoryEntry {
  content: string;
  timestamp: number;
}

function getInputHistoryPath(): string {
  return join(getConfigDir(), 'input-history.json');
}

export function getInputHistory(): InputHistoryEntry[] {
  const path = getInputHistoryPath();
  if (!existsSync(path)) {
    return [];
  }
  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

function saveInputHistory(history: InputHistoryEntry[]): void {
  ensureConfigDir();
  const path = getInputHistoryPath();
  writeFileSync(path, JSON.stringify(history, null, 2), { mode: 0o600 });
}

export function addToInputHistory(content: string): void {
  if (!content.trim()) return;

  const history = getInputHistory();

  const existingIndex = history.findIndex(h => h.content === content);
  if (existingIndex >= 0) {
    history.splice(existingIndex, 1);
  }

  history.unshift({
    content,
    timestamp: Date.now(),
  });

  if (history.length > MAX_INPUT_HISTORY) {
    history.splice(MAX_INPUT_HISTORY);
  }

  saveInputHistory(history);
}

export function searchInputHistory(query: string): InputHistoryEntry[] {
  const history = getInputHistory();
  if (!query) return history.slice(0, 20);
  return history.filter(h => h.content.toLowerCase().includes(query.toLowerCase())).slice(0, 20);
}
