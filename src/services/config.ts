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
 * UI renderer is intentionally not read from openhorse.json or env. The stable
 * native terminal UI is the default; --ui tui is the recommended beta renderer;
 * --ui ink is deprecated and will be removed in a future release.
 */

import {
  loadGlobalConfig,
  type GlobalConfig,
  type ToolConfirmationPolicy,
  type UIConfig,
  type UIRenderer,
  type UIConfirmationMode,
  type WebSearchMcpConfig,
  type SkillsConfig,
  type AgentLoopConfig,
  type AgentLoopBudgetConfig,
  type SubagentUserConfig,
  type SubagentMode,
  type SubagentRole,
  type CostConfig,
} from './global-config';
import {
  buildRegistry,
  isLegacyConfig,
  getLegacyMigrationHint,
  type ModelRegistry,
  type ResolvedModelProfile,
} from './model-registry';
import { ModelClientPool } from './model-client-pool';
import { delimiter } from 'path';
import {
  DEFAULT_SUBAGENT_CONFIG,
  type SubagentConfig,
} from '../runtime/subagents/types';
import { clampSubagentConfig } from '../runtime/subagents/policy';

export type {
  ToolConfirmationPolicy,
  UIConfig,
  UIRenderer,
  UIConfirmationMode,
  WebSearchMcpConfig,
  SkillsConfig,
  AgentLoopConfig,
  AgentLoopBudgetConfig,
  SubagentUserConfig,
  SubagentMode,
  SubagentRole,
  CostConfig,
};

export const STABLE_UI_RENDERER: UIRenderer = 'terminal';
export const RECOMMENDED_BETA_UI_RENDERER: UIRenderer = 'tui';
export const DEPRECATED_BETA_UI_RENDERERS = ['ink'] as const satisfies readonly UIRenderer[];
export const BETA_UI_RENDERERS = [RECOMMENDED_BETA_UI_RENDERER, ...DEPRECATED_BETA_UI_RENDERERS] as const satisfies readonly UIRenderer[];
export const SUPPORTED_UI_RENDERERS = [STABLE_UI_RENDERER, ...BETA_UI_RENDERERS] as const satisfies readonly UIRenderer[];

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
  /** v0.2.26 — Resolved model registry (providers + models). */
  modelRegistry?: ModelRegistry;
  /** v0.2.26 — Provider client pool. */
  modelClientPool?: ModelClientPool;
  /** How to handle tool permission checks that need confirmation. */
  toolConfirmation: ToolConfirmationPolicy;
  /** Remote MCP service used by web_search. */
  webSearch?: WebSearchMcpConfig;
  /** Terminal UI configuration. loadConfig() fills defaults when loading app config. */
  ui?: UIConfig;
  /** Additional user-managed skills roots. */
  skills?: SkillsConfig;
  /** Agent loop guardrail configuration. */
  agentLoop?: AgentLoopConfig;
  /** Resolved subagent runtime configuration (v0.2.20 beta). */
  subagents?: SubagentConfig;
  /** Cost-accounting overrides for custom or routed models. */
  cost?: CostConfig;

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

/** v0.2.26: suppress repeated legacy config warnings. */
let _legacyConfigWarned = false;

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
    renderer: 'terminal' as UIRenderer,
    confirmations: 'config' as UIConfirmationMode,
  },
} as const;

function normalizeToolConfirmationPolicy(value: unknown): ToolConfirmationPolicy | undefined {
  return value === 'ask' || value === 'allow' || value === 'deny'
    ? value
    : undefined;
}

export function resolveUIRenderer(value: unknown): UIRenderer | undefined {
  if (value === 'stable') return 'terminal';
  return isSupportedUIRenderer(value) ? value : undefined;
}

export function isSupportedUIRenderer(value: unknown): value is UIRenderer {
  return typeof value === 'string' && (SUPPORTED_UI_RENDERERS as readonly string[]).includes(value);
}

export function isInteractiveUIRenderer(value: unknown): value is UIRenderer {
  return isSupportedUIRenderer(value);
}

export function isBetaUIRenderer(value: unknown): value is typeof BETA_UI_RENDERERS[number] {
  return typeof value === 'string' && (BETA_UI_RENDERERS as readonly string[]).includes(value);
}

export function isRecommendedBetaUIRenderer(value: unknown): boolean {
  return value === RECOMMENDED_BETA_UI_RENDERER;
}

export function isDeprecatedUIRenderer(value: unknown): boolean {
  return typeof value === 'string' && (DEPRECATED_BETA_UI_RENDERERS as readonly string[]).includes(value);
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

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths = value
    .map(item => toNonEmptyString(item))
    .filter((item): item is string => Boolean(item));
  return [...new Set(paths)];
}

function loadSkillsConfig(
  globalConfig: GlobalConfig,
  overrides: Partial<OpenHorseCLIConfig>
): SkillsConfig | undefined {
  const paths = normalizeStringList([
    ...normalizeStringList(globalConfig.skills?.paths),
    ...(process.env.OPENHORSE_SKILLS_PATHS
      ? process.env.OPENHORSE_SKILLS_PATHS.split(delimiter)
      : []),
    ...normalizeStringList(overrides.skills?.paths),
  ]);

  return paths.length > 0 ? { paths } : undefined;
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
  const envConfirmations = process.env.OPENHORSE_UI_CONFIRMATIONS;

  return {
    renderer:
      resolveUIRenderer(overrides.ui?.renderer)
      ?? INTERNAL_DEFAULTS.ui.renderer,
    confirmations:
      normalizeUIConfirmationMode(overrides.ui?.confirmations)
      ?? normalizeUIConfirmationMode(globalConfig.ui?.confirmations)
      ?? normalizeUIConfirmationMode(envConfirmations)
      ?? INTERNAL_DEFAULTS.ui.confirmations,
  };
}

function loadAgentLoopConfig(
  globalConfig: GlobalConfig,
  overrides: Partial<OpenHorseCLIConfig>
): AgentLoopConfig | undefined {
  const budget: AgentLoopBudgetConfig = {
    ...globalConfig.agentLoop?.budget,
    ...overrides.agentLoop?.budget,
  };

  const envBudget: Array<[keyof AgentLoopBudgetConfig, string | undefined]> = [
    ['maxLlmRequestsPerUserTurn', process.env.OPENHORSE_MAX_LLM_REQUESTS_PER_TURN],
    ['maxToolCallsPerUserTurn', process.env.OPENHORSE_MAX_TOOL_CALLS_PER_TURN],
    ['maxReadOnlyFragmentation', process.env.OPENHORSE_MAX_READ_ONLY_FRAGMENTATION],
    ['maxModelVisibleToolBytes', process.env.OPENHORSE_MAX_MODEL_VISIBLE_TOOL_BYTES],
  ];

  for (const [key, value] of envBudget) {
    const parsed = parsePositiveInt(value);
    if (parsed) budget[key] = parsed;
  }

  return Object.keys(budget).length > 0 ? { budget } : undefined;
}

function normalizePricing(value: unknown): CostConfig['defaultPricing'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const pricing = value as Record<string, unknown>;
  const input = pricing.input;
  const output = pricing.output;
  const cachedInput = pricing.cachedInput;
  if (
    typeof input !== 'number'
    || !Number.isFinite(input)
    || input < 0
    || typeof output !== 'number'
    || !Number.isFinite(output)
    || output < 0
  ) {
    return undefined;
  }
  return {
    input,
    output,
    ...(typeof cachedInput === 'number' && Number.isFinite(cachedInput) && cachedInput >= 0
      ? { cachedInput }
      : {}),
  };
}

function loadCostConfig(
  globalConfig: GlobalConfig,
  overrides: Partial<OpenHorseCLIConfig>,
): CostConfig | undefined {
  const sourceModels = {
    ...(globalConfig.cost?.modelPricing ?? {}),
    ...(overrides.cost?.modelPricing ?? {}),
  };
  const modelPricing = Object.fromEntries(
    Object.entries(sourceModels)
      .map(([model, pricing]) => [model, normalizePricing(pricing)] as const)
      .filter((entry): entry is readonly [string, NonNullable<CostConfig['defaultPricing']>] =>
        Boolean(entry[1]),
      ),
  );
  const defaultPricing = normalizePricing(
    overrides.cost?.defaultPricing ?? globalConfig.cost?.defaultPricing,
  );

  if (Object.keys(modelPricing).length === 0 && !defaultPricing) return undefined;
  return {
    ...(Object.keys(modelPricing).length > 0 ? { modelPricing } : {}),
    ...(defaultPricing ? { defaultPricing } : {}),
  };
}

function parseSubagentMode(value: unknown): SubagentMode | undefined {
  return value === 'off' || value === 'explicit' || value === 'auto' ? value : undefined;
}

function loadSubagentConfig(
  globalConfig: GlobalConfig,
  overrides: Partial<OpenHorseCLIConfig>,
): SubagentConfig {
  const merged: SubagentUserConfig = {
    ...globalConfig.subagents,
    ...overrides.subagents,
  };

  const envMode = parseSubagentMode(process.env.OPENHORSE_SUBAGENTS);
  if (envMode) merged.mode = envMode;

  const envMaxParallel = parsePositiveInt(process.env.OPENHORSE_SUBAGENT_MAX_PARALLEL);
  if (envMaxParallel) merged.maxParallel = envMaxParallel;

  const resolved: SubagentConfig = {
    mode: merged.mode ?? DEFAULT_SUBAGENT_CONFIG.mode,
    maxParallel: merged.maxParallel ?? DEFAULT_SUBAGENT_CONFIG.maxParallel,
    maxTasksPerTurn: merged.maxTasksPerTurn ?? DEFAULT_SUBAGENT_CONFIG.maxTasksPerTurn,
    maxTurnsPerTask: merged.maxTurnsPerTask ?? DEFAULT_SUBAGENT_CONFIG.maxTurnsPerTask,
    maxModelRequestsPerTask: merged.maxModelRequestsPerTask ?? DEFAULT_SUBAGENT_CONFIG.maxModelRequestsPerTask,
    maxModelRequestsPerTurn: merged.maxModelRequestsPerTurn ?? DEFAULT_SUBAGENT_CONFIG.maxModelRequestsPerTurn,
    maxToolCallsPerTask: merged.maxToolCallsPerTask ?? DEFAULT_SUBAGENT_CONFIG.maxToolCallsPerTask,
    timeoutMs: merged.timeoutMs ?? DEFAULT_SUBAGENT_CONFIG.timeoutMs,
    roles: merged.roles && merged.roles.length > 0 ? merged.roles : DEFAULT_SUBAGENT_CONFIG.roles,
  };

  // Clamp to enforced bounds so a misconfigured openhorse.json cannot weaken limits.
  return clampSubagentConfig(resolved);
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

  // v0.2.26 — build ModelRegistry from providers+models if configured.
  // Falls back to legacy 4-field format with a console warning.
  let modelRegistry: ModelRegistry | undefined;
  let modelClientPool: ModelClientPool | undefined;
  let resolvedModel = 'gpt-4o';
  let resolvedFallback: string | undefined;

  const rawConfig = globalConfig as unknown as Record<string, unknown>;
  if (rawConfig.providers && rawConfig.models) {
    // New providers+models format
    const result = buildRegistry({
      providers: rawConfig.providers as never,
      models: rawConfig.models as never,
      defaultModel: globalConfig.defaultModel,
      fallbackModel: globalConfig.fallbackModel,
    });
    if (result.valid && result.registry) {
      modelRegistry = result.registry;
      modelClientPool = new ModelClientPool();
      resolvedModel = modelRegistry.defaultProfile?.id ?? 'gpt-4o';
      resolvedFallback = modelRegistry.fallbackProfile?.id ?? undefined;
    } else {
      console.error('[openhorse] Invalid providers+models configuration:');
      for (const err of result.errors) {
        console.error(`  ${err.path}: ${err.message}`);
      }
      // Fall through to legacy
    }
  }

  if (!modelRegistry) {
    // Legacy 4-field fallback
    if (isLegacyConfig(rawConfig)) {
      if (!_legacyConfigWarned) {
        _legacyConfigWarned = true;
        console.warn('[openhorse] Using legacy configuration format. Migrate to providers+models for v0.2.26+.');
      }
    }
    resolvedModel =
      toNonEmptyString(overrides.model)
      ?? toNonEmptyString(globalConfig.defaultModel)
      ?? toNonEmptyString(process.env.OPENHORSE_MODEL)
      ?? 'gpt-4o';
    resolvedFallback =
      toNonEmptyString(overrides.fallbackModel)
      ?? toNonEmptyString(globalConfig.fallbackModel)
      ?? toNonEmptyString(process.env.OPENHORSE_FALLBACK_MODEL)
      ?? undefined;
  }

  const config: OpenHorseCLIConfig = {
    // 用户核心配置
    apiKey:
      toNonEmptyString(overrides.apiKey)
      ?? globalConfig.apiKey
      ?? toNonEmptyString(process.env.OPENHORSE_API_KEY)
      ?? '',
    apiBaseUrl:
      toNonEmptyString(overrides.apiBaseUrl)
      ?? globalConfig.apiBaseUrl
      ?? toNonEmptyString(process.env.OPENHORSE_API_BASE_URL)
      ?? toNonEmptyString(process.env.OPENHORSE_BASE_URL)
      ?? undefined,
    model: resolvedModel,
    fallbackModel: resolvedFallback,
    modelRegistry,
    modelClientPool,
    toolConfirmation:
      normalizeToolConfirmationPolicy(overrides.toolConfirmation)
      ?? normalizeToolConfirmationPolicy(globalConfig.toolConfirmation)
      ?? normalizeToolConfirmationPolicy(process.env.OPENHORSE_TOOL_CONFIRMATION)
      ?? INTERNAL_DEFAULTS.toolConfirmation,
    webSearch: loadWebSearchConfig(globalConfig, overrides),
    ui: loadUIConfig(globalConfig, overrides),
    skills: loadSkillsConfig(globalConfig, overrides),
    agentLoop: loadAgentLoopConfig(globalConfig, overrides),
    subagents: loadSubagentConfig(globalConfig, overrides),
    cost: loadCostConfig(globalConfig, overrides),

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
