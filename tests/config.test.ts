import { loadConfig, isConfigured, getConfigErrors, getConfigSummary } from '../src/services/config';

// Store original env
const originalEnv = { ...process.env };

function cleanEnv() {
  delete process.env.OPENHORSE_API_KEY;
  delete process.env.OPENHORSE_API_BASE_URL;
  delete process.env.OPENHORSE_BASE_URL;
  delete process.env.OPENHORSE_MODEL;
  delete process.env.OPENHORSE_MAX_TOKENS;
  delete process.env.OPENHORSE_TEMPERATURE;
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
    const config = loadConfig();
    expect(config.model).toBe('gpt-4o');
    expect(config.maxTokens).toBe(4096);
    expect(config.temperature).toBe(0.7);
    expect(config.name).toBe('openhorse');
    expect(config.mode).toBe('development');
    expect(config.logLevel).toBe('info');
    expect(config.apiKey).toBe('');
  });

  test('overrides take priority', () => {
    const config = loadConfig({
      apiKey: 'test-key',
      model: 'custom-model',
      maxTokens: 2048,
      temperature: 0.9,
      name: 'my-instance',
      mode: 'production',
      logLevel: 'debug',
    });
    expect(config.apiKey).toBe('test-key');
    expect(config.model).toBe('custom-model');
    expect(config.maxTokens).toBe(2048);
    expect(config.temperature).toBe(0.9);
    expect(config.name).toBe('my-instance');
    expect(config.mode).toBe('production');
    expect(config.logLevel).toBe('debug');
  });

  test('env vars are used when no overrides', () => {
    process.env.OPENHORSE_API_KEY = 'env-key';
    process.env.OPENHORSE_MODEL = 'env-model';
    process.env.OPENHORSE_MAX_TOKENS = '1024';
    process.env.OPENHORSE_TEMPERATURE = '0.5';
    process.env.OPENHORSE_NAME = 'env-name';
    process.env.OPENHORSE_MODE = 'production';
    process.env.OPENHORSE_LOG_LEVEL = 'warn';

    const config = loadConfig();
    expect(config.apiKey).toBe('env-key');
    expect(config.model).toBe('env-model');
    expect(config.maxTokens).toBe(1024);
    expect(config.temperature).toBe(0.5);
    expect(config.name).toBe('env-name');
    expect(config.mode).toBe('production');
    expect(config.logLevel).toBe('warn');
  });

  test('overrides take priority over env vars', () => {
    process.env.OPENHORSE_API_KEY = 'env-key';
    process.env.OPENHORSE_MODEL = 'env-model';

    const config = loadConfig({ apiKey: 'override-key' });
    expect(config.apiKey).toBe('override-key');
    expect(config.model).toBe('env-model');
  });

  test('OPENHORSE_API_BASE_URL takes priority over OPENHORSE_BASE_URL', () => {
    process.env.OPENHORSE_API_BASE_URL = 'https://api-base.example.com';
    process.env.OPENHORSE_BASE_URL = 'https://base.example.com';

    const config = loadConfig();
    expect(config.apiBaseUrl).toBe('https://api-base.example.com');
  });

  test('falls back to OPENHORSE_BASE_URL when API_BASE_URL not set', () => {
    process.env.OPENHORSE_BASE_URL = 'https://base.example.com';

    const config = loadConfig();
    expect(config.apiBaseUrl).toBe('https://base.example.com');
  });

  test('ignores invalid numeric env values', () => {
    process.env.OPENHORSE_MAX_TOKENS = 'not-a-number';
    process.env.OPENHORSE_TEMPERATURE = 'abc';

    const config = loadConfig();
    expect(config.maxTokens).toBe(4096);
    expect(config.temperature).toBe(0.7);
  });

  test('apiBaseUrl defaults to undefined when not set', () => {
    const config = loadConfig();
    expect(config.apiBaseUrl).toBeUndefined();
  });
});

describe('isConfigured', () => {
  test('returns true when apiKey is set', () => {
    const config = loadConfig({ apiKey: 'some-key' });
    expect(isConfigured(config)).toBe(true);
  });

  test('returns false when apiKey is empty', () => {
    const config = loadConfig();
    expect(isConfigured(config)).toBe(false);
  });
});

describe('getConfigErrors', () => {
  test('returns error when apiKey is missing', () => {
    const config = loadConfig();
    const errors = getConfigErrors(config);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('OPENHORSE_API_KEY');
  });

  test('returns no errors when apiKey is set', () => {
    const config = loadConfig({ apiKey: 'key' });
    const errors = getConfigErrors(config);
    expect(errors).toHaveLength(0);
  });
});

describe('getConfigSummary', () => {
  test('hides api key partially', () => {
    const config = loadConfig({ apiKey: 'sk-1234567890' });
    const summary = getConfigSummary(config);
    expect(summary.apiKey).toBe('sk-1234***');
  });

  test('shows (not set) when apiKey is empty', () => {
    const config = loadConfig();
    const summary = getConfigSummary(config);
    expect(summary.apiKey).toBe('(not set)');
  });

  test('includes all config fields', () => {
    const config = loadConfig({ apiKey: 'key' });
    const summary = getConfigSummary(config);
    expect(summary).toHaveProperty('name');
    expect(summary).toHaveProperty('model');
    expect(summary).toHaveProperty('apiBaseUrl');
    expect(summary).toHaveProperty('apiKey');
    expect(summary).toHaveProperty('maxTokens');
    expect(summary).toHaveProperty('temperature');
    expect(summary).toHaveProperty('mode');
    expect(summary).toHaveProperty('logLevel');
  });
});
