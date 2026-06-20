import { getVisibleCommands } from '../commands';
import { matchFiles } from '../services/file-glob';

export type ReadlineCompleter = (line: string) => [string[], string];

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0];
  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

export function completeSlashCommand(line: string): [string[], string] {
  const match = line.match(/^\/([^\s]*)$/u);
  if (!match) return [[], line];

  const partial = match[1];
  const commands = getVisibleCommands();
  const nameMatches = commands.filter(command => command.name.startsWith(partial));
  const aliasMatches = nameMatches.length > 0
    ? []
    : commands.filter(command => command.aliases?.some(alias => alias.startsWith(partial)));
  const completions = [...nameMatches, ...aliasMatches].map(command => `/${command.name} `);

  return [unique(completions), line];
}

export function completeFileMention(line: string, cwd: string): [string[], string] {
  const match = line.match(/(^|\s)@([^\s]*)$/u);
  if (!match || match.index === undefined) return [[], line];

  const atIndex = match.index + match[1].length;
  const query = match[2];
  const prefix = line.slice(0, atIndex + 1);
  const completions = matchFiles(query, cwd).map(file =>
    `${prefix}${file.path}${file.isDirectory ? '/' : ' '}`
  );

  return [unique(completions), line];
}

export function createTerminalCompleter(cwd: string): ReadlineCompleter {
  return (line: string): [string[], string] => {
    const slash = completeSlashCommand(line);
    if (slash[0].length > 0) return slash;

    return completeFileMention(line, cwd);
  };
}

export function applyTerminalTabCompletion(input: string, cwd: string): string {
  if (!input.includes('\t')) return input;

  const completer = createTerminalCompleter(cwd);
  let current = '';
  for (const chunk of input.split(/(\t+)/u)) {
    if (!chunk) continue;
    if (!chunk.includes('\t')) {
      current += chunk;
      continue;
    }

    for (let i = 0; i < chunk.length; i++) {
      const [matches] = completer(current);
      if (matches.length === 1) {
        current = matches[0];
        continue;
      }

      const prefix = commonPrefix(matches);
      if (prefix && prefix.length > current.length) {
        current = prefix;
      }
    }
  }

  return current;
}
