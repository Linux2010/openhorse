/**
 * openhorse - 模型上下文窗口数据库 + 动态发现
 *
 * 混合策略：
 * 1. 内置数据库（兜底）
 * 2. 启动时尝试 /models 端点动态获取
 * 3. 每次 API 调用使用实际 token 数
 */

import type { LLMService } from './llm';

export interface ModelContextInfo {
  id: string;
  label: string;
  contextWindow: number;
  maxOutputTokens?: number;
  provider?: string;
  discovered?: boolean; // true = 来自 /models 端点
}

// ============================================================================
// 内置数据库（兜底）
// ============================================================================

export const BUILTIN_MODELS: Record<string, ModelContextInfo> = {
  // DashScope (coding + standard)
  'glm-5': { id: 'glm-5', label: 'GLM-5', contextWindow: 202752, maxOutputTokens: 8192, provider: 'glm' },
  'glm-4': { id: 'glm-4', label: 'GLM-4', contextWindow: 131072, maxOutputTokens: 4096, provider: 'glm' },
  'qwen-turbo': { id: 'qwen-turbo', label: 'Qwen Turbo', contextWindow: 131072, maxOutputTokens: 8192, provider: 'qwen' },
  'qwen-plus': { id: 'qwen-plus', label: 'Qwen Plus', contextWindow: 131072, maxOutputTokens: 8192, provider: 'qwen' },
  'qwen-max': { id: 'qwen-max', label: 'Qwen Max', contextWindow: 32768, maxOutputTokens: 8192, provider: 'qwen' },
  'qwen-long': { id: 'qwen-long', label: 'Qwen Long', contextWindow: 1000000, maxOutputTokens: 8192, provider: 'qwen' },

  // OpenAI
  'gpt-4o': { id: 'gpt-4o', label: 'GPT-4o', contextWindow: 128000, maxOutputTokens: 16384, provider: 'openai' },
  'gpt-4o-mini': { id: 'gpt-4o-mini', label: 'GPT-4o Mini', contextWindow: 128000, maxOutputTokens: 16384, provider: 'openai' },
  'gpt-4': { id: 'gpt-4', label: 'GPT-4', contextWindow: 8192, maxOutputTokens: 8192, provider: 'openai' },

  // Claude
  'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 200000, maxOutputTokens: 16000, provider: 'anthropic' },
  'claude-opus-4-8': { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindow: 200000, maxOutputTokens: 32000, provider: 'anthropic' },

  // DeepSeek
  'deepseek-chat': { id: 'deepseek-chat', label: 'DeepSeek Chat', contextWindow: 64000, maxOutputTokens: 8192, provider: 'deepseek' },
  'deepseek-reasoner': { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', contextWindow: 64000, maxOutputTokens: 8192, provider: 'deepseek' },
};

/** 默认上下文窗口（未知模型） */
export const DEFAULT_CONTEXT_WINDOW = 128000;

/** 自动 compact 阈值（95%） */
export const AUTO_COMPACT_THRESHOLD = 0.95;

// ============================================================================
// 运行时发现模型（从 /models 端点）
// ============================================================================

/** 运行时发现的模型上下文窗口 */
const discoveredModels: Map<string, ModelContextInfo> = new Map();

/**
 * 尝试从 API 端点动态发现模型上下文
 * 调用 OpenAI 兼容的 /models 端点
 */
export async function discoverModelContexts(
  baseUrl: string,
  apiKey: string,
): Promise<ModelContextInfo[]> {
  try {
    const url = baseUrl.endsWith('/') ? baseUrl + 'models' : baseUrl + '/models';
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return [];

    const data = await response.json() as { data?: Array<Record<string, unknown>> };
    const models: ModelContextInfo[] = [];

    for (const m of data.data || []) {
      const id = String(m.id || '');
      const contextWindow = (m.context_window ?? m.max_context_length) as number | undefined;
      if (contextWindow && id) {
        const info: ModelContextInfo = {
          id,
          label: id,
          contextWindow: Number(contextWindow),
          discovered: true,
        };
        discoveredModels.set(id, info);
        models.push(info);
      }
    }

    return models;
  } catch {
    return []; // 静默失败，回退到内置数据库
  }
}

/**
 * 获取模型上下文窗口
 * 优先级：动态发现 > 内置数据库 > 默认值
 */
export function getModelContextWindow(modelId: string): number {
  // 1. 动态发现的模型
  const discovered = discoveredModels.get(modelId);
  if (discovered) return discovered.contextWindow;

  // 2. 内置数据库
  const builtin = BUILTIN_MODELS[modelId];
  if (builtin) return builtin.contextWindow;

  // 3. 模糊匹配
  const normalized = modelId.toLowerCase();
  for (const [id, model] of Object.entries(BUILTIN_MODELS)) {
    if (normalized.includes(id) || id.includes(normalized.split(':')[0])) {
      return model.contextWindow;
    }
  }

  // 4. 默认值
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * 获取模型信息
 */
export function getModelInfo(modelId: string): ModelContextInfo | null {
  return discoveredModels.get(modelId) || BUILTIN_MODELS[modelId] || null;
}

/**
 * 计算上下文使用百分比
 */
export function calculateCtxPercent(usedTokens: number, modelId: string): number {
  const contextWindow = getModelContextWindow(modelId);
  return Math.min(100, Math.round((usedTokens / contextWindow) * 100));
}

/**
 * 获取所有已知模型列表（内置 + 动态发现）
 */
export function getAllKnownModels(): ModelContextInfo[] {
  const all = [...Object.values(BUILTIN_MODELS)];
  for (const [, discovered] of discoveredModels) {
    if (!all.some(m => m.id === discovered.id)) {
      all.push(discovered);
    }
  }
  return all;
}
