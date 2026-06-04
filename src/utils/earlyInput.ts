/**
 * openhorse - Early input capture stub
 *
 * OpenClaude uses this to capture input before Ink is fully initialized.
 * In openhorse we don't need this — stdin is only used by Ink after setup.
 */

export function stopCapturingEarlyInput(): void {
  // No-op in openhorse
}

export function startCapturingEarlyInput(): void {
  // No-op in openhorse
}

export function consumeEarlyInput(): string {
  return '';
}
