/**
 * openhorse - 配置加载
 *
 * 用户只需配置少量核心项，其他参数由 Agent 内部智能控制。
 *
 * 配置加载优先级：
 *   1. 命令行参数
 *   2. ~/.openhorse/openhorse.json (GlobalConfig)
 *   3. 环境变量
 *   4. Agent 内部默认值
 *
 * UI renderer is intentionally not read from openhorse.json. The new UI is the
 * default, and startup flags such as --ui legacy are the supported fallback.
 */

import {
  loadGlobalConfig,
  type GlobalConfig,
  type ToolConfirmationPolicy,
  type UIConfig,
  type UIRenderer,
  type UIConfirmationMode,
  type WebSearchMcpConfig,
} from './global-config';

export type { ToolConfirmationPolicy, UIConfig, UIRenderer, UIConfirmationMode, WebSearchMcpConfig };

// ============================================================================
// 类型定义
// ============================================================================

/**
 * OpenHorse 运行时配置
 * 用户可配置核心项：apiKey, apiBaseUrl, model, fallbackModel, toolConfirmation
 * 其余由 Agent 内部控制
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
  /** How to handle tool permission checks that need confirmation. */
  toolConfirmation: ToolConfirmationPolicy;
  /** Remote MCP service used by web_search. */
  webSearch?: WebSearchMcpConfig;
  /** Terminal UI configuration. loadConfig() fills defaults when loading app config. */
  ui?: UIConfig;

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
  toolConfirmation: 'allow' as ToolConfirmationPolicy,
  ui: {
    renderer: 'v2' as UIRenderer,
    confirmations: 'config' as UIConfirmationMode,
  },
} as const;

function normalizeToolConfirmationPolicy(value: unknown): ToolConfirmationPolicy | undefined {
  return value === 'ask' || value === 'allow' || value === 'deny'
    ? value
    : undefined;
}

function normalizeUIRenderer(value: unknown): UIRenderer | undefined {
  return value === 'legacy' || value === 'v2'
    ? value
    : undefined;
}

function normalizeUIConfirmationMode(value: unknown): UIConfirmationMode | undefined {
  return value === 'config' || value === 'interactive'
    ? value
    : undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function loadWebSearchConfig(
  globalConfig: GlobalConfig,
  overrides: Partial<OpenHorseCLIConfig>
): WebSearchMcpConfig | undefined {
  const merged: WebSearchMcpConfig = {
    ...globalConfig.webSearch,
    ...overrides.webSearch,
  };

  const endpoint = process.env.OPENHORSE_WEBSEARCH_MCP_ENDPOINT;
  const apiKey = process.env.OPENHORSE_WEBSEARCH_API_KEY ?? process.env.DASHSCOPE_API_KEY;
  const provider = process.env.OPENHORSE_WEBSEARCH_PROVIDER ?? process.env.OPENHORSE_WEBSEARCH_MCP_PROVIDER;
  const toolName = process.env.OPENHORSE_WEBSEARCH_MCP_TOOL;
  const timeoutMs = parsePositiveInt(process.env.OPENHORSE_WEBSEARCH_MCP_TIMEOUT_MS);
  const authType = process.env.OPENHORSE_WEBSEARCH_AUTH_TYPE;
  const apiKeyHeader = process.env.OPENHORSE_WEBSEARCH_API_KEY_HEADER;
  const apiKeyQueryParam = process.env.OPENHORSE_WEBSEARCH_API_KEY_QUERY_PARAM;

  if (provider) merged.provider = provider;
  if (endpoint) merged.endpoint = endpoint;
  if (apiKey) merged.apiKey = apiKey;
  if (toolName) merged.toolName = toolName;
  if (timeoutMs) merged.timeoutMs = timeoutMs;
  if (authType === 'bearer' || authType === 'header' || authType === 'query' || authType === 'none') {
    merged.authType = authType;
  }
  if (apiKeyHeader) merged.apiKeyHeader = apiKeyHeader;
  if (apiKeyQueryParam) merged.apiKeyQueryParam = apiKeyQueryParam;

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function loadUIConfig(
  globalConfig: GlobalConfig,
  overrides: Partial<OpenHorseCLIConfig>
): Required<UIConfig> {
  const envRenderer = process.env.OPENHORSE_UI_RENDERER ?? process.env.OPENHORSE_UI;
  const envConfirmations = process.env.OPENHORSE_UI_CONFIRMATIONS;

  return {
    renderer:
      normalizeUIRenderer(overrides.ui?.renderer)
      ?? normalizeUIRenderer(envRenderer)
      ?? INTERNAL_DEFAULTS.ui.renderer,
    confirmations:
      normalizeUIConfirmationMode(overrides.ui?.confirmations)
      ?? normalizeUIConfirmationMode(globalConfig.ui?.confirmations)
      ?? normalizeUIConfirmationMode(envConfirmations)
      ?? INTERNAL_DEFAULTS.ui.confirmations,
  };
}

// ============================================================================
// 加载配置
// ============================================================================

/**
 * 从多源加载配置
 * 优先级：命令行 > 配置文件 > 环境变量 > Agent 内部默认值
 */
export function loadConfig(overrides: Partial<OpenHorseCLIConfig> = {}): OpenHorseCLIConfig {
  const globalConfig = loadGlobalConfig();

  const config: OpenHorseCLIConfig = {
    // 用户核心配置
    apiKey:
      overrides.apiKey ?? globalConfig.apiKey ?? process.env.OPENHORSE_API_KEY ?? '',
    apiBaseUrl:
      overrides.apiBaseUrl ?? globalConfig.apiBaseUrl ?? process.env.OPENHORSE_API_BASE_URL ?? process.env.OPENHORSE_BASE_URL ?? undefined,
    model:
      overrides.model ?? globalConfig.defaultModel ?? process.env.OPENHORSE_MODEL ?? 'gpt-4o',
    fallbackModel:
      overrides.fallbackModel ?? globalConfig.fallbackModel ?? process.env.OPENHORSE_FALLBACK_MODEL ?? undefined,
    toolConfirmation:
      normalizeToolConfirmationPolicy(overrides.toolConfirmation)
      ?? normalizeToolConfirmationPolicy(globalConfig.toolConfirmation)
      ?? normalizeToolConfirmationPolicy(process.env.OPENHORSE_TOOL_CONFIRMATION)
      ?? INTERNAL_DEFAULTS.toolConfirmation,
    webSearch: loadWebSearchConfig(globalConfig, overrides),
    ui: loadUIConfig(globalConfig, overrides),

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
    toolConfirmation: config.toolConfirmation,
    ui: `${config.ui?.renderer ?? INTERNAL_DEFAULTS.ui.renderer}/${config.ui?.confirmations ?? INTERNAL_DEFAULTS.ui.confirmations}`,
    webSearch: config.webSearch?.endpoint || config.webSearch?.apiKey || config.webSearch?.toolName
      ? 'configured'
      : '(default)',
  };
}
