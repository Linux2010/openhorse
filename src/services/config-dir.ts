/**
 * openhorse - 配置目录路径管理
 *
 * 参考 OpenClaude 的 ~/.claude/ 目录结构。
 * 支持 OPENHORSE_CONFIG_DIR 环境变量覆盖。
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

// ============================================================================
// 配置目录根路径
// ============================================================================

/**
 * 获取配置目录根路径
 * 优先使用 OPENHORSE_CONFIG_DIR 环境变量
 */
export function getConfigHome(): string {
  return process.env.OPENHORSE_CONFIG_DIR ?? join(homedir(), '.openhorse');
}

/** Alias for getConfigHome */
export function getConfigDir(): string {
  return getConfigHome();
}

/**
 * 确保配置目录存在
 * 创建时使用 0o700 权限（仅用户可读写执行）
 */
export function ensureConfigDir(): void {
  const dir = getConfigHome();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // 确保子目录存在
  const subdirs = ['sessions', 'projects', 'cost', 'cache'];
  for (const subdir of subdirs) {
    const path = join(dir, subdir);
    if (!existsSync(path)) {
      mkdirSync(path, { mode: 0o700 });
    }
  }
}

// ============================================================================
// 各文件/目录路径
// ============================================================================

/** 全局配置文件路径 */
export function getGlobalConfigPath(): string {
  return join(getConfigHome(), 'openhorse.json');
}

/** 运行时设置文件路径 */
export function getSettingsPath(): string {
  return join(getConfigHome(), 'settings.json');
}

/** 用户级 Memory 文件路径 */
export function getUserMemoryPath(): string {
  return join(getConfigHome(), 'OPENHORSE.md');
}

/** 命令历史文件路径 (JSONL) */
export function getHistoryPath(): string {
  return join(getConfigHome(), 'history.jsonl');
}

/** 会话目录路径 */
export function getSessionsDir(): string {
  return join(getConfigHome(), 'sessions');
}

/** 单个会话元数据文件路径 */
export function getSessionMetaPath(sessionId: string): string {
  return join(getSessionsDir(), `${sessionId}.json`);
}

/** 单个会话对话记录文件路径 (JSONL) */
export function getSessionMessagesPath(sessionId: string): string {
  return join(getSessionsDir(), `${sessionId}.jsonl`);
}

/** 项目配置目录路径 */
export function getProjectsDir(): string {
  return join(getConfigHome(), 'projects');
}

/** 成本记录目录路径 */
export function getCostDir(): string {
  return join(getConfigHome(), 'cost');
}

/** 每日成本记录文件路径 */
export function getDailyCostPath(date?: Date): string {
  const d = date ?? new Date();
  const filename = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`;
  return join(getCostDir(), filename);
}

/** 缓存目录路径 */
export function getCacheDir(): string {
  return join(getConfigHome(), 'cache');
}

// ============================================================================
// Memory 层级
// ============================================================================

/** Memory 类型 */
export type MemoryType = 'User' | 'Project' | 'Local';

/**
 * 获取 Memory 文件路径
 * - User: ~/.openhorse/OPENHORSE.md
 * - Project: {cwd}/OPENHORSE.md
 * - Local: {cwd}/OPENHORSE.local.md
 */
export function getMemoryPath(type: MemoryType, cwd?: string): string {
  const workDir = cwd ?? process.cwd();

  switch (type) {
    case 'User':
      return getUserMemoryPath();
    case 'Project':
      return join(workDir, 'OPENHORSE.md');
    case 'Local':
      return join(workDir, 'OPENHORSE.local.md');
  }
}

/**
 * 获取所有存在的 Memory 文件路径（按优先级排序）
 * Local > Project > User
 */
export function getExistingMemoryPaths(cwd?: string): string[] {
  const types: MemoryType[] = ['Local', 'Project', 'User'];
  return types
    .map(t => getMemoryPath(t, cwd))
    .filter(p => existsSync(p));
}