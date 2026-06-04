/**
 * v0.1.13 Ink UI 单元测试
 *
 * Tests verify component exports and basic module structure.
 * Note: Full rendering tests require a TTY context and are done manually.
 */

describe('Ink UI Components', () => {
  describe('StatusBar', () => {
    it('should export StatusBar component', () => {
      const mod = require('../src/ui/ink/components/StatusBar');
      expect(mod.StatusBar).toBeDefined();
      expect(typeof mod.StatusBar).toBe('function');
    });
  });

  describe('InputLine', () => {
    it('should export InputLine component', () => {
      const mod = require('../src/ui/ink/components/InputLine');
      expect(mod.InputLine).toBeDefined();
      expect(typeof mod.InputLine).toBe('function');
    });
  });

  describe('CommandPanel', () => {
    it('should export CommandPanel component', () => {
      const mod = require('../src/ui/ink/components/CommandPanel');
      expect(mod.CommandPanel).toBeDefined();
      expect(typeof mod.CommandPanel).toBe('function');
    });

    it('should have default commands', () => {
      const mod = require('../src/ui/ink/components/CommandPanel');
      expect(mod.DEFAULT_COMMANDS).toBeDefined();
      expect(Array.isArray(mod.DEFAULT_COMMANDS)).toBe(true);
      expect(mod.DEFAULT_COMMANDS.length).toBeGreaterThan(0);
      expect(mod.DEFAULT_COMMANDS[0].name).toBe('help');
    });
  });

  describe('App', () => {
    it('should export App component', () => {
      const mod = require('../src/ui/ink/components/App');
      expect(mod.App).toBeDefined();
      expect(typeof mod.App).toBe('function');
    });
  });
});

describe('Ink Framework', () => {
  // Skipped: requires full Ink module load with TTY-dependent imports
  it.skip('should export render from root', async () => {
    const mod = require('../src/ink/root');
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe('function');
  });

  it('should export useApp hook', () => {
    const mod = require('../src/ink/hooks/use-app');
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe('function');
  });

  it('should export useInput hook', () => {
    const mod = require('../src/ink/hooks/use-input');
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe('function');
  });

  it('should export Box component', () => {
    const mod = require('../src/ink/components/Box');
    expect(mod.default).toBeDefined();
  });

  it('should export Text component', () => {
    const mod = require('../src/ink/components/Text');
    expect(mod.default).toBeDefined();
  });
});

describe('LLM Integration', () => {
  it('should have chatStream method', () => {
    const { LLMService } = require('../src/services/llm');
    expect(LLMService).toBeDefined();

    const mockConfig = {
      apiKey: 'test-key',
      baseUrl: 'https://test.api',
      model: 'glm-5',
    };

    const service = new LLMService(mockConfig);
    expect(service.chatStream).toBeDefined();
    expect(typeof service.chatStream).toBe('function');
  });

  it('should have chat method', () => {
    const { LLMService } = require('../src/services/llm');
    const service = new LLMService({
      apiKey: 'test',
      baseUrl: 'test',
      model: 'test',
    });
    expect(service.chat).toBeDefined();
    expect(typeof service.chat).toBe('function');
  });
});

describe('Config Service', () => {
  it('should export loadConfig', () => {
    const { loadConfig } = require('../src/services/config');
    expect(loadConfig).toBeDefined();
    expect(typeof loadConfig).toBe('function');
  });
});
