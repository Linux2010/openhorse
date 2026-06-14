// This must be set before the module is imported
// Jest hoists import statements, so we use a setup file approach
// Instead, we test with the actual config directory

import {
  getConfigHome,
  ensureConfigDir,
  getGlobalConfigPath,
  getSettingsPath,
  getUserMemoryPath,
  getHistoryPath,
  getSessionsDir,
  getProjectsDir,
  getProjectSessionRuntimePath,
  getCostDir,
  getMemoryPath,
  getExistingMemoryPaths,
  type MemoryType,
} from '../src/services/config-dir';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

describe('config-dir', () => {
  // Use a unique test directory based on timestamp to avoid conflicts
  const testDir = join(homedir(), `.openhorse-test-${Date.now()}`);
  const originalEnv = process.env.OPENHORSE_CONFIG_DIR;

  beforeAll(() => {
    process.env.OPENHORSE_CONFIG_DIR = testDir;
    // Clean up test directory if it exists
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    // Restore original env var
    if (originalEnv !== undefined) {
      process.env.OPENHORSE_CONFIG_DIR = originalEnv;
    } else {
      delete process.env.OPENHORSE_CONFIG_DIR;
    }
  });

  describe('getConfigHome', () => {
    test('returns env override when set', () => {
      // The env var is set in beforeAll
      expect(getConfigHome()).toBe(testDir);
    });
  });

  describe('ensureConfigDir', () => {
    test('creates config directory and subdirectories', () => {
      ensureConfigDir();

      expect(existsSync(testDir)).toBe(true);
      expect(existsSync(join(testDir, 'sessions'))).toBe(true);
      expect(existsSync(join(testDir, 'projects'))).toBe(true);
      expect(existsSync(join(testDir, 'cost'))).toBe(true);
      expect(existsSync(join(testDir, 'cache'))).toBe(true);
    });

    test('does not throw when directory already exists', () => {
      ensureConfigDir();
      ensureConfigDir(); // Call again
      expect(existsSync(testDir)).toBe(true);
    });
  });

  describe('path getters', () => {
    test('getGlobalConfigPath returns correct path', () => {
      expect(getGlobalConfigPath()).toBe(join(testDir, 'openhorse.json'));
    });

    test('getSettingsPath returns correct path', () => {
      expect(getSettingsPath()).toBe(join(testDir, 'settings.json'));
    });

    test('getUserMemoryPath returns correct path', () => {
      expect(getUserMemoryPath()).toBe(join(testDir, 'OPENHORSE.md'));
    });

    test('getHistoryPath returns correct path', () => {
      expect(getHistoryPath()).toBe(join(testDir, 'history.jsonl'));
    });

    test('getSessionsDir returns correct path', () => {
      expect(getSessionsDir()).toBe(join(testDir, 'sessions'));
    });

    test('getProjectsDir returns correct path', () => {
      expect(getProjectsDir()).toBe(join(testDir, 'projects'));
    });

    test('getCostDir returns correct path', () => {
      expect(getCostDir()).toBe(join(testDir, 'cost'));
    });

    test('getProjectSessionRuntimePath returns project-scoped runtime path', () => {
      expect(getProjectSessionRuntimePath('/tmp/test-project', 'session-1'))
        .toBe(join(testDir, 'projects', 'tmp-test-project', 'sessions', 'session-1.runtime.json'));
    });
  });

  describe('getMemoryPath', () => {
    const testCwd = '/tmp/test-project';

    test('User memory path', () => {
      expect(getMemoryPath('User')).toBe(join(testDir, 'OPENHORSE.md'));
    });

    test('Project memory path', () => {
      expect(getMemoryPath('Project', testCwd)).toBe(join(testCwd, 'OPENHORSE.md'));
    });

    test('Local memory path', () => {
      expect(getMemoryPath('Local', testCwd)).toBe(join(testCwd, 'OPENHORSE.local.md'));
    });

    test('Project memory uses process.cwd() when not specified', () => {
      const path = getMemoryPath('Project');
      expect(path).toBe(join(process.cwd(), 'OPENHORSE.md'));
    });
  });

  describe('getExistingMemoryPaths', () => {
    test('returns empty array when no memory files exist', () => {
      const paths = getExistingMemoryPaths();
      expect(paths).toEqual([]);
    });

    test('returns existing memory files in correct order', () => {
      // Create test memory files
      const userMemory = getUserMemoryPath();
      writeFileSync(userMemory, '# User Memory\n');

      const paths = getExistingMemoryPaths();
      expect(paths).toContain(userMemory);

      // Clean up
      rmSync(userMemory);
    });
  });
});
