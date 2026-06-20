import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { Store } from '../src/framework/store';
import { loadConfig } from '../src/services/config';
import { collectDoctorReport, formatDoctorReport, hasDoctorFailures } from '../src/services/doctor';
import { TOOLS } from '../src/tools';
import { mcpManager } from '../src/tools/mcp';
import { findCommand } from '../src/commands';
import type { CommandContext } from '../src/commands/types';

const originalEnv = { ...process.env };

function makeRuntime() {
  return {
    brain: { getStatus: () => ({ agents: [], pendingTasks: 0, strategy: 'sequential' }) },
    memory: { getStatus: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }) },
    store: { getStats: () => ({ working: 0, 'short-term': 0, 'long-term': 0 }) },
  };
}

function makeLlm(model = 'mock-doctor') {
  return {
    getModel: () => model,
  };
}

describe('doctor report', () => {
  let configDir: string;
  let projectDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'openhorse-doctor-config-'));
    projectDir = mkdtempSync(join(tmpdir(), 'openhorse-doctor-project-'));
    mkdirSync(join(projectDir, '.git'));
    process.env.OPENHORSE_CONFIG_DIR = configDir;
    mcpManager.disconnectAll();
  });

  afterEach(() => {
    mcpManager.disconnectAll();
    if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
    if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it('reports actionable failures when the model is not configured', () => {
    const config = loadConfig();
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: config.model,
    });

    const report = collectDoctorReport({
      cwd: projectDir,
      config,
      store,
      llm: null,
      runtime: makeRuntime() as any,
    });
    const rendered = formatDoctorReport(report);

    expect(hasDoctorFailures(report)).toBe(true);
    expect(report.checks.find(check => check.id === 'config')?.status).toBe('fail');
    expect(rendered).toContain('Missing API key');
    expect(rendered).toContain('OpenHorse Doctor');
  });

  it('loads project rules and reports a healthy configured runtime', () => {
    writeFileSync(join(projectDir, 'AGENTS.md'), 'Follow repository rules.\n');
    const config = loadConfig({ apiKey: 'sk-test', model: 'mock-doctor' });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: config.model,
    });

    const report = collectDoctorReport({
      cwd: projectDir,
      config,
      store,
      llm: makeLlm('mock-doctor') as any,
      runtime: makeRuntime() as any,
    });

    expect(report.checks.find(check => check.id === 'config')?.status).toBe('ok');
    expect(report.checks.find(check => check.id === 'llm')?.summary).toContain('mock-doctor');
    expect(report.checks.find(check => check.id === 'project-instructions')?.summary).toContain('1 files');
    expect(store.getSnapshot().projectInstructionsContent).toContain('Follow repository rules.');
  });

  it('does not warn for ask tool confirmation in the stable terminal renderer', () => {
    const config = loadConfig({
      apiKey: 'sk-test',
      model: 'mock-doctor',
      toolConfirmation: 'ask',
      ui: { renderer: 'terminal', confirmations: 'config' },
    });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: config.model,
    });

    const report = collectDoctorReport({
      cwd: projectDir,
      config,
      store,
      llm: makeLlm('mock-doctor') as any,
      runtime: makeRuntime() as any,
    });

    expect(report.checks.find(check => check.id === 'permissions')?.status).toBe('ok');
  });

  it('warns when ask tool confirmation is configured for a non-terminal renderer', () => {
    const config = loadConfig({
      apiKey: 'sk-test',
      model: 'mock-doctor',
      toolConfirmation: 'ask',
      ui: { renderer: 'ink', confirmations: 'config' },
    });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: config.model,
    });

    const report = collectDoctorReport({
      cwd: projectDir,
      config,
      store,
      llm: makeLlm('mock-doctor') as any,
      runtime: makeRuntime() as any,
    });

    const permissions = report.checks.find(check => check.id === 'permissions');
    expect(permissions?.status).toBe('warn');
    expect(permissions?.detail).toContain('--ui terminal');
  });

  it('is exposed as /doctor slash command', async () => {
    const config = loadConfig({ apiKey: 'sk-test', model: 'mock-doctor' });
    const store = new Store({
      config,
      tools: TOOLS,
      currentModel: config.model,
    });
    const logs: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    try {
      const ctx: CommandContext = {
        cwd: projectDir,
        config,
        store,
        llm: makeLlm('mock-doctor') as any,
        runtime: makeRuntime() as any,
      };
      const result = await findCommand('doctor')!.execute(ctx, '');
      expect(result.success).toBe(true);
      expect(logs.join('\n')).toContain('OpenHorse Doctor');
      expect(logs.join('\n')).toContain('Tools:');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('openhorse doctor CLI', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'openhorse-doctor-cli-'));
  });

  afterEach(() => {
    if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
  });

  it('prints JSON diagnostics without entering the interactive UI', () => {
    const result = spawnSync(
      'node',
      ['-r', 'ts-node/register', 'src/cli.ts', 'doctor', '--output-format', 'json'],
      {
        cwd: join(__dirname, '..'),
        env: {
          ...process.env,
          OPENHORSE_CONFIG_DIR: configDir,
          OPENHORSE_API_KEY: 'sk-doctor',
          OPENHORSE_MODEL: 'mock-doctor',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
        encoding: 'utf8',
        timeout: 20000,
        maxBuffer: 1024 * 1024,
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('stable terminal UI');
    const parsed = JSON.parse(result.stdout);
    expect(parsed.checks.some((check: any) => check.id === 'config' && check.status === 'ok')).toBe(true);
    expect(parsed.checks.some((check: any) => check.id === 'tools')).toBe(true);
  });
});
