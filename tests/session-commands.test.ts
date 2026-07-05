/**
 * Session command behavior tests.
 */

import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findCommand } from '../src/commands';
import { Store } from '../src/framework/store';
import { TOOLS } from '../src/tools';
import { loadConfig } from '../src/services/config';
import {
  appendSessionMessage,
  createSession,
  type SessionMeta,
} from '../src/services/session-storage';
import type { CommandContext } from '../src/commands/types';
import type { RuntimeSessionRestoredEvent } from '../src/runtime/ui-events';

describe('session commands', () => {
  const testConfigDir = mkdtempSync(join(tmpdir(), 'openhorse-session-commands-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'openhorse-project-'));
  const originalConfigDir = process.env.OPENHORSE_CONFIG_DIR;
  let logSpy: jest.SpyInstance;

  beforeAll(() => {
    process.env.OPENHORSE_CONFIG_DIR = testConfigDir;
  });

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  afterAll(() => {
    if (existsSync(testConfigDir)) {
      rmSync(testConfigDir, { recursive: true, force: true });
    }
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
    if (originalConfigDir !== undefined) {
      process.env.OPENHORSE_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.OPENHORSE_CONFIG_DIR;
    }
  });

  function makeContext(renderer: 'terminal' | 'ink' | 'tui' = 'terminal') {
    const config = loadConfig({
      apiKey: 'test-key',
      ui: { renderer, confirmations: 'config' },
    });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: 'gpt-4o',
    });
    const restored: SessionMeta[] = [];
    const sessionRestored: RuntimeSessionRestoredEvent[] = [];
    const ctx: CommandContext = {
      cwd: projectDir,
      config,
      store,
      llm: null,
      runtime: {} as any,
      setSession: session => restored.push(session),
      sessionRestored: event => sessionRestored.push(event),
      getSession: () => restored[restored.length - 1] ?? null,
    };

    return { ctx, restored, sessionRestored, store };
  }

  function createRestorableSession(content: string, withTool = false): SessionMeta {
    const session = createSession(projectDir, 'gpt-4o');
    appendSessionMessage(session.id, {
      role: 'user',
      content,
      timestamp: Date.now(),
    });
    if (withTool) {
      appendSessionMessage(session.id, {
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        tool_calls: [
          {
            id: 'call-read',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"package.json"}' },
          },
        ],
      });
    }
    return session;
  }

  test('/resume returns an interactive picker request for terminal when multiple sessions exist', async () => {
    createRestorableSession('first restorable session');
    createRestorableSession('second restorable session');
    const { ctx } = makeContext('terminal');

    const result = await findCommand('resume')!.execute(ctx, '');

    expect(result.success).toBe(true);
    expect(result.sessionPicker).toBeDefined();
    expect(result.sessionPicker?.sessions).toHaveLength(2);
    expect(result.sessionPicker?.title).toBe('Pick a Session');
  });

  test('/resume returns an interactive picker request for tui when multiple sessions exist', async () => {
    createRestorableSession('first tui restorable session');
    createRestorableSession('second tui restorable session');
    const { ctx } = makeContext('tui');

    const result = await findCommand('resume')!.execute(ctx, '');

    expect(result.success).toBe(true);
    expect(result.sessionPicker).toBeDefined();
    expect(result.sessionPicker?.sessions.length).toBeGreaterThanOrEqual(2);
    expect(result.sessionPicker?.maxVisibleItems).toBe(10);
  });

  test('/resume can fall back to printed picker when renderer adapter disables structured pickers', async () => {
    createRestorableSession('first printed restorable session');
    createRestorableSession('second printed restorable session');
    const { ctx } = makeContext('terminal');
    ctx.uiCapabilities = { structuredPickers: false };

    const result = await findCommand('resume')!.execute(ctx, '');

    expect(result.success).toBe(true);
    expect(result.sessionPicker).toBeUndefined();
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Use /resume <number|session-id|name>');
  });

  test('/resume <session-id> restores history and switches active session', async () => {
    const session = createRestorableSession('restore this exact session apiKey=sk-testsecret123456', true);
    const { ctx, restored, sessionRestored, store } = makeContext('terminal');

    const result = await findCommand('resume')!.execute(ctx, session.id);

    expect(result.success).toBe(true);
    expect(restored[0]?.id).toBe(session.id);
    expect(sessionRestored).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        projectPath: session.projectPath,
        model: 'gpt-4o',
        restoredMessages: 2,
        summary: 'Tools: read_file',
      }),
    ]);
    expect(sessionRestored[0].summary).not.toContain('restore this exact session');
    expect(sessionRestored[0].summary).not.toContain('sk-testsecret');
    const printed = logSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('apiKey=[REDACTED_SECRET]');
    expect(printed).not.toContain('sk-testsecret');
    expect(store.getSnapshot().conversationHistory).toEqual([
      { role: 'user', content: 'restore this exact session apiKey=sk-testsecret123456' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-read',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"package.json"}' },
          },
        ],
      },
    ]);
  });
});
