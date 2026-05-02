/**
 * openhorse - Tool System v2
 *
 * buildTool() factory pattern for general-purpose agent harness tools.
 */

// ============================================================================
// 类型定义
// ============================================================================

/** JSON Schema for tool input parameters */
export interface ToolInputJSONSchema {
  type: 'object';
  properties: Record<string, {
    type: string;
    description: string;
    enum?: string[];
  }>;
  required?: string[];
}

/** Tool execution result */
export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

/** Context passed to tool execute and permission checks */
export interface ToolContext {
  cwd: string;
  config: ToolConfig;
}

/** Minimal config needed by tools */
export interface ToolConfig {
  name: string;
  mode: string;
}

/** Permission check result */
export interface PermissionResult {
  behavior: 'allow' | 'ask' | 'deny';
  reason?: string;
}

/** OpenHorse tool definition */
export interface OpenHorseTool {
  /** Unique tool name */
  name: string;
  /** Alternative names */
  aliases?: string[];
  /** Description for LLM function calling */
  description: string;
  /** JSON Schema parameters */
  parameters: ToolInputJSONSchema;
  /** Execute the tool */
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;

  /** Check permissions before execution */
  checkPermissions?(args: Record<string, unknown>, context: ToolContext): PermissionResult;

  /** Can this tool run concurrently with other tools */
  isConcurrencySafe?(args: Record<string, unknown>): boolean;
  /** Is this a read-only operation */
  isReadOnly?(args: Record<string, unknown>): boolean;
  /** Is this a potentially destructive operation */
  isDestructive?(args: Record<string, unknown>): boolean;

  /** User-facing name for display */
  userFacingName?(args: Record<string, unknown>): string;
  /** Compact summary for tool result display */
  getSummary?(args: Record<string, unknown>, result: ToolResult): string;
}

/** OpenAI function calling tool format */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolInputJSONSchema;
  };
}

// ============================================================================
// buildTool 工厂
// ============================================================================

/** Default implementations for optional properties */
const TOOL_DEFAULTS = {
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: () => false,
  checkPermissions: (): PermissionResult => ({ behavior: 'allow' }),
};

/**
 * Build an OpenHorseTool with default values filled in.
 *
 * @example
 * const myTool = buildTool({
 *   name: 'my_tool',
 *   description: 'Does something useful',
 *   parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] },
 *   execute: async (args) => ({ success: true, output: 'ok' }),
 *   isReadOnly: () => true,
 * });
 */
export function buildTool(def: OpenHorseTool): OpenHorseTool {
  return {
    isConcurrencySafe: TOOL_DEFAULTS.isConcurrencySafe,
    isReadOnly: TOOL_DEFAULTS.isReadOnly,
    isDestructive: TOOL_DEFAULTS.isDestructive,
    checkPermissions: TOOL_DEFAULTS.checkPermissions,
    ...def,
  };
}

// ============================================================================
// toOpenAITool 转换器
// ============================================================================

/** Convert an OpenHorseTool to OpenAI function calling format */
export function toOpenAITool(tool: OpenHorseTool): OpenAITool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/** Convert an array of OpenHorseTools to OpenAI format */
export function toOpenAITools(tools: OpenHorseTool[]): OpenAITool[] {
  return tools.map(toOpenAITool);
}
