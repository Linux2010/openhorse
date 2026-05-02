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

import { execFile } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, resolve, relative } from 'path';
import { buildTool, type OpenHorseTool, type ToolResult, type ToolContext } from '../framework/tool';

// ============================================================================
// 工具集
// ============================================================================

export const TOOLS: OpenHorseTool[] = [
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
      return readFileSync_(args.path as string, args.maxLines as number | undefined);
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
      return writeFileSync_(args.path as string, args.content as string);
    },
    isDestructive: () => true,
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
      return listFiles_(args.path as string, args.maxDepth as number | undefined);
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    userFacingName: (args) => `List ${args.path as string}`,
  }),

  buildTool({
    name: 'exec_command',
    description: '执行一个 shell 命令。返回 stdout 和 stderr。',
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
      },
      required: ['command'],
    },
    execute: async (args) => {
      return execCommand_(args.command as string, args.cwd as string | undefined, args.timeout as number | undefined);
    },
    isDestructive: (args) => {
      const cmd = (args.command as string) || '';
      return /(rm\s+-rf|mkfs|dd\s)/.test(cmd);
    },
    userFacingName: (args) => `Exec ${(args.command as string)?.slice(0, 60) || ''}`,
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

async function execCommand_(command: string, cwd?: string, timeout?: number): Promise<ToolResult> {
  return new Promise((resolve) => {
    const workdir = cwd ? safePath(cwd) : process.cwd();
    const timeoutMs = timeout ?? 30000;

    execFile('sh', ['-c', command], {
      cwd: workdir,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const output = stdout.toString().trim();
      const errOutput = stderr.toString().trim();

      if (error) {
        resolve({
          success: false,
          output: output || errOutput,
          error: error.message || `Command exited with code ${error.code}`,
        });
      } else {
        resolve({
          success: true,
          output: output || '(no output)',
          error: errOutput || undefined,
        });
      }
    });
  });
}

// ============================================================================
// 统一执行入口
// ============================================================================

/**
 * 执行一个工具调用，返回结构化结果字符串
 */
export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
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
