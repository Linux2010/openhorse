import { existsSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { getCommandCategoryLabel, getVisibleCommands } from '../commands';

export interface TuiPickerItem {
  value: string;
  label: string;
  description?: string;
}

export interface TuiFileQuery {
  base: string;
  query: string;
}

export function visibleCommandItems(input: string): TuiPickerItem[] {
  const query = input.startsWith('/') ? input.slice(1).toLowerCase() : '';
  return getVisibleCommands()
    .filter(command => {
      if (!query) return true;
      return command.name.startsWith(query) || command.aliases?.some(alias => alias.startsWith(query));
    })
    .sort((left, right) => commandMatchRank(left, query) - commandMatchRank(right, query))
    .map(command => ({
      value: command.name,
      label: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}${command.aliases?.length ? ` (${command.aliases.join(', ')})` : ''}`,
      description: `${getCommandCategoryLabel(command.category)}  ${command.description}`,
    }));
}

export function getFileQuery(input: string): TuiFileQuery | null {
  const match = input.match(/(^|\s)@([^\s]*)$/u);
  if (!match || match.index === undefined) return null;
  const atIndex = match.index + match[1].length;
  return {
    base: input.slice(0, atIndex),
    query: match[2] ?? '',
  };
}

export function visibleFileItems(cwd: string, input: string): TuiPickerItem[] {
  const fileQuery = getFileQuery(input);
  if (!fileQuery) return [];

  const rawQuery = fileQuery.query;
  const queryDir = rawQuery.endsWith('/') ? rawQuery : dirname(rawQuery);
  const prefix = rawQuery.endsWith('/') ? '' : rawQuery.split('/').pop() ?? '';
  const displayDir = queryDir === '.' ? '' : queryDir;
  const absoluteDir = resolve(cwd, displayDir || '.');

  if (!existsSync(absoluteDir)) return [];

  try {
    return readdirSync(absoluteDir)
      .filter(name => !prefix || name.toLowerCase().startsWith(prefix.toLowerCase()))
      .slice(0, 80)
      .map(name => {
        const absolute = join(absoluteDir, name);
        const isDirectory = statSync(absolute).isDirectory();
        const rel = relative(cwd, absolute) || name;
        return {
          value: isDirectory ? `${rel}/` : rel,
          label: `${isDirectory ? 'dir ' : 'file'} ${rel}${isDirectory ? '/' : ''}`,
          description: isDirectory ? 'directory' : 'file',
        };
      });
  } catch {
    return [];
  }
}

function commandMatchRank(command: { name: string; aliases?: string[] }, query: string): number {
  if (!query) return 0;
  const name = command.name.toLowerCase();
  const aliases = command.aliases?.map(alias => alias.toLowerCase()) ?? [];
  if (name === query) return 0;
  if (aliases.some(alias => alias === query)) return 1;
  if (name.startsWith(query)) return 2;
  if (aliases.some(alias => alias.startsWith(query))) return 3;
  return 4;
}
