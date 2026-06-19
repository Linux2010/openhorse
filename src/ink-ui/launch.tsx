import React from 'react';
import { render } from 'ink';
import { App } from './App';
import { createInkStdout } from './runtime/stdout';
import type { OpenHorseInkRuntime } from './types';

export async function launchInkUI(runtime: OpenHorseInkRuntime): Promise<void> {
  const instance = render(<App runtime={runtime} />, {
    exitOnCtrlC: false,
    stdout: createInkStdout(process.stdout),
  });
  await instance.waitUntilExit();
}
