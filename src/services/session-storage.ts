/**
 * openhorse - 会话存储
 *
 * 使用 JSONL 格式存储会话历史和对话记录。
 * 参考 OpenClaude 的 history.jsonl 和 sessions/ 目录。
 */

import { existsSync, readFileSync, appendFileSync, readdirSync, unlinkSync, realpathSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { join, resolve } from 'path';
import {
  encodeProjectPath,
  ensureConfigDir,
  ensureProjectDir,
  getHistoryPath,
  getProjectSessionMessagesPath,
  getProjectSessionHarnessPath,
  getProjectSessionMetaPath,
  getProjectSessionsDir,
  getProjectsDir,
  getSessionMetaPath,
  getSessionMessagesPath,
  getSessionsDir,
} from './config-dir';
import { atomicWriteFileSync } from './atomic-write';
import type { Message } from './llm';
import { summarizeHarnessStateForMeta, upgradeHarnessState, type ContextCapsule, type HarnessSidecar, type HarnessState } from '../harness';

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
  /** Canonical project root path */
  projectPath: string;
  /** Encoded project key used under ~/.openhorse/projects/ */
  projectKey?: string;
  /** Original working directory used when the session started */
  cwd?: string;
  /** 使用的模型 */
  model: string;
  /** 开始时间 (timestamp ms) */
  startTime: number;
  /** ISO create time for SDK/picker compatibility */
  createdAt?: string;
  /** Last update timestamp (ms) */
  updatedAt?: number;
  /** ISO update time for SDK/picker compatibility */
  updatedAtIso?: string;
  /** 结束时间 (timestamp ms) */
  endTime?: number;
  /** Number of recorded transcript messages */
  messageCount?: number;
  /** Size of the session transcript history file in bytes */
  historySizeBytes?: number;
  /** UI transcript should resume from this timestamp; compacted earlier messages may stay hidden. */
  transcriptDisplayStartTime?: number;
  /** Optional human-readable name */
  name?: string;
  /** Git branch at session creation/resume time */
  gitBranch?: string;
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
  /** Skills applied in this session. */
  skillsUsed?: string[];
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
  /** Skills applied for this turn (usually stored on the user message). */
  appliedSkills?: string[];
}

export interface ListSessionsOptions {
  /** Filter sessions to this canonical project. */
  projectPath?: string;
  /** Include sessions from all projects. Overrides projectPath. */
  allProjects?: boolean;
  /** Include sessions without transcript messages. Defaults to true. */
  includeEmpty?: boolean;
}

export type SessionLookupResult =
  | { status: 'found'; session: SessionMeta }
  | { status: 'not_found' }
  | { status: 'ambiguous'; matches: SessionMeta[] };

// ============================================================================
// Project helpers
// ============================================================================

const resolvedProjectPathCache = new Map<string, string>();
const gitBranchCache = new Map<string, string | undefined>();

/**
 * Resolve a working directory to the project identity used for session storage.
 * Git repositories share sessions from the repository root; non-git folders use
 * their real absolute path.
 */
export function resolveProjectPath(cwd: string = process.cwd()): string {
  const absolute = resolve(cwd);
  const cached = resolvedProjectPathCache.get(absolute);
  if (cached) {
    return cached;
  }

  let resolvedPath = absolute;

  if (existsSync(absolute)) {
    try {
      const root = execFileSync('git', ['-C', absolute, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (root) {
        resolvedPath = realpathSync(root);
        resolvedProjectPathCache.set(absolute, resolvedPath);
        return resolvedPath;
      }
    } catch {
      // Not a git worktree, or git is unavailable.
    }
  }

  try {
    resolvedPath = realpathSync(absolute);
  } catch {
    resolvedPath = absolute;
  }

  resolvedProjectPathCache.set(absolute, resolvedPath);
  return resolvedPath;
}

export function getProjectKey(projectPath: string): string {
  return encodeProjectPath(resolveProjectPath(projectPath));
}

function getGitBranch(projectPath: string): string | undefined {
  if (gitBranchCache.has(projectPath)) {
    return gitBranchCache.get(projectPath);
  }

  if (!existsSync(projectPath)) {
    gitBranchCache.set(projectPath, undefined);
    return undefined;
  }

  try {
    const branch = execFileSync('git', ['-C', projectPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const value = branch || undefined;
    gitBranchCache.set(projectPath, value);
    return value;
  } catch {
    gitBranchCache.set(projectPath, undefined);
    return undefined;
  }
}

function normalizeSessionMeta(session: SessionMeta): SessionMeta {
  const projectPath = resolveProjectPath(session.projectPath);
  const startTime = session.startTime ?? Date.now();
  const updatedAt = session.updatedAt ?? session.endTime ?? startTime;

  return {
    ...session,
    projectPath,
    projectKey: session.projectKey ?? encodeProjectPath(projectPath),
    cwd: session.cwd ?? projectPath,
    startTime,
    createdAt: session.createdAt ?? new Date(startTime).toISOString(),
    updatedAt,
    updatedAtIso: session.updatedAtIso ?? new Date(updatedAt).toISOString(),
    messageCount: session.messageCount ?? 0,
    historySizeBytes: computeSessionHistorySizeBytes({ id: session.id, projectPath }),
    tokenCount: session.tokenCount ?? 0,
    cost: session.cost ?? 0,
    gitBranch: session.gitBranch ?? getGitBranch(projectPath),
  };
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function parseSessionMetaFile(path: string): SessionMeta | null {
  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as SessionMeta;
  } catch {
    return null;
  }
}

function parseHarnessSidecarFile(path: string): HarnessSidecar | null {
  try {
    const content = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(content) as HarnessSidecar;
    return parsed?.version === 2 && parsed.state ? parsed : null;
  } catch {
    return null;
  }
}

function upsertNewestSession(sessionsById: Map<string, SessionMeta>, session: SessionMeta): void {
  const existing = sessionsById.get(session.id);
  const existingTime = existing ? existing.updatedAt ?? existing.startTime : 0;
  const nextTime = session.updatedAt ?? session.startTime;

  if (!existing || nextTime >= existingTime) {
    sessionsById.set(session.id, session);
  }
}

function sortSessionsNewestFirst(sessions: SessionMeta[]): SessionMeta[] {
  return sessions.sort((a, b) => (b.updatedAt ?? b.startTime) - (a.updatedAt ?? a.startTime));
}

function safeFileSize(path: string): number | null {
  try {
    return existsSync(path) ? statSync(path).size : null;
  } catch {
    return null;
  }
}

function computeSessionHistorySizeBytes(session: Pick<SessionMeta, 'id' | 'projectPath'>): number {
  const projectSize = safeFileSize(getProjectSessionMessagesPath(session.projectPath, session.id));
  if (projectSize !== null) return projectSize;
  return safeFileSize(getSessionMessagesPath(session.id)) ?? 0;
}

// ============================================================================
// 会话管理
// ============================================================================

/**
 * 创建新会话
 */
export function createSession(projectPath: string, model: string): SessionMeta {
  ensureConfigDir();
  const canonicalProjectPath = resolveProjectPath(projectPath);
  const now = Date.now();

  const session: SessionMeta = {
    id: randomUUID(),
    projectPath: canonicalProjectPath,
    projectKey: encodeProjectPath(canonicalProjectPath),
    cwd: resolve(projectPath),
    model,
    startTime: now,
    createdAt: new Date(now).toISOString(),
    updatedAt: now,
    updatedAtIso: new Date(now).toISOString(),
    messageCount: 0,
    gitBranch: getGitBranch(canonicalProjectPath),
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
  const normalized = normalizeSessionMeta(session);
  const payload = JSON.stringify(normalized, null, 2);

  ensureProjectDir(normalized.projectPath);
  atomicWriteFileSync(getProjectSessionMetaPath(normalized.projectPath, normalized.id), payload, { mode: 0o600 });
}

/**
 * 加载会话元数据
 */
export function loadSessionMeta(sessionId: string): SessionMeta | null {
  const projectsDir = getProjectsDir();
  if (existsSync(projectsDir)) {
    for (const projectKey of readdirSync(projectsDir)) {
      const path = join(projectsDir, projectKey, 'sessions', `${sessionId}.json`);
      if (!existsSync(path)) continue;

      const session = parseSessionMetaFile(path);
      if (session) {
        return normalizeSessionMeta(session);
      }
    }
  }

  const globalPath = getSessionMetaPath(sessionId);
  if (existsSync(globalPath)) {
    const session = parseSessionMetaFile(globalPath);
    if (session) {
      return normalizeSessionMeta(session);
    }
  }

  return null;
}

/**
 * 更新会话统计
 */
export function updateSessionStats(sessionId: string, tokens: number, cost: number): void {
  const session = loadSessionMeta(sessionId);
  if (!session) return;

  session.tokenCount += tokens;
  session.cost += cost;
  session.updatedAt = Date.now();
  session.updatedAtIso = new Date(session.updatedAt).toISOString();
  saveSessionMeta(session);
}

function touchSession(sessionId: string, messageDelta: number = 0): SessionMeta | null {
  const session = loadSessionMeta(sessionId);
  if (!session) return null;

  session.updatedAt = Date.now();
  session.updatedAtIso = new Date(session.updatedAt).toISOString();
  session.messageCount = (session.messageCount ?? 0) + messageDelta;
  saveSessionMeta(session);
  return session;
}

/**
 * Mark a saved session as active again and refresh project metadata.
 */
export function resumeSession(sessionId: string): SessionMeta | null {
  const session = loadSessionMeta(sessionId);
  if (!session) return null;

  session.endTime = undefined;
  session.gitBranch = getGitBranch(session.projectPath);
  session.updatedAt = Date.now();
  session.updatedAtIso = new Date(session.updatedAt).toISOString();
  saveSessionMeta(session);
  return session;
}

/**
 * 更新会话 Harness 状态。
 */
export function updateSessionHarnessState(sessionId: string, harnessState: HarnessState): void {
  const session = loadSessionMeta(sessionId);
  if (!session) return;

  const fullState = upgradeHarnessState(harnessState, { cwd: session.cwd ?? session.projectPath });
  const sidecar: HarnessSidecar = {
    version: 2,
    sessionId,
    projectPath: session.projectPath,
    state: fullState,
    contextCapsule: fullState.capsule,
    updatedAt: Date.now(),
    diagnostics: fullState.diagnostics,
  };

  ensureProjectDir(session.projectPath);
  atomicWriteFileSync(
    getProjectSessionHarnessPath(session.projectPath, sessionId),
    JSON.stringify(sidecar, null, 2),
    { mode: 0o600 }
  );

  session.harnessState = summarizeHarnessStateForMeta(fullState);
  session.contextCapsule = fullState.capsule;
  session.updatedAt = Date.now();
  session.updatedAtIso = new Date(session.updatedAt).toISOString();
  saveSessionMeta(session);
}

export function loadSessionHarnessState(sessionId: string): HarnessState | null {
  const session = loadSessionMeta(sessionId);
  if (!session) return null;

  const sidecarPath = getProjectSessionHarnessPath(session.projectPath, sessionId);
  if (existsSync(sidecarPath)) {
    const sidecar = parseHarnessSidecarFile(sidecarPath);
    if (sidecar?.state) {
      return upgradeHarnessState(sidecar.state, {
        cwd: session.cwd ?? session.projectPath,
        messages: readSessionMessages(sessionId),
      });
    }
  }

  if (session.harnessState) {
    return upgradeHarnessState(session.harnessState, {
      cwd: session.cwd ?? session.projectPath,
      messages: readSessionMessages(sessionId),
    });
  }

  const messages = readSessionMessages(sessionId);
  if (messages.length > 0) {
    return upgradeHarnessState(null, {
      cwd: session.cwd ?? session.projectPath,
      messages,
    });
  }

  return null;
}

export function updateSessionSkills(sessionId: string, skills: string[]): void {
  if (skills.length === 0) return;
  const session = loadSessionMeta(sessionId);
  if (!session) return;

  session.skillsUsed = [...new Set([...(session.skillsUsed || []), ...skills])];
  session.updatedAt = Date.now();
  session.updatedAtIso = new Date(session.updatedAt).toISOString();
  saveSessionMeta(session);
}

export function markSessionTranscriptDisplayStart(sessionId: string, timestamp: number = Date.now()): SessionMeta | null {
  const session = loadSessionMeta(sessionId);
  if (!session) return null;

  session.transcriptDisplayStartTime = timestamp;
  session.updatedAt = timestamp;
  session.updatedAtIso = new Date(timestamp).toISOString();
  saveSessionMeta(session);
  return session;
}

/**
 * 结束会话
 */
export function endSession(sessionId: string): void {
  const session = loadSessionMeta(sessionId);
  if (!session) return;

  session.endTime = Date.now();
  session.updatedAt = session.endTime;
  session.updatedAtIso = new Date(session.updatedAt).toISOString();
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
  session.messageCount = messages.length;
  session.updatedAt = Date.now();
  session.updatedAtIso = new Date(session.updatedAt).toISOString();

  saveSessionMeta(session);
}

/**
 * 获取项目最近的会话
 */
export function getLastSession(projectPath: string): SessionMeta | null {
  const sessions = listProjectSessions(projectPath)
    .filter(session => (session.messageCount ?? 0) > 0);
  return sessions[0] ?? null;
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
  const line = JSON.stringify(message) + '\n';
  const session = touchSession(sessionId, 1);

  const paths = session
    ? [getProjectSessionMessagesPath(session.projectPath, sessionId)]
    : [getSessionMessagesPath(sessionId)];

  if (session) {
    ensureProjectDir(session.projectPath);
  }

  for (const path of uniquePaths(paths)) {
    appendFileSync(path, line, { mode: 0o600 });
  }

  // Update session index for fast search
  if (session) {
    try {
      const { updateSessionIndex } = require('./session-index');
      updateSessionIndex(sessionId, session.projectPath, message);
    } catch {
      // Best-effort — don't fail the main flow
    }
  }
}

/**
 * 追加多条会话消息
 */
export function appendSessionMessages(sessionId: string, messages: SessionMessage[]): void {
  if (messages.length === 0) return;

  ensureConfigDir();
  const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
  const session = touchSession(sessionId, messages.length);

  const paths = session
    ? [getProjectSessionMessagesPath(session.projectPath, sessionId)]
    : [getSessionMessagesPath(sessionId)];

  if (session) {
    ensureProjectDir(session.projectPath);
  }

  for (const path of uniquePaths(paths)) {
    appendFileSync(path, lines, { mode: 0o600 });
  }
}

/**
 * 读取会话消息
 */
export function readSessionMessages(sessionId: string): SessionMessage[] {
  const session = loadSessionMeta(sessionId);
  const candidatePaths = session
    ? [
        getProjectSessionMessagesPath(session.projectPath, sessionId),
        getSessionMessagesPath(sessionId),
      ]
    : [getSessionMessagesPath(sessionId)];

  for (const path of uniquePaths(candidatePaths)) {
    if (!existsSync(path)) continue;

    try {
      const content = readFileSync(path, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      return lines.map(line => JSON.parse(line) as SessionMessage);
    } catch {
      // try the next candidate
    }
  }

  return [];
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

  const sessionsById = new Map<string, SessionMeta>();

  if (existsSync(sessionsDir)) {
    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json') && !f.endsWith('.harness.json'));
    for (const file of files) {
      const rawSession = parseSessionMetaFile(join(sessionsDir, file));
      if (rawSession) {
        upsertNewestSession(sessionsById, normalizeSessionMeta(rawSession));
      }
    }
  }

  const projectsDir = getProjectsDir();
  if (existsSync(projectsDir)) {
    for (const projectKey of readdirSync(projectsDir)) {
      const projectSessionsDir = join(projectsDir, projectKey, 'sessions');
      if (!existsSync(projectSessionsDir)) continue;

      const files = readdirSync(projectSessionsDir).filter(f => f.endsWith('.json') && !f.endsWith('.harness.json'));
      for (const file of files) {
        const rawSession = parseSessionMetaFile(join(projectSessionsDir, file));
        if (rawSession) {
          upsertNewestSession(sessionsById, normalizeSessionMeta(rawSession));
        }
      }
    }
  }

  const sessions = sortSessionsNewestFirst(Array.from(sessionsById.values()));
  return limit ? sessions.slice(0, limit) : sessions;
}

/**
 * List sessions for a single canonical project.
 */
export function listProjectSessions(projectPath: string, limit?: number): SessionMeta[] {
  const canonicalProjectPath = resolveProjectPath(projectPath);
  const sessionsById = new Map<string, SessionMeta>();

  const projectSessionsDir = getProjectSessionsDir(canonicalProjectPath);
  if (existsSync(projectSessionsDir)) {
    const files = readdirSync(projectSessionsDir).filter(f => f.endsWith('.json') && !f.endsWith('.harness.json'));
    for (const file of files) {
      const rawSession = parseSessionMetaFile(join(projectSessionsDir, file));
      if (rawSession) {
        upsertNewestSession(sessionsById, normalizeSessionMeta(rawSession));
      }
    }
  }

  const sessions = sortSessionsNewestFirst(Array.from(sessionsById.values()));
  return limit ? sessions.slice(0, limit) : sessions;
}

/**
 * Find a session by full id, id prefix, or exact name. Project sessions are
 * searched by default; pass allProjects when the user explicitly asks.
 */
export function findSession(
  ref: string,
  projectPath?: string,
  options: { allProjects?: boolean } = {}
): SessionMeta | null {
  const result = lookupSessionRef(ref, projectPath, options);
  return result.status === 'found' ? result.session : null;
}

/**
 * Resolve a session reference and preserve ambiguity details for user-facing
 * conflict prompts.
 */
export function lookupSessionRef(
  ref: string,
  projectPath?: string,
  options: { allProjects?: boolean } = {}
): SessionLookupResult {
  const query = ref.trim();
  if (!query) return { status: 'not_found' };

  const candidates = options.allProjects || !projectPath
    ? listSessions()
    : listProjectSessions(projectPath);

  const exactId = candidates.find(session => session.id === query);
  if (exactId) return { status: 'found', session: exactId };

  const exactNameMatches = candidates.filter(session => session.name === query);
  if (exactNameMatches.length === 1) {
    return { status: 'found', session: exactNameMatches[0] };
  }
  if (exactNameMatches.length > 1) {
    return { status: 'ambiguous', matches: exactNameMatches };
  }

  const prefixMatches = candidates.filter(session =>
    session.id.startsWith(query) || session.name?.startsWith(query)
  );

  if (prefixMatches.length === 1) {
    return { status: 'found', session: prefixMatches[0] };
  }
  if (prefixMatches.length > 1) {
    return { status: 'ambiguous', matches: prefixMatches };
  }

  return { status: 'not_found' };
}

/**
 * Rename a session for easier picker/resume targeting.
 */
export function renameSession(sessionId: string, name: string): SessionMeta | null {
  const session = loadSessionMeta(sessionId);
  if (!session) return null;

  const trimmed = name.trim();
  session.name = trimmed || undefined;
  session.updatedAt = Date.now();
  session.updatedAtIso = new Date(session.updatedAt).toISOString();
  saveSessionMeta(session);
  return session;
}

/**
 * 删除会话
 */
export function deleteSession(sessionId: string): boolean {
  const session = loadSessionMeta(sessionId);
  const paths = [
    getSessionMetaPath(sessionId),
    getSessionMessagesPath(sessionId),
  ];

  if (session) {
    paths.push(
      getProjectSessionMetaPath(session.projectPath, sessionId),
      getProjectSessionMessagesPath(session.projectPath, sessionId),
      getProjectSessionHarnessPath(session.projectPath, sessionId)
    );
  }

  let deleted = false;

  for (const path of uniquePaths(paths)) {
    if (existsSync(path)) {
      unlinkSync(path);
      deleted = true;
    }
  }

  return deleted;
}
