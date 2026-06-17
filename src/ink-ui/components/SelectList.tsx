import React from 'react';
import { Box, Text } from 'ink';

export interface SelectListItem {
  label: string;
  description?: string;
  value: string;
}

export interface SelectListProps {
  title: string;
  items: SelectListItem[];
  selectedIndex: number;
  maxVisibleItems?: number;
  emptyText?: string;
  footer?: string;
}

function windowStartFor(selectedIndex: number, total: number, maxVisibleItems: number): number {
  if (total <= maxVisibleItems) return 0;
  const half = Math.floor(maxVisibleItems / 2);
  return Math.min(Math.max(0, selectedIndex - half), total - maxVisibleItems);
}

export function SelectList({
  title,
  items,
  selectedIndex,
  maxVisibleItems = 10,
  emptyText = 'No matches',
  footer = '↑↓ navigate  Enter select  Esc cancel',
}: SelectListProps): JSX.Element {
  const safeSelected = Math.max(0, Math.min(selectedIndex, Math.max(0, items.length - 1)));
  const start = windowStartFor(safeSelected, items.length, maxVisibleItems);
  const visible = items.slice(start, start + maxVisibleItems);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color="cyan">{title}</Text>
      {items.length === 0 ? (
        <Text color="gray">{emptyText}</Text>
      ) : (
        visible.map((item, offset) => {
          const index = start + offset;
          const selected = index === safeSelected;
          return (
            <Text key={`${item.value}:${index}`} color={selected ? 'black' : undefined} backgroundColor={selected ? 'cyan' : undefined}>
              {selected ? '› ' : '  '}
              {item.label}
              {item.description ? <Text color={selected ? 'black' : 'gray'}>  {item.description}</Text> : null}
            </Text>
          );
        })
      )}
      {items.length > maxVisibleItems ? (
        <Text color="gray">
          {start + 1}-{Math.min(start + maxVisibleItems, items.length)} / {items.length}
        </Text>
      ) : null}
      <Text color="gray">{footer}</Text>
    </Box>
  );
}
