import React, { useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';

export interface Command {
  name: string;
  description: string;
  type: 'chat' | 'cmd';
}

export interface CommandPanelProps {
  commands?: Command[];
  onSelect?: (command: Command) => void;
}

const DEFAULT_COMMANDS: Command[] = [
  { name: 'help', description: 'Show available commands', type: 'cmd' },
  { name: 'exit', description: 'Exit the REPL', type: 'cmd' },
  { name: 'model', description: 'Show or change model', type: 'cmd' },
  { name: 'status', description: 'Show system status', type: 'cmd' },
  { name: 'compact', description: 'Compact conversation', type: 'cmd' },
  { name: 'chat', description: 'Send message to LLM', type: 'chat' },
];

export function CommandPanel({ commands = DEFAULT_COMMANDS, onSelect }: CommandPanelProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((_: string, key: Key) => {
    if (key.upArrow) {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    }
    if (key.downArrow) {
      setSelectedIndex(Math.min(commands.length - 1, selectedIndex + 1));
    }
    if (key.return) {
      const selected = commands[selectedIndex];
      onSelect?.(selected);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray">
      <Text bold color="cyan">
        Commands
      </Text>
      {commands.map((cmd, i) => (
        <Box key={cmd.name}>
          <Text color={i === selectedIndex ? 'green' : 'white'} bold={i === selectedIndex}>
            {i === selectedIndex ? '❯ ' : '  '}
            /{cmd.name}
          </Text>
          <Text dimColor> - {cmd.description}</Text>
        </Box>
      ))}
      <Text dimColor>↑↓ Navigate | Enter Select | Esc Cancel</Text>
    </Box>
  );
}