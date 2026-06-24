/**
 * openhorse - File Checkpoints
 *
 * Before editing files, create recoverable snapshots so the user can
 * undo agent changes back to a specific turn.
 *
 * Storage: ~/.openhorse/projects/<hash>/_checkpoints/<turnId>/<file>
 * TTL: 7 days
 */

import * as fs from 'fs';
import * as path from 'path';
import { getProjectSessionsDir } from '../services/config-dir';

export const CHECKPOINT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface CheckpointFile {
  path: string;
  content: string;
  sizeBytes: number;
}

export interface Checkpoint {
  turnId: string;
  createdAt: number;
  files: CheckpointFile[];
}

function getCheckpointDir(projectPath: string): string {
  const base = getProjectSessionsDir(projectPath);
  const dir = path.join(base, '_checkpoints');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function getTurnDir(projectPath: string, turnId: string): string {
  const base = getCheckpointDir(projectPath);
  return path.join(base, `${turnId}`);
}

/**
 * Create a checkpoint for the given files at the current state.
 * Files are saved individually so they can be restored independently.
 */
export function createCheckpoint(
  projectPath: string | undefined,
  turnId: string,
  filePaths: string[],
): Checkpoint | null {
  if (!projectPath || filePaths.length === 0) return null;

  const dir = getTurnDir(projectPath, turnId);
  if (fs.existsSync(dir)) return null; // Already exists

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const files: CheckpointFile[] = [];
  for (const filePath of filePaths) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const relativePath = path.relative(projectPath, filePath);
      const checkpointPath = path.join(dir, safeFileName(relativePath));
      fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
      fs.writeFileSync(checkpointPath, content, { mode: 0o600 });

      files.push({
        path: relativePath,
        content: content.slice(0, 200), // Preview only
        sizeBytes: Buffer.byteLength(content, 'utf8'),
      });
    } catch {
      // Skip files that can't be read
    }
  }

  // Write checkpoint metadata
  const meta: Checkpoint = { turnId, createdAt: Date.now(), files };
  fs.writeFileSync(path.join(dir, '.checkpoint.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });

  return meta;
}

/**
 * Restore a checkpoint — overwrite current files with checkpointed content.
 * Returns the list of restored files.
 */
export function restoreCheckpoint(
  projectPath: string | undefined,
  turnId: string,
): { restored: string[]; error?: string } {
  if (!projectPath) return { restored: [], error: 'No project path' };

  const dir = getTurnDir(projectPath, turnId);
  if (!fs.existsSync(dir)) {
    return { restored: [], error: `No checkpoint found for turn ${turnId}` };
  }

  const metaPath = path.join(dir, '.checkpoint.json');
  if (!fs.existsSync(metaPath)) {
    return { restored: [], error: 'Checkpoint metadata missing' };
  }

  let meta: Checkpoint;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return { restored: [], error: 'Checkpoint metadata corrupted' };
  }

  const restored: string[] = [];
  for (const file of meta.files) {
    const checkpointFile = path.join(dir, safeFileName(file.path));
    const targetFile = path.join(projectPath, file.path);
    try {
      if (!fs.existsSync(checkpointFile)) continue;
      const content = fs.readFileSync(checkpointFile, 'utf8');
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.writeFileSync(targetFile, content, { mode: 0o600 });
      restored.push(file.path);
    } catch {
      // Skip files that can't be restored
    }
  }

  return { restored };
}

/**
 * List available checkpoints for a project.
 */
export function listCheckpoints(projectPath: string | undefined): Checkpoint[] {
  if (!projectPath) return [];

  const dir = getCheckpointDir(projectPath);
  if (!fs.existsSync(dir)) return [];

  const checkpoints: Checkpoint[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const metaPath = path.join(dir, entry, '.checkpoint.json');
    if (fs.existsSync(metaPath)) {
      try {
        checkpoints.push(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
      } catch {
        // Skip corrupted metadata
      }
    }
  }

  return checkpoints.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Clean up checkpoints older than the TTL (7 days).
 */
export function cleanupCheckpoints(projectPath: string | undefined): number {
  if (!projectPath) return 0;

  const dir = getCheckpointDir(projectPath);
  if (!fs.existsSync(dir)) return 0;

  let cleaned = 0;
  const now = Date.now();

  for (const entry of fs.readdirSync(dir)) {
    if (entry === '.checkpoint.json') continue; // Skip stray meta files

    const entryPath = path.join(dir, entry);
    try {
      const stat = fs.statSync(entryPath);
      if (!stat.isDirectory()) continue;

      // Check the meta file's mtime
      const metaPath = path.join(entryPath, '.checkpoint.json');
      if (fs.existsSync(metaPath)) {
        const metaStat = fs.statSync(metaPath);
        if (now - metaStat.mtimeMs > CHECKPOINT_TTL_MS) {
          fs.rmSync(entryPath, { recursive: true, force: true });
          cleaned++;
        }
      }
    } catch {
      // Skip entries that can't be accessed
    }
  }

  return cleaned;
}

function safeFileName(filePath: string): string {
  // Replace problematic characters in file names for safe storage
  return filePath.replace(/[<>:"|?*]/g, '_');
}
