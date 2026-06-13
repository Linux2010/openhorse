/**
 * openhorse - System Prompt Builder (segment-based)
 *
 * Segment-based system prompt composition with static/dynamic separation.
 * Static sections are cacheable for API prompt caching.
 * Dynamic sections are rebuilt each request.
 */

import type { OpenHorseTool } from './tool';

// ============================================================================
// 类型
// ============================================================================

/** Context for rendering prompt sections */
export interface PromptContext {
  cwd: string;
  platform: string;
  nodeVersion: string;
  tools: OpenHorseTool[];
  memoryContent?: string;
  /** Pre-rendered skills section (e.g. from SkillsRegistry.generateSystemPromptInjection) */
  skillsContent?: string;
}

/** A named prompt section */
export interface PromptSection {
  name: string;
  dynamic: boolean;
  render: (ctx: PromptContext) => string;
}

// ============================================================================
// 内置段落
// ============================================================================

const SECTIONS: PromptSection[] = [
  {
    name: 'intro',
    dynamic: false,
    render: () => `You are OpenHorse, a universal AI agent powered by the OpenHorse Framework.
Your core mission is to solve the user's problem — be concise, direct, and action-oriented.`,
  },
  {
    name: 'capabilities',
    dynamic: false,
    render: () => `Guidelines:
- Be brief — explain only what's necessary
- Persist through failures — try alternative approaches, don't give up easily
- When blocked, diagnose the root cause and attempt at least 2 different fixes before asking
- Ask clarifying questions only when the user's intent is genuinely ambiguous or there are multiple equally-valid paths
- Write code, don't describe it
- Output plans/proposals as workspace markdown files, not just text
- When summarizing repository changes, only name files verified by tool output such as git_status, git diff, or direct file reads
- Keep responses structured and short
- Respond in the same language as the user`,
  },
  {
    name: 'tools',
    dynamic: false,
    render: (ctx) => {
      const toolNames = ctx.tools.map(t => t.name).join(', ');
      return `Available tools: ${toolNames}.
Use tools when they help complete the task. Prefer the right tool for the job.`;
    },
  },
  {
    name: 'env_info',
    dynamic: true,
    render: (ctx) => `Current environment:
- Working directory: ${ctx.cwd}
- Platform: ${ctx.platform}
- Node.js: ${ctx.nodeVersion}`,
  },
  {
    name: 'memory',
    dynamic: true,
    render: (ctx) => {
      if (!ctx.memoryContent) return '';
      return `Project memory:\n${ctx.memoryContent}`;
    },
  },
  {
    name: 'skills',
    dynamic: true,
    render: (ctx) => {
      if (!ctx.skillsContent) return '';
      return ctx.skillsContent;
    },
  },
];

// ============================================================================
// buildSystemPrompt
// ============================================================================

/**
 * Build a system prompt from segments, separating static and dynamic parts.
 *
 * Returns `{ static, dynamic }` for potential API prompt caching.
 * The two parts are joined with a separator when used as a single string.
 */
export function buildSystemPrompt(ctx: PromptContext): { static: string; dynamic: string } {
  const staticParts: string[] = [];
  const dynamicParts: string[] = [];

  for (const section of SECTIONS) {
    const content = section.render(ctx);
    if (!content.trim()) continue;

    if (section.dynamic) {
      dynamicParts.push(content);
    } else {
      staticParts.push(content);
    }
  }

  return {
    static: staticParts.join('\n\n'),
    dynamic: dynamicParts.join('\n\n'),
  };
}

/**
 * Build a single system prompt string (static + dynamic joined).
 * Convenience wrapper around buildSystemPrompt.
 */
export function getSystemPrompt(ctx: PromptContext): string {
  const { static: staticPart, dynamic } = buildSystemPrompt(ctx);
  const parts = [staticPart, dynamic].filter(Boolean);
  return parts.join('\n\n---\n');
}
