/**
 * openhorse - 消息摘要生成器
 *
 * 为压缩的历史消息生成简洁摘要，保留关键信息。
 */

import type { Message } from '../llm';

// ============================================================================
// 类型定义
// ============================================================================

export interface SummaryOptions {
  /** 摘要最大长度 */
  maxLength?: number;
  /** 是否包含工具调用摘要 */
  includeToolCalls?: boolean;
  /** 是否包含文件修改摘要 */
  includeFileChanges?: boolean;
  /** 摘要格式 */
  format?: 'bullet' | 'narrative' | 'structured';
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_OPTIONS: SummaryOptions = {
  maxLength: 500,
  includeToolCalls: true,
  includeFileChanges: true,
  format: 'bullet',
};

// ============================================================================
// 摘要生成
// ============================================================================

/**
 * 从消息列表生成摘要
 *
 * 注意：这是一个简化实现，不调用 LLM。
 * 实际生产版本应该调用 LLM 生成更准确的摘要。
 */
export async function summaryGenerator(
  messages: Message[],
  options?: SummaryOptions
): Promise<string> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (messages.length === 0) {
    return '';
  }

  // 收集关键信息
  const userTopics: string[] = [];
  const toolsUsed: string[] = [];
  const filesModified: string[] = [];
  const keyDecisions: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'user' && msg.content) {
      // 提取用户主题（截取前 50 字符）
      const topic = msg.content.slice(0, 50).trim();
      if (topic) {
        userTopics.push(topic);
      }
    }

    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolsUsed.push(tc.function.name);

        // 提取文件修改
        if (tc.function.name === 'write_file' || tc.function.name === 'edit_file') {
          try {
            const args = JSON.parse(tc.function.arguments);
            if (args.path) {
              filesModified.push(args.path);
            }
          } catch {
            // ignore
          }
        }
      }
    }
  }

  // 唯一化
  const uniqueTopics = [...new Set(userTopics)].slice(0, 5);
  const uniqueTools = [...new Set(toolsUsed)];
  const uniqueFiles = [...new Set(filesModified)];

  // 构建摘要
  const maxLen = opts.maxLength || 500;
  switch (opts.format) {
    case 'bullet':
      return buildBulletSummary(uniqueTopics, uniqueTools, uniqueFiles, maxLen);

    case 'narrative':
      return buildNarrativeSummary(uniqueTopics, uniqueTools, uniqueFiles, maxLen);

    case 'structured':
      return buildStructuredSummary(uniqueTopics, uniqueTools, uniqueFiles, maxLen);
  }

  return '';
}

// ============================================================================
// 摘要格式化
// ============================================================================

function buildBulletSummary(
  topics: string[],
  tools: string[],
  files: string[],
  maxLength: number
): string {
  const lines: string[] = [];

  if (topics.length > 0) {
    lines.push('Discussion topics:');
    for (const t of topics) {
      lines.push(`- ${t}${t.length > 80 ? '...' : ''}`);
    }
  }

  if (tools.length > 0) {
    lines.push(`Tools used: ${tools.join(', ')}`);
  }

  if (files.length > 0) {
    lines.push('Files modified:');
    for (const f of files.slice(0, 10)) {
      lines.push(`- ${f}`);
    }
    if (files.length > 10) {
      lines.push(`- ... and ${files.length - 10} more`);
    }
  }

  const summary = lines.join('\n');
  return summary.length > maxLength ? summary.slice(0, maxLength - 3) + '...' : summary;
}

function buildNarrativeSummary(
  topics: string[],
  tools: string[],
  files: string[],
  maxLength: number
): string {
  const parts: string[] = [];

  if (topics.length > 0) {
    parts.push(`We discussed: ${topics.join('; ')}.`);
  }

  if (tools.length > 0) {
    parts.push(`I used these tools: ${tools.join(', ')}.`);
  }

  if (files.length > 0) {
    parts.push(`I modified files: ${files.slice(0, 5).join(', ')}.`);
  }

  const summary = parts.join(' ');
  return summary.length > maxLength ? summary.slice(0, maxLength - 3) + '...' : summary;
}

function buildStructuredSummary(
  topics: string[],
  tools: string[],
  files: string[],
  maxLength: number
): string {
  const summary = JSON.stringify({
    topics: topics.slice(0, 5),
    tools: tools.slice(0, 10),
    files: files.slice(0, 10),
  });

  return summary.length > maxLength ? summary.slice(0, maxLength - 3) + '...' : summary;
}

// ============================================================================
// 导出
// ============================================================================

export { summaryGenerator as generateSummary };

// ============================================================================
// LLM-driven Summary (生产级摘要)
// ============================================================================

import type { LLMService } from '../llm';

/**
 * Generate a summary using the LLM for high-quality context compaction.
 * Falls back to heuristic summary if LLM call fails or times out.
 *
 * @param messages - Messages to summarize
 * @param llm - LLM service instance
 * @param options - Summary options
 * @returns Structured summary string
 */
export async function generateLLMSummary(
  messages: Message[],
  llm: LLMService,
  options?: SummaryOptions
): Promise<string> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (messages.length === 0) return '';

  // Build a condensed representation of the messages for the LLM
  const condensed = messages
    .map(msg => {
      if (msg.role === 'user') {
        return `[User]: ${msg.content?.slice(0, 200) || ''}`;
      }
      if (msg.role === 'assistant') {
        const toolCalls = msg.tool_calls
          ? ` (tools: ${msg.tool_calls.map(tc => tc.function.name).join(', ')})`
          : '';
        return `[Assistant]: ${msg.content?.slice(0, 300) || ''}${toolCalls}`;
      }
      if (msg.role === 'tool') {
        return `[Tool]: ${(msg.content || '').slice(0, 150)}`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');

  const prompt = `Summarize the following coding agent conversation compactly. Focus on:
1. User's main goal/objective
2. Key actions taken (files modified, commands run)
3. Current state (what's done, what's pending)
4. Any important decisions or constraints mentioned

Keep the summary under ${opts.maxLength || 500} characters. Use bullet points.

Conversation:
${condensed.slice(0, 8000)}

Summary:`;

  try {
    const response = await llm.chat([{ role: 'user', content: prompt }]);

    if (response.content) {
      return response.content.trim().slice(0, opts.maxLength || 500);
    }
  } catch {
    // LLM call failed or timed out — fall through to heuristic
  }

  // Fallback to heuristic summary
  return summaryGenerator(messages, options);
}