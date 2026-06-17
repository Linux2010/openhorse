/**
 * openhorse - Framework module
 *
 * Core framework components:
 *   - Tool System v2 (buildTool factory)
 *   - Query Loop (async generator)
 *   - System Prompt Builder (segment-based)
 *   - State Store (pub-sub)
 */

export { buildTool, toOpenAITool, toOpenAITools } from './tool';
export type {
  OpenHorseTool,
  ToolResult,
  ToolContext,
  ToolConfig,
  PermissionResult,
  ToolInputJSONSchema,
  OpenAITool,
} from './tool';

export { query } from './query';
export type { QueryEvent, QueryParams } from './query';

export { buildSystemPrompt, getSystemPrompt } from './prompt';
export type { PromptContext, PromptSection } from './prompt';

export { Store } from './store';
export type { AppState } from './store';

export {
  ContextHarness,
  createContextHarness,
  ContextLedger,
  createContextCapsule,
  renderContextCapsule,
  renderHarnessStateForCompact,
  assembleHarnessMessages,
  buildHarnessContext,
  classifyIntent,
  rankEvidence,
  upgradeHarnessState,
} from '../harness';
export type {
  ContextCapsule,
  ContextLedgerEntry,
  EvidenceRecord,
  HarnessConfig,
  IntentKind,
  IntentUpdate,
  HarnessState,
  PromptAssemblyStats,
  TaskContract,
  TurnSummary,
} from '../harness';

export {
  getToolState,
  setToolState,
  subscribeToolState,
  resetToolState,
} from './tool-state';
export type { ToolState, TodoItem } from './tool-state';
