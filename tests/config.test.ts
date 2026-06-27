import {
  loadConfig,
  isConfigured,
  getConfigErrors,
  getConfigSummary,
  isBetaUIRenderer,
  isInteractiveUIRenderer,
  isSupportedUIRenderer,
  resolveUIRenderer,
  SUPPORTED_UI_RENDERERS,
} from '../src/services/config';

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
  delete process.env.OPENHORSE_TOOL_CONFIRMATION;
  delete process.env.OPENHORSE_UI;
  delete process.env.OPENHORSE_UI_RENDERER;
  delete process.env.OPENHORSE_UI_CONFIRMATIONS;
  delete process.env.OPENHORSE_WEBSEARCH_API_KEY;
  delete process.env.OPENHORSE_WEBSEARCH_PROVIDER;
  delete process.env.OPENHORSE_WEBSEARCH_MCP_PROVIDER;
  delete process.env.OPENHORSE_WEBSEARCH_MCP_ENDPOINT;
  delete process.env.OPENHORSE_WEBSEARCH_MCP_TOOL;
  delete process.env.OPENHORSE_WEBSEARCH_MCP_TIMEOUT_MS;
  delete process.env.OPENHORSE_WEBSEARCH_AUTH_TYPE;
  delete process.env.OPENHORSE_WEBSEARCH_API_KEY_HEADER;
  delete process.env.OPENHORSE_WEBSEARCH_API_KEY_QUERY_PARAM;
  delete process.env.DASHSCOPE_API_KEY;
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
    expect(config.toolConfirmation).toBe('allow');
    expect(config.ui).toEqual({ renderer: 'terminal', confirmations: 'config' });
  });

  test('overrides take priority', () => {
    const config = loadConfig({
      apiKey: 'test-key',
      model: 'custom-model',
      fallbackModel: 'backup-model',
      name: 'my-instance',
      mode: 'production',
      logLevel: 'debug',
      toolConfirmation: 'deny',
      ui: { renderer: 'ink', confirmations: 'interactive' },
    });
    expect(config.apiKey).toBe('test-key');
    expect(config.model).toBe('custom-model');
    expect(config.fallbackModel).toBe('backup-model');
    expect(config.name).toBe('my-instance');
    expect(config.mode).toBe('production');
    expect(config.logLevel).toBe('debug');
    expect(config.toolConfirmation).toBe('deny');
    expect(config.ui).toEqual({ renderer: 'ink', confirmations: 'interactive' });
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
    process.env.OPENHORSE_TOOL_CONFIRMATION = 'ask';
    process.env.OPENHORSE_UI_RENDERER = 'ink';
    process.env.OPENHORSE_UI_CONFIRMATIONS = 'interactive';
    process.env.OPENHORSE_WEBSEARCH_API_KEY = 'sk-websearch-env';
    process.env.OPENHORSE_WEBSEARCH_PROVIDER = 'tavily';
    process.env.OPENHORSE_WEBSEARCH_MCP_ENDPOINT = 'https://example.com/mcp';
    process.env.OPENHORSE_WEBSEARCH_MCP_TOOL = 'search';
    process.env.OPENHORSE_WEBSEARCH_MCP_TIMEOUT_MS = '12345';
    process.env.OPENHORSE_WEBSEARCH_AUTH_TYPE = 'query';
    process.env.OPENHORSE_WEBSEARCH_API_KEY_QUERY_PARAM = 'tavilyApiKey';

    const config = loadConfig();
    expect(config.apiKey).toBe('env-key');
    expect(config.model).toBe('env-model');
    expect(config.fallbackModel).toBe('env-fallback');
    expect(config.toolConfirmation).toBe('ask');
    expect(config.ui).toEqual({ renderer: 'terminal', confirmations: 'interactive' });
    expect(config.webSearch).toEqual({
      apiKey: 'sk-websearch-env',
      provider: 'tavily',
      endpoint: 'https://example.com/mcp',
      toolName: 'search',
      timeoutMs: 12345,
      authType: 'query',
      apiKeyQueryParam: 'tavilyApiKey',
    });
  });

  test('globalConfig is used when no env or overrides', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      apiKey: 'global-key',
      apiBaseUrl: 'https://custom.api.com',
      defaultModel: 'glm-5',
      fallbackModel: 'qwen-plus',
      toolConfirmation: 'deny',
      webSearch: {
        endpoint: 'https://dashscope.example/mcp',
        apiKey: 'sk-websearch-global',
        toolName: 'web_search',
      },
      ui: {
        renderer: 'ink',
        confirmations: 'interactive',
      },
      totalSessions: 10,
      totalTokens: 50000,
      totalCost: 2.50,
    });

    const config = loadConfig();
    expect(config.apiKey).toBe('global-key');
    expect(config.apiBaseUrl).toBe('https://custom.api.com');
    expect(config.model).toBe('glm-5');
    expect(config.fallbackModel).toBe('qwen-plus');
    expect(config.toolConfirmation).toBe('deny');
    // openhorse.json no longer controls renderer; terminal is the product default.
    expect(config.ui).toEqual({ renderer: 'terminal', confirmations: 'interactive' });
    expect(config.webSearch?.endpoint).toBe('https://dashscope.example/mcp');
    expect(config.webSearch?.apiKey).toBe('sk-websearch-global');
    expect(config.webSearch?.toolName).toBe('web_search');
  });

  test('cli renderer override can switch to experimental ink beta', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: 'gpt-4o',
      ui: {
        renderer: 'ink',
        confirmations: 'config',
      },
      totalSessions: 0,
      totalTokens: 0,
      totalCost: 0,
    });

    const config = loadConfig({ ui: { renderer: 'ink' } });
    expect(config.ui).toEqual({ renderer: 'ink', confirmations: 'config' });
  });

  test('cli renderer override can switch to renderer-owned tui preview', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: 'gpt-4o',
      totalSessions: 0,
      totalTokens: 0,
      totalCost: 0,
    });

    const config = loadConfig({ ui: { renderer: 'tui' } });
    expect(config.ui).toEqual({ renderer: 'tui', confirmations: 'config' });
  });

  test('ignores env renderer so npm run start stays on the stable terminal UI', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: 'gpt-4o',
      totalSessions: 0,
      totalTokens: 0,
      totalCost: 0,
    });

    process.env.OPENHORSE_UI = 'ink';
    process.env.OPENHORSE_UI_RENDERER = 'ink';

    const config = loadConfig();
    expect(config.ui).toEqual({ renderer: 'terminal', confirmations: 'config' });
  });

  test('ignores invalid tool confirmation values', () => {
    jest.spyOn(require('../src/services/global-config'), 'loadGlobalConfig').mockReturnValue({
      defaultModel: 'gpt-4o',
      toolConfirmation: 'invalid',
      totalSessions: 0,
      totalTokens: 0,
      totalCost: 0,
    });

    process.env.OPENHORSE_TOOL_CONFIRMATION = 'also-invalid';
    process.env.OPENHORSE_UI = 'invalid';
    process.env.OPENHORSE_UI_CONFIRMATIONS = 'also-invalid';

    const config = loadConfig();
    expect(config.toolConfirmation).toBe('allow');
    expect(config.ui).toEqual({ renderer: 'terminal', confirmations: 'config' });
  });
});

describe('UI renderer helpers', () => {
  test('defines terminal as stable and ink/tui as explicit beta renderers', () => {
    expect(SUPPORTED_UI_RENDERERS).toEqual(['terminal', 'tui', 'ink']);
    expect(resolveUIRenderer('stable')).toBe('terminal');
    expect(resolveUIRenderer('terminal')).toBe('terminal');
    expect(resolveUIRenderer('tui')).toBe('tui');
    expect(resolveUIRenderer('ink')).toBe('ink');
    expect(resolveUIRenderer('legacy')).toBeUndefined();
    expect(resolveUIRenderer('v2')).toBeUndefined();
  });

  test('keeps renderer capability checks centralized', () => {
    expect(isSupportedUIRenderer('terminal')).toBe(true);
    expect(isInteractiveUIRenderer('ink')).toBe(true);
    expect(isBetaUIRenderer('ink')).toBe(true);
    expect(isBetaUIRenderer('tui')).toBe(true);
    expect(isBetaUIRenderer('terminal')).toBe(false);
    expect(isSupportedUIRenderer('print')).toBe(false);
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
    expect(summary.toolConfirmation).toBe('allow');
    expect(summary.ui).toBe('terminal/config');
    expect(summary.webSearch).toBe('(default)');
  });
});
