/**
 * openhorse - Bootstrap state stub
 *
 * OpenClaude tracks interaction time for notification/timeout features.
 * Stubbed for openhorse.
 */

let lastInteractionTime: number = Date.now();

export function updateLastInteractionTime(): void {
  lastInteractionTime = Date.now();
}

export function flushInteractionTime(): void {
  // Reset interaction time — no-op in openhorse
  lastInteractionTime = Date.now();
}

export function markScrollActivity(): void {
  // No-op in openhorse
}

export function getLastInteractionTime(): number {
  return lastInteractionTime;
}
