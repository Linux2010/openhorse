import { AgentRuntimeController, type AgentRuntimeInput } from '../runtime/agent-runtime-controller';
import type { OpenHorseInkRuntime, SessionPickerRequest } from '../runtime/ui-events';
import { TuiRunner } from './runner';

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const EXIT_ALT_SCREEN = '\x1b[?1049l';
const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';
const SHOW_CURSOR = '\x1b[?25h';
const HIDE_CURSOR = '\x1b[?25l';

export interface TuiLaunchOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export async function launchTuiUI(
  runtime: OpenHorseInkRuntime,
  options: TuiLaunchOptions = {}
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  if (input.isTTY === false || output.isTTY === false) {
    throw new Error('TUI renderer requires a TTY input and output');
  }

  let runner!: TuiRunner;
  let controller!: AgentRuntimeController;
  let stopping = false;
  let settled = false;
  let resolveLaunch: (() => void) | null = null;

  const dimensions = () => {
    const size = readTtyDimensions(output);
    return {
      width: Math.max(24, size.width),
      height: Math.max(8, size.height),
    };
  };

  const finishLaunch = (): void => {
    if (settled) return;
    settled = true;
    resolveLaunch?.();
  };

  const cleanup = async (): Promise<void> => {
    input.off('data', handleData);
    output.off('resize', handleResize);
    process.off('SIGWINCH', handleResize);
    process.off('SIGINT', handleSigint);
    if (typeof input.setRawMode === 'function') {
      try {
        input.setRawMode(false);
      } catch {
        // best effort terminal restoration
      }
    }
    input.pause();
    output.write(`${SHOW_CURSOR}${DISABLE_BRACKETED_PASTE}${EXIT_ALT_SCREEN}`);
    await runtime.shutdown();
  };

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await controller.stopActiveTurn();
    await cleanup();
    finishLaunch();
  };

  const consumeSessionPickerSelection = (inputValue: string): string | AgentRuntimeInput => {
    const overlay = runner.getState().overlay;
    if (overlay?.type !== 'sessions') return inputValue;

    runner.dispatch({ type: 'closeOverlay' });
    const request: SessionPickerRequest = overlay.request;
    const trimmed = inputValue.trim();
    if (!trimmed) {
      const selected = request.sessions[overlay.selectedIndex];
      if (!selected) {
        runner.events.append({ role: 'error', content: 'No session selected.' });
        return '';
      }
      return { type: 'select_session', sessionId: selected.id, allProjects: request.allProjects, source: 'picker' };
    }

    if (trimmed.startsWith('/')) return trimmed;

    const numeric = trimmed.match(/^#?(\d+)$/);
    if (numeric) {
      const index = Number(numeric[1]) - 1;
      const selected = request.sessions[index];
      if (!selected) {
        runner.events.append({ role: 'error', content: `No session at index ${numeric[1]}.` });
        return '';
      }
      return { type: 'select_session', sessionId: selected.id, allProjects: request.allProjects, source: 'picker' };
    }

    return { type: 'select_session', sessionId: trimmed, allProjects: request.allProjects, source: 'picker' };
  };

  const submit = (rawInput: string): void => {
    const selectedInput = consumeSessionPickerSelection(rawInput);
    const runtimeInput: AgentRuntimeInput = typeof selectedInput === 'string'
      ? { type: 'submit', text: selectedInput.trim(), source: 'composer' }
      : selectedInput;
    if (runtimeInput.type === 'submit' && !runtimeInput.text) return;

    const result = controller.handle(runtimeInput);
    if (result.type === 'exit_requested') {
      void stop();
    }
  };

  const handleCtrlC = (): void => {
    if (runner.getState().overlay) {
      runner.dispatch({ type: 'closeOverlay' });
      controller.handle({ type: 'clear_exit_intent' });
      return;
    }

    const result = controller.handle({ type: 'interrupt', source: 'keyboard' });
    if (result.type === 'exit_requested') {
      void stop();
    }
  };

  const handleData = (chunk: Buffer): void => {
    if (!stopping) {
      runner.feedInput(chunk);
    }
  };

  const handleResize = (): void => {
    const { width, height } = dimensions();
    runner.resize(width, height);
  };

  const handleSigint = (): void => {
    handleCtrlC();
  };

  output.write(`${ENTER_ALT_SCREEN}${ENABLE_BRACKETED_PASTE}${HIDE_CURSOR}`);
  const { width, height } = dimensions();
  runner = new TuiRunner({
    output,
    width,
    height,
    cwd: runtime.cwd,
    onSubmit: submit,
    onCtrlC: handleCtrlC,
    onPermissionDecision: (requestId, approved) => {
      controller.handle({
        type: 'permission_decision',
        requestId,
        approved,
        source: 'keyboard',
      });
    },
  });
  controller = new AgentRuntimeController({
    runtime,
    events: runner.events,
    useRuntimeToolPermissions: true,
    runningStatus: () => statusSnapshot(runtime, 'running'),
    readyStatus: () => statusSnapshot(runtime, 'ready'),
  });
  runner.events.append({
    role: 'system',
    content: `OPENHORSE v${runtime.version}\nProject ${runtime.cwd}\n/ commands   @ files   ? shortcuts   Alt+Enter newline   Ctrl+C twice exits`,
  });
  runner.events.setStatus(statusSnapshot(runtime, 'ready'));

  input.resume();
  if (typeof input.setRawMode === 'function') {
    input.setRawMode(true);
  }
  input.on('data', handleData);
  output.on('resize', handleResize);
  process.on('SIGWINCH', handleResize);
  process.on('SIGINT', handleSigint);

  await new Promise<void>(resolve => {
    resolveLaunch = resolve;
  });
}

function statusSnapshot(runtime: OpenHorseInkRuntime, left: string): string {
  const snapshot = runtime.store.getSnapshot();
  const session = runtime.getSession()?.id.slice(0, 8) ?? 'none';
  const tokens = snapshot.tokenUsage
    ? `${((snapshot.tokenUsage.promptTokens + snapshot.tokenUsage.completionTokens) / 1000).toFixed(1)}K`
    : '0.0K';
  const cost = snapshot.costTracker.getSessionStats().totalCost;
  return `${left}   model=${snapshot.currentModel || runtime.config.model}  session=${session}  tokens=${tokens}  cost=$${cost.toFixed(4)}`;
}

function readTtyDimensions(output: NodeJS.WriteStream): { width: number; height: number } {
  const getWindowSize = (output as NodeJS.WriteStream & {
    getWindowSize?: () => [number, number];
  }).getWindowSize;

  if (typeof getWindowSize === 'function') {
    try {
      const [width, height] = getWindowSize.call(output);
      if (width > 0 && height > 0) {
        return { width, height };
      }
    } catch {
      // Fall back to cached columns/rows below.
    }
  }

  return {
    width: output.columns || 80,
    height: output.rows || 24,
  };
}
