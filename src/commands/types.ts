/**
 * openhorse - Slash Command System
 *
 * 使用 `/` 前缀的命令系统，支持 Tab 补全、命令建议、参数定义。
 * 非 `/` 前缀的输入直接作为 chat 消息处理。
 */

import type { OpenHorseRuntime } from '../init';
import type { Store } from '../framework/store';
import type { LLMService } from '../services/llm';
import type { OpenHorseCLIConfig } from '../services/config';
import type { SessionMeta } from '../services/session-storage';

// ============================================================================
// 类型定义
// ============================================================================

/** 命令执行上下文 */
export interface CommandContext {
  cwd: string;
  config: OpenHorseCLIConfig;
  store: Store;
  llm: LLMService | null;
  runtime: OpenHorseRuntime;
  /** 当前会话 ID（用于记录消息） */
  sessionId?: string;
  /** Lazily create or return the active session. */
  ensureSession?: () => SessionMeta;
  /** Switch the active session after /resume. */
  setSession?: (session: SessionMeta) => void;
  /** Return the active session if one exists. */
  getSession?: () => SessionMeta | null;
}

/** 命令执行结果 */
export interface CommandResult {
  success: boolean;
  output?: string;
  error?: string;
  /** 需要后续处理（如 chat） */
  continueAsChat?: boolean;
  chatInput?: string;
  /** Interactive session picker request for terminal UI. */
  sessionPicker?: {
    sessions: SessionMeta[];
    title: string;
    showProject?: boolean;
    moreCount?: number;
    allProjects?: boolean;
  };
}

/** 命令参数定义 */
export interface CommandParam {
  name: string;
  description: string;
  required?: boolean;
  default?: string;
}

/** 命令类型 */
export type CommandType = 'builtin' | 'tool' | 'chat';

/** Permission Mode - controls how tools/edits are handled */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto';

/** Permission mode cycle order */
export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto'];

/** Get next permission mode in cycle order */
export function getNextPermissionMode(current: PermissionMode): PermissionMode {
  const idx = PERMISSION_MODES.indexOf(current);
  return PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length];
}

/** Get mode display text */
export function getModeDisplayText(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'plan mode on';
    case 'acceptEdits':
      return 'auto-accept edits';
    case 'auto':
      return 'auto mode';
    default:
      return '';
  }
}

/** Slash 命令定义 */
export interface SlashCommand {
  name: string;
  aliases?: string[];
  /** 描述（可以是 getter 函数支持动态） */
  description: string;
  /** 参数提示（显示在命令名后面） */
  argumentHint?: string;
  params?: CommandParam[];
  type: CommandType;
  /** 是否隐藏（不显示在 help 中） */
  isHidden?: boolean;
  execute(ctx: CommandContext, args: string): Promise<CommandResult> | CommandResult;
}
