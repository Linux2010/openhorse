import {
  loadGlobalConfig,
  saveGlobalConfig,
  updateGlobalConfig,
  getProjectConfig,
  saveProjectConfig,
  getOrCreateUserId,
  recordFirstStartTime,
  incrementSessionCount,
  updateTokenStats,
  type GlobalConfig,
  type ProjectConfig,
} from '../src/services/global-config';
import { existsSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

describe('global-config', () => {
  // Use a unique test directory based on timestamp to avoid conflicts
  const testDir = join(homedir(), `.openhorse-test-global-${Date.now()}`);
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

  describe('loadGlobalConfig', () => {
    test('returns default config when file does not exist', () => {
      const config = loadGlobalConfig();

      expect(config.defaultModel).toBe('gpt-4o');
      expect(config.toolConfirmation).toBe('allow');
      expect(config.ui).toBeUndefined();
      expect(config.totalSessions).toBe(0);
      expect(config.totalTokens).toBe(0);
      expect(config.totalCost).toBe(0);
    });

    test('loads existing config file', () => {
      // Create a config file
      const customConfig: Partial<GlobalConfig> = {
        defaultModel: 'claude-sonnet-4-6',
        fallbackModel: 'gpt-4o',
        apiKey: 'test-key',
        toolConfirmation: 'deny',
      };
      saveGlobalConfig({ ...loadGlobalConfig(), ...customConfig });

      const config = loadGlobalConfig();

      expect(config.defaultModel).toBe('claude-sonnet-4-6');
      expect(config.fallbackModel).toBe('gpt-4o');
      expect(config.apiKey).toBe('test-key');
      expect(config.toolConfirmation).toBe('deny');
    });

    test('returns default config when file is corrupted', () => {
      // Write invalid JSON
      const path = join(testDir, 'openhorse.json');
      writeFileSync(path, 'invalid json{');

      const config = loadGlobalConfig();

      expect(config.defaultModel).toBe('gpt-4o'); // Default value
    });
  });

  describe('saveGlobalConfig', () => {
    test('creates config file with correct content', () => {
      const config = loadGlobalConfig();
      config.defaultModel = 'glm-5';
      config.fallbackModel = 'qwen-plus';

      saveGlobalConfig(config);

      const path = join(testDir, 'openhorse.json');
      expect(existsSync(path)).toBe(true);

      const content = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.defaultModel).toBe('glm-5');
      expect(parsed.fallbackModel).toBe('qwen-plus');
    });

    test('does not persist ui.renderer in openhorse.json', () => {
      const config = loadGlobalConfig();
      saveGlobalConfig({
        ...config,
        ui: {
          renderer: 'ink',
          confirmations: 'interactive',
        },
      });

      const path = join(testDir, 'openhorse.json');
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));

      expect(parsed.ui).toEqual({ confirmations: 'interactive' });
      expect(parsed.ui.renderer).toBeUndefined();
      expect(loadGlobalConfig().ui).toEqual({ confirmations: 'interactive' });
    });
  });

  describe('updateGlobalConfig', () => {
    test('updates specific fields', () => {
      updateGlobalConfig({ totalSessions: 5 });

      const config = loadGlobalConfig();
      expect(config.totalSessions).toBe(5);
    });

    test('preserves existing fields', () => {
      updateGlobalConfig({ totalSessions: 10 });
      updateGlobalConfig({ totalCost: 0.5 });

      const config = loadGlobalConfig();
      expect(config.totalSessions).toBe(10);
      expect(config.totalCost).toBe(0.5);
    });
  });

  describe('project config', () => {
    const projectPath = '/tmp/test-project';

    test('getProjectConfig returns empty config for new project', () => {
      const projectConfig = getProjectConfig(projectPath);
      expect(projectConfig).toEqual({});
    });

    test('saveProjectConfig saves project config', () => {
      const projectConfig: ProjectConfig = {
        allowedTools: ['read_file', 'write_file'],
        lastSessionId: 'session-123',
        hasTrustDialogAccepted: true,
      };

      saveProjectConfig(projectPath, projectConfig);

      const loaded = getProjectConfig(projectPath);
      expect(loaded.allowedTools).toEqual(['read_file', 'write_file']);
      expect(loaded.lastSessionId).toBe('session-123');
      expect(loaded.hasTrustDialogAccepted).toBe(true);
    });
  });

  describe('getOrCreateUserId', () => {
    test('generates and persists user ID', () => {
      const userId = getOrCreateUserId();

      expect(userId).toBeDefined();
      expect(userId.length).toBe(32); // 16 bytes hex = 32 chars

      // Should return same ID on second call
      const userId2 = getOrCreateUserId();
      expect(userId2).toBe(userId);
    });
  });

  describe('recordFirstStartTime', () => {
    test('records first start time', () => {
      recordFirstStartTime();

      const config = loadGlobalConfig();
      expect(config.firstStartTime).toBeDefined();

      // Should not update on second call
      const firstTime = config.firstStartTime;
      recordFirstStartTime();
      const config2 = loadGlobalConfig();
      expect(config2.firstStartTime).toBe(firstTime);
    });
  });

  describe('stats updates', () => {
    test('incrementSessionCount', () => {
      const before = loadGlobalConfig().totalSessions;
      incrementSessionCount();
      const after = loadGlobalConfig().totalSessions;
      expect(after).toBe(before + 1);
    });

    test('updateTokenStats', () => {
      const before = loadGlobalConfig();
      updateTokenStats(1000, 0.01);

      const after = loadGlobalConfig();
      expect(after.totalTokens).toBe(before.totalTokens + 1000);
      expect(after.totalCost).toBe(before.totalCost + 0.01);
    });
  });
});
