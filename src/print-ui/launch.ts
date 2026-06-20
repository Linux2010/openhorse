import { AgentRuntimeController } from '../runtime/agent-runtime-controller';
import { emitToUiEventSink, type AgentRuntimeEventSink } from '../runtime/agent-runtime-protocol';
import type { OpenHorseInkRuntime, SessionPickerRequest, TranscriptAppendEntry, TranscriptEntry, UiEventSink } from '../runtime/ui-events';

export type PrintOutputFormat = 'text' | 'json';

export interface PrintModeOptions {
  outputFormat?: PrintOutputFormat;
}

interface PrintModeResult {
  content: string;
  entries: TranscriptEntry[];
  statuses: string[];
  errors: string[];
  sessionId: string | null;
  model: string;
}

function stripTrailingNewlines(text: string): string {
  return text.replace(/\n+$/g, '');
}

function stderrLine(text: string): void {
  if (!text.trim()) return;
  process.stderr.write(`${stripTrailingNewlines(text)}\n`);
}

class PrintEventSink implements UiEventSink {
  private readonly entries = new Map<string, TranscriptEntry>();
  private readonly printedContent = new Map<string, string>();
  private readonly statuses: string[] = [];
  private readonly errors: string[] = [];
  private idCounter = 0;

  constructor(
    private readonly runtime: OpenHorseInkRuntime,
    private readonly outputFormat: PrintOutputFormat,
  ) {}

  append(entry: TranscriptAppendEntry): string {
    const id = `print-${++this.idCounter}`;
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
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
    }
  }

  clearTranscript(): void {
    this.entries.clear();
    this.printedContent.clear();
  }

  setStatus(message: string): void {
    if (!message.trim()) return;
    this.statuses.push(message);
    if (this.outputFormat === 'text') {
      stderrLine(message);
    }
  }

  showSessionPicker(request: SessionPickerRequest): void {
    const message = `Session picker is not interactive in print mode. Use /resume <session-id> or /resume --last. (${request.sessions.length} sessions available)`;
    this.errors.push(message);
    if (this.outputFormat === 'text') {
      stderrLine(message);
    }
  }

  showPermissionRequest(request: { name: string; reason?: string }): void {
    const message = `Tool ${request.name} requires confirmation, but print mode is non-interactive.${request.reason ? ` ${request.reason}` : ''}`;
    this.errors.push(message);
    if (this.outputFormat === 'text') {
      stderrLine(message);
    }
  }

  setProcessing(_processing: boolean): void {
    // Non-interactive print mode has no live processing indicator.
  }

  result(): PrintModeResult {
    const entries = Array.from(this.entries.values());
    const content = entries
      .filter(entry => entry.role === 'assistant' || entry.role === 'system' || entry.role === 'command')
      .map(entry => entry.content)
      .filter(Boolean)
      .join('\n')
      .trimEnd();

    return {
      content,
      entries,
      statuses: [...this.statuses],
      errors: [...this.errors],
      sessionId: this.runtime.getSession()?.id ?? null,
      model: this.runtime.store.getSnapshot().currentModel || this.runtime.config.model,
    };
  }

  hasErrors(): boolean {
    return Array.from(this.entries.values()).some(entry => entry.role === 'error') || this.errors.length > 0;
  }

  private printEntry(entry: TranscriptEntry, finalized: boolean): void {
    if (this.outputFormat === 'json' || !entry.content) return;

    if (entry.role === 'assistant') {
      this.printAssistantDelta(entry, finalized);
      return;
    }

    const previous = this.printedContent.get(entry.id);
    if (previous === entry.content && !finalized) return;
    this.printedContent.set(entry.id, entry.content);

    if (entry.role === 'error') {
      this.errors.push(entry.content);
      stderrLine(entry.content);
      return;
    }

    if (entry.role === 'tool' || entry.role === 'status') {
      stderrLine(entry.content);
      return;
    }

    process.stdout.write(`${stripTrailingNewlines(entry.content)}\n`);
  }

  private printAssistantDelta(entry: TranscriptEntry, finalized: boolean): void {
    const previous = this.printedContent.get(entry.id) ?? '';
    const next = entry.content;
    if (next === previous && !finalized) return;

    if (next.startsWith(previous)) {
      const delta = next.slice(previous.length);
      if (delta) process.stdout.write(delta);
    } else {
      process.stdout.write(next);
    }
    this.printedContent.set(entry.id, next);

    if (finalized && next && !next.endsWith('\n')) {
      process.stdout.write('\n');
    }
  }
}

export async function readPromptFromStdinIfAvailable(stdin: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stdin.isTTY) return '';

  stdin.setEncoding('utf8');
  let data = '';
  for await (const chunk of stdin) {
    data += String(chunk);
  }
  return data.trim();
}

export async function launchPrintMode(
  runtime: OpenHorseInkRuntime,
  input: string,
  options: PrintModeOptions = {},
): Promise<number> {
  const outputFormat = options.outputFormat ?? 'text';
  await runtime.mcpReady?.catch(() => undefined);

  const events = new PrintEventSink(runtime, outputFormat);
  let controller!: AgentRuntimeController;
  const eventSink: AgentRuntimeEventSink = {
    emit: event => {
      if (event.type !== 'permission_requested') {
        return emitToUiEventSink(events, event);
      }

      events.showPermissionRequest(event.request);
      controller.handle({
        type: 'permission_decision',
        requestId: event.request.id,
        approved: false,
        source: 'programmatic',
      });
      return undefined;
    },
  };
  controller = new AgentRuntimeController({
    runtime,
    eventSink,
    echoSubmittedInput: false,
    useRuntimeToolPermissions: true,
  });

  try {
    const result = controller.handle({ type: 'submit', text: input, source: 'programmatic' });
    if (result.type === 'exit_requested' || result.type === 'empty') {
      return result.type === 'empty' ? 1 : 0;
    }
    await controller.waitForIdle();
  } finally {
    await runtime.shutdown();
  }

  if (outputFormat === 'json') {
    process.stdout.write(`${JSON.stringify(events.result(), null, 2)}\n`);
  }

  return events.hasErrors() ? 1 : 0;
}
