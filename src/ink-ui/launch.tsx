import React from 'react';
import { render } from 'ink';
import { App } from './App';
import { createNativeCursorController } from './runtime/native-cursor';
import type { OpenHorseUiRuntime } from './types';

type RawModeStream = NodeJS.ReadStream & {
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => NodeJS.ReadStream;
};

export function prepareInkStdin(stdin: RawModeStream = process.stdin): () => void {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return () => undefined;
  }

  const wasRaw = stdin.isRaw === true;
  stdin.setEncoding('utf8');
  stdin.resume();
  stdin.setRawMode(true);

  return () => {
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return;
    stdin.setRawMode(wasRaw);
    if (wasRaw) stdin.resume();
  };
}

export async function launchInkUI(runtime: OpenHorseUiRuntime): Promise<void> {
  const restoreStdin = prepareInkStdin(process.stdin);
  const cursorController = createNativeCursorController(process.stdout);
  let resizeEpoch = 0;
  let resizeTimer: NodeJS.Timeout | undefined;
  const viewportReset = '\x1b[2J\x1b[H';
  const app = () => <App runtime={runtime} cursorController={cursorController} resizeEpoch={resizeEpoch} />;
  const instance = render(app(), {
    exitOnCtrlC: false,
    stdout: cursorController.wrapStdout(),
  });
  const handleResize = () => {
    resizeEpoch += 1;
    if (resizeTimer) clearTimeout(resizeTimer);

    cursorController.resetForViewportClear();
    instance.clear();
    if (process.stdout.isTTY) {
      process.stdout.write(viewportReset);
    }
    cursorController.resetForViewportClear();

    resizeTimer = setTimeout(() => {
      cursorController.resetForViewportClear();
      instance.rerender(app());
    }, 16);
  };
  if (typeof process.stdout.prependListener === 'function') {
    process.stdout.prependListener('resize', handleResize);
  } else {
    process.stdout.on?.('resize', handleResize);
  }

  try {
    await instance.waitUntilExit();
  } finally {
    process.stdout.off?.('resize', handleResize);
    if (resizeTimer) clearTimeout(resizeTimer);
    cursorController.disable();
    instance.clear();
    restoreStdin();
  }
}
