/**
 * openhorse - runtime usage counters
 *
 * Usage counters are runtime state, not user configuration. They live in
 * ~/.openhorse/usage.json so ~/.openhorse/openhorse.json stays focused on
 * user-editable provider and behavior settings.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { ensureConfigDir, getGlobalConfigPath, getUsageStatePath } from './config-dir';

export interface UsageState {
  schemaVersion: 1;
  totalSessions: number;
  totalTokens: number;
  totalCost: number;
  updatedAt: string;
}

interface LegacyUsageFields {
  totalSessions?: unknown;
  totalTokens?: unknown;
  totalCost?: unknown;
}

const USAGE_SCHEMA_VERSION = 1 as const;

function nowIso(): string {
  return new Date().toISOString();
}

function toNonNegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

function defaultUsageState(): UsageState {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    totalSessions: 0,
    totalTokens: 0,
    totalCost: 0,
    updatedAt: nowIso(),
  };
}

function normalizeUsageState(value: unknown): UsageState {
  if (!value || typeof value !== 'object') return defaultUsageState();
  const parsed = value as Partial<UsageState>;

  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    totalSessions: toNonNegativeNumber(parsed.totalSessions),
    totalTokens: toNonNegativeNumber(parsed.totalTokens),
    totalCost: toNonNegativeNumber(parsed.totalCost),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : nowIso(),
  };
}

function readJsonFile(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function hasLegacyUsageFields(value: unknown): value is LegacyUsageFields {
  if (!value || typeof value !== 'object') return false;
  const record = value as LegacyUsageFields;
  return (
    record.totalSessions !== undefined ||
    record.totalTokens !== undefined ||
    record.totalCost !== undefined
  );
}

function readLegacyUsageState(): UsageState | null {
  const parsed = readJsonFile(getGlobalConfigPath());
  if (!hasLegacyUsageFields(parsed)) return null;

  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    totalSessions: toNonNegativeNumber(parsed.totalSessions),
    totalTokens: toNonNegativeNumber(parsed.totalTokens),
    totalCost: toNonNegativeNumber(parsed.totalCost),
    updatedAt: nowIso(),
  };
}

function stripLegacyUsageFields(): void {
  const path = getGlobalConfigPath();
  const parsed = readJsonFile(path);
  if (!hasLegacyUsageFields(parsed)) return;

  const {
    totalSessions: _totalSessions,
    totalTokens: _totalTokens,
    totalCost: _totalCost,
    ...config
  } = parsed as Record<string, unknown>;

  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function loadUsageState(): UsageState {
  ensureConfigDir();

  const path = getUsageStatePath();
  const existing = readJsonFile(path);
  if (existing) {
    stripLegacyUsageFields();
    return normalizeUsageState(existing);
  }

  const migrated = readLegacyUsageState();
  if (migrated) {
    saveUsageState(migrated);
    stripLegacyUsageFields();
    return migrated;
  }

  return defaultUsageState();
}

export function saveUsageState(state: UsageState): void {
  ensureConfigDir();
  const normalized = normalizeUsageState({ ...state, updatedAt: nowIso() });
  writeFileSync(getUsageStatePath(), JSON.stringify(normalized, null, 2), { mode: 0o600 });
}

export function updateUsageState(updates: Partial<Omit<UsageState, 'schemaVersion'>>): UsageState {
  const current = loadUsageState();
  const next = normalizeUsageState({
    ...current,
    ...updates,
    schemaVersion: USAGE_SCHEMA_VERSION,
    updatedAt: nowIso(),
  });
  saveUsageState(next);
  return next;
}

export function incrementSessionCount(): void {
  const state = loadUsageState();
  updateUsageState({ totalSessions: state.totalSessions + 1 });
}

export function updateTokenStats(tokens: number, cost: number): void {
  const state = loadUsageState();
  updateUsageState({
    totalTokens: state.totalTokens + Math.max(0, tokens),
    totalCost: state.totalCost + Math.max(0, cost),
  });
}
