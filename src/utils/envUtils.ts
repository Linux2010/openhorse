/**
 * openhorse - Environment utility
 */

export function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}
