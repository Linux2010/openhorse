/**
 * openhorse - API Compatibility Tests
 *
 * Ensure public exports from src/index.ts are stable and callable.
 * Run before publishing patch releases to prevent breaking changes.
 */

import * as openhorse from '../src/index';

describe('Public API', () => {
  describe('Core exports', () => {
    it('exports Brain', () => {
      expect(openhorse.Brain).toBeDefined();
      expect(typeof openhorse.Brain).toBe('function');
    });

    it('exports BaseAgent', () => {
      expect(openhorse.BaseAgent).toBeDefined();
      expect(typeof openhorse.BaseAgent).toBe('function');
    });

    it('exports LeaderAgent', () => {
      expect(openhorse.LeaderAgent).toBeDefined();
      expect(typeof openhorse.LeaderAgent).toBe('function');
    });

    it('exports CoderAgent', () => {
      expect(openhorse.CoderAgent).toBeDefined();
      expect(typeof openhorse.CoderAgent).toBe('function');
    });

    it('exports init', () => {
      expect(openhorse.init).toBeDefined();
      expect(typeof openhorse.init).toBe('function');
    });
  });

  describe('SDK compatibility', () => {
    it('exports HarnessEngine for backward compatibility', () => {
      expect(openhorse.HarnessEngine).toBeDefined();
      expect(typeof openhorse.HarnessEngine).toBe('function');
    });

    it('exports SafetyChecker', () => {
      expect(openhorse.SafetyChecker).toBeDefined();
      expect(typeof openhorse.SafetyChecker).toBe('function');
    });
  });

  describe('Framework exports', () => {
    it('exports buildTool', () => {
      expect(openhorse.buildTool).toBeDefined();
      expect(typeof openhorse.buildTool).toBe('function');
    });

    it('exports toOpenAITool', () => {
      expect(openhorse.toOpenAITool).toBeDefined();
      expect(typeof openhorse.toOpenAITool).toBe('function');
    });

    it('exports query', () => {
      expect(openhorse.query).toBeDefined();
      expect(typeof openhorse.query).toBe('function');
    });

    it('exports buildSystemPrompt', () => {
      expect(openhorse.buildSystemPrompt).toBeDefined();
      expect(typeof openhorse.buildSystemPrompt).toBe('function');
    });

    it('exports getSystemPrompt', () => {
      expect(openhorse.getSystemPrompt).toBeDefined();
      expect(typeof openhorse.getSystemPrompt).toBe('function');
    });

    it('exports Store', () => {
      expect(openhorse.Store).toBeDefined();
      expect(typeof openhorse.Store).toBe('function');
    });

    it('exports ContextHarness', () => {
      expect(openhorse.ContextHarness).toBeDefined();
      expect(typeof openhorse.ContextHarness).toBe('function');
    });

    it('exports ContextLedger', () => {
      expect(openhorse.ContextLedger).toBeDefined();
    });

    it('exports createContextCapsule', () => {
      expect(openhorse.createContextCapsule).toBeDefined();
      expect(typeof openhorse.createContextCapsule).toBe('function');
    });
  });

  describe('Tool API shape', () => {
    it('buildTool returns valid OpenHorseTool', () => {
      const tool = openhorse.buildTool({
        name: 'test_tool',
        description: 'A test tool',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Input' },
          },
          required: ['input'],
        },
        execute: async () => ({ success: true, output: 'done' }),
      });

      expect(tool.name).toBe('test_tool');
      expect(tool.description).toBe('A test tool');
      expect(tool.parameters).toEqual({
        type: 'object',
        properties: { input: { type: 'string', description: 'Input' } },
        required: ['input'],
      });
      expect(typeof tool.execute).toBe('function');
      expect(typeof tool.isReadOnly).toBe('function');
      expect(typeof tool.isDestructive).toBe('function');
      expect(typeof tool.isConcurrencySafe).toBe('function');
    });

    it('toOpenAITool converts to OpenAI format', () => {
      const tool = openhorse.buildTool({
        name: 'my_tool',
        description: 'My tool',
        parameters: {
          type: 'object',
          properties: { x: { type: 'string', description: 'X' } },
          required: ['x'],
        },
        execute: async () => ({ success: true, output: 'ok' }),
      });

      const openAI = openhorse.toOpenAITool(tool);
      expect(openAI.type).toBe('function');
      expect(openAI.function.name).toBe('my_tool');
      expect(openAI.function.description).toBe('My tool');
      expect(openAI.function.parameters).toEqual({
        type: 'object',
        properties: { x: { type: 'string', description: 'X' } },
        required: ['x'],
      });
    });
  });

  describe('Type exports exist', () => {
    // These verify that TypeScript types are exported (no runtime check needed)
    it('has expected type exports available at build time', () => {
      // Type-only exports are compiled away, but we can verify the module structure
      const exports = Object.keys(openhorse);
      expect(exports).toContain('buildTool');
      expect(exports).toContain('query');
      expect(exports).toContain('ContextHarness');
      expect(exports).toContain('HarnessEngine');
    });
  });
});
