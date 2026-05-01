/**
 * openhorse - 配置加载
 *
 * 配置加载优先级：
 *   1. 命令行参数
 *   2. 环境变量
 *   3. .env 文件 (dotenv 已在 cli.ts 加载)
 *   4. 默认值
 */

// ============================================================================
// 类型定义
// ============================================================================

/** OpenHorse 全局配置 */
export interface OpenHorseCLIConfig {
  /** LLM API Key */
  apiKey: string;
  /** LLM API Base URL */
  apiBaseUrl?: string;
  /** 模型名称 */
  model: string;
  /** 最大输出 token */
  maxTokens: number;
  /** 温度 */
  temperature: number;
  /** 实例名称 */
  name: string;
  /** 运行模式 */
  mode: 'development' | 'production';
  /** 日志级别 */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULTS: Partial<OpenHorseCLIConfig> = {
  model: 'gpt-4o',
  maxTokens: 4096,
  temperature: 0.7,
  name: 'openhorse',
  mode: 'development',
  logLevel: 'info',
};

// ============================================================================
// 加载配置
// ============================================================================

/**
 * 从环境变量加载配置
 */
export function loadConfig(overrides: Partial<OpenHorseCLIConfig> = {}): OpenHorseCLIConfig {
  const config: OpenHorseCLIConfig = {
    apiKey: overrides.apiKey ?? process.env.OPENHORSE_API_KEY ?? '',
    apiBaseUrl: overrides.apiBaseUrl ?? process.env.OPENHORSE_BASE_URL ?? undefined,
    model: overrides.model ?? process.env.OPENHORSE_MODEL ?? DEFAULTS.model!,
    maxTokens: overrides.maxTokens ?? parseNum(process.env.OPENHORSE_MAX_TOKENS) ?? DEFAULTS.maxTokens!,
    temperature:
      overrides.temperature ??
      parseNum(process.env.OPENHORSE_TEMPERATURE) ??
      DEFAULTS.temperature!,
    name: overrides.name ?? process.env.OPENHORSE_NAME ?? DEFAULTS.name!,
    mode: (overrides.mode ?? process.env.OPENHORSE_MODE ?? DEFAULTS.mode!) as 'development' | 'production',
    logLevel: (overrides.logLevel ?? process.env.OPENHORSE_LOG_LEVEL ?? DEFAULTS.logLevel!) as OpenHorseCLIConfig['logLevel'],
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
    errors.push('Missing OPENHORSE_API_KEY. Set it in .env file or environment variable.');
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
    apiBaseUrl: config.apiBaseUrl || '(default OpenAI)',
    apiKey: config.apiKey ? `${config.apiKey.slice(0, 7)}***` : '(not set)',
    maxTokens: String(config.maxTokens),
    temperature: String(config.temperature),
    mode: config.mode,
    logLevel: config.logLevel,
  };
}

// ---- Internal ----

function parseNum(val: string | undefined): number | undefined {
  if (!val) return undefined;
  const num = Number(val);
  return Number.isNaN(num) ? undefined : num;
}
