import React from 'react';
import { ReplScreen } from './screens/ReplScreen';
import type { OpenHorseInkRuntime } from './types';

export interface AppProps {
  runtime: OpenHorseInkRuntime;
}

export function App({ runtime }: AppProps): JSX.Element {
  return <ReplScreen runtime={runtime} />;
}
