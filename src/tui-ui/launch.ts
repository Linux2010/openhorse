import { AgentRuntimeController, type AgentRuntimeInput } from '../runtime/agent-runtime-controller';
import { resolveUiRendererCapabilities, type OpenHorseUiRuntime, type SessionPickerRequest } from '../runtime/ui-events';
import { createStatusSnapshot } from '../runtime/ui-view-model';
import { TuiRunner } from './runner';
import { InlineTerminalSurface } from './inline-surface';

const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';
const SHOW_CURSOR = '\x1b[?25h';
const HIDE_CURSOR = '\x1b[?25l';

export interface TuiLaunchOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export async function launchTuiUI(
  runtime: OpenHorseUiRuntime,
  options: TuiLaunchOptions = {}
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  if (input.isTTY === false || output.isTTY === false) {
    throw new Error('TUI renderer requires a TTY input and output');
  }

  let runner!: TuiRunner;
  let controller!: AgentRuntimeController;
  let surface!: InlineTerminalSurface;
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
    // Primary-screen restore: NO alternate-screen exit, NO full clear.
    // Surface unmount clears only the ephemeral live region.
    await surface.unmount();
    output.write(`${SHOW_CURSOR}${DISABLE_BRACKETED_PASTE}`);
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
    if (stopping) return;
    const { width, height } = dimensions();
    runner.resize(width, height);
  };

  const handleSigint = (): void => {
    handleCtrlC();
  };

  // Primary-screen inline surface: no alternate screen (1049).
  // The runner continues to own frame rendering via its writer; the surface
  // manages the primary-screen lifecycle (mount/unmount/suspend/restore)
  // and will progressively take over live-region rendering in later slices.
  const { width, height } = dimensions();
  surface = new InlineTerminalSurface({ output });
  void surface.mount(width, height);
  output.write(`${ENABLE_BRACKETED_PASTE}${HIDE_CURSOR}`);
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
  const dispatchStatusSnapshot = (phase: 'ready' | 'running'): string => {
    const snapshot = createStatusSnapshot({
      renderer: 'tui',
      model: runtime.store.getSnapshot().currentModel || runtime.config.model,
      sessionId: runtime.getSession()?.id,
      costUsd: runtime.store.getSnapshot().costTracker.getSessionStats().totalCost,
      runningState: phase,
      tokens: tokensFromRuntime(runtime),
    });
    runner.dispatch({ type: 'setStatusSnapshot', snapshot, phase });
    return statusSnapshotString(runtime, phase);
  };
  controller = new AgentRuntimeController({
    runtime,
    events: runner.events,
    uiCapabilities: resolveUiRendererCapabilities(undefined, 'tui'),
    uiRenderer: 'tui',
    useRuntimeToolPermissions: true,
    runningStatus: () => dispatchStatusSnapshot('running'),
    readyStatus: () => dispatchStatusSnapshot('ready'),
  });
  runner.events.append({
    role: 'system',
    content: `OPENHORSE v${runtime.version}\nProject ${runtime.cwd}\n/ commands   @ files   ? shortcuts   Ctrl+C twice exits`,
  });
  runner.events.setStatus(statusSnapshotString(runtime, 'ready'));
  dispatchStatusSnapshot('ready');

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

function tokensFromRuntime(rt: OpenHorseUiRuntime): { input?: number; output?: number } {
  const usage = rt.store.getSnapshot().tokenUsage;
  if (!usage) return {};
  return { input: usage.promptTokens, output: usage.completionTokens };
}

function statusSnapshotString(rt: OpenHorseUiRuntime, left: string): string {
  const snapshot = rt.store.getSnapshot();
  const session = rt.getSession()?.id.slice(0, 8) ?? 'none';
  const tokens = snapshot.tokenUsage
    ? `${((snapshot.tokenUsage.promptTokens + snapshot.tokenUsage.completionTokens) / 1000).toFixed(1)}K`
    : '0.0K';
  const cost = snapshot.costTracker.getSessionStats().totalCost;
  return `${left}   model=${snapshot.currentModel || rt.config.model}  session=${session}  tokens=${tokens}  cost=$${cost.toFixed(4)}`;
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
