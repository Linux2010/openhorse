import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import type { DOMElement } from 'ink/build/dom';
import { existsSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { getCommandCategoryLabel, getCommands, getVisibleCommands } from '../../commands';
import { getModeDisplayText } from '../../commands/types';
import { AgentRuntimeController } from '../../runtime/agent-runtime-controller';
import { addToInputHistory, getInputHistory } from '../../services/global-config';
import { formatBytes } from '../../ui-v2/state/sessions';
import type { SessionMeta } from '../../services/session-storage';
import { NativeCursor } from '../components/NativeCursor';
import { PromptInput } from '../components/PromptInput';
import { PixelHorseBanner } from '../components/PixelHorseBanner';
import { SelectList, type SelectListItem } from '../components/SelectList';
import { StatusLine } from '../components/StatusLine';
import { Transcript, TranscriptEntryBlock } from '../components/Transcript';
import { useRawInputBridge } from '../hooks/use-raw-input-bridge';
import { useTerminalSize } from '../hooks/use-terminal-size';
import { initialInputBuffer, reduceInputBuffer, type InputBuffer } from '../runtime/input-buffer';
import { getInkLayoutBudget } from '../runtime/layout-budget';
import type { NativeCursorController } from '../runtime/native-cursor';
import { deleteActionFromRawInput, hasDeletionRawInput } from '../runtime/raw-input';
import {
  initialTranscriptState,
  liveTranscriptEntries,
  staticTranscriptEntries,
  transcriptReducer,
} from '../runtime/transcript-state';
import type { OpenHorseInkRuntime, SessionPickerRequest, ToolPermissionRequest, TranscriptAppendEntry, TranscriptEntry, UiEventSink } from '../types';

type Overlay =
  | { type: 'commands'; selectedIndex: number }
  | { type: 'files'; selectedIndex: number }
  | { type: 'sessions'; selectedIndex: number; request: SessionPickerRequest }
  | { type: 'permission'; selectedIndex: number; request: ToolPermissionRequest }
  | { type: 'shortcuts' }
  | null;

let nextTranscriptId = 1;

function createId(): string {
  return `ui-${nextTranscriptId++}`;
}

type StaticTranscriptItem =
  | { id: string; type: 'banner' }
  | (TranscriptEntry & { type: 'entry' });

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

function compactPermissionArgs(args: Record<string, unknown>): string {
  for (const key of ['path', 'file_path', 'file', 'cwd', 'command', 'pattern', 'query', 'url', 'target', 'sessionId']) {
    const value = args[key];
    if (typeof value === 'string') {
      return value.length > 72 ? `${value.slice(0, 69)}...` : value;
    }
  }
  const firstString = Object.values(args).find(value => typeof value === 'string');
  if (typeof firstString === 'string') {
    return firstString.length > 72 ? `${firstString.slice(0, 69)}...` : firstString;
  }
  return '';
}

export function permissionItems(request: ToolPermissionRequest): SelectListItem[] {
  const detail = compactPermissionArgs(request.args);
  return [
    {
      value: 'allow',
      label: `Allow ${request.name}`,
      description: [detail, request.reason].filter(Boolean).join('  '),
    },
    {
      value: 'deny',
      label: `Deny ${request.name}`,
      description: 'Do not run this tool call',
    },
  ];
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

export interface ReplScreenProps {
  runtime: OpenHorseInkRuntime;
  cursorController: NativeCursorController;
  resizeEpoch?: number;
}

export function ReplScreen({ runtime, cursorController, resizeEpoch = 0 }: ReplScreenProps): JSX.Element {
  const app = useApp();
  const { stdout } = useStdout();
  const terminalSize = useTerminalSize(stdout);
  const terminalHeight = terminalSize.height;
  const terminalWidth = terminalSize.width;
  const [transcriptState, dispatchTranscript] = useReducer(transcriptReducer, initialTranscriptState);
  const [inputBuffer, dispatchInput] = useReducer(reduceInputBuffer, initialInputBuffer);
  const input = inputBuffer.value;
  const inputCursor = inputBuffer.cursor;
  const [overlay, setOverlay] = useState<Overlay>(null);
  const layout = useMemo(
    () => getInkLayoutBudget(terminalWidth, terminalHeight, { overlayVisible: overlay !== null }),
    [terminalWidth, terminalHeight, overlay]
  );
  const { layoutWidth, maxLiveTranscriptItems, maxOverlayItems, maxPromptRows } = layout;
  const [processing, setProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [exiting, setExiting] = useState(false);
  const [history, setHistory] = useState(() => getInputHistory());
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [, setStoreVersion] = useState(0);
  const shuttingDownRef = useRef(false);
  const lastCtrlCEventAtRef = useRef(0);
  const inputRef = useRef<InputBuffer>(initialInputBuffer);
  const promptBoxRef = useRef<DOMElement>(null);

  useEffect(() => {
    inputRef.current = inputBuffer;
  }, [inputBuffer]);

  useEffect(() => runtime.store.subscribe(() => setStoreVersion(version => version + 1)), [runtime.store]);

  const append = useCallback((entry: TranscriptAppendEntry): string => {
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

  const remove = useCallback((id: string) => {
    dispatchTranscript({ type: 'remove', id });
  }, []);

  const events: UiEventSink = useMemo(() => ({
    append,
    update,
    finalize,
    remove,
    replaceTranscript: entries => {
      dispatchTranscript({ type: 'replace', entries });
    },
    clearTranscript: () => {
      dispatchTranscript({ type: 'clear' });
    },
    setStatus: setStatusMessage,
    showSessionPicker: request => setOverlay({ type: 'sessions', selectedIndex: 0, request }),
    showPermissionRequest: request => setOverlay({ type: 'permission', selectedIndex: 0, request }),
    setProcessing,
  }), [append, finalize, remove, stdout, update]);

  const agentController = useMemo(() => new AgentRuntimeController({
    runtime,
    events,
    exitConfirmWindowMs: 5000,
    useRuntimeToolPermissions: true,
    beforeTurn: () => setStatusMessage(''),
  }), [runtime, events]);

  const shutdown = useCallback(() => {
    if (shuttingDownRef.current) return;
    shuttingDownRef.current = true;
    cursorController.disable();
    runtime.store.setProcessing(false);
    setProcessing(false);
    setExiting(true);

    setTimeout(() => {
      app.exit();
    }, 50);

    void runtime.shutdown().catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`OpenHorse shutdown warning: ${message}\n`);
    });
  }, [app, cursorController, runtime]);

  const submit = useCallback((value: string) => {
    const submitted = value.trim();
    if (!submitted) return;
    dispatchInput({ type: 'clear' });
    setOverlay(null);
    addToInputHistory(submitted);
    setHistory(getInputHistory());
    setHistoryIndex(-1);

    const result = agentController.handle({ type: 'submit', text: submitted, source: 'composer' });
    if (result.type === 'exit_requested') {
      void shutdown();
    }
  }, [agentController, shutdown]);

  const answerPermission = useCallback((request: ToolPermissionRequest, approved: boolean) => {
    setOverlay(null);
    agentController.handle({
      type: 'permission_decision',
      requestId: request.id,
      approved,
      source: 'keyboard',
    });
  }, [agentController]);

  const closeOverlay = useCallback((): boolean => {
    if (!overlay) return false;
    if (overlay.type === 'permission') {
      answerPermission(overlay.request, false);
      return true;
    }
    setOverlay(null);
    return true;
  }, [answerPermission, overlay]);

  const handleCtrlC = useCallback(() => {
    if (closeOverlay()) {
      agentController.handle({ type: 'clear_exit_intent' });
      return;
    }

    const result = agentController.handle({ type: 'interrupt', source: 'keyboard' });
    if (result.type === 'exit_requested') {
      void shutdown();
    }
  }, [agentController, closeOverlay, shutdown]);

  const handleCtrlCEvent = useCallback((options: { allowRapidRepeat?: boolean } = {}) => {
    const now = Date.now();
    const delta = now - lastCtrlCEventAtRef.current;
    if (!options.allowRapidRepeat && delta < 30) {
      return;
    }
    lastCtrlCEventAtRef.current = now;
    handleCtrlC();
  }, [handleCtrlC]);

  const lastRawInputRef = useRawInputBridge(handleCtrlCEvent);

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
    const result = agentController.handle({
      type: 'select_session',
      sessionId: session.id,
      allProjects: request.allProjects,
      source: 'picker',
    });
    if (result.type === 'exit_requested') {
      void shutdown();
    }
  }, [agentController, shutdown]);

  useInput((value, key: any) => {
    const isReturn = key?.return || value === '\r' || value === '\n';

    if (key?.ctrl && value === 'c') {
      handleCtrlCEvent();
      return;
    }

    agentController.handle({ type: 'clear_exit_intent' });

    if (!key?.ctrl && isMultilinePasteValue(value)) {
      dispatchInput({ type: 'inputChunk', text: normalizePastedInput(value) });
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

    if (overlay?.type === 'permission') {
      const items = permissionItems(overlay.request);
      if (key?.escape || value?.toLowerCase() === 'n') {
        answerPermission(overlay.request, false);
        return;
      }
      if (value?.toLowerCase() === 'y') {
        answerPermission(overlay.request, true);
        return;
      }
      if (key?.upArrow) {
        setOverlay({ ...overlay, selectedIndex: Math.max(0, overlay.selectedIndex - 1) });
        return;
      }
      if (key?.downArrow || key?.tab) {
        setOverlay({ ...overlay, selectedIndex: Math.min(items.length - 1, overlay.selectedIndex + 1) });
        return;
      }
      if (isReturn) {
        answerPermission(overlay.request, items[overlay.selectedIndex]?.value === 'allow');
        return;
      }
      return;
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

    if (key?.ctrl && value === 'u') {
      const rawInput = lastRawInputRef.current;
      dispatchInput({ type: 'inputChunk', text: rawInput.startsWith('\x15') ? rawInput : '\x15' });
      setOverlay(null);
      return;
    }

    if (isReturn) {
      submit(inputRef.current.value);
      return;
    }

    if (value && hasDeletionRawInput(value)) {
      dispatchInput({ type: 'inputChunk', text: value });
      return;
    }

    if (key?.backspace) {
      dispatchInput({ type: 'backspace' });
      return;
    }

    if (key?.delete) {
      dispatchInput({ type: deleteActionFromRawInput(value || lastRawInputRef.current) });
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

    if (value === '/' && inputRef.current.value === '' && !agentController.hasActiveTurn()) {
      dispatchInput({ type: 'set', value: '/' });
      setOverlay({ type: 'commands', selectedIndex: 0 });
      return;
    }

    if (value === '@' && !agentController.hasActiveTurn()) {
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
      ...staticTranscriptEntries(transcriptState).map(entry => ({ ...entry, type: 'entry' as const })),
    ],
    [transcriptState]
  );
  const liveEntries = useMemo(() => liveTranscriptEntries(transcriptState), [transcriptState]);

  if (exiting) {
    return <Box flexDirection="column" />;
  }

  return (
    <Box flexDirection="column">
      <Static key={`${transcriptState.generation}:${resizeEpoch}`} items={staticItems}>
        {item => item.type === 'banner' ? (
          <Box key={item.id} flexDirection="column" marginBottom={1}>
            <PixelHorseBanner runtime={runtime} width={layoutWidth} />
          </Box>
        ) : (
          <TranscriptEntryBlock key={item.id} entry={item} width={layoutWidth} />
        )}
      </Static>

      <Transcript
        entries={liveEntries}
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
          width={layoutWidth}
        />
      ) : null}

      {overlay?.type === 'files' ? (
        <SelectList
          title="Files"
          items={fileItems}
          selectedIndex={overlay.selectedIndex}
          maxVisibleItems={maxOverlayItems}
          footer="↑↓ navigate  Tab/Enter complete  Esc cancel"
          width={layoutWidth}
        />
      ) : null}

      {overlay?.type === 'sessions' ? (
        <SelectList
          title={overlay.request.title}
          items={sessionItems(overlay.request)}
          selectedIndex={overlay.selectedIndex}
          maxVisibleItems={Math.min(overlay.request.maxVisibleItems ?? maxOverlayItems, maxOverlayItems)}
          footer="↑↓ scroll  PgUp/PgDn  Enter resume  Esc cancel"
          width={layoutWidth}
        />
      ) : null}

      {overlay?.type === 'permission' ? (
        <SelectList
          title="Tool Permission"
          items={permissionItems(overlay.request)}
          selectedIndex={overlay.selectedIndex}
          maxVisibleItems={2}
          footer="↑↓ choose  Enter select  y allow  n/Esc deny"
          width={layoutWidth}
        />
      ) : null}

      {overlay?.type === 'shortcuts' ? (
        <Box width={layoutWidth} borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column">
          <Text color="cyan">Shortcuts</Text>
          <Text>/ commands    @ file picker    ? shortcuts</Text>
          <Text>Alt+Enter newline    Ctrl+C interrupt / twice exits    ↑↓ history or picker navigation</Text>
          <Text color="gray">Enter or Esc closes this panel.</Text>
        </Box>
      ) : null}

      <StatusLine runtime={runtime} running={processing} statusMessage={statusMessage} width={layoutWidth} />
      <PromptInput ref={promptBoxRef} value={input} cursor={inputCursor} running={processing} modeText={modeText} width={layoutWidth} maxRows={maxPromptRows} />
      <NativeCursor
        cursorController={cursorController}
        promptRef={promptBoxRef}
        value={input}
        cursor={inputCursor}
        maxRows={maxPromptRows}
        terminalWidth={layoutWidth}
      />
    </Box>
  );
}
