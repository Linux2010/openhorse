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
You are helpful, concise, and accurate.`,
  },
  {
    name: 'capabilities',
    dynamic: false,
    render: () => `You can perform a wide range of tasks:
- Read and write files on the local filesystem
- List directories and explore project structure
- Execute shell commands when needed
- Analyze code, data, and text
- Provide structured summaries and explanations

When a user asks you to do something:
1. If you need file or system information, use the appropriate tool first
2. If the user wants you to create or modify files, use the write tool
3. Provide a clear summary of what you found or did
4. Respond in the same language as the user
5. Keep responses concise and structured`,
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
