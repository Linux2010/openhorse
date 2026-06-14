/**
 * openhorse - Memory Storage
 *
 * File-based memory system stored in ~/.openhorse/projects/<project-key>/memory/
 * - MEMORY.md: Index file (one-line hooks)
 * - *.md: Individual memory entries with frontmatter
 *
 * Memory is project-scoped: each project has its own memory directory.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, realpathSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, basename, resolve } from 'path';
import { createHash } from 'crypto';
import type { MemoryEntry, MemoryType } from './types';
import { getConfigHome, getProjectDir } from '../services/config-dir';
import { atomicWriteFileSync } from '../services/atomic-write';
import { getVectorStore, type SearchResult } from './vector-store';  // Issue #32 #3.8

// Re-export types for convenience
export type { MemoryEntry, MemoryType } from './types';

// ============================================================================
// Constants
// ============================================================================

export const PROJECTS_SUBDIR = 'projects';
export const MEMORY_SUBDIR = 'memory';
export const ENTRYPOINT_NAME = 'MEMORY.md';
export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25000;

// ============================================================================
// Project Path Hash
// ============================================================================

/**
 * Convert project path to a hash for directory naming.
 * Uses SHA256 truncated to 16 characters for shorter paths.
 */
export function getProjectHash(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
}

function resolveMemoryProjectPath(projectPath: string): string {
  const absolute = resolve(projectPath);

  if (existsSync(absolute)) {
    try {
      const root = execFileSync('git', ['-C', absolute, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (root) {
        return realpathSync(root);
      }
    } catch {
      // Not a git worktree.
    }
  }

  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

// ============================================================================
// Paths
// ============================================================================

/**
 * Get memory directory path for a specific project.
 * @param projectPath - Project path (defaults to current working directory)
 *
 * Note: when `projectPath` is omitted we fall back to the legacy v0.1.2
 * global memory directory. This branch is preserved for backwards
 * compatibility with existing config homes; new code should always pass a
 * `projectPath`. The fallback is slated for removal once a migration tool
 * lands (tracked in v0.1.4-plus roadmap Part 10).
 */
export function getMemoryDir(projectPath?: string): string {
  const configHome = getConfigHome();

  if (projectPath) {
    return join(getProjectDir(resolveMemoryProjectPath(projectPath)), MEMORY_SUBDIR);
  }

  return join(configHome, MEMORY_SUBDIR);
}

function getLegacyMemoryDir(projectPath?: string): string {
  const configHome = getConfigHome();
  if (projectPath) {
    const hash = getProjectHash(projectPath);
    return join(configHome, PROJECTS_SUBDIR, hash, MEMORY_SUBDIR);
  }
  return join(configHome, MEMORY_SUBDIR);
}

function getMemoryDirs(projectPath?: string): string[] {
  const dirs = [getMemoryDir(projectPath)];
  const legacyDir = getLegacyMemoryDir(projectPath);
  if (legacyDir !== dirs[0] && existsSync(legacyDir)) {
    dirs.push(legacyDir);
  }
  return dirs;
}

/**
 * Get MEMORY.md path for a project.
 */
export function getEntrypointPath(projectPath?: string): string {
  return join(getMemoryDir(projectPath), ENTRYPOINT_NAME);
}

/**
 * Ensure memory directory exists for a project.
 */
export function ensureMemoryDir(projectPath?: string): string {
  const dir = getMemoryDir(projectPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ============================================================================
// Parsing
// ============================================================================

/** Parse frontmatter from memory file */
export function parseMemoryFrontmatter(content: string): MemoryEntry | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) return null;

  const [, frontmatter, body] = frontmatterMatch;
  const lines = frontmatter.split('\n');
  const fields: Record<string, string> = {};

  for (const line of lines) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) {
      fields[match[1]] = match[2].trim();
    }
  }

  if (!fields.name || !fields.type) return null;

  const type = fields.type as MemoryType;
  if (!['user', 'feedback', 'project', 'reference'].includes(type)) return null;

  return {
    name: fields.name,
    description: fields.description || '',
    type,
    content: body.trim(),
    createdAt: 0, // Will be set from file
    updatedAt: 0,
  };
}

/** Generate frontmatter for memory file */
export function generateMemoryFrontmatter(entry: MemoryEntry): string {
  return `---
name: ${entry.name}
description: ${entry.description}
type: ${entry.type}
---

${entry.content}`;
}

// ============================================================================
// Loading
// ============================================================================

/**
 * Load all memory entries from a project's memory directory.
 * @param projectPath - Project path (defaults to cwd)
 */
export function loadAllMemories(projectPath?: string): MemoryEntry[] {
  ensureMemoryDir(projectPath);
  const memoriesByName = new Map<string, MemoryEntry>();

  for (const dir of getMemoryDirs(projectPath).reverse()) {
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith('.md') || file === ENTRYPOINT_NAME) continue;

        const filePath = join(dir, file);
        try {
          const content = readFileSync(filePath, 'utf-8');
          const entry = parseMemoryFrontmatter(content);
          if (entry) {
            entry.name = basename(file, '.md');
            memoriesByName.set(entry.name, entry);
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Directory doesn't exist or unreadable
    }
  }

  return Array.from(memoriesByName.values());
}

/**
 * Load MEMORY.md index for a project.
 */
export function loadMemoryIndex(projectPath?: string): string {
  const path = getEntrypointPath(projectPath);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8');
}

/**
 * Load specific memory by name from a project.
 */
export function loadMemory(name: string, projectPath?: string): MemoryEntry | null {
  for (const dir of getMemoryDirs(projectPath)) {
    const filePath = join(dir, `${name}.md`);

    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const entry = parseMemoryFrontmatter(content);
      if (entry) {
        entry.name = name;
        return entry;
      }
    } catch {
      // File unreadable
    }
  }

  return null;
}

// ============================================================================
// Saving
// ============================================================================

/**
 * Save memory entry to a project's memory directory.
 */
export function saveMemory(entry: MemoryEntry, projectPath?: string): void {
  ensureMemoryDir(projectPath);
  const dir = getMemoryDir(projectPath);
  const filePath = join(dir, `${entry.name}.md`);

  const now = Date.now();
  entry.createdAt = entry.createdAt || now;
  entry.updatedAt = now;

  const content = generateMemoryFrontmatter(entry);
  atomicWriteFileSync(filePath, content);

  // Update MEMORY.md index
  updateMemoryIndex(projectPath);
}

/**
 * Delete memory entry from a project.
 * Hard-deletes the file so `memory_recall` no longer returns it.
 */
export function deleteMemory(name: string, projectPath?: string): void {
  for (const dir of getMemoryDirs(projectPath)) {
    const filePath = join(dir, `${name}.md`);

    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
      } catch {
        // ignore — index regeneration below will reflect whatever is on disk
      }
    }
  }

  updateMemoryIndex(projectPath);
}

/**
 * Update MEMORY.md index for a project.
 */
export function updateMemoryIndex(projectPath?: string): void {
  const memories = loadAllMemories(projectPath);
  const lines: string[] = [
    '# Memory Index',
    '',
    'This file lists all saved memories. Each entry is one line under ~150 characters.',
    '',
  ];

  for (const mem of memories) {
    const hook = mem.description || mem.content.slice(0, 80);
    const line = `- [${mem.name}](${mem.name}.md) — ${hook}`;
    if (line.length <= 150) {
      lines.push(line);
    } else {
      lines.push(line.slice(0, 147) + '...');
    }
  }

  // Truncate if exceeds limits
  if (lines.length > MAX_ENTRYPOINT_LINES) {
    lines.splice(MAX_ENTRYPOINT_LINES);
    lines.push('', '> WARNING: MEMORY.md truncated. Keep index entries concise.');
  }

  // Issue #32 修复：每次迭代重新计算 content
  let content = lines.join('\n');
  if (content.length > MAX_ENTRYPOINT_BYTES) {
    while (lines.join('\n').length > MAX_ENTRYPOINT_BYTES && lines.length > 10) {
      lines.pop();
    }
    lines.push('', '> WARNING: MEMORY.md truncated to fit size limit.');
  }

  atomicWriteFileSync(getEntrypointPath(projectPath), lines.join('\n'));
}

// ============================================================================
// Search
// ============================================================================

/**
 * Search memories by query in a project.
 */
export function searchMemories(query: string, projectPath?: string): MemoryEntry[] {
  const memories = loadAllMemories(projectPath);
  const lowerQuery = query.toLowerCase();

  return memories.filter(mem => {
    return (
      mem.name.toLowerCase().includes(lowerQuery) ||
      mem.description.toLowerCase().includes(lowerQuery) ||
      mem.content.toLowerCase().includes(lowerQuery) ||
      mem.type.toLowerCase().includes(lowerQuery)
    );
  });
}

/**
 * Get memories by type from a project.
 */
export function getMemoriesByType(type: MemoryType, projectPath?: string): MemoryEntry[] {
  const memories = loadAllMemories(projectPath);
  return memories.filter(mem => mem.type === type);
}

// Issue #32 #3.8: 异步搜索版本，利用 VectorStore 索引
/**
 * Async search using VectorStore index (faster for large memory sets).
 * Falls back to synchronous search if VectorStore not initialized.
 */
export async function searchMemoriesAsync(query: string, projectPath?: string, limit: number = 50): Promise<MemoryEntry[]> {
  try {
    const store = getVectorStore();
    if (store.isVectorSearchAvailable()) {
      const results = await store.search(query, limit, projectPath);
      // Convert SearchResult to MemoryEntry
      return results.map(r => ({
        name: r.name,
        description: r.description || '',
        type: r.type as MemoryType,
        content: r.content,
        createdAt: r.createdAt || 0,
        updatedAt: r.createdAt || 0,
      }));
    }
  } catch {
    // VectorStore not available, fall back
  }
  // Fallback: synchronous search
  return searchMemories(query, projectPath);
}
