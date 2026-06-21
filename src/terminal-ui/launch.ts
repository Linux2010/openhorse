import chalk from 'chalk';
import stringWidth from 'string-width';
import { parseInput } from '../commands/parser';
import { AgentRuntimeController, type AgentRuntimeInput } from '../runtime/agent-runtime-controller';
import { emitToUiEventSink, type AgentRuntimeEventSink } from '../runtime/agent-runtime-protocol';
import { applyTerminalTabCompletion } from './completion';
import { openExternalEditor } from './editor';
import { RawTerminalEditor } from './raw-editor';
import type {
  EditPreviewRequest,
  OpenHorseInkRuntime,
  SessionPickerRequest,
  TranscriptAppendEntry,
  TranscriptEntry,
  TranscriptRole,
  UiEventSink,
} from '../runtime/ui-events';

const ACCENT = chalk.hex('#80E6E8');
const DIM = chalk.hex('#567089');
const ERROR = chalk.hex('#FF7A7A');
const TOOL = chalk.hex('#7FA2B8');
const BORDER = chalk.hex('#38556A');

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function stripTrailingNewlines(text: string): string {
  return text.replace(/\n+$/g, '');
}

function sessionTitle(session: SessionPickerRequest['sessions'][number]): string {
  return session.name || session.taskSummary || '(untitled)';
}

function formatTranscriptEntry(entry: TranscriptEntry): string {
  const content = stripTrailingNewlines(entry.content);
  if (!content) return '';

  switch (entry.role) {
    case 'user':
      return `${ACCENT('›')} ${content}`;
    case 'tool':
      return TOOL(content);
    case 'error':
      return ERROR(content);
    case 'status':
      return DIM(content);
    case 'command':
    case 'system':
      return content;
    case 'assistant':
    default:
      return content;
  }
}

function shouldShowStatus(message: string): boolean {
  return Boolean(message.trim());
}

interface TerminalWriter {
  write(text: string): void;
}

class DirectTerminalWriter implements TerminalWriter {
  write(text: string): void {
    process.stdout.write(text);
  }
}

const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function visibleLength(text: string): number {
  return stringWidth(stripTrailingNewlines(text).replace(ANSI_PATTERN, ''));
}

export function truncateTerminalText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return '.'.repeat(maxWidth);

  let output = '';
  for (const char of Array.from(text)) {
    if (stringWidth(`${output}${char}...`) > maxWidth) break;
    output += char;
  }
  return `${output}...`;
}

function bannerRow(content: string, width: number): string {
  const innerWidth = Math.max(0, width - 2);
  const safeContent = visibleLength(content) > innerWidth
    ? truncateTerminalText(content.replace(ANSI_PATTERN, ''), innerWidth)
    : content;
  const padding = ' '.repeat(Math.max(0, innerWidth - visibleLength(safeContent)));
  return `${BORDER('│')}${safeContent}${padding}${BORDER('│')}`;
}

class TerminalEventSink implements UiEventSink {
  private readonly entries = new Map<string, TranscriptEntry>();
  private readonly printedContent = new Map<string, string>();
  private readonly pendingAssistantOutput = new Map<string, string>();
  private idCounter = 0;
  private pendingPicker: SessionPickerRequest | null = null;
  private pendingEditPreview: EditPreviewRequest | null = null;

  constructor(
    private readonly runtime: OpenHorseInkRuntime,
    private readonly writer: TerminalWriter = new DirectTerminalWriter()
  ) {}

  append(entry: TranscriptAppendEntry): string {
    const id = `terminal-${++this.idCounter}`;
    const fullEntry: TranscriptEntry = {
      id,
      role: entry.role,
      title: entry.title,
      content: entry.content,
    };
    this.entries.set(id, fullEntry);
    this.printEntry(fullEntry, false);
    return id;
  }

  update(id: string, patch: Partial<Omit<TranscriptEntry, 'id'>>): void {
    const existing = this.entries.get(id);
    if (!existing) return;
    const next = { ...existing, ...patch };
    this.entries.set(id, next);
    this.printEntry(next, false);
  }

  finalize(id: string, patch?: Partial<Omit<TranscriptEntry, 'id'>>): void {
    const existing = this.entries.get(id);
    if (!existing) return;
    const next = patch ? { ...existing, ...patch } : existing;
    this.entries.set(id, next);
    this.printEntry(next, true);
  }

  remove(id: string): void {
    this.entries.delete(id);
    this.printedContent.delete(id);
  }

  replaceTranscript(entries: TranscriptEntry[]): void {
    this.entries.clear();
    this.printedContent.clear();
    this.pendingAssistantOutput.clear();
    if (entries.length === 0) return;

    this.writer.write(`\n${BORDER('─'.repeat(Math.min(process.stdout.columns || 80, 96)))}\n`);
    this.writer.write(`${DIM('Restored conversation')}\n\n`);
    for (const entry of entries) {
      const formatted = formatTranscriptEntry(entry);
      if (formatted) {
        this.writer.write(`${formatted}\n\n`);
      }
    }
  }

  clearTranscript(): void {
    this.entries.clear();
    this.printedContent.clear();
    this.pendingAssistantOutput.clear();
    this.writer.write(`${DIM('View marker reset. Terminal scrollback is preserved.')}\n`);
  }

  setStatus(message: string): void {
    if (!shouldShowStatus(message)) return;
    this.writer.write(`${DIM(message)}\n`);
  }

  showSessionPicker(request: SessionPickerRequest): void {
    this.pendingPicker = request;
    this.writer.write(`\n${ACCENT(request.title)}\n`);
    this.writer.write(`${BORDER('─'.repeat(Math.min(process.stdout.columns || 80, 96)))}\n`);
    request.sessions.forEach((session, index) => {
      const id = session.id.slice(0, 8);
      const size = formatBytes(session.historySizeBytes ?? 0);
      const messages = session.messageCount ?? 0;
      const project = request.showProject ? `  ${session.projectPath}` : '';
      this.writer.write(
        `${String(index + 1).padStart(2, ' ')}. ${ACCENT(id)}  ${sessionTitle(session)}  ${DIM(`${messages} msgs  ${size}  ${session.model}${project}`)}\n`
      );
    });
    this.writer.write(`${DIM('Type a number, session id/name, or /resume --last. Empty input cancels.')}\n`);
  }

  showEditPreview(request: EditPreviewRequest): void {
    this.pendingEditPreview = request;
    const kindLabel = request.kind === 'fuzzy' ? `fuzzy (${request.strategy ?? 'match'})` : 'exact';
    this.writer.write(`\n${ACCENT(`Edit Preview: ${request.path} (${kindLabel})`)}\n`);
    this.writer.write(`${BORDER('─'.repeat(Math.min(process.stdout.columns || 80, 96)))}\n`);
    request.candidates.slice(0, 10).forEach(c => {
      const matchPreview = c.match.length > 60 ? c.match.slice(0, 57) + '...' : c.match;
      const newPreview = request.newString.length > 40 ? request.newString.slice(0, 37) + '...' : request.newString;
      this.writer.write(`  line ${String(c.line).padStart(3, ' ')}  "${matchPreview}"  → "${newPreview}"\n`);
    });
    if (request.candidates.length > 10) {
      this.writer.write(`${DIM(`  ... ${request.candidates.length - 10} more candidates`)}\n`);
    }
    this.writer.write(`${DIM('Press Enter to dismiss.')}\n`);
  }

  setProcessing(_processing: boolean): void {
    // The stable terminal UI is append-only, so there is no live spinner state.
  }

  consumePendingSelection(input: string): string | AgentRuntimeInput | null {
    const picker = this.pendingPicker;
    if (picker) {
      const trimmed = input.trim();
      this.pendingPicker = null;
      if (!trimmed) {
        this.writer.write(`${DIM('Session picker cancelled.')}\n`);
        return '';
      }
      if (trimmed.startsWith('/')) return trimmed;

      const numeric = trimmed.match(/^#?(\d+)$/);
      if (numeric) {
        const index = Number(numeric[1]) - 1;
        const selected = picker.sessions[index];
        if (!selected) {
          this.writer.write(`${ERROR(`No session at index ${numeric[1]}.`)}\n`);
          return '';
        }
        return { type: 'select_session', sessionId: selected.id, allProjects: picker.allProjects, source: 'picker' };
      }

      return { type: 'select_session', sessionId: trimmed, allProjects: picker.allProjects, source: 'picker' };
    }

    // Dismiss pending edit preview on any input
    if (this.pendingEditPreview) {
      this.pendingEditPreview = null;
      return '';
    }

    return null;
  }

  private printEntry(entry: TranscriptEntry, finalized: boolean): void {
    if (!entry.content) return;

    if (entry.role === 'assistant') {
      this.printAssistantDelta(entry, finalized);
      return;
    }

    const previous = this.printedContent.get(entry.id);
    if (previous === entry.content && !finalized) return;
    this.printedContent.set(entry.id, entry.content);
    const formatted = formatTranscriptEntry(entry);
    if (formatted) {
      this.writer.write(`${formatted}\n`);
    }
  }

  private printAssistantDelta(entry: TranscriptEntry, finalized: boolean): void {
    const previous = this.printedContent.get(entry.id) ?? '';
    const next = entry.content;
    if (next === previous && !finalized) return;

    const delta = next.startsWith(previous) ? next.slice(previous.length) : `\n${next}`;
    const pending = `${this.pendingAssistantOutput.get(entry.id) ?? ''}${delta}`;
    this.printedContent.set(entry.id, next);

    const shouldFlush = finalized || pending.includes('\n') || visibleLength(pending) >= 80;
    if (shouldFlush) {
      this.pendingAssistantOutput.delete(entry.id);
      if (pending) {
        this.writer.write(pending);
      } else if (finalized && next && !next.endsWith('\n')) {
        this.writer.write('\n');
      }
      return;
    }

    this.pendingAssistantOutput.set(entry.id, pending);
  }
}

function printBanner(runtime: OpenHorseInkRuntime): void {
  const width = Math.min(process.stdout.columns || 88, 112);
  const line = '─'.repeat(Math.max(20, width - 2));
  const firstLine = ` ${ACCENT.bold('OPENHORSE')} ${DIM(`v${runtime.version}`)} ${DIM('stable terminal UI')}`;
  const projectPrefix = ` ${DIM('Model')} ${ACCENT(runtime.config.model)}  ${DIM('Project')} `;
  const project = truncateTerminalText(runtime.cwd, Math.max(10, width - 2 - visibleLength(projectPrefix)));
  process.stdout.write('\n');
  process.stdout.write(`${BORDER(`╭${line}╮`)}\n`);
  process.stdout.write(`${bannerRow(firstLine, width)}\n`);
  process.stdout.write(`${bannerRow(`${projectPrefix}${project}`, width)}\n`);
  process.stdout.write(`${BORDER(`╰${line}╯`)}\n\n`);
}

function promptText(runtime: OpenHorseInkRuntime): string {
  const session = runtime.getSession()?.id.slice(0, 8) ?? 'new';
  return `${DIM(`[${session}]`)} ${ACCENT('›')} `;
}

function summarizeToolArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
    .slice(0, 4)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  const summary = entries.join(' ');
  return summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
}

function isExitInput(input: string): boolean {
  return ['/exit', '/quit', '/q'].includes(input.trim());
}

export function parseEditInput(input: string): { isEdit: boolean; initialContent: string } {
  const trimmed = input.trimStart();
  if (trimmed === '/edit') return { isEdit: true, initialContent: '' };
  if (trimmed.startsWith('/edit ')) {
    return { isEdit: true, initialContent: trimmed.slice('/edit '.length) };
  }
  return { isEdit: false, initialContent: '' };
}

export interface TerminalComposeResult {
  input?: string;
  notice?: string;
  cancelled?: boolean;
}

export class TerminalInputComposer {
  private mode: 'paste' | 'continuation' | null = null;
  private readonly lines: string[] = [];

  isActive(): boolean {
    return this.mode !== null;
  }

  prompt(basePrompt: string): string {
    return this.mode ? `${DIM('[multi]')} ${ACCENT('…')} ` : basePrompt;
  }

  receive(input: string): TerminalComposeResult {
    const trimmed = input.trim();

    if (!this.mode && ['/paste', '/multi', '/multiline'].includes(trimmed)) {
      this.mode = 'paste';
      this.lines.length = 0;
      return { notice: DIM('Multiline input: finish with /end, cancel with /cancel.') };
    }

    if (this.mode === 'paste') {
      if (trimmed === '/cancel') {
        this.reset();
        return { cancelled: true, notice: DIM('Multiline input cancelled.') };
      }
      if (trimmed === '/end') {
        const submitted = this.lines.join('\n').trimEnd();
        this.reset();
        return submitted ? { input: submitted } : { cancelled: true, notice: DIM('Multiline input was empty.') };
      }
      this.lines.push(input);
      return {};
    }

    if (this.mode === 'continuation') {
      const continued = input.endsWith('\\');
      this.lines.push(continued ? input.slice(0, -1) : input);
      if (continued) return {};

      const submitted = this.lines.join('\n').trimEnd();
      this.reset();
      return submitted ? { input: submitted } : {};
    }

    if (input.endsWith('\\')) {
      this.mode = 'continuation';
      this.lines.length = 0;
      this.lines.push(input.slice(0, -1));
      return {};
    }

    return { input };
  }

  private reset(): void {
    this.mode = null;
    this.lines.length = 0;
  }
}

export function normalizeTerminalAnswer(input: string): string {
  let output = '';
  let index = 0;

  const popChar = (): void => {
    const chars = Array.from(output);
    chars.pop();
    output = chars.join('');
  };

  while (index < input.length) {
    const escapeMatch = input.slice(index).match(/^\x1b\[[0-?]*[ -/]*[@-~]/u);
    if (escapeMatch) {
      index += escapeMatch[0].length;
      continue;
    }

    const char = input[index];
    if (char === '\x7f' || char === '\b') {
      popChar();
      index++;
      continue;
    }
    if (char === '\x15') {
      output = '';
      index++;
      continue;
    }
    if (char === '\x17') {
      output = output.replace(/\s*\S+\s*$/u, '');
      index++;
      continue;
    }
    if (char >= ' ' || char === '\t') {
      output += char;
    }
    index++;
  }

  return output;
}

export async function launchTerminalUI(runtime: OpenHorseInkRuntime): Promise<void> {
  printBanner(runtime);

  let editor!: RawTerminalEditor;
  const writer: TerminalWriter = {
    write: text => editor.writeExternal(text),
  };
  const events = new TerminalEventSink(runtime, writer);
  let agentController!: AgentRuntimeController;

  let stopping = false;
  let settled = false;
  let resolveLaunch: (() => void) | null = null;
  const composer = new TerminalInputComposer();
  let confirmingTool = false;
  const eventSink: AgentRuntimeEventSink = {
    emit: event => {
      if (event.type !== 'permission_requested') {
        return emitToUiEventSink(events, event);
      }

      if (event.request.abortSignal?.aborted || stopping) {
        agentController.handle({
          type: 'permission_decision',
          requestId: event.request.id,
          approved: false,
          source: 'programmatic',
        });
        return undefined;
      }

      confirmingTool = true;
      const detail = summarizeToolArgs(event.request.args);
      const reason = event.request.reason ? ` ${DIM(event.request.reason)}` : '';
      const suffix = detail ? ` ${DIM(detail)}` : '';

      void editor.ask(
        `${ACCENT('?')} Allow tool ${ACCENT(event.request.name)}?${suffix}${reason} ${DIM('[y/N]')} `,
        event.request.abortSignal
      ).then(answer => {
        agentController.handle({
          type: 'permission_decision',
          requestId: event.request.id,
          approved: /^y(es)?$/i.test(answer.trim()),
          source: 'keyboard',
        });
      }).catch(() => {
        agentController.handle({
          type: 'permission_decision',
          requestId: event.request.id,
          approved: false,
          source: 'programmatic',
        });
      }).finally(() => {
        confirmingTool = false;
        prompt();
      });
      return undefined;
    },
  };

  agentController = new AgentRuntimeController({
    runtime,
    eventSink,
    useRuntimeToolPermissions: true,
    echoSubmittedInput: false,
    beforeTurn: () => writer.write('\n'),
    afterTurnLoop: () => {
      writer.write('\n');
      prompt();
    },
    onTurnError: error => {
      const message = error instanceof Error ? error.message : String(error);
      events.append({ role: 'error', content: `Error: ${message}` });
    },
  });
  editor = new RawTerminalEditor({
    cwd: runtime.cwd,
    onSubmit: input => handleInput(input),
    onCtrlC: () => handleSigint(),
  });

  const prompt = (): void => {
    if (stopping) return;
    editor.setPrompt(composer.prompt(promptText(runtime)));
  };

  const finishLaunch = (): void => {
    if (settled) return;
    settled = true;
    resolveLaunch?.();
  };

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await agentController.stopActiveTurn();
    editor.stop();
    await runtime.shutdown();
    process.stdout.write('\n');
    finishLaunch();
  };

  const handleInput = (rawInput: string): void => {
    if (stopping) return;

    const answer = applyTerminalTabCompletion(
      normalizeTerminalAnswer(rawInput),
      runtime.cwd
    );
    const submitted = answer.trim();

    if (agentController.hasActiveTurn()) {
      if (confirmingTool) {
        return;
      }

      if (!submitted) {
        prompt();
        return;
      }

      const result = agentController.handle({ type: 'submit', text: answer, source: 'composer' });
      if (result.type === 'exit_requested') {
        void stop();
        return;
      }
      prompt();
      return;
    }

    agentController.handle({ type: 'clear_exit_intent' });

    let input = !composer.isActive() ? events.consumePendingSelection(answer) : null;
    if (input === '') {
      prompt();
      return;
    }
    if (input && typeof input !== 'string') {
      const result = agentController.handle(input);
      if (result.type === 'exit_requested') {
        void stop();
        return;
      }
      return;
    }
    input ??= answer;

    if (!composer.isActive()) {
      const edit = parseEditInput(input);
      if (edit.isEdit) {
        editor.stop();
        const result = openExternalEditor({ initialContent: edit.initialContent });
        if (!stopping) editor.start();
        if (result.error) {
          events.append({ role: 'error', content: `Editor failed: ${result.error}` });
          prompt();
          return;
        }
        if (result.cancelled || !result.content) {
          events.setStatus('Editor input cancelled.');
          prompt();
          return;
        }
        input = result.content;
      }
    }

    const composed = composer.receive(input);
    if (composed.notice) writer.write(`${composed.notice}\n`);
    if (composed.cancelled) {
      prompt();
      return;
    }
    if (composed.input === undefined) {
      prompt();
      return;
    }
    input = composed.input;

    if (!input.trim()) {
      prompt();
      return;
    }

    const result = agentController.handle({ type: 'submit', text: input, source: 'composer' });
    if (result.type === 'exit_requested') {
      void stop();
      return;
    }
    prompt();
  };

  const handleSigint = (): void => {
    const result = agentController.handle({ type: 'interrupt', source: 'keyboard' });
    if (result.type === 'exit_requested') {
      void stop();
      return;
    }
    prompt();
  };

  try {
    process.stdout.write(`${DIM('Ready. Stable terminal editor is enabled for CJK input, Backspace, and live revision. Use /paste for multiline, /edit for $EDITOR.')}\n`);
    editor.start();
    prompt();
    await new Promise<void>(resolve => {
      resolveLaunch = resolve;
    });
  } finally {
    if (!stopping) {
      stopping = true;
      editor.stop();
      await runtime.shutdown();
      process.stdout.write('\n');
    }
  }
}
