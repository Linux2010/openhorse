/**
 * openhorse - 配置目录路径管理
 *
 * 参考 OpenClaude 的 ~/.claude/ 目录结构。
 * 支持 OPENHORSE_CONFIG_DIR 环境变量覆盖。
 */

import { homedir } from 'os';
import { join, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { atomicWriteFileSync } from './atomic-write';

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
  const subdirs = ['projects', 'cost', 'cache'];
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

export const PROJECT_METADATA_SCHEMA_VERSION = 1;

/** Project-scoped storage metadata persisted in projects/<project-key>/project.json. */
export interface ProjectMetadata {
  schemaVersion: number;
  projectKey: string;
  projectPath: string;
  createdAt: string;
  lastSeenAt: string;
}

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

/** 项目配置目录路径 */
export function getProjectsDir(): string {
  return join(getConfigHome(), 'projects');
}

/** Encode an absolute project path into a stable, readable directory key. */
export function encodeProjectPath(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, '/');
  const encoded = normalized
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return encoded || 'root';
}

/** Resolve a project path for storage identity without depending on session-storage. */
export function resolveProjectStoragePath(projectPath: string): string {
  const absolute = resolve(projectPath);

  if (existsSync(absolute)) {
    try {
      const root = execFileSync('git', ['-C', absolute, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (root) return realpathSync(root);
    } catch {
      // Not a git worktree, or git is unavailable.
    }

    try {
      return realpathSync(absolute);
    } catch {
      // Fall through to absolute path.
    }
  }

  return absolute;
}

/** Canonical project key used for all project-scoped storage. */
export function getCanonicalProjectKey(projectPath: string): string {
  return encodeProjectPath(resolveProjectStoragePath(projectPath));
}

/** 项目状态目录路径 */
export function getProjectDir(projectPath: string): string {
  return join(getProjectsDir(), getCanonicalProjectKey(projectPath));
}

/** Project metadata file path. */
export function getProjectMetadataPath(projectPath: string): string {
  return join(getProjectDir(projectPath), 'project.json');
}

/** 项目会话目录路径 */
export function getProjectSessionsDir(projectPath: string): string {
  return join(getProjectDir(projectPath), 'sessions');
}

/** 确保项目状态目录存在 */
export function ensureProjectDir(projectPath: string): void {
  ensureConfigDir();

  const projectDir = getProjectDir(projectPath);
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  }

  const sessionsDir = getProjectSessionsDir(projectPath);
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  }

  updateProjectMetadata(projectPath);
}

/** Read project metadata, returning null for missing or invalid files. */
export function readProjectMetadata(projectPath: string): ProjectMetadata | null {
  const metadataPath = getProjectMetadataPath(projectPath);
  if (!existsSync(metadataPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(metadataPath, 'utf8')) as ProjectMetadata;
    if (
      parsed?.schemaVersion !== PROJECT_METADATA_SCHEMA_VERSION ||
      typeof parsed.projectKey !== 'string' ||
      typeof parsed.projectPath !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Create or refresh project metadata without changing the project identity. */
export function updateProjectMetadata(projectPath: string, now: Date = new Date()): ProjectMetadata {
  const resolvedPath = resolveProjectStoragePath(projectPath);
  const projectKey = encodeProjectPath(resolvedPath);
  const projectDir = join(getProjectsDir(), projectKey);
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  }

  const metadataPath = join(projectDir, 'project.json');
  let createdAt = now.toISOString();
  try {
    const existing = JSON.parse(readFileSync(metadataPath, 'utf8')) as Partial<ProjectMetadata>;
    if (typeof existing.createdAt === 'string' && existing.createdAt) {
      createdAt = existing.createdAt;
    }
  } catch {
    // Missing or invalid metadata is replaced below.
  }

  const metadata: ProjectMetadata = {
    schemaVersion: PROJECT_METADATA_SCHEMA_VERSION,
    projectKey,
    projectPath: resolvedPath,
    createdAt,
    lastSeenAt: now.toISOString(),
  };

  atomicWriteFileSync(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });
  return metadata;
}

/** 项目内单个会话元数据文件路径 */
export function getProjectSessionMetaPath(projectPath: string, sessionId: string): string {
  return join(getProjectSessionsDir(projectPath), `${sessionId}.json`);
}

/** 项目内单个会话对话记录文件路径 */
export function getProjectSessionMessagesPath(projectPath: string, sessionId: string): string {
  return join(getProjectSessionsDir(projectPath), `${sessionId}.jsonl`);
}

/** 项目内单个会话 Harness sidecar 路径 */
export function getProjectSessionHarnessPath(projectPath: string, sessionId: string): string {
  return join(getProjectSessionsDir(projectPath), `${sessionId}.harness.json`);
}

/** 项目 Memory 目录路径 */
export function getProjectMemoryDir(projectPath: string): string {
  return join(getProjectDir(projectPath), 'memory');
}

/** Legacy hash-based project Memory 目录路径（只读兼容） */
export function getLegacyProjectMemoryDir(projectPath: string): string {
  const hash = createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
  return join(getProjectsDir(), hash, 'memory');
}

/** 项目工具 Artifact 目录路径 */
export function getProjectArtifactsDir(projectPath: string): string {
  return join(getProjectDir(projectPath), 'artifacts');
}

/** 项目 Checkpoint 目录路径 */
export function getProjectCheckpointsDir(projectPath: string): string {
  return join(getProjectDir(projectPath), 'checkpoints');
}

/** 项目索引目录路径 */
export function getProjectIndexesDir(projectPath: string): string {
  return join(getProjectDir(projectPath), 'indexes');
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
