import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { existsSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { getCommandCategoryLabel, getCommands, getVisibleCommands } from '../../commands';
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
import { Transcript, TranscriptEntryBlock } from '../components/Transcript';
import { InkChatController } from '../controllers/chat-controller';
import { initialInputBuffer, reduceInputBuffer, type InputBuffer } from '../runtime/input-buffer';
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

function isLiveTranscriptEntry(entry: Omit<TranscriptEntry, 'id'>): boolean {
  return entry.role === 'tool';
}

type StaticTranscriptItem =
  | { id: string; type: 'banner' }
  | (TranscriptEntry & { type: 'entry' });

interface TranscriptState {
  archived: TranscriptEntry[];
  live: TranscriptEntry[];
  generation: number;
}

type TranscriptAction =
  | { type: 'append'; entry: TranscriptEntry }
  | { type: 'update'; id: string; patch: Partial<Omit<TranscriptEntry, 'id'>> }
  | { type: 'finalize'; id: string; patch?: Partial<Omit<TranscriptEntry, 'id'>> }
  | { type: 'replace'; entries: TranscriptEntry[] }
  | { type: 'clear' };

function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.type) {
    case 'append':
      if (isLiveTranscriptEntry(action.entry)) {
        return { ...state, live: [...state.live, action.entry] };
      }
      return { ...state, archived: [...state.archived, action.entry] };
    case 'update':
      return {
        ...state,
        live: state.live.map(entry => entry.id === action.id ? { ...entry, ...action.patch } : entry),
      };
    case 'finalize': {
      let finalized: TranscriptEntry | null = null;
      const live = state.live.filter(entry => {
        if (entry.id !== action.id) return true;
        finalized = action.patch ? { ...entry, ...action.patch } : entry;
        return false;
      });
      return finalized
        ? { ...state, archived: [...state.archived, finalized], live }
        : state;
    }
    case 'replace':
      return { archived: action.entries, live: [], generation: state.generation + 1 };
    case 'clear':
      return { archived: [], live: [], generation: state.generation + 1 };
  }
}

export function visibleCommandItems(input: string): SelectListItem[] {
  const query = input.startsWith('/') ? input.slice(1).toLowerCase() : '';
  return getVisibleCommands()
    .filter(command => {
      if (!query) return true;
      return command.name.startsWith(query) || command.aliases?.some(alias => alias.startsWith(query));
    })
    .sort((a, b) => commandMatchRank(a, query) - commandMatchRank(b, query))
    .map(command => ({
      value: command.name,
      label: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}${command.aliases?.length ? ` (${command.aliases.join(', ')})` : ''}`,
      description: `${getCommandCategoryLabel(command.category)}  ${command.description}`,
    }));
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

export function normalizePastedInput(value: string): string {
  return value
    .replace(/\x1b\[200~/g, '')
    .replace(/\x1b\[201~/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

export function isMultilinePasteValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = normalizePastedInput(value);
  return normalized.length > 1 && normalized.includes('\n');
}

function fitCount(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface ReplScreenProps {
  runtime: OpenHorseInkRuntime;
}

export function ReplScreen({ runtime }: ReplScreenProps): JSX.Element {
  const app = useApp();
  const { stdout } = useStdout();
  const terminalHeight = process.stdout.rows || 24;
  const terminalWidth = stdout?.columns || process.stdout.columns || 80;
  const layoutWidth = Math.max(20, terminalWidth - 1);
  const maxLiveTranscriptItems = fitCount(terminalHeight - 10, 1, 8);
  const maxOverlayItems = fitCount(terminalHeight - 9, 3, 10);
  const maxPromptRows = fitCount(Math.floor(terminalHeight / 4), 1, 6);
  const [transcriptState, dispatchTranscript] = useReducer(transcriptReducer, { archived: [], live: [], generation: 0 });
  const [inputBuffer, dispatchInput] = useReducer(reduceInputBuffer, initialInputBuffer);
  const input = inputBuffer.value;
  const inputCursor = inputBuffer.cursor;
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [processing, setProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [history, setHistory] = useState(() => getInputHistory());
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [, setStoreVersion] = useState(0);
  const turnControllerRef = useRef(new TurnController({ exitConfirmWindowMs: 5000 }));
  const runningRef = useRef(false);
  const inputRef = useRef<InputBuffer>(initialInputBuffer);

  useEffect(() => {
    inputRef.current = inputBuffer;
  }, [inputBuffer]);

  useEffect(() => runtime.store.subscribe(() => setStoreVersion(version => version + 1)), [runtime.store]);

  const append = useCallback((entry: Omit<TranscriptEntry, 'id'>): string => {
    const id = createId();
    const next = { id, ...entry };
    dispatchTranscript({ type: 'append', entry: next });
    return id;
  }, []);

  const update = useCallback((id: string, patch: Partial<Omit<TranscriptEntry, 'id'>>) => {
    dispatchTranscript({ type: 'update', id, patch });
  }, []);

  const finalize = useCallback((id: string, patch?: Partial<Omit<TranscriptEntry, 'id'>>) => {
    dispatchTranscript({ type: 'finalize', id, patch });
  }, []);

  const events: UiEventSink = useMemo(() => ({
    append,
    update,
    finalize,
    replaceTranscript: entries => {
      dispatchTranscript({ type: 'replace', entries });
    },
    clearTranscript: () => {
      stdout?.write('\x1b[2J\x1b[3J\x1b[H');
      dispatchTranscript({ type: 'clear' });
    },
    setStatus: setStatusMessage,
    showSessionPicker: request => setOverlay({ type: 'sessions', selectedIndex: 0, request }),
    setProcessing,
  }), [append, finalize, stdout, update]);

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
    dispatchInput({ type: 'clear' });
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
      dispatchInput({ type: 'set', value });
    }
  }, [submit]);

  const completeFile = useCallback((item: SelectListItem) => {
    const fileQuery = getFileQuery(inputRef.current.value);
    if (!fileQuery) return;
    dispatchInput({ type: 'set', value: `${fileQuery.base}@${item.value}` });
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

    if (!key?.ctrl && isMultilinePasteValue(value)) {
      dispatchInput({ type: 'insert', text: normalizePastedInput(value) });
      setOverlay(null);
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
      dispatchInput({ type: 'insert', text: '\n' });
      return;
    }

    if (key?.leftArrow) {
      dispatchInput({ type: 'move', direction: 'left' });
      return;
    }

    if (key?.rightArrow) {
      dispatchInput({ type: 'move', direction: 'right' });
      return;
    }

    if (key?.ctrl && value === 'a') {
      dispatchInput({ type: 'move', direction: 'home' });
      return;
    }

    if (key?.ctrl && value === 'e') {
      dispatchInput({ type: 'move', direction: 'end' });
      return;
    }

    if (isReturn) {
      submit(inputRef.current.value);
      return;
    }

    if (key?.backspace) {
      dispatchInput({ type: 'backspace' });
      return;
    }

    if (key?.delete) {
      dispatchInput({ type: 'delete' });
      return;
    }

    if (key?.upArrow && inputRef.current.value === '' && history.length > 0) {
      const nextIndex = Math.min(history.length - 1, historyIndex + 1);
      setHistoryIndex(nextIndex);
      dispatchInput({ type: 'set', value: history[nextIndex]?.content ?? '' });
      return;
    }

    if (key?.downArrow && historyIndex >= 0) {
      const nextIndex = historyIndex - 1;
      setHistoryIndex(nextIndex);
      dispatchInput({ type: 'set', value: nextIndex >= 0 ? history[nextIndex]?.content ?? '' : '' });
      return;
    }

    if (key?.tab) {
      if (inputRef.current.value.startsWith('/')) {
        setOverlay({ type: 'commands', selectedIndex: 0 });
      } else if (getFileQuery(inputRef.current.value)) {
        setOverlay({ type: 'files', selectedIndex: 0 });
      }
      return;
    }

    if (value === '/' && inputRef.current.value === '' && !turnControllerRef.current.hasActiveTurn()) {
      dispatchInput({ type: 'set', value: '/' });
      setOverlay({ type: 'commands', selectedIndex: 0 });
      return;
    }

    if (value === '@' && !turnControllerRef.current.hasActiveTurn()) {
      dispatchInput({ type: 'insert', text: '@' });
      setOverlay({ type: 'files', selectedIndex: 0 });
      return;
    }

    if (value === '?' && inputRef.current.value === '') {
      setOverlay({ type: 'shortcuts' });
      return;
    }

    if (value && !key?.ctrl) {
      dispatchInput({ type: 'inputChunk', text: value });
    }
  });

  const modeText = getModeDisplayText(runtime.store.getSnapshot().permissionMode);

  const staticItems = useMemo<StaticTranscriptItem[]>(
    () => [
      { id: 'openhorse-banner', type: 'banner' },
      ...transcriptState.archived.map(entry => ({ ...entry, type: 'entry' as const })),
    ],
    [transcriptState.archived]
  );

  return (
    <Box flexDirection="column">
      <Static key={transcriptState.generation} items={staticItems}>
        {item => item.type === 'banner' ? (
          <Box key={item.id} flexDirection="column" marginBottom={1}>
            <PixelHorseBanner runtime={runtime} width={layoutWidth} />
          </Box>
        ) : (
          <TranscriptEntryBlock key={item.id} entry={item} width={layoutWidth} />
        )}
      </Static>

      <Transcript
        entries={transcriptState.live}
        maxItems={maxLiveTranscriptItems}
        width={layoutWidth}
        emptyMessage={null}
      />

      {overlay?.type === 'commands' ? (
        <SelectList
          title={`Commands ${input.slice(1) ? `"${input.slice(1)}"` : ''}`}
          items={commandItems}
          selectedIndex={overlay.selectedIndex}
          maxVisibleItems={maxOverlayItems}
          footer="↑↓ navigate  Tab complete  Enter select  Esc cancel"
        />
      ) : null}

      {overlay?.type === 'files' ? (
        <SelectList
          title="Files"
          items={fileItems}
          selectedIndex={overlay.selectedIndex}
          maxVisibleItems={maxOverlayItems}
          footer="↑↓ navigate  Tab/Enter complete  Esc cancel"
        />
      ) : null}

      {overlay?.type === 'sessions' ? (
        <SelectList
          title={overlay.request.title}
          items={sessionItems(overlay.request)}
          selectedIndex={overlay.selectedIndex}
          maxVisibleItems={Math.min(overlay.request.maxVisibleItems ?? maxOverlayItems, maxOverlayItems)}
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

      <StatusLine runtime={runtime} running={processing} statusMessage={statusMessage} width={layoutWidth} />
      <PromptInput value={input} cursor={inputCursor} running={processing} modeText={modeText} width={layoutWidth} maxRows={maxPromptRows} />
      <TerminalCursor value={input} cursor={inputCursor} maxRows={maxPromptRows} terminalHeight={terminalHeight} terminalWidth={layoutWidth} sticky={processing} />
    </Box>
  );
}
