/**
 * openhorse - 会话存储
 *
 * 使用 JSONL 格式存储会话历史和对话记录。
 * 参考 OpenClaude 的 history.jsonl 和 sessions/ 目录。
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { ensureConfigDir, getHistoryPath, getSessionMetaPath, getSessionMessagesPath, getSessionsDir } from './config-dir';
import { atomicWriteFileSync } from './atomic-write';
import type { Message } from './llm';
import type { ContextCapsule, HarnessState } from '../harness';

// ============================================================================
// 类型定义
// ============================================================================

/** 工具调用记录（用于 assistant 消息） */
export interface ToolCallRecord {
  /** 调用 ID */
  id: string;
  /** 类型 */
  type: 'function';
  /** 函数信息 */
  function: {
    name: string;
    arguments: string;  // JSON string
  };
}

/** 会话元数据 */
export interface SessionMeta {
  /** 会话 ID */
  id: string;
  /** 项目路径 */
  projectPath: string;
  /** 使用的模型 */
  model: string;
  /** 开始时间 (timestamp ms) */
  startTime: number;
  /** 结束时间 (timestamp ms) */
  endTime?: number;
  /** token 数 */
  tokenCount: number;
  /** 成本 (USD) */
  cost: number;
  /** 任务摘要 */
  taskSummary?: string;
  /** 使用过的工具列表 */
  toolsUsed?: string[];
  /** 修改过的文件列表 */
  filesModified?: string[];
  /** Context Harness 状态摘要 */
  harnessState?: HarnessState;
  /** 最近一次可恢复上下文包 */
  contextCapsule?: ContextCapsule;
}

/** 历史记录条目 */
export interface HistoryEntry {
  /** 显示文本 */
  display: string;
  /** 时间戳 (ms) */
  timestamp: number;
  /** 项目路径 */
  project: string;
  /** 会话 ID */
  sessionId: string;
  /** 角色 */
  role: 'user' | 'assistant';
}

/** 对话消息 */
export interface SessionMessage {
  /** 角色 */
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** 内容 */
  content: string;
  /** 时间戳 (ms) */
  timestamp: number;
  /** 工具调用 ID (tool role) */
  toolCallId?: string;
  /** 工具调用列表 (assistant role) */
  tool_calls?: ToolCallRecord[];
}

// ============================================================================
// 会话管理
// ============================================================================

/**
 * 创建新会话
 */
export function createSession(projectPath: string, model: string): SessionMeta {
  ensureConfigDir();

  const session: SessionMeta = {
    id: randomUUID(),
    projectPath,
    model,
    startTime: Date.now(),
    tokenCount: 0,
    cost: 0,
  };

  saveSessionMeta(session);
  return session;
}

/**
 * 保存会话元数据
 */
export function saveSessionMeta(session: SessionMeta): void {
  ensureConfigDir();
  const path = getSessionMetaPath(session.id);
  atomicWriteFileSync(path, JSON.stringify(session, null, 2), { mode: 0o600 });
}

/**
 * 加载会话元数据
 */
export function loadSessionMeta(sessionId: string): SessionMeta | null {
  const path = getSessionMetaPath(sessionId);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as SessionMeta;
  } catch {
    return null;
  }
}

/**
 * 更新会话统计
 */
export function updateSessionStats(sessionId: string, tokens: number, cost: number): void {
  const session = loadSessionMeta(sessionId);
  if (!session) return;

  session.tokenCount += tokens;
  session.cost += cost;
  saveSessionMeta(session);
}

/**
 * 更新会话 Harness 状态。
 */
export function updateSessionHarnessState(sessionId: string, harnessState: HarnessState): void {
  const session = loadSessionMeta(sessionId);
  if (!session) return;

  session.harnessState = harnessState;
  session.contextCapsule = harnessState.capsule;
  saveSessionMeta(session);
}

/**
 * 结束会话
 */
export function endSession(sessionId: string): void {
  const session = loadSessionMeta(sessionId);
  if (!session) return;

  session.endTime = Date.now();
  saveSessionMeta(session);
}

/**
 * 更新会话任务摘要
 * 从会话消息中提取关键信息并更新元数据
 */
export function updateSessionSummary(sessionId: string, messages: SessionMessage[]): void {
  const session = loadSessionMeta(sessionId);
  if (!session) return;

  // 提取工具使用列表
  const toolsUsed: string[] = [];
  const filesModified: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolsUsed.push(tc.function.name);

        // 从 write_file, edit_file 工具参数中提取文件路径
        if (tc.function.name === 'write_file' || tc.function.name === 'edit_file') {
          try {
            const args = JSON.parse(tc.function.arguments);
            if (args.path) {
              filesModified.push(args.path);
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    }
  }

  // 提取任务摘要（从第一个用户消息）
  const firstUserMsg = messages.find(m => m.role === 'user' && m.content);
  const taskSummary = firstUserMsg?.content?.slice(0, 100) || '';

  // 更新 session
  session.toolsUsed = [...new Set(toolsUsed)];  // unique
  session.filesModified = [...new Set(filesModified)];  // unique
  session.taskSummary = taskSummary.length > 100 ? taskSummary.slice(0, 100) + '...' : taskSummary;

  saveSessionMeta(session);
}

/**
 * 获取项目最近的会话
 */
export function getLastSession(projectPath: string): SessionMeta | null {
  ensureConfigDir();
  const sessionsDir = getSessionsDir();

  if (!existsSync(sessionsDir)) {
    return null;
  }

  // 遍历所有会话文件，找到该项目路径最近的
  const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));

  let latest: SessionMeta | null = null;
  for (const file of files) {
    try {
      const content = readFileSync(join(sessionsDir, file), 'utf-8');
      const session = JSON.parse(content) as SessionMeta;
      if (session.projectPath === projectPath) {
        if (!latest || session.startTime > latest.startTime) {
          latest = session;
        }
      }
    } catch {
      // ignore
    }
  }

  return latest;
}

// ============================================================================
// 历史记录 (JSONL)
// ============================================================================

/**
 * 追加历史记录
 */
export function appendHistory(entry: HistoryEntry): void {
  ensureConfigDir();
  const path = getHistoryPath();
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(path, line, { mode: 0o600 });
}

/**
 * 读取历史记录
 * @param limit 最大条数（从最新开始）
 */
export function readHistory(limit?: number): HistoryEntry[] {
  const path = getHistoryPath();

  if (!existsSync(path)) {
    return [];
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const entries = lines.map(line => JSON.parse(line) as HistoryEntry);

    // 从最新开始
    const reversed = entries.reverse();
    return limit ? reversed.slice(0, limit) : reversed;
  } catch {
    return [];
  }
}

/**
 * 按项目过滤历史记录
 */
export function readProjectHistory(projectPath: string, limit?: number): HistoryEntry[] {
  const all = readHistory();
  const filtered = all.filter(e => e.project === projectPath);
  return limit ? filtered.slice(0, limit) : filtered;
}

// ============================================================================
// 会话对话记录 (JSONL)
// ============================================================================

/**
 * 追加会话消息
 */
export function appendSessionMessage(sessionId: string, message: SessionMessage): void {
  ensureConfigDir();
  const path = getSessionMessagesPath(sessionId);
  const line = JSON.stringify(message) + '\n';
  appendFileSync(path, line, { mode: 0o600 });
}

/**
 * 追加多条会话消息
 */
export function appendSessionMessages(sessionId: string, messages: SessionMessage[]): void {
  ensureConfigDir();
  const path = getSessionMessagesPath(sessionId);
  const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
  appendFileSync(path, lines, { mode: 0o600 });
}

/**
 * 读取会话消息
 */
export function readSessionMessages(sessionId: string): SessionMessage[] {
  const path = getSessionMessagesPath(sessionId);

  if (!existsSync(path)) {
    return [];
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.map(line => JSON.parse(line) as SessionMessage);
  } catch {
    return [];
  }
}

/**
 * 读取会话消息并转换为 Message 格式（用于恢复对话历史）
 * 包含完整的 tool_calls 信息，确保 LLM 能理解之前的工具调用
 */
export function loadSessionHistory(sessionId: string): Message[] {
  const messages = readSessionMessages(sessionId);
  return messages.map(m => {
    const result: Message = {
      role: m.role,
      content: m.content,
    };

    // tool role: 添加 tool_call_id
    if (m.role === 'tool' && m.toolCallId) {
      result.tool_call_id = m.toolCallId;
    }

    // assistant role: 添加 tool_calls
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      result.tool_calls = m.tool_calls;
    }

    return result;
  });
}

/**
 * 列出所有会话
 */
export function listSessions(limit?: number): SessionMeta[] {
  ensureConfigDir();
  const sessionsDir = getSessionsDir();

  if (!existsSync(sessionsDir)) {
    return [];
  }

  const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
  const sessions: SessionMeta[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(sessionsDir, file), 'utf-8');
      const session = JSON.parse(content) as SessionMeta;
      sessions.push(session);
    } catch {
      // ignore
    }
  }

  // 按开始时间排序（最新的在前）
  sessions.sort((a, b) => b.startTime - a.startTime);

  return limit ? sessions.slice(0, limit) : sessions;
}

/**
 * 删除会话
 */
export function deleteSession(sessionId: string): boolean {
  const metaPath = getSessionMetaPath(sessionId);
  const messagesPath = getSessionMessagesPath(sessionId);

  let deleted = false;

  if (existsSync(metaPath)) {
    unlinkSync(metaPath);
    deleted = true;
  }

  if (existsSync(messagesPath)) {
    unlinkSync(messagesPath);
    deleted = true;
  }

  return deleted;
}
