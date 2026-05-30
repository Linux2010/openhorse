/**
 * openhorse - Bootstrap State 管理
 *
 * v0.1.11: 全局状态字段规范化
 *
 * 提供项目标识、成本追踪、会话状态、缓存等状态管理
 */

// ============================================================================
// Types
// ============================================================================

export interface ModelUsage {
  tokens: number;
  cost: number;
}

export interface GlobalState {
  // 项目标识
  projectRoot: string;
  sessionId: string;

  // 成本追踪
  totalCostUSD: number;
  modelUsage: Map<string, ModelUsage>;

  // 会话状态
  sessionBypassPermissionsMode: boolean;
  hasExitedPlanMode: boolean;

  // 缓存
  cachedMemoryContent: string | null;

  // 运行状态
  initializedAt: number;
  lastActivityAt: number;

  // 工具状态
  toolCallCount: number;
  errorCount: number;
}

// ============================================================================
// Global State Singleton
// ============================================================================

let globalState: GlobalState | null = null;

/**
 * 初始化全局状态
 * @param projectRoot - 项目根目录
 * @param sessionId - 会话 ID
 */
export function initGlobalState(projectRoot: string, sessionId?: string): GlobalState {
  globalState = {
    projectRoot,
    sessionId: sessionId || generateSessionId(),

    totalCostUSD: 0,
    modelUsage: new Map<string, ModelUsage>(),

    sessionBypassPermissionsMode: false,
    hasExitedPlanMode: false,

    cachedMemoryContent: null,

    initializedAt: Date.now(),
    lastActivityAt: Date.now(),

    toolCallCount: 0,
    errorCount: 0,
  };

  return globalState;
}

/**
 * 获取全局状态
 */
export function getGlobalState(): GlobalState | null {
  return globalState;
}

/**
 * 确保全局状态已初始化
 */
export function ensureGlobalState(): GlobalState {
  if (!globalState) {
    return initGlobalState(process.cwd());
  }
  return globalState;
}

/**
 * 重置全局状态
 */
export function resetGlobalState(): void {
  globalState = null;
}

// ============================================================================
// State Updates
// ============================================================================

/**
 * 更新最后活动时间
 */
export function updateActivity(): void {
  const state = ensureGlobalState();
  state.lastActivityAt = Date.now();
}

/**
 * 记录工具调用
 */
export function recordToolCall(): void {
  const state = ensureGlobalState();
  state.toolCallCount++;
  updateActivity();
}

/**
 * 记录错误
 */
export function recordError(): void {
  const state = ensureGlobalState();
  state.errorCount++;
}

/**
 * 添加成本
 */
export function addCost(model: string, tokens: number, costUSD: number): void {
  const state = ensureGlobalState();

  state.totalCostUSD += costUSD;

  const existing = state.modelUsage.get(model) || { tokens: 0, cost: 0 };
  state.modelUsage.set(model, {
    tokens: existing.tokens + tokens,
    cost: existing.cost + costUSD,
  });
}

/**
 * 设置内存缓存
 */
export function setCachedMemory(content: string): void {
  const state = ensureGlobalState();
  state.cachedMemoryContent = content;
}

/**
 * 清除内存缓存
 */
export function clearCachedMemory(): void {
  const state = ensureGlobalState();
  state.cachedMemoryContent = null;
}

/**
 * 设置绕过权限模式
 */
export function setBypassPermissionsMode(enabled: boolean): void {
  const state = ensureGlobalState();
  state.sessionBypassPermissionsMode = enabled;
}

/**
 * 标记已退出计划模式
 */
export function markExitedPlanMode(): void {
  const state = ensureGlobalState();
  state.hasExitedPlanMode = true;
}

// ============================================================================
// Helpers
// ============================================================================

function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}

/**
 * 获取状态摘要
 */
export function getStateSummary(): string {
  const state = getGlobalState();
  if (!state) return 'State not initialized';

  const lines: string[] = [
    `Project: ${state.projectRoot}`,
    `Session: ${state.sessionId}`,
    `Cost: $${state.totalCostUSD.toFixed(4)}`,
    `Tool calls: ${state.toolCallCount}`,
    `Errors: ${state.errorCount}`,
    `Uptime: ${Math.round((Date.now() - state.initializedAt) / 1000)}s`,
  ];

  return lines.join('\n');
}

// ============================================================================
// Export
// ============================================================================

export const STATE_MANAGER = {
  initGlobalState,
  getGlobalState,
  ensureGlobalState,
  resetGlobalState,
  updateActivity,
  recordToolCall,
  recordError,
  addCost,
  setCachedMemory,
  clearCachedMemory,
  setBypassPermissionsMode,
  markExitedPlanMode,
  getStateSummary,
};