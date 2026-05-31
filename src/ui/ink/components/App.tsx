import React, { useState, useCallback } from 'react';
import { Box, Text, useApp, useInput, type Key } from 'ink';
import { StatusBar } from './StatusBar';
import { InputLine } from './InputLine';
import { CommandPanel } from './CommandPanel';

export interface AppProps {
  model?: string;
}

export function App({ model = 'glm-5' }: AppProps) {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [showPanel, setShowPanel] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [mode, setMode] = useState<string>('');

  // Input handling
  useInput(
    useCallback(
      (char: string, key: Key) => {
        if (showPanel) {
          // Command panel mode
          if (key.escape) {
            setShowPanel(false);
          }
          return;
        }

        // Normal input mode
        if (key.escape) {
          setShowPanel(false);
        }
        if (key.return) {
          if (input.trim()) {
            setMessages([...messages, input]);
            setInput('');
          }
        }
        if (key.backspace || key.delete) {
          setInput(input.slice(0, -1));
        }
        if (char === '/' && input === '') {
          setShowPanel(true);
        }
        if (char && !key.ctrl && !key.meta) {
          setInput(input + char);
        }
      },
      [input, showPanel, messages],
    ),
  );

  return (
    <Box flexDirection="column" height="100%">
      {/* Status bar */}
      <StatusBar model={model} tokens={0} cost={0} ctxPercent={0} />

      {/* Messages area */}
      <Box flexGrow={1} flexDirection="column">
        {messages.map((msg, i) => (
          <Text key={i}>{msg}</Text>
        ))}
      </Box>

      {/* Command panel */}
      {showPanel && <CommandPanel onSelect={() => setShowPanel(false)} />}

      {/* Input line */}
      <InputLine value={input} prompt="❯" modeIndicator={mode} />
    </Box>
  );
}