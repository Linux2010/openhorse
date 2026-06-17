/**
 * openhorse - Ink/React CLI entry
 */

import 'dotenv/config';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { join } from 'path';
import { init, type OpenHorseRuntime } from './init';
import { LLMService } from './services/llm';
import { loadConfig, isConfigured, type UIRenderer } from './services/config';
import { ensureConfigDir } from './services/config-dir';
import { recordFirstStartTime, incrementSessionCount } from './services/global-config';
import { createSession, endSession, readSessionMessages, updateSessionSummary, type SessionMeta } from './services/session-storage';
import { loadAllMemories } from './memory/storage';
import { getSkillsRegistry } from './skills';
import { Store, subscribeToolState, resetToolState } from './framework';
import { getRuntimeTools } from './tools';
import { mcpManager } from './tools/mcp';
import { discoverModelContexts } from './services/model-context';
import { launchInkUI } from './ink-ui/launch';
import type { OpenHorseInkRuntime } from './ink-ui/types';

const BRAND = chalk.hex('#FF6B35');
const ACCENT = chalk.hex('#00D4AA');
const DIM = chalk.dim;
const ERROR = chalk.red;
const WARN = chalk.yellow;

const VERSION = (() => {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.2.0';
  } catch {
    return '0.2.0';
  }
})();

function showCliHelp(): void {
  console.log();
  console.log(BRAND('openhorse') + DIM(` v${VERSION}`));
  console.log(DIM('  Universal Agent Harness Framework'));
  console.log();
  console.log(ACCENT('Usage:'));
  console.log('  openhorse             Start the Ink/React interactive UI');
  console.log('  openhorse --help      Show this help message');
  console.log('  openhorse --version   Show version');
  console.log('  openhorse --ui ink    Start the Ink UI explicitly');
  console.log();
  console.log(ACCENT('Options:'));
  console.log('  -h, --help     Show help');
  console.log('  -v, --version  Show version');
  console.log('  --ui <mode>    UI renderer: ink');
  console.log();
  console.log(DIM('Legacy readline/v2 renderers were removed in v0.2.0.'));
  console.log();
}

function parseCliUIRenderer(args: string[]): UIRenderer {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = arg === '--ui'
      ? args[i + 1]
      : arg.startsWith('--ui=')
        ? arg.slice('--ui='.length)
        : undefined;

    if (value === undefined) continue;
    if (value === 'ink') return 'ink';

    if (value === 'legacy' || value === 'v2') {
      console.log(WARN(`Renderer "${value}" was removed in v0.2.0; starting Ink UI instead.`));
      return 'ink';
    }

    console.error(ERROR(`Invalid --ui value: ${value}`));
    console.error(DIM('Expected: ink'));
    process.exit(1);
  }

  return 'ink';
}

async function bootstrapRuntime(uiRenderer: UIRenderer): Promise<OpenHorseInkRuntime> {
  ensureConfigDir();
  recordFirstStartTime();

  const cwd = process.cwd();
  const config = loadConfig({ ui: { renderer: uiRenderer } });
  const memories = loadAllMemories(cwd);
  const memoryContent = memories.length > 0
    ? memories.map(memory => `## ${memory.name} (${memory.type})\n${memory.content}`).join('\n\n')
    : '';

  let skillsContent = '';
  try {
    const registry = getSkillsRegistry();
    skillsContent = registry.generateSystemPromptInjection();
  } catch {
    skillsContent = '';
  }

  const store = new Store({
    config,
    tools: getRuntimeTools(),
    currentModel: config.model,
    memoryContent,
    skillsContent,
  });

  resetToolState();
  subscribeToolState(state => {
    store.setState({
      todos: state.todos,
      planMode: state.planMode,
      currentPlan: state.currentPlan,
    });
  });

  let llm: LLMService | null = null;
  if (isConfigured(config)) {
    llm = new LLMService({
      apiKey: config.apiKey,
      baseUrl: config.apiBaseUrl,
      model: config.model,
      fallbackModel: config.fallbackModel,
    });

    if (config.apiBaseUrl) {
      discoverModelContexts(config.apiBaseUrl, config.apiKey).catch(() => undefined);
    }
  }

  const runtime: OpenHorseRuntime = await init({
    name: config.name,
    mode: config.mode as any,
    logLevel: config.logLevel,
  });
  await runtime.start();

  void (async () => {
    const originalLog = console.log;
    const originalError = console.error;
    try {
      console.log = () => undefined;
      console.error = () => undefined;
      await mcpManager.connectAll();
      store.setState({ tools: getRuntimeTools() });
    } catch {
      // MCP failures are surfaced through /mcp and tool errors.
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  })();

  let currentSession: SessionMeta | null = null;
  let shuttingDown = false;

  const ensureSession = (): SessionMeta => {
    if (!currentSession) {
      currentSession = createSession(cwd, store.getSnapshot().currentModel || store.getSnapshot().config.model);
      incrementSessionCount();
    }
    return currentSession;
  };

  const setSession = (session: SessionMeta | null): void => {
    currentSession = session;
  };

  const getSession = (): SessionMeta | null => currentSession;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    if (currentSession) {
      const messages = readSessionMessages(currentSession.id);
      if (messages.length > 0) {
        updateSessionSummary(currentSession.id, messages);
      }
      endSession(currentSession.id);
    }

    await mcpManager.disconnectAll();
    await runtime.shutdown();
  };

  return {
    cwd,
    version: VERSION,
    config,
    store,
    llm,
    runtime,
    isConfigured: isConfigured(config),
    ensureSession,
    setSession,
    getSession,
    shutdown,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    showCliHelp();
    process.exit(0);
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(`openhorse v${VERSION}`);
    process.exit(0);
  }

  const uiRenderer = parseCliUIRenderer(args);
  const runtime = await bootstrapRuntime(uiRenderer);
  await launchInkUI(runtime);
}

main().catch(async error => {
  console.error(ERROR('[OpenHorse] Fatal error:'), error);
  try {
    await mcpManager.disconnectAll();
  } catch {
    // ignore shutdown errors
  }
  process.exit(1);
});
