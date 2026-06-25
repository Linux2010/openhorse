/**
 * openhorse - Tool Artifacts
 *
 * Store large tool outputs as disk artifacts instead of embedding them in
 * session transcripts or harness evidence. Returns a reference ID that can
 * be used to retrieve the full output later.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getProjectArtifactsDir, getProjectSessionsDir } from '../services/config-dir';

/** Maximum output size before truncation + artifact storage (10KB) */
export const ARTIFACT_THRESHOLD = 10_240;

/** Directory for tool artifacts */
function getArtifactDir(projectPath: string): string {
  const dir = getProjectArtifactsDir(projectPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function getLegacyArtifactDir(projectPath: string): string {
  return path.join(getProjectSessionsDir(projectPath), '_artifacts');
}

export interface ToolArtifact {
  /** Unique artifact reference ID */
  id: string;
  /** Size in bytes of the full output */
  outputBytes: number;
  /** Whether the output was truncated */
  truncated: boolean;
  /** Path to the artifact file on disk (relative to artifact dir) */
  path: string;
}

/**
 * Store a large output as an artifact file and return a reference.
 * Returns null if the project path is not available (falls back to inline).
 */
export function storeArtifact(
  projectPath: string | undefined,
  toolName: string,
  output: string,
  outputBytes: number,
): ToolArtifact | null {
  if (!projectPath) return null;

  const id = `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const artifactDir = getArtifactDir(projectPath);
  const artifactPath = path.join(artifactDir, `${id}.txt`);

  try {
    fs.writeFileSync(artifactPath, output, { mode: 0o600 });
    return {
      id,
      outputBytes,
      truncated: false,
      path: artifactPath,
    };
  } catch {
    return null;
  }
}

/**
 * Retrieve a stored artifact by path.
 */
export function retrieveArtifact(artifactPath: string): string | null {
  try {
    if (!fs.existsSync(artifactPath)) return null;
    return fs.readFileSync(artifactPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Truncate a large output for inline context display.
 * Shows the first portion and last portion with an ellipsis in between.
 */
export function truncateForContext(output: string, maxBytes = 4096): string {
  const byteLen = Buffer.byteLength(output, 'utf8');
  if (byteLen <= maxBytes) return output;

  const half = Math.floor(maxBytes / 2);
  const buf = Buffer.from(output, 'utf8');
  const head = buf.subarray(0, half).toString('utf8');
  const tail = buf.subarray(buf.length - half).toString('utf8');
  return `${head}\n\n[... ${byteLen - maxBytes} bytes truncated, ${byteLen}B total — see artifact for full output]\n\n${tail}`;
}

/**
 * Clean up expired artifacts (older than 24h).
 */
export function cleanupArtifacts(projectPath: string): void {
  const artifactDirs = [getArtifactDir(projectPath), getLegacyArtifactDir(projectPath)];

  const now = Date.now();
  for (const artifactDir of artifactDirs) {
    if (!fs.existsSync(artifactDir)) continue;
    const entries = fs.readdirSync(artifactDir);
    for (const entry of entries) {
      const fullPath = path.join(artifactDir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
          fs.unlinkSync(fullPath);
        }
      } catch {
        // Best-effort
      }
    }
  }
}
