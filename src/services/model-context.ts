/**
 * openhorse - 模型上下文窗口数据库
 *
 * 每个模型的最大上下文 token 数。
 * 用于计算 ctxPercent 和触发自动 compact。
 */

export interface ModelContextInfo {
  /** 模型 ID */
  id: string;
  /** 显示名称 */
  label: string;
  /** 最大上下文 token 数 */
  contextWindow: number;
  /** 最大输出 token 数 */
  maxOutputTokens?: number;
  /** 提供商 */
  provider?: string;
}

/**
 * 已知模型上下文窗口数据库
 * 数据来源：各厂商官方文档
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, ModelContextInfo> = {
  // ---- 通义千问 (DashScope) ----
  'qwen-turbo': { id: 'qwen-turbo', label: 'Qwen Turbo', contextWindow: 131072, maxOutputTokens: 8192, provider: 'qwen' },
  'qwen-plus': { id: 'qwen-plus', label: 'Qwen Plus', contextWindow: 131072, maxOutputTokens: 8192, provider: 'qwen' },
  'qwen-max': { id: 'qwen-max', label: 'Qwen Max', contextWindow: 32768, maxOutputTokens: 8192, provider: 'qwen' },
  'qwen-long': { id: 'qwen-long', label: 'Qwen Long', contextWindow: 1000000, maxOutputTokens: 8192, provider: 'qwen' },

  // ---- GLM (智谱) ----
  'glm-4': { id: 'glm-4', label: 'GLM-4', contextWindow: 131072, maxOutputTokens: 4096, provider: 'glm' },
  'glm-5': { id: 'glm-5', label: 'GLM-5', contextWindow: 202752, maxOutputTokens: 8192, provider: 'glm' },

  // ---- OpenAI ----
  'gpt-4o': { id: 'gpt-4o', label: 'GPT-4o', contextWindow: 128000, maxOutputTokens: 16384, provider: 'openai' },
  'gpt-4o-mini': { id: 'gpt-4o-mini', label: 'GPT-4o Mini', contextWindow: 128000, maxOutputTokens: 16384, provider: 'openai' },
  'gpt-4': { id: 'gpt-4', label: 'GPT-4', contextWindow: 8192, maxOutputTokens: 8192, provider: 'openai' },
  'gpt-3.5-turbo': { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo', contextWindow: 16385, maxOutputTokens: 4096, provider: 'openai' },

  // ---- Claude ----
  'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 200000, maxOutputTokens: 16000, provider: 'anthropic' },
  'claude-opus-4-8': { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', contextWindow: 200000, maxOutputTokens: 32000, provider: 'anthropic' },
  'claude-haiku-4-5-20251001': { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', contextWindow: 200000, maxOutputTokens: 8192, provider: 'anthropic' },

  // ---- DeepSeek ----
  'deepseek-chat': { id: 'deepseek-chat', label: 'DeepSeek Chat', contextWindow: 64000, maxOutputTokens: 8192, provider: 'deepseek' },
  'deepseek-reasoner': { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', contextWindow: 64000, maxOutputTokens: 8192, provider: 'deepseek' },

  // ---- Ollama (本地，常见模型) ----
  'llama3.1:8b': { id: 'llama3.1:8b', label: 'Llama 3.1 8B', contextWindow: 128000, provider: 'ollama' },
  'llama3.1:70b': { id: 'llama3.1:70b', label: 'Llama 3.1 70B', contextWindow: 128000, provider: 'ollama' },
  'qwen2.5-coder': { id: 'qwen2.5-coder', label: 'Qwen 2.5 Coder', contextWindow: 128000, provider: 'ollama' },
  'qwen2.5-coder:latest': { id: 'qwen2.5-coder:latest', label: 'Qwen 2.5 Coder', contextWindow: 128000, provider: 'ollama' },
};

/** 默认上下文窗口（未知模型） */
export const DEFAULT_CONTEXT_WINDOW = 128000;

/** 自动 compact 阈值（95%） */
export const AUTO_COMPACT_THRESHOLD = 0.95;

/**
 * 获取模型的上下文窗口大小
 */
export function getModelContextWindow(modelId: string): number {
  const info = MODEL_CONTEXT_WINDOWS[modelId];
  if (info) return info.contextWindow;

  // 尝试模糊匹配
  const normalized = modelId.toLowerCase();
  for (const [id, model] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (normalized.includes(id) || id.includes(normalized.split(':')[0])) {
      return model.contextWindow;
    }
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * 获取模型信息
 */
export function getModelInfo(modelId: string): ModelContextInfo | null {
  return MODEL_CONTEXT_WINDOWS[modelId] || null;
}

/**
 * 计算上下文使用百分比（基于 token 数）
 */
export function calculateCtxPercent(usedTokens: number, modelId: string): number {
  const contextWindow = getModelContextWindow(modelId);
  return Math.min(100, Math.round((usedTokens / contextWindow) * 100));
}
