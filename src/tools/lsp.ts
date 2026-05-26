/**
 * openhorse - LSP 工具
 *
 * 提供代码智能功能：
 *   - lsp_get_definition: go-to-definition
 *   - lsp_get_references: 引用查询
 *   - lsp_get_hover: Hover 信息
 *   - lsp_get_diagnostics: 诊断获取
 *
 * 支持 tsserver, pyright
 */

import { buildTool, type OpenHorseTool, type ToolResult, type ToolContext } from '../framework/tool';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

// ============================================================================
// LSP Client
// ============================================================================

interface LspPosition {
  line: number;
  character: number;
}

interface LspLocation {
  uri: string;
  range: {
    start: LspPosition;
    end: LspPosition;
  };
}

interface LspDiagnostic {
  range: { start: LspPosition; end: LspPosition };
  severity: number;
  message: string;
  source?: string;
  code?: string | number;
}

interface LspHover {
  contents: string | { kind: string; value: string } | Array<{ kind: string; value: string }>;
  range?: { start: LspPosition; end: LspPosition };
}

class LspClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private requestId: number = 0;
  private pendingRequests: Map<number, { resolve: Function; reject: Function }> = new Map();
  private buffer: string = '';
  private initialized: boolean = false;

  constructor(private language: string, private projectRoot: string) {
    super();
  }

  async start(): Promise<void> {
    const command = this.getLspCommand();

    this.process = spawn(command.cmd, command.args, {
      cwd: this.projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      this.handleData(data.toString());
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      this.emit('error', data.toString());
    });

    this.process.on('error', (err) => {
      this.emit('error', err.message);
    });

    // 初始化 LSP
    await this.sendRequest('initialize', {
      processId: process.pid,
      rootUri: `file://${this.projectRoot}`,
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          references: { dynamicRegistration: false },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          publishDiagnostics: { relatedInformation: true },
        },
      },
    });

    this.initialized = true;

    // 发送 initialized 通知
    this.sendNotification('initialized', {});
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.sendNotification('shutdown', {});
      try {
        await this.sendRequest('exit', {});
      } catch {
        // 忽略退出请求错误
      }
      this.process.kill();
      this.process = null;
    }
  }

  async getDefinition(uri: string, position: LspPosition): Promise<LspLocation[] | LspLocation | null> {
    const result = await this.sendRequest('textDocument/definition', {
      textDocument: { uri },
      position,
    });
    return result as LspLocation[] | LspLocation | null;
  }

  async getReferences(uri: string, position: LspPosition, includeDeclaration: boolean = true): Promise<LspLocation[] | null> {
    const result = await this.sendRequest('textDocument/references', {
      textDocument: { uri },
      position,
      context: { includeDeclaration },
    });
    return result as LspLocation[] | null;
  }

  async getHover(uri: string, position: LspPosition): Promise<LspHover | null> {
    const result = await this.sendRequest('textDocument/hover', {
      textDocument: { uri },
      position,
    });
    return result as LspHover | null;
  }

  async getDiagnostics(uri: string): Promise<LspDiagnostic[]> {
    // 诊断通常通过 notification 发送，这里请求主动获取
    const result = await this.sendRequest('textDocument/diagnostic', {
      textDocument: { uri },
    });
    return (result as { items: LspDiagnostic[] })?.items || [];
  }

  private getLspCommand(): { cmd: string; args: string[] } {
    switch (this.language) {
      case 'typescript':
      case 'javascript':
        return { cmd: 'typescript-language-server', args: ['--stdio'] };
      case 'python':
        return { cmd: 'pyright', args: ['--stdio'] };
      default:
        throw new Error(`Unsupported language: ${this.language}`);
    }
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      const message = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });

      this.pendingRequests.set(id, { resolve, reject });

      const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;
      this.process?.stdin?.write(header + message);

      // 超时处理
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const message = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    });

    const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;
    this.process?.stdin?.write(header + message);
  }

  private handleData(data: string): void {
    this.buffer += data;

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length: (\d+)/);
      if (!contentLengthMatch) break;

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const contentStart = headerEnd + 4;
      const contentEnd = contentStart + contentLength;

      if (this.buffer.length < contentEnd) break;

      const content = this.buffer.slice(contentStart, contentEnd);
      this.buffer = this.buffer.slice(contentEnd);

      try {
        const response = JSON.parse(content);
        this.handleResponse(response);
      } catch (err) {
        this.emit('error', `Failed to parse LSP response: ${err}`);
      }
    }
  }

  private handleResponse(response: { id?: number; result?: unknown; error?: { message: string } }): void {
    if (response.id !== undefined) {
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        if (response.error) {
          pending.reject(new Error(response.error.message));
        } else {
          pending.resolve(response.result);
        }
      }
    }
  }
}

// ============================================================================
// LSP Manager
// ============================================================================

class LspManager {
  private clients: Map<string, LspClient> = new Map();

  async getClient(language: string, projectRoot: string): Promise<LspClient> {
    const key = `${language}:${projectRoot}`;

    if (!this.clients.has(key)) {
      const client = new LspClient(language, projectRoot);
      await client.start();
      this.clients.set(key, client);
    }

    return this.clients.get(key)!;
  }

  async shutdownAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.stop();
    }
    this.clients.clear();
  }
}

const lspManager = new LspManager();

// ============================================================================
// LSP 工具定义
// ============================================================================

/**
 * 检测文件语言类型
 */
function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'py':
      return 'python';
    default:
      return 'typescript'; // 默认
  }
}

/**
 * 转换文件路径为 URI
 */
function pathToUri(filePath: string): string {
  return `file://${filePath}`;
}

/**
 * 解析 LSP Location 结果
 */
function formatLocationResult(location: LspLocation[] | LspLocation | null): string {
  if (!location) return 'No definition found';

  const locations = Array.isArray(location) ? location : [location];

  if (locations.length === 0) return 'No definition found';

  return locations.map(loc => {
    const path = loc.uri.replace('file://', '');
    const line = loc.range.start.line + 1;
    const char = loc.range.start.character + 1;
    return `${path}:${line}:${char}`;
  }).join('\n');
}

/**
 * 解析 Hover 结果
 */
function formatHoverResult(hover: LspHover | null): string {
  if (!hover) return 'No hover information';

  if (typeof hover.contents === 'string') {
    return hover.contents;
  }

  if (Array.isArray(hover.contents)) {
    return hover.contents.map(c => c.value).join('\n');
  }

  return hover.contents.value;
}

// ============================================================================
// 工具注册
// ============================================================================

export const lspGetDefinitionTool: OpenHorseTool = buildTool({
  name: 'lsp_get_definition',
  description: 'Get definition location for a symbol at a position. Supports TypeScript, JavaScript, Python.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file',
      },
      line: {
        type: 'number',
        description: 'Line number (1-based)',
      },
      character: {
        type: 'number',
        description: 'Character position (1-based)',
      },
    },
    required: ['file_path', 'line', 'character'],
  },
  execute: async (args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const file_path = args.file_path as string;
    const line = args.line as number;
    const character = args.character as number;

    const language = detectLanguage(file_path);
    const uri = pathToUri(file_path);
    const position = {
      line: line - 1, // LSP 使用 0-based
      character: character - 1,
    };

    try {
      const client = await lspManager.getClient(language, context.cwd);
      const result = await client.getDefinition(uri, position);
      return { success: true, output: formatLocationResult(result) };
    } catch (err) {
      return { success: false, output: '', error: String(err) };
    }
  },
  isReadOnly: () => true,
});

export const lspGetReferencesTool: OpenHorseTool = buildTool({
  name: 'lsp_get_references',
  description: 'Get all references to a symbol at a position. Supports TypeScript, JavaScript, Python.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file',
      },
      line: {
        type: 'number',
        description: 'Line number (1-based)',
      },
      character: {
        type: 'number',
        description: 'Character position (1-based)',
      },
      include_declaration: {
        type: 'boolean',
        description: 'Include declaration in results (default: true)',
      },
    },
    required: ['file_path', 'line', 'character'],
  },
  execute: async (args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const file_path = args.file_path as string;
    const line = args.line as number;
    const character = args.character as number;
    const include_declaration = args.include_declaration !== false;

    const language = detectLanguage(file_path);
    const uri = pathToUri(file_path);
    const position = {
      line: line - 1,
      character: character - 1,
    };

    try {
      const client = await lspManager.getClient(language, context.cwd);
      const result = await client.getReferences(uri, position, include_declaration);
      return { success: true, output: formatLocationResult(result) };
    } catch (err) {
      return { success: false, output: '', error: String(err) };
    }
  },
  isReadOnly: () => true,
});

export const lspGetHoverTool: OpenHorseTool = buildTool({
  name: 'lsp_get_hover',
  description: 'Get hover information (type, docs) for a symbol at a position. Supports TypeScript, JavaScript, Python.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file',
      },
      line: {
        type: 'number',
        description: 'Line number (1-based)',
      },
      character: {
        type: 'number',
        description: 'Character position (1-based)',
      },
    },
    required: ['file_path', 'line', 'character'],
  },
  execute: async (args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const file_path = args.file_path as string;
    const line = args.line as number;
    const character = args.character as number;

    const language = detectLanguage(file_path);
    const uri = pathToUri(file_path);
    const position = {
      line: line - 1,
      character: character - 1,
    };

    try {
      const client = await lspManager.getClient(language, context.cwd);
      const result = await client.getHover(uri, position);
      return { success: true, output: formatHoverResult(result) };
    } catch (err) {
      return { success: false, output: '', error: String(err) };
    }
  },
  isReadOnly: () => true,
});

export const lspGetDiagnosticsTool: OpenHorseTool = buildTool({
  name: 'lsp_get_diagnostics',
  description: 'Get diagnostics (errors, warnings) for a file. Supports TypeScript, JavaScript, Python.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file',
      },
    },
    required: ['file_path'],
  },
  execute: async (args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    const file_path = args.file_path as string;

    const language = detectLanguage(file_path);
    const uri = pathToUri(file_path);

    try {
      const client = await lspManager.getClient(language, context.cwd);
      const diagnostics = await client.getDiagnostics(uri);

      if (diagnostics.length === 0) {
        return { success: true, output: 'No diagnostics found' };
      }

      const severityMap: Record<number, string> = {
        1: 'Error',
        2: 'Warning',
        3: 'Information',
        4: 'Hint',
      };

      const output = diagnostics.map(d => {
        const sev = severityMap[d.severity] || 'Unknown';
        const line = d.range.start.line + 1;
        const char = d.range.start.character + 1;
        return `[${sev}] ${file_path}:${line}:${char}: ${d.message}`;
      }).join('\n');

      return { success: true, output };
    } catch (err) {
      return { success: false, output: '', error: String(err) };
    }
  },
  isReadOnly: () => true,
});

// 导出所有 LSP 工具
export const lspTools: OpenHorseTool[] = [
  lspGetDefinitionTool,
  lspGetReferencesTool,
  lspGetHoverTool,
  lspGetDiagnosticsTool,
];