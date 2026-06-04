/**
 * openhorse - Error logging utility
 */

export function logError(error: unknown): void {
  if (error instanceof Error) {
    process.stderr.write(`[openhorse:error] ${error.message}\n${error.stack ?? ''}\n`);
  } else {
    process.stderr.write(`[openhorse:error] ${String(error)}\n`);
  }
}
