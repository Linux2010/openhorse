/**
 * openhorse - Shared mutation lock stub
 *
 * Used by ink termio tests to prevent concurrent mutation of shared state.
 * In openhorse, tests don't run concurrently on the same data.
 */

export function withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}
