/**
 * openhorse - 工具集
 *
 * 定义 Agent 可用的工具（Tool System v2）：
 *   - read_file: 读取文件内容
 *   - write_file: 写入文件
 *   - list_files: 列出目录
 *   - exec_command: 执行 shell 命令
 *
 * 使用 buildTool() 工厂模式。
 */

import { execFile, spawn } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, createReadStream } from 'fs';
import { join, resolve, relative, extname } from 'path';
import { createInterface } from 'readline';
import { buildTool, type OpenHorseTool, type ToolResult, type ToolContext } from '../framework/tool';
import {
  saveMemory,
  loadMemory,
  loadAllMemories,
  searchMemories,
  deleteMemory,
  type MemoryEntry,
  type MemoryType,
} from '../memory';
import { getSemanticSearchService, isSemanticEnabled } from '../memory/semantic-search';
import { readSessionMessages, loadSessionMeta, listSessions, type SessionMessage } from '../services/session-storage';
import { WEB_TOOLS } from './web';
import { MCP_TOOLS } from './mcp';
import { TODO_TOOLS } from './todo';
import { PLAN_TOOLS } from './plan';
import { GIT_TOOLS } from './git';
import { lspTools } from './lsp';
import {
  assessCommandSecurity,
  isReadOnlyCommand,
  checkDangerousCommand,
  wrapForSandbox,
  type SandboxOptions,
  DEFAULT_SANDBOX_OPTIONS,
} from './bash_security';

// ============================================================================
// 工具集
// ============================================================================

export const TOOLS: OpenHorseTool[] = [
  // Web tools (P0)
  ...WEB_TOOLS,

  // MCP tools (P0)
  ...MCP_TOOLS,

  // Git tools (P0 - Issue #18/#23)
  ...GIT_TOOLS,

  // LSP tools (P0 - Phase 6)
  ...lspTools,

  // Todo tools (P1)
  ...TODO_TOOLS,

  // Plan mode tools (P1)
  ...PLAN_TOOLS,

  // File tools
  buildTool({
    name: 'read_file',
    description: '读取文件的全部内容。返回文件内容字符串。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径（绝对路径或相对路径）',
        },
        maxLines: {
          type: 'number',
          description: '最大读取行数（可选，默认 500 行）',
        },
      },
      required: ['path'],
    },
    execute: async (args) => {
      // Ensure path is a valid string
      const path = args.path;
      if (!path || typeof path !== 'string') {
        return { success: false, output: '', error: 'read_file requires a path parameter' };
      }
      return readFileSync_(path, args.maxLines as number | undefined);
    },
    isReadOnly: () => true,
    userFacingName: (args) => `Read ${args.path as string}`,
  }),

  buildTool({
    name: 'write_file',
    description: '将内容写入文件。如果文件不存在则创建，存在则覆盖。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径（绝对路径或相对路径）',
        },
        content: {
          type: 'string',
          description: '要写入的文件内容',
        },
      },
      required: ['path', 'content'],
    },
    execute: async (args) => {
      // Ensure path and content are valid strings
      const path = args.path;
      const content = args.content;
      if (!path || typeof path !== 'string') {
        return { success: false, output: '', error: 'write_file requires a path parameter' };
      }
      if (!content || typeof content !== 'string') {
        return { success: false, output: '', error: 'write_file requires a content parameter' };
      }
      return writeFileSync_(path, content);
    },
    isDestructive: () => true,
    checkPermissions: (args, context) => {
      // Destructive operation - ask for confirmation in default mode
      return { behavior: 'ask', reason: 'Write operation may modify existing files' };
    },
    userFacingName: (args) => `Write ${args.path as string}`,
  }),

  buildTool({
    name: 'list_files',
    description: '列出指定目录中的文件和子目录。支持控制递归深度。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '目录路径（绝对路径或相对路径）',
        },
        maxDepth: {
          type: 'number',
          description: '最大递归深度（可选，默认 2）',
        },
      },
      required: ['path'],
    },
    execute: async (args) => {
      // Ensure path is a valid string
      const path = args.path;
      if (!path || typeof path !== 'string') {
        return { success: false, output: '', error: 'list_files requires a path parameter' };
      }
      return listFiles_(path, args.maxDepth as number | undefined);
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    userFacingName: (args) => `List ${args.path as string}`,
  }),

  buildTool({
    name: 'exec_command',
    description: '执行一个 shell 命令。返回 stdout 和 stderr。输出超过 maxOutput 会自动截断。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的 shell 命令',
        },
        cwd: {
          type: 'string',
          description: '工作目录（可选，默认当前目录）',
        },
        timeout: {
          type: 'number',
          description: '超时时间 ms（可选，默认 30000）',
        },
        maxOutput: {
          type: 'number',
          description: '最大输出字节数（可选，默认 51200 = 50KB，超出截断）',
        },
      },
      required: ['command'],
    },
    execute: async (args, context) => {
      // Ensure command is a valid string
      const command = args.command;
      if (!command || typeof command !== 'string') {
        return { success: false, output: '', error: 'exec_command requires a command parameter' };
      }
      // Issue #32 #3.2: 传递 abortSignal
      return execCommand_(command, args.cwd as string | undefined, args.timeout as number | undefined, args.maxOutput as number | undefined, context.abortSignal);
    },
    isDestructive: (args) => {
      const cmd = (args.command as string) || '';
      return /(rm\s+-rf|mkfs|dd\s)/.test(cmd);
    },
    checkPermissions: (args, context) => {
      const cmd = (args.command as string) || '';

      // Use the bash_security module for comprehensive checks
      const security = assessCommandSecurity(cmd);

      if (security.level === 'blocked') {
        return { behavior: 'deny', reason: security.reason || `Command blocked by safety policy: ${cmd.slice(0, 50)}` };
      }

      if (security.level === 'safe' && security.isReadOnly) {
        return { behavior: 'allow' };
      }

      if (security.level === 'caution') {
        return { behavior: 'ask', reason: security.reason || 'Command requires confirmation' };
      }

      // Default: ask for confirmation
      return { behavior: 'ask', reason: 'Command requires confirmation' };
    },
    isReadOnly: (args) => {
      const cmd = (args.command as string) || '';
      return isReadOnlyCommand(cmd);
    },
    userFacingName: (args) => `Exec ${(args.command as string)?.slice(0, 60) || ''}`,
  }),

  buildTool({
    name: 'edit_file',
    description: '对文件进行精确字符串替换。old_string 必须在文件中唯一匹配，否则拒绝执行。使用 replace_all 可替换所有匹配。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径（绝对路径或相对路径）',
        },
        old_string: {
          type: 'string',
          description: '要替换的字符串（必须精确匹配）',
        },
        new_string: {
          type: 'string',
          description: '替换后的字符串',
        },
        replace_all: {
          type: 'boolean',
          description: '是否替换所有匹配（可选，默认 false）',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    execute: async (args) => {
      // Ensure required parameters are valid strings
      const path = args.path;
      const old_string = args.old_string;
      const new_string = args.new_string;
      if (!path || typeof path !== 'string') {
        return { success: false, output: '', error: 'edit_file requires a path parameter' };
      }
      if (!old_string || typeof old_string !== 'string') {
        return { success: false, output: '', error: 'edit_file requires an old_string parameter' };
      }
      if (!new_string || typeof new_string !== 'string') {
        return { success: false, output: '', error: 'edit_file requires a new_string parameter' };
      }
      return editFile_(path, old_string, new_string, args.replace_all as boolean | undefined);
    },
    isDestructive: () => true,
    checkPermissions: (args, context) => {
      return { behavior: 'ask', reason: 'Edit operation modifies file contents' };
    },
    userFacingName: (args) => `Edit ${args.path as string}`,
  }),

  buildTool({
    name: 'glob',
    description: '使用 glob 模式搜索文件。支持 **（递归）、*（任意字符）、?（单个字符）等通配符。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob 模式（如 **/*.ts, src/**/*.js）',
        },
        path: {
          type: 'string',
          description: '搜索起始目录（可选，默认当前目录）',
        },
      },
      required: ['pattern'],
    },
    execute: async (args) => {
      // Ensure pattern is a valid string
      const pattern = args.pattern;
      if (!pattern || typeof pattern !== 'string') {
        return { success: false, output: '', error: 'glob requires a pattern parameter' };
      }
      return glob_(pattern, args.path as string | undefined);
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    userFacingName: (args) => `Glob ${args.pattern as string}`,
  }),

  buildTool({
    name: 'grep',
    description: '在文件中搜索正则表达式模式。返回匹配的文件路径和行内容。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '正则表达式模式',
        },
        path: {
          type: 'string',
          description: '搜索路径（可选，默认当前目录）',
        },
        glob: {
          type: 'string',
          description: '文件过滤模式（可选，如 *.ts）',
        },
        context: {
          type: 'number',
          description: '上下文行数（可选，默认 0）',
        },
      },
      required: ['pattern'],
    },
    execute: async (args) => {
      // Ensure pattern is a valid string
      const pattern = args.pattern;
      if (!pattern || typeof pattern !== 'string') {
        return { success: false, output: '', error: 'grep requires a pattern parameter' };
      }
      return grep_(pattern, args.path as string | undefined, args.glob as string | undefined, args.context as number | undefined);
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    userFacingName: (args) => `Grep ${args.pattern as string}`,
  }),

  // Memory tools
  buildTool({
    name: 'memory_save',
    description: 'Save a memory entry to the persistent memory system. Memories help tailor behavior to user preferences.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Memory name (kebab-case, e.g., "user-role", "feedback-style")',
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: 'Memory type',
        },
        description: {
          type: 'string',
          description: 'One-line description for memory index',
        },
        content: {
          type: 'string',
          description: 'Memory content. For feedback/project: use rule + Why + How to apply structure',
        },
      },
      required: ['name', 'type', 'content'],
    },
    execute: async (args) => {
      const name = args.name as string;
      const type = args.type as MemoryType;
      const content = args.content as string;
      const description = (args.description as string) || content.slice(0, 80);

      if (!name || typeof name !== 'string') {
        return { success: false, output: '', error: 'memory_save requires a name parameter' };
      }
      if (!type || !['user', 'feedback', 'project', 'reference'].includes(type)) {
        return { success: false, output: '', error: 'memory_save requires a valid type: user, feedback, project, or reference' };
      }
      if (!content || typeof content !== 'string') {
        return { success: false, output: '', error: 'memory_save requires a content parameter' };
      }

      try {
        const projectPath = process.cwd();
        const entry: MemoryEntry = {
          name,
          type,
          description,
          content,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        if (isSemanticEnabled()) {
          // saveAndIndex internally calls saveMemory + vectorStore.upsert
          await getSemanticSearchService().saveAndIndex(entry, projectPath);
        } else {
          saveMemory(entry, projectPath);
        }
        return { success: true, output: `Saved memory: ${name} (${type})` };
      } catch (err: any) {
        return { success: false, output: '', error: err.message };
      }
    },
    isReadOnly: () => false,
    userFacingName: (args) => `Memory save ${args.name as string}`,
  }),

  buildTool({
    name: 'memory_recall',
    description: 'Recall memories from the memory system. Returns matching memories or all if no query.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (optional, returns all if empty)',
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: 'Filter by memory type (optional)',
        },
      },
      required: [],
    },
    execute: async (args) => {
      try {
        const projectPath = process.cwd();
        const query = (args.query as string) || '';
        const type = args.type as MemoryType | undefined;

        let memories: MemoryEntry[];

        if (query && isSemanticEnabled()) {
          // Semantic path: ask the vector store, then fall back to keywords if it
          // returns nothing (e.g. embedding provider unreachable, empty index)
          try {
            const result = await getSemanticSearchService().search({
              query,
              projectPath,
              type,
            });
            memories = result.memories.map(m => ({
              name: m.name,
              type: m.type,
              description: m.description,
              content: m.content,
              createdAt: m.createdAt,
              updatedAt: m.createdAt,
            }));
            if (memories.length === 0) {
              memories = searchMemories(query, projectPath);
              if (type) memories = memories.filter(m => m.type === type);
            }
          } catch {
            memories = searchMemories(query, projectPath);
            if (type) memories = memories.filter(m => m.type === type);
          }
        } else if (type) {
          memories = loadAllMemories(projectPath).filter(m => m.type === type);
        } else if (query) {
          memories = searchMemories(query, projectPath);
        } else {
          memories = loadAllMemories(projectPath);
        }

        if (memories.length === 0) {
          return { success: true, output: 'No memories found' };
        }

        const lines: string[] = [];
        for (const mem of memories) {
          lines.push(`## ${mem.name} (${mem.type})`);
          lines.push(mem.description);
          lines.push(mem.content);
          lines.push('');
        }

        return { success: true, output: lines.join('\n') };
      } catch (err: any) {
        return { success: false, output: '', error: err.message };
      }
    },
    isReadOnly: () => true,
    userFacingName: (args) => `Memory recall ${(args.query as string) || 'all'}`,
  }),

  buildTool({
    name: 'memory_forget',
    description: 'Delete a memory entry from the memory system.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Memory name to delete',
        },
      },
      required: ['name'],
    },
    execute: async (args) => {
      const name = args.name as string;
      if (!name || typeof name !== 'string') {
        return { success: false, output: '', error: 'memory_forget requires a name parameter' };
      }

      try {
        const projectPath = process.cwd();
        const existing = loadMemory(name, projectPath);
        if (!existing) {
          return { success: false, output: '', error: `Memory not found: ${name}` };
        }
        deleteMemory(name, projectPath);

        if (isSemanticEnabled()) {
          try {
            const { getVectorStore } = require('../memory/vector-store');
            getVectorStore().delete(name);
          } catch {
            // Vector store cleanup is best-effort
          }
        }

        return { success: true, output: `Deleted memory: ${name}` };
      } catch (err: any) {
        return { success: false, output: '', error: err.message };
      }
    },
    isReadOnly: () => false,
    userFacingName: (args) => `Memory forget ${args.name as string}`,
  }),

  // History search tool
  buildTool({
    name: 'history_search',
    description: 'Search previous tool operations in current or past sessions. Helps find what was done before.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (tool name, file path, keyword)',
        },
        sessionId: {
          type: 'string',
          description: 'Session ID to search (optional, defaults to searching recent sessions)',
        },
        limit: {
          type: 'number',
          description: 'Max results (optional, default 10)',
        },
      },
      required: ['query'],
    },
    execute: async (args) => {
      const query = args.query as string;
      if (!query || typeof query !== 'string') {
        return { success: false, output: '', error: 'history_search requires a query parameter' };
      }

      try {
        const limit = (args.limit as number) || 10;
        const sessionId = args.sessionId as string | undefined;

        // If sessionId provided, search that session; otherwise search all recent sessions
        const sessions = sessionId
          ? [loadSessionMeta(sessionId)!].filter(Boolean)
          : listSessions(5);

        const results: Array<{
          sessionId: string;
          tool: string;
          args: string;
          resultPreview: string;
          timestamp: number;
        }> = [];

        for (const session of sessions) {
          if (!session) continue;
          const messages = readSessionMessages(session.id);

          // Search through messages for tool calls matching query
          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.role === 'assistant' && msg.tool_calls) {
              for (const tc of msg.tool_calls) {
                // Match tool name or arguments content
                const matchesQuery =
                  tc.function.name.toLowerCase().includes(query.toLowerCase()) ||
                  tc.function.arguments.toLowerCase().includes(query.toLowerCase());

                if (matchesQuery) {
                  // Find corresponding tool result
                  const nextMsg = messages[i + 1];
                  const resultPreview = nextMsg?.role === 'tool' && nextMsg.toolCallId === tc.id
                    ? nextMsg.content.slice(0, 200)
                    : '(no result)';

                  results.push({
                    sessionId: session.id.slice(0, 8),
                    tool: tc.function.name,
                    args: tc.function.arguments.slice(0, 100),
                    resultPreview,
                    timestamp: msg.timestamp,
                  });
                }
              }
            }
          }
        }

        // Sort by timestamp (newest first) and limit
        results.sort((a, b) => b.timestamp - a.timestamp);
        const limited = results.slice(0, limit);

        if (limited.length === 0) {
          return { success: true, output: 'No matching tool operations found' };
        }

        const lines: string[] = [];
        lines.push(`Found ${limited.length} matching operations:`);
        lines.push('');
        for (const r of limited) {
          lines.push(`Session ${r.sessionId}: ${r.tool}`);
          lines.push(`  Args: ${r.args}`);
          lines.push(`  Result: ${r.resultPreview.slice(0, 100)}...`);
          lines.push('');
        }

        return { success: true, output: lines.join('\n') };
      } catch (err: any) {
        return { success: false, output: '', error: err.message };
      }
    },
    isReadOnly: () => true,
    userFacingName: (args) => `History search ${args.query as string}`,
  }),
];

// ============================================================================
// 工具实现
// ============================================================================

/** 安全路径解析 — 防止路径遍历攻击 */
function safePath(input: string): string {
  const resolved = resolve(input);
  const cwd = process.cwd();
  if (relative(cwd, resolved).startsWith('..')) {
    return cwd;
  }
  return resolved;
}

async function readFileSync_(path: string, maxLines?: number): Promise<ToolResult> {
  try {
    const resolved = safePath(path);
    if (!existsSync(resolved)) {
      return { success: false, output: '', error: `File not found: ${path}` };
    }
    if (statSync(resolved).isDirectory()) {
      return { success: false, output: '', error: `Path is a directory, not a file: ${path}` };
    }

    const content = readFileSync(resolved, 'utf-8');
    const lines = content.split('\n');
    const limit = maxLines ?? 500;

    if (lines.length > limit) {
      return {
        success: true,
        output: lines.slice(0, limit).join('\n') + `\n\n[... truncated, ${lines.length - limit} more lines]`,
      };
    }

    return { success: true, output: content };
  } catch (err: any) {
    return { success: false, output: '', error: String(err.message) };
  }
}

async function writeFileSync_(path: string, content: string): Promise<ToolResult> {
  try {
    const resolved = safePath(path);
    writeFileSync(resolved, content, 'utf-8');
    return { success: true, output: `Wrote ${content.split('\n').length} lines to ${path}` };
  } catch (err: any) {
    return { success: false, output: '', error: String(err.message) };
  }
}

async function listFiles_(path: string, maxDepth?: number): Promise<ToolResult> {
  const resolved = safePath(path);
  if (!existsSync(resolved)) {
    return { success: false, output: '', error: `Path not found: ${path}` };
  }
  if (!statSync(resolved).isDirectory()) {
    return { success: true, output: path };
  }

  const depth = maxDepth ?? 2;
  const results: string[] = [];

  function walk(dir: string, currentDepth: number, prefix: string) {
    if (currentDepth > depth) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        const fullPath = join(dir, entry.name);
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          results.push(`${relPath}/`);
          walk(fullPath, currentDepth + 1, relPath);
        } else {
          results.push(relPath);
        }
      }
    } catch {
      // skip unreadable directories
    }
  }

  walk(resolved, 1, '');
  return { success: true, output: results.join('\n') };
}

// Issue #32 #3.2: execCommand_ 支持 abortSignal
async function execCommand_(command: string, cwd?: string, timeout?: number, maxOutput?: number, abortSignal?: AbortSignal): Promise<ToolResult> {
  return new Promise((resolve) => {
    const workdir = cwd ? safePath(cwd) : process.cwd();
    const timeoutMs = timeout ?? 30000;
    const maxBytes = maxOutput ?? 51200; // Default 50KB, Issue #28 fix

    // Use spawn for streaming output with truncation support
    const child = spawn('sh', ['-c', command], {
      cwd: workdir,
    });

    let stdoutData = '';
    let stderrData = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    // Issue #32 修复：使用独立计数器
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let aborted = false;

    // Issue #32 #3.2: AbortSignal 处理
    const abortHandler = () => {
      aborted = true;
      if (child.pid) {
        child.kill('SIGTERM');
      }
      resolve({
        success: false,
        output: stdoutData.slice(0, maxBytes),
        error: 'Command aborted by user',
      });
    };

    if (abortSignal) {
      abortSignal.addEventListener('abort', abortHandler);
    }

    // Timeout handling
    const timeoutId = setTimeout(() => {
      if (!aborted) {
        child.kill();
        resolve({
          success: false,
          output: stdoutData.slice(0, maxBytes),
          error: `Command timed out after ${timeoutMs}ms`,
        });
      }
    }, timeoutMs);

    // Stream stdout with truncation
    child.stdout.on('data', (data: Buffer) => {
      if (!stdoutTruncated) {
        const chunk = data.toString();
        stdoutBytes += chunk.length;

        if (stdoutBytes > maxBytes) {
          stdoutTruncated = true;
          stdoutData += chunk.slice(0, maxBytes - stdoutData.length);
        } else {
          stdoutData += chunk;
        }
      }
    });

    // Stream stderr with truncation (Issue #32 修复：使用独立计数器)
    child.stderr.on('data', (data: Buffer) => {
      if (!stderrTruncated) {
        const chunk = data.toString();
        stderrBytes += chunk.length;

        if (stderrBytes > maxBytes) {
          stderrTruncated = true;
          stderrData += chunk.slice(0, maxBytes - stderrData.length);
        } else {
          stderrData += chunk;
        }
      }
    });

    child.on('close', (code) => {
      clearTimeout(timeoutId);
      // Issue #32 #3.2: 清理 abortSignal 监听器
      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler);
      }

      // 如果已被 abort，不再处理结果
      if (aborted) return;

      const output = stdoutData.trim();
      const errOutput = stderrData.trim();

      // Add truncation notice if output was truncated
      let finalOutput = output;
      if (stdoutTruncated) {
        finalOutput += '\n\n[... output truncated, exceeded 50KB limit]';
      }

      if (code !== 0) {
        resolve({
          success: false,
          output: finalOutput || errOutput,
          error: `Command exited with code ${code}`,
        });
      } else {
        resolve({
          success: true,
          output: finalOutput || '(no output)',
          error: stderrTruncated ? errOutput + '\n\n[... stderr truncated]' : errOutput || undefined,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      resolve({
        success: false,
        output: '',
        error: err.message,
      });
    });
  });
}

async function editFile_(path: string, old_string: string, new_string: string, replace_all?: boolean): Promise<ToolResult> {
  try {
    const resolved = safePath(path);
    if (!existsSync(resolved)) {
      return { success: false, output: '', error: `File not found: ${path}` };
    }
    if (statSync(resolved).isDirectory()) {
      return { success: false, output: '', error: `Path is a directory, not a file: ${path}` };
    }

    const content = readFileSync(resolved, 'utf-8');

    // Check if old_string exists
    const count = (content.match(new RegExp(escapeRegExp(old_string), 'g')) || []).length;
    if (count === 0) {
      return { success: false, output: '', error: `old_string not found in file: ${old_string.slice(0, 100)}...` };
    }

    // If not replace_all, require unique match
    if (!replace_all && count > 1) {
      return {
        success: false,
        output: '',
        error: `old_string found ${count} times in file. Use replace_all=true to replace all occurrences, or provide a more specific string that matches exactly once.`,
      };
    }

    // Perform replacement
    let newContent: string;
    if (replace_all) {
      newContent = content.split(old_string).join(new_string);
    } else {
      // Replace first occurrence only
      const idx = content.indexOf(old_string);
      newContent = content.slice(0, idx) + new_string + content.slice(idx + old_string.length);
    }

    writeFileSync(resolved, newContent, 'utf-8');

    return {
      success: true,
      output: `Replaced ${count} occurrence(s) of old_string with new_string in ${path}`,
    };
  } catch (err: any) {
    return { success: false, output: '', error: String(err.message) };
  }
}

/** Escape special regex characters for literal matching */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// Glob/Grep 工具实现
// ============================================================================

/**
 * Glob 模式匹配 - 简化版实现
 * 支持: **（递归目录）、*（任意字符）、?（单个字符）
 */
async function glob_(pattern: string, basePath?: string): Promise<ToolResult> {
  try {
    const base = basePath ? safePath(basePath) : process.cwd();
    if (!existsSync(base)) {
      return { success: false, output: '', error: `Path not found: ${basePath}` };
    }
    if (!statSync(base).isDirectory()) {
      return { success: false, output: '', error: `Path is not a directory: ${basePath}` };
    }

    const results: string[] = [];

    // Convert glob pattern to regex
    function globToRegex(pat: string): RegExp {
      // Use placeholders to avoid interference between replacements
      let regex = pat;

      // **/ at start - matches optional path (including empty)
      regex = regex.replace(/^\*\*\//, '<<STARSTAR_SLASH_START>>');

      // **/ in middle - matches any number of path segments
      regex = regex.replace(/\*\*\//g, '<<STARSTAR_SLASH>>');

      // standalone ** - matches anything
      regex = regex.replace(/\*\*/g, '<<STARSTAR>>');

      // escape dots
      regex = regex.replace(/\./g, '\\.');

      // * matches anything except /
      regex = regex.replace(/\*/g, '[^/]*');

      // ? matches single char except /
      regex = regex.replace(/\?/g, '[^/]');

      // Now restore ** placeholders
      regex = regex.replace(/<<STARSTAR_SLASH_START>>/g, '(.*\\/)?');
      regex = regex.replace(/<<STARSTAR_SLASH>>/g, '([^/]+\\/)*');
      regex = regex.replace(/<<STARSTAR>>/g, '.*');

      return new RegExp(`^${regex}$`);
    }

    const regex = globToRegex(pattern);

    // Recursive walk
    function walk(dir: string, prefix: string) {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;

          const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            walk(join(dir, entry.name), relPath);
          } else {
            if (regex.test(relPath)) {
              results.push(relPath);
            }
          }
        }
      } catch {
        // skip unreadable directories
      }
    }

    walk(base, '');

    if (results.length === 0) {
      return { success: true, output: 'No files found matching pattern' };
    }

    return { success: true, output: results.sort().join('\n') };
  } catch (err: any) {
    return { success: false, output: '', error: String(err.message) };
  }
}

/**
 * Grep 搜索 - 在文件中搜索正则表达式
 */
async function grep_(pattern: string, basePath?: string, globPattern?: string, contextLines?: number): Promise<ToolResult> {
  try {
    const base = basePath ? safePath(basePath) : process.cwd();
    if (!existsSync(base)) {
      return { success: false, output: '', error: `Path not found: ${basePath}` };
    }

    const regex = new RegExp(pattern, 'g');
    const context = contextLines ?? 0;
    const results: string[] = [];
    const maxResults = 100;

    // Get list of files to search
    const files: string[] = [];

    function collectFiles(dir: string) {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            collectFiles(fullPath);
          } else {
            // Check glob filter if provided
            if (globPattern) {
              const ext = extname(entry.name);
              if (!matchGlobSimple(entry.name, globPattern)) continue;
            }
            files.push(fullPath);
          }
        }
      } catch {
        // skip unreadable
      }
    }

    function matchGlobSimple(name: string, pat: string): boolean {
      const regex = pat.replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\./g, '\\.');
      return new RegExp(`^${regex}$`).test(name);
    }

    if (statSync(base).isDirectory()) {
      collectFiles(base);
    } else {
      files.push(base);
    }

    // Search each file
    for (const file of files) {
      if (results.length >= maxResults) break;

      try {
        const rl = createInterface({
          input: createReadStream(file, { encoding: 'utf-8' }),
          crlfDelay: Infinity,
        });

        const lines: string[] = [];
        const relPath = relative(base, file);

        rl.on('line', (line) => {
          lines.push(line);
        });

        await new Promise<void>((resolve) => {
          rl.on('close', resolve);
        });

        // Search for matches
        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
          if (regex.test(lines[i])) {
            // Format: file:line:content
            const start = Math.max(0, i - context);
            const end = Math.min(lines.length - 1, i + context);

            if (context > 0) {
              results.push(`${relPath}:${i + 1}:`);
              for (let j = start; j <= end; j++) {
                const prefix = j === i ? '>' : ' ';
                results.push(`  ${prefix}${j + 1}: ${lines[j]}`);
              }
              results.push('');
            } else {
              results.push(`${relPath}:${i + 1}: ${lines[i]}`);
            }
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    if (results.length === 0) {
      return { success: true, output: 'No matches found' };
    }

    return { success: true, output: results.slice(0, maxResults).join('\n') };
  } catch (err: any) {
    return { success: false, output: '', error: String(err.message) };
  }
}

// ============================================================================
// 统一执行入口
// ============================================================================

/**
 * 执行一个工具调用，返回结构化结果字符串
 * Issue #32 #3.2: 支持 abortSignal
 */
export async function executeTool(name: string, args: Record<string, unknown>, abortSignal?: AbortSignal): Promise<string> {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) {
    return JSON.stringify({
      success: false,
      error: `Unknown tool: ${name}. Available tools: ${TOOLS.map(t => t.name).join(', ')}`,
    });
  }

  const context: ToolContext = {
    cwd: process.cwd(),
    config: {
      name: 'openhorse',
      mode: 'development',
    },
    abortSignal,  // Issue #32 #3.2: 透传 abortSignal
  };

  const result = await tool.execute(args, context);

  if (!result.success) {
    return JSON.stringify({
      success: false,
      error: result.error,
      output: result.output,
    });
  }

  return JSON.stringify({
    success: true,
    output: result.output,
  });
}

/**
 * 获取可用工具名称列表
 */
export function getToolNames(): string {
  return TOOLS.map(t => t.name).join(', ');
}

// Re-export bash_security module
export {
  READ_ONLY_COMMANDS,
  DANGEROUS_PATTERNS,
  POTENTIALLY_DESTRUCTIVE_PATTERNS,
  isReadOnlyCommand,
  checkDangerousCommand,
  isPotentiallyDestructive,
  assessCommandSecurity,
  wrapForSandbox,
  type SandboxOptions,
  DEFAULT_SANDBOX_OPTIONS,
} from './bash_security';
