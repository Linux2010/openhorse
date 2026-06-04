/**
 * openhorse - Debug utility stub
 *
 * Stub for OpenClaude's debug module.
 * Logs to stderr when DEBUG environment variable is set.
 */

export interface LogOptions {
  level?: 'info' | 'warn' | 'error';
  context?: Record<string, unknown>;
}

export function logForDebugging(
  message: string,
  options?: LogOptions
): void {
  if (process.env.DEBUG || process.env.OPENHORSE_DEBUG) {
    const level = options?.level ?? 'info';
    const ctx = options?.context ? ` ${JSON.stringify(options.context)}` : '';
    process.stderr.write(`[openhorse:${level}] ${message}${ctx}\n`);
  }
}
