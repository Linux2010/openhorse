/**
 * openhorse - 配置加载
 *
 * 配置加载优先级：
 *   1. 命令行参数
 *   2. ~/.openhorse/openhorse.json (GlobalConfig)
 *   3. 环境变量
 *   4. 默认值
 */

import { loadGlobalConfig, type GlobalConfig } from './global-config';

// ============================================================================
// 类型定义
// ============================================================================

/** OpenHorse 运行时配置 */
export interface OpenHorseCLIConfig {
  /** LLM API Key */
  apiKey: string;
  /** LLM API Base URL */
  apiBaseUrl?: string;
  /** 模型名称 */
  model: string;
  /** 备用模型（主模型失败时切换） */
  fallbackModel?: string;
  /** 最大输出 token */
  maxTokens: number;
  /** 温度 */
  temperature: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试基础延迟 (ms) */
  retryBaseDelay: number;
  /** 实例名称 */
  name: string;
  /** 运行模式 */
  mode: 'development' | 'production';
  /** 日志级别 */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** 预算限制 (USD) */
  budgetLimit?: number;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULTS: Partial<OpenHorseCLIConfig> = {
  model: 'gpt-4o',
  maxTokens: 4096,
  temperature: 0.7,
  maxRetries: 3,
  retryBaseDelay: 500,
  name: 'openhorse',
  mode: 'development',
  logLevel: 'info',
};

// ============================================================================
// 加载配置
// ============================================================================

/**
 * 从多源加载配置
 * 优先级：命令行 > 配置文件 > 环境变量 > 默认值
 */
export function loadConfig(overrides: Partial<OpenHorseCLIConfig> = {}): OpenHorseCLIConfig {
  const globalConfig = loadGlobalConfig();

  const config: OpenHorseCLIConfig = {
    // 新优先级：overrides > globalConfig > env > defaults
    apiKey:
      overrides.apiKey ?? globalConfig.apiKey ?? process.env.OPENHORSE_API_KEY ?? '',
    apiBaseUrl:
      overrides.apiBaseUrl ?? globalConfig.apiBaseUrl ?? process.env.OPENHORSE_API_BASE_URL ?? process.env.OPENHORSE_BASE_URL ?? undefined,
    model:
      overrides.model ?? globalConfig.defaultModel ?? process.env.OPENHORSE_MODEL ?? DEFAULTS.model!,
    fallbackModel:
      overrides.fallbackModel ?? globalConfig.fallbackModel ?? process.env.OPENHORSE_FALLBACK_MODEL ?? undefined,
    maxTokens:
      overrides.maxTokens ?? globalConfig.maxTokens ?? parseNum(process.env.OPENHORSE_MAX_TOKENS) ?? DEFAULTS.maxTokens!,
    temperature:
      overrides.temperature ?? globalConfig.temperature ?? parseNum(process.env.OPENHORSE_TEMPERATURE) ?? DEFAULTS.temperature!,
    maxRetries:
      overrides.maxRetries ?? globalConfig.maxRetries ?? parseNum(process.env.OPENHORSE_MAX_RETRIES) ?? DEFAULTS.maxRetries!,
    retryBaseDelay:
      overrides.retryBaseDelay ?? globalConfig.retryBaseDelay ?? parseNum(process.env.OPENHORSE_RETRY_BASE_DELAY) ?? DEFAULTS.retryBaseDelay!,
    name:
      overrides.name ?? process.env.OPENHORSE_NAME ?? DEFAULTS.name!,
    mode:
      (overrides.mode ?? process.env.OPENHORSE_MODE ?? DEFAULTS.mode!) as 'development' | 'production',
    logLevel:
      (overrides.logLevel ?? process.env.OPENHORSE_LOG_LEVEL ?? DEFAULTS.logLevel!) as OpenHorseCLIConfig['logLevel'],
    budgetLimit:
      overrides.budgetLimit ?? globalConfig.budgetLimit ?? parseNum(process.env.OPENHORSE_BUDGET),
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
    errors.push('Missing OPENHORSE_API_KEY. Set it in ~/.openhorse/openhorse.json, .env file, or environment variable.');
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
    maxTokens: String(config.maxTokens),
    temperature: String(config.temperature),
    maxRetries: String(config.maxRetries),
    retryBaseDelay: String(config.retryBaseDelay) + 'ms',
    mode: config.mode,
    logLevel: config.logLevel,
    budgetLimit: config.budgetLimit ? `$${config.budgetLimit}` : '(no limit)',
  };
}

// ---- Internal ----

function parseNum(val: string | undefined): number | undefined {
  if (!val) return undefined;
  const num = Number(val);
  return Number.isNaN(num) ? undefined : num;
}
