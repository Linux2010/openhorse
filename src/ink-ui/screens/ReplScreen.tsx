import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { existsSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { getCommands } from '../../commands';
import { parseInput } from '../../commands/parser';
import { getModeDisplayText } from '../../commands/types';
import { TurnController } from '../../runtime/turn-controller';
import { addToInputHistory, getInputHistory } from '../../services/global-config';
import { formatBytes } from '../../ui-v2/state/sessions';
import type { SessionMeta } from '../../services/session-storage';
import { PromptInput } from '../components/PromptInput';
import { PixelHorseBanner } from '../components/PixelHorseBanner';
import { SelectList, type SelectListItem } from '../components/SelectList';
import { StatusLine } from '../components/StatusLine';
import { TerminalCursor } from '../components/TerminalCursor';
import { Transcript } from '../components/Transcript';
import { InkChatController } from '../controllers/chat-controller';
import type { OpenHorseInkRuntime, SessionPickerRequest, TranscriptEntry, UiEventSink } from '../types';

type Overlay =
  | { type: 'commands'; selectedIndex: number }
  | { type: 'files'; selectedIndex: number }
  | { type: 'sessions'; selectedIndex: number; request: SessionPickerRequest }
  | { type: 'shortcuts' }
  | null;

let nextTranscriptId = 1;

function createId(): string {
  return `ui-${nextTranscriptId++}`;
}

export function visibleCommandItems(input: string): SelectListItem[] {
  const query = input.startsWith('/') ? input.slice(1).toLowerCase() : '';
  return getCommands()
    .filter(command => !command.isHidden)
    .filter(command => {
      if (!query) return true;
      return command.name.startsWith(query) || command.aliases?.some(alias => alias.startsWith(query));
    })
    .map(command => ({
      value: command.name,
      label: `/${command.name}${command.aliases?.length ? ` (${command.aliases.join(', ')})` : ''}`,
      description: command.description,
    }));
}

export function getFileQuery(input: string): { base: string; query: string } | null {
  const match = input.match(/(^|\s)@([^\s]*)$/);
  if (!match || match.index === undefined) return null;
  const atIndex = match.index + match[1].length;
  return {
    base: input.slice(0, atIndex),
    query: match[2] ?? '',
  };
}

export function visibleFileItems(cwd: string, input: string): SelectListItem[] {
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
        const isDir = statSync(absolute).isDirectory();
        const rel = relative(cwd, absolute) || name;
        return {
          value: isDir ? `${rel}/` : rel,
          label: `${isDir ? 'dir ' : 'file'} ${rel}${isDir ? '/' : ''}`,
          description: isDir ? 'directory' : 'file',
        };
      });
  } catch {
    return [];
  }
}

function sessionTitle(session: SessionMeta): string {
  return session.name || session.taskSummary || '(untitled)';
}

export function sessionItems(request: SessionPickerRequest): SelectListItem[] {
  return request.sessions.map(session => ({
    value: session.id,
    label: `${session.id.slice(0, 8)}  ${sessionTitle(session)}`,
    description: [
      `${session.messageCount ?? 0} msgs`,
      formatBytes(session.historySizeBytes ?? 0),
      session.model,
      request.showProject ? session.projectPath : '',
    ].filter(Boolean).join('  '),
  }));
}

function isExitCommand(input: string): boolean {
  const parsed = parseInput(input.trim());
  return parsed.isCommand && ['exit', 'quit', 'q'].includes(parsed.name);
}

export interface ReplScreenProps {
  runtime: OpenHorseInkRuntime;
}

export function ReplScreen({ runtime }: ReplScreenProps): JSX.Element {
  const app = useApp();
  const { stdout } = useStdout();
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [input, setInput] = useState('');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [processing, setProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [history, setHistory] = useState(() => getInputHistory());
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [, setStoreVersion] = useState(0);
  const turnControllerRef = useRef(new TurnController({ exitConfirmWindowMs: 5000 }));
  const runningRef = useRef(false);
  const inputRef = useRef('');

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => runtime.store.subscribe(() => setStoreVersion(version => version + 1)), [runtime.store]);

  const append = useCallback((entry: Omit<TranscriptEntry, 'id'>): string => {
    const id = createId();
    setTranscript(current => [...current, { id, ...entry }]);
    return id;
  }, []);

  const update = useCallback((id: string, patch: Partial<Omit<TranscriptEntry, 'id'>>) => {
    setTranscript(current => current.map(entry => entry.id === id ? { ...entry, ...patch } : entry));
  }, []);

  const events: UiEventSink = useMemo(() => ({
    append,
    update,
    clearTranscript: () => setTranscript([]),
    setStatus: setStatusMessage,
    showSessionPicker: request => setOverlay({ type: 'sessions', selectedIndex: 0, request }),
    setProcessing,
  }), [append, update]);

  const controller = useMemo(() => new InkChatController(runtime, events), [runtime, events]);

  const shutdown = useCallback(async () => {
    await runtime.shutdown();
    app.exit();
  }, [app, runtime]);

  const appendSubmittedInput = useCallback((value: string) => {
    const parsed = parseInput(value.trim());
    append({
      role: parsed.isCommand ? 'command' : 'user',
      title: parsed.isCommand ? 'command' : 'you',
      content: value,
    });
  }, [append]);

  const runTurn = useCallback(async (firstInput: string) => {
    let nextInput: string | undefined = firstInput;

    while (nextInput && nextInput.trim()) {
      appendSubmittedInput(nextInput);
      const turn = turnControllerRef.current.beginTurn(nextInput);
      runningRef.current = true;
      setProcessing(true);
      runtime.store.setProcessing(true);
      setStatusMessage('');

      try {
        await controller.runInput(nextInput, { abortSignal: turn.abortSignal });
      } finally {
        const revision = turnControllerRef.current.finishTurn(turn.id);
        if (revision?.trim()) {
          setStatusMessage('Restarting with latest instruction...');
          nextInput = revision;
        } else {
          nextInput = undefined;
        }
      }
    }

    runningRef.current = false;
    setProcessing(false);
    runtime.store.setProcessing(false);
  }, [appendSubmittedInput, controller, runtime.store]);

  const submit = useCallback((value: string) => {
    const submitted = value.trim();
    if (!submitted) return;
    setInput('');
    setOverlay(null);
    addToInputHistory(submitted);
    setHistory(getInputHistory());
    setHistoryIndex(-1);

    if (isExitCommand(submitted)) {
      void shutdown();
      return;
    }

    if (turnControllerRef.current.hasActiveTurn()) {
      const parsed = parseInput(submitted);
      if (parsed.isCommand) {
        setStatusMessage('Command ignored while agent is running. Press Ctrl+C to interrupt first.');
        return;
      }

      turnControllerRef.current.clearExitIntent();
      turnControllerRef.current.requestRevision(submitted);
      setStatusMessage('Revision received. Interrupting current response...');
      return;
    }

    void runTurn(submitted);
  }, [runTurn, shutdown]);

  const closeOverlay = useCallback((): boolean => {
    if (!overlay) return false;
    setOverlay(null);
    return true;
  }, [overlay]);

  const handleCtrlC = useCallback(() => {
    if (closeOverlay()) {
      turnControllerRef.current.clearExitIntent();
      return;
    }

    if (turnControllerRef.current.hasActiveTurn()) {
      const shouldExit = turnControllerRef.current.registerExitIntent();
      turnControllerRef.current.interruptActiveTurn();
      if (shouldExit) {
        void shutdown();
      } else {
        setStatusMessage('again exits');
      }
      return;
    }

    if (turnControllerRef.current.registerExitIntent()) {
      void shutdown();
      return;
    }

    setStatusMessage('again exits');
  }, [closeOverlay, shutdown]);

  useEffect(() => {
    let lastDataCtrlCAt = 0;

    const onData = (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      const ctrlCCount = [...text].filter(char => char === '\u0003').length;
      if (ctrlCCount > 0) {
        lastDataCtrlCAt = Date.now();
      }
      for (let i = 0; i < ctrlCCount; i++) {
        handleCtrlC();
      }
    };
    const onSignal = () => {
      if (Date.now() - lastDataCtrlCAt < 50) return;
      handleCtrlC();
    };

    process.stdin.on('data', onData);
    process.on('SIGINT', onSignal);
    return () => {
      process.stdin.off('data', onData);
      process.off('SIGINT', onSignal);
    };
  }, [handleCtrlC]);

  const commandItems = visibleCommandItems(input);
  const fileItems = visibleFileItems(runtime.cwd, input);

  const completeCommand = useCallback((item: SelectListItem, submitImmediately: boolean) => {
    const command = getCommands().find(candidate => candidate.name === item.value);
    const value = `/${item.value}${command?.argumentHint || command?.params?.some(param => param.required) ? ' ' : ''}`;
    setOverlay(null);
    if (submitImmediately && value.trim() === `/${item.value}`) {
      submit(value);
    } else {
      setInput(value);
    }
  }, [submit]);

  const completeFile = useCallback((item: SelectListItem) => {
    const fileQuery = getFileQuery(inputRef.current);
    if (!fileQuery) return;
    setInput(`${fileQuery.base}@${item.value}`);
    setOverlay(null);
  }, []);

  const selectSession = useCallback((request: SessionPickerRequest, index: number) => {
    const session = request.sessions[index];
    if (!session) return;
    setOverlay(null);
    submit(`/resume ${session.id}${request.allProjects ? ' --all' : ''}`);
  }, [submit]);

  useInput((value, key: any) => {
    const isReturn = key?.return || value === '\r' || value === '\n';

    if (value === '\u0003' || value?.includes('\u0003')) {
      return;
    }

    if (!key?.ctrl && value && /[\r\n]/.test(value) && value !== '\r' && value !== '\n') {
      const beforeReturn = value.split(/[\r\n]/)[0] ?? '';
      submit(`${inputRef.current}${beforeReturn}`);
      return;
    }

    if (overlay?.type === 'shortcuts') {
      if (key?.escape || isReturn || value === '?') setOverlay(null);
      return;
    }

    if (overlay?.type === 'commands') {
      const items = commandItems;
      if (key?.escape) {
        setOverlay(null);
        return;
      }
      if (key?.upArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.max(0, overlay.selectedIndex - 1) });
        return;
      }
      if (key?.downArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.min(Math.max(0, items.length - 1), overlay.selectedIndex + 1) });
        return;
      }
      if (key?.tab && items[overlay.selectedIndex]) {
        completeCommand(items[overlay.selectedIndex], false);
        return;
      }
      if (isReturn && items[overlay.selectedIndex]) {
        completeCommand(items[overlay.selectedIndex], true);
        return;
      }
    }

    if (overlay?.type === 'files') {
      const items = fileItems;
      if (key?.escape) {
        setOverlay(null);
        return;
      }
      if (key?.upArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.max(0, overlay.selectedIndex - 1) });
        return;
      }
      if (key?.downArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.min(Math.max(0, items.length - 1), overlay.selectedIndex + 1) });
        return;
      }
      if ((key?.tab || isReturn) && items[overlay.selectedIndex]) {
        completeFile(items[overlay.selectedIndex]);
        return;
      }
    }

    if (overlay?.type === 'sessions') {
      const total = overlay.request.sessions.length;
      if (key?.escape) {
        setOverlay(null);
        return;
      }
      if (key?.upArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.max(0, overlay.selectedIndex - 1) });
        return;
      }
      if (key?.downArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.min(Math.max(0, total - 1), overlay.selectedIndex + 1) });
        return;
      }
      if (key?.pageUp) {
        setOverlay({ ...overlay, selectedIndex: Math.max(0, overlay.selectedIndex - 10) });
        return;
      }
      if (key?.pageDown) {
        setOverlay({ ...overlay, selectedIndex: Math.min(Math.max(0, total - 1), overlay.selectedIndex + 10) });
        return;
      }
      if (isReturn) {
        selectSession(overlay.request, overlay.selectedIndex);
        return;
      }
    }

    if (isReturn && key?.meta) {
      setInput(current => `${current}\n`);
      return;
    }

    if (isReturn) {
      submit(inputRef.current);
      return;
    }

    if (key?.backspace || key?.delete) {
      setInput(current => current.slice(0, -1));
      return;
    }

    if (key?.upArrow && inputRef.current === '' && history.length > 0) {
      const nextIndex = Math.min(history.length - 1, historyIndex + 1);
      setHistoryIndex(nextIndex);
      setInput(history[nextIndex]?.content ?? '');
      return;
    }

    if (key?.downArrow && historyIndex >= 0) {
      const nextIndex = historyIndex - 1;
      setHistoryIndex(nextIndex);
      setInput(nextIndex >= 0 ? history[nextIndex]?.content ?? '' : '');
      return;
    }

    if (key?.tab) {
      if (inputRef.current.startsWith('/')) {
        setOverlay({ type: 'commands', selectedIndex: 0 });
      } else if (getFileQuery(inputRef.current)) {
        setOverlay({ type: 'files', selectedIndex: 0 });
      }
      return;
    }

    if (value === '/' && inputRef.current === '' && !turnControllerRef.current.hasActiveTurn()) {
      setInput('/');
      setOverlay({ type: 'commands', selectedIndex: 0 });
      return;
    }

    if (value === '@' && !turnControllerRef.current.hasActiveTurn()) {
      setInput(current => `${current}@`);
      setOverlay({ type: 'files', selectedIndex: 0 });
      return;
    }

    if (value === '?' && inputRef.current === '') {
      setOverlay({ type: 'shortcuts' });
      return;
    }

    if (value && !key?.ctrl) {
      setInput(current => `${current}${value}`);
    }
  });

  const terminalHeight = stdout?.rows || process.stdout.rows || 24;
  const terminalWidth = stdout?.columns || process.stdout.columns || 80;
  const transcriptItems = Math.max(6, terminalHeight - 10);
  const modeText = getModeDisplayText(runtime.store.getSnapshot().permissionMode);

  return (
    <Box flexDirection="column" minHeight={terminalHeight}>
      <Box flexDirection="column" marginBottom={1}>
        <PixelHorseBanner runtime={runtime} width={terminalWidth} />
      </Box>

      <Transcript entries={transcript} maxItems={transcriptItems} width={terminalWidth} />

      {overlay?.type === 'commands' ? (
        <SelectList
          title={`Commands ${input.slice(1) ? `"${input.slice(1)}"` : ''}`}
          items={commandItems}
          selectedIndex={overlay.selectedIndex}
          maxVisibleItems={10}
          footer="↑↓ navigate  Tab complete  Enter select  Esc cancel"
        />
      ) : null}

      {overlay?.type === 'files' ? (
        <SelectList
          title="Files"
          items={fileItems}
          selectedIndex={overlay.selectedIndex}
          maxVisibleItems={10}
          footer="↑↓ navigate  Tab/Enter complete  Esc cancel"
        />
      ) : null}

      {overlay?.type === 'sessions' ? (
        <SelectList
          title={overlay.request.title}
          items={sessionItems(overlay.request)}
          selectedIndex={overlay.selectedIndex}
          maxVisibleItems={overlay.request.maxVisibleItems ?? 10}
          footer="↑↓ scroll  PgUp/PgDn  Enter resume  Esc cancel"
        />
      ) : null}

      {overlay?.type === 'shortcuts' ? (
        <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column">
          <Text color="cyan">Shortcuts</Text>
          <Text>/ commands    @ file picker    ? shortcuts</Text>
          <Text>Alt+Enter newline    Ctrl+C interrupt / twice exits    ↑↓ history or picker navigation</Text>
          <Text color="gray">Enter or Esc closes this panel.</Text>
        </Box>
      ) : null}

      <StatusLine runtime={runtime} running={processing} statusMessage={statusMessage} width={terminalWidth} />
      <PromptInput value={input} running={processing} modeText={modeText} width={terminalWidth} />
      <TerminalCursor value={input} terminalHeight={terminalHeight} terminalWidth={terminalWidth} sticky={processing} />
    </Box>
  );
}
