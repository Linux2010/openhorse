/**
 * openhorse - 配置加载
 *
 * 用户只需配置 3 项：apiKey、apiBaseUrl、defaultModel
 * 其他参数由 Agent 内部智能控制。
 *
 * 配置加载优先级：
 *   1. 命令行参数
 *   2. ~/.openhorse/openhorse.json (GlobalConfig)
 *   3. 环境变量
 *   4. Agent 内部默认值
 */

import { loadGlobalConfig, type GlobalConfig } from './global-config';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * OpenHorse 运行时配置
 * 用户可配置的只有 3 项，其余由 Agent 控制
 */
export interface OpenHorseCLIConfig {
  // ---- 用户配置 ----
  /** LLM API Key */
  apiKey: string;
  /** LLM API Base URL */
  apiBaseUrl?: string;
  /** 模型名称 */
  model: string;
  /** 备用模型（主模型失败时切换） */
  fallbackModel?: string;

  // ---- Agent 内部参数 (不由用户配置) ----
  /** 实例名称 */
  name: string;
  /** 运行模式 */
  mode: 'development' | 'production';
  /** 日志级别 */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// ============================================================================
// Agent 内部默认值（用户无需关心）
// ============================================================================

const INTERNAL_DEFAULTS = {
  // 以下参数由 Agent 根据任务自动选择，不暴露给用户配置
  // maxTokens:    代码 8192 / 分析 4096 / 简短 512
  // temperature:  代码 0.1 / 分析 0.3 / 创意 0.7
  // maxRetries:   指数退避，自动调整
  // retryDelay:   500ms → 1s → 2s → 4s
  name: 'openhorse',
  mode: 'development',
  logLevel: 'info',
} as const;

// ============================================================================
// 加载配置
// ============================================================================

/**
 * 从多源加载配置
 * 优先级：命令行 > 配置文件 > 环境变量 > 内部默认值
 */
export function loadConfig(overrides: Partial<OpenHorseCLIConfig> = {}): OpenHorseCLIConfig {
  const globalConfig = loadGlobalConfig();

  const config: OpenHorseCLIConfig = {
    // 用户核心配置 — 3 项
    apiKey:
      overrides.apiKey ?? globalConfig.apiKey ?? process.env.OPENHORSE_API_KEY ?? '',
    apiBaseUrl:
      overrides.apiBaseUrl ?? globalConfig.apiBaseUrl ?? process.env.OPENHORSE_API_BASE_URL ?? process.env.OPENHORSE_BASE_URL ?? undefined,
    model:
      overrides.model ?? globalConfig.defaultModel ?? process.env.OPENHORSE_MODEL ?? 'gpt-4o',
    fallbackModel:
      overrides.fallbackModel ?? globalConfig.fallbackModel ?? process.env.OPENHORSE_FALLBACK_MODEL ?? undefined,

    // Agent 内部参数
    name:
      overrides.name ?? process.env.OPENHORSE_NAME ?? INTERNAL_DEFAULTS.name,
    mode:
      (overrides.mode ?? process.env.OPENHORSE_MODE ?? INTERNAL_DEFAULTS.mode) as 'development' | 'production',
    logLevel:
      (overrides.logLevel ?? process.env.OPENHORSE_LOG_LEVEL ?? INTERNAL_DEFAULTS.logLevel) as OpenHorseCLIConfig['logLevel'],
  };

  return config;
}

/**
 * 检查 API Key 是否已配置
 */
export function isConfigured(config: OpenHorseCLIConfig): boolean {
  return Boolean(config.apiKey);
}

/**
 * 获取缺失配置的提示信息
 */
export function getConfigErrors(config: OpenHorseCLIConfig): string[] {
  const errors: string[] = [];
  if (!config.apiKey) {
    errors.push('Missing OPENHORSE_API_KEY. Set it in ~/.openhorse/openhorse.json or environment variable.');
  }
  return errors;
}

/**
 * 获取配置摘要（隐藏 Key 值）
 */
export function getConfigSummary(config: OpenHorseCLIConfig): Record<string, string> {
  return {
    name: config.name,
    model: config.model,
    fallback: config.fallbackModel || '(none)',
    apiBaseUrl: config.apiBaseUrl || '(default OpenAI)',
    apiKey: config.apiKey ? `${config.apiKey.slice(0, 7)}***` : '(not set)',
    mode: config.mode,
    logLevel: config.logLevel,
  };
}
