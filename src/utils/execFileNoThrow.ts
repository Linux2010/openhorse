/**
 * openhorse - execFileNoThrow stub
 *
 * Executes a command and returns its result.
 * Does not throw on non-zero exit codes.
 */

import { execFile } from 'child_process';

export interface ExecFileResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function execFileNoThrow(
  command: string,
  args: string[] = [],
  options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<ExecFileResult> {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: options.timeout || 5000,
      env: options.env || process.env,
    }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        code: error?.code ? 1 : 0,
      });
    });
  });
}

export function execFileNoThrowWithCwd(
  command: string,
  args: string[] = [],
  options: { cwd?: string; timeout?: number } = {}
): Promise<ExecFileResult> {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: options.cwd,
      timeout: options.timeout || 5000,
    }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        code: error?.code ? 1 : 0,
      });
    });
  });
}
