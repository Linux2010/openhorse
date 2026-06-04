import React from 'react';
import Box from '../../../ink/components/Box.js';
import Text from '../../../ink/components/Text.js';

export interface InputLineProps {
  value: string;
  prompt: string;
  modeIndicator?: string;
}

export function InputLine({ value, prompt, modeIndicator }: InputLineProps) {
  return (
    <Box>
      <Text color="cyan" bold>
        {prompt}{' '}
      </Text>
      {modeIndicator && (
        <Text dimColor>
          [{modeIndicator}]{' '}
        </Text>
      )}
      <Text>{value}</Text>
    </Box>
  );
}