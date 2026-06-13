import { loadConfig, isConfigured, getConfigErrors, getConfigSummary } from '../src/services/config';

const originalEnv = { ...process.env };

function cleanEnv() {
  delete process.env.OPENHORSE_API_KEY;
  delete process.env.OPENHORSE_API_BASE_URL;
  delete process.env.OPENHORSE_BASE_URL;
  delete process.env.OPENHORSE_MODEL;
  delete process.env.OPENHORSE_FALLBACK_MODEL;
  delete process.env.OPENHORSE_NAME;
  delete process.env.OPENHORSE_MODE;
  delete process.env.OPENHORSE_LOG_LEVEL;
}

beforeEach(() => {
  cleanEnv();
  jest.restoreAllMocks();
});

afterAll(() => {
  Object.assign(process.env, originalEnv);
});

describe('loadConfig', () => {
  test('returns defaults when no env or overrides', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: 'gpt-4o',
      totalSessions: 0,
      totalTokens: 0,
      totalCost: 0,
    });

    const config = loadConfig();
    expect(config.model).toBe('gpt-4o');
    expect(config.name).toBe('openhorse');
    expect(config.mode).toBe('development');
    expect(config.logLevel).toBe('info');
    expect(config.apiKey).toBe('');
  });

  test('overrides take priority', () => {
    const config = loadConfig({
      apiKey: 'test-key',
      model: 'custom-model',
      fallbackModel: 'backup-model',
      name: 'my-instance',
      mode: 'production',
      logLevel: 'debug',
    });
    expect(config.apiKey).toBe('test-key');
    expect(config.model).toBe('custom-model');
    expect(config.fallbackModel).toBe('backup-model');
    expect(config.name).toBe('my-instance');
    expect(config.mode).toBe('production');
    expect(config.logLevel).toBe('debug');
  });

  test('env vars are used when no overrides and no globalConfig', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: undefined as any,
      totalSessions: 0,
      totalTokens: 0,
      totalCost: 0,
    });

    process.env.OPENHORSE_API_KEY = 'env-key';
    process.env.OPENHORSE_MODEL = 'env-model';
    process.env.OPENHORSE_FALLBACK_MODEL = 'env-fallback';

    const config = loadConfig();
    expect(config.apiKey).toBe('env-key');
    expect(config.model).toBe('env-model');
    expect(config.fallbackModel).toBe('env-fallback');
  });

  test('globalConfig is used when no env or overrides', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      apiKey: 'global-key',
      apiBaseUrl: 'https://custom.api.com',
      defaultModel: 'glm-5',
      fallbackModel: 'qwen-plus',
      totalSessions: 10,
      totalTokens: 50000,
      totalCost: 2.50,
    });

    const config = loadConfig();
    expect(config.apiKey).toBe('global-key');
    expect(config.apiBaseUrl).toBe('https://custom.api.com');
    expect(config.model).toBe('glm-5');
    expect(config.fallbackModel).toBe('qwen-plus');
  });
});

describe('isConfigured', () => {
  test('returns false when no API key', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: 'gpt-4o',
      totalSessions: 0,
      totalTokens: 0,
      totalCost: 0,
    });

    const config = loadConfig();
    expect(isConfigured(config)).toBe(false);
  });

  test('returns true when API key is set', () => {
    const config = loadConfig({ apiKey: 'some-key' });
    expect(isConfigured(config)).toBe(true);
  });
});

describe('getConfigErrors', () => {
  test('returns error when no API key', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: 'gpt-4o',
      totalSessions: 0,
      totalTokens: 0,
      totalCost: 0,
    });

    const config = loadConfig();
    const errors = getConfigErrors(config);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('OPENHORSE_API_KEY');
  });

  test('returns empty when API key is set', () => {
    const config = loadConfig({ apiKey: 'some-key' });
    const errors = getConfigErrors(config);
    expect(errors.length).toBe(0);
  });
});

describe('getConfigSummary', () => {
  test('returns summary with masked API key', () => {
    const config = loadConfig({
      apiKey: 'sk-test-12345',
      model: 'gpt-4o',
      fallbackModel: 'claude-sonnet-4-6',
    });

    const summary = getConfigSummary(config);
    expect(summary.apiKey).toBe('sk-test***');
    expect(summary.model).toBe('gpt-4o');
    expect(summary.fallback).toBe('claude-sonnet-4-6');
  });
});
