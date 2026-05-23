/**
 * openhorse - 流式 Markdown 渲染器
 *
 * 支持代码块缓冲渲染，防止断裂。
 */

import chalk from 'chalk';

const ACCENT = chalk.hex('#00D4AA');
const CODE_BG = chalk.bgHex('#1E293B');
const CODE_TEXT = chalk.hex('#E2E8F0');
const DIM = chalk.dim;
const CYAN = chalk.cyan;

// ============================================================================
// 类型定义
// ============================================================================

export interface StreamRendererState {
  buffer: string;
  inCodeBlock: boolean;
  codeBlockLang: string;
  codeBlockLines: string[];
}

// ============================================================================
// 流式渲染器
// ============================================================================

export class StreamMarkdownRenderer {
  private state: StreamRendererState = {
    buffer: '',
    inCodeBlock: false,
    codeBlockLang: '',
    codeBlockLines: [],
  };

  /**
   * 输入 chunk，返回渲染后的 ANSI 字符串
   */
  feed(chunk: string): string {
    // 添加到缓冲
    this.state.buffer += chunk;

    // 检测代码块开始
    if (!this.state.inCodeBlock && this.state.buffer.includes('```')) {
      // 找到代码块开始
      const startIdx = this.state.buffer.indexOf('```');
      const beforeCode = this.state.buffer.slice(0, startIdx);
      const afterCodeStart = this.state.buffer.slice(startIdx);

      // 解析语言
      const langMatch = afterCodeStart.match(/```(\w+)?\n?/);
      this.state.codeBlockLang = langMatch?.[1] || '';
      this.state.inCodeBlock = true;
      this.state.codeBlockLines = [];

      // 清空缓冲（保留代码块开始后的内容）
      const codeStartEnd = afterCodeStart.indexOf('\n') + 1;
      this.state.buffer = afterCodeStart.slice(codeStartEnd);

      // 渲染代码块前的内容
      return this.renderInline(beforeCode);
    }

    // 代码块内缓冲
    if (this.state.inCodeBlock) {
      // 检测代码块结束
      if (this.state.buffer.includes('```')) {
        const endIdx = this.state.buffer.indexOf('```');
        const codeContent = this.state.buffer.slice(0, endIdx);
        const afterCodeEnd = this.state.buffer.slice(endIdx + 3);

        this.state.codeBlockLines.push(codeContent);
        this.state.inCodeBlock = false;

        // 渲染完整代码块
        const rendered = this.renderCodeBlock(this.state.codeBlockLines, this.state.codeBlockLang);

        // 清空缓冲
        this.state.buffer = afterCodeEnd;
        this.state.codeBlockLines = [];

        return rendered;
      }

      // 按行分割，最后一行可能不完整
      const lines = this.state.buffer.split('\n');
      if (lines.length > 1) {
        // 完整行加入代码块
        for (let i = 0; i < lines.length - 1; i++) {
          this.state.codeBlockLines.push(lines[i]);
        }
        // 最后一行保留在缓冲
        this.state.buffer = lines[lines.length - 1];
      }

      // 代码块内不输出（缓冲）
      return '';
    }

    // 普通文本：实时渲染
    const output = this.renderInline(this.state.buffer);
    this.state.buffer = '';
    return output;
  }

  /**
   * 结束时输出剩余内容
   */
  flush(): string {
    if (this.state.inCodeBlock) {
      // 代码块未结束，直接输出
      return this.state.codeBlockLines.join('\n') + '\n' + this.state.buffer;
    }

    return this.renderInline(this.state.buffer);
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.state = {
      buffer: '',
      inCodeBlock: false,
      codeBlockLang: '',
      codeBlockLines: [],
    };
  }

  // ============================================================================
  // 内部渲染
  // ============================================================================

  private renderInline(text: string): string {
    if (!text) return '';

    // 行内代码
    let result = text.replace(/`([^`]+)`/g, (_, code) => CODE_BG(' ') + CODE_TEXT(code) + CODE_BG(' '));

    // 粗体
    result = result.replace(/\*\*(.+?)\*\*/g, (_, inner) => chalk.bold(inner));

    return result;
  }

  private renderCodeBlock(lines: string[], lang: string): string {
    const output: string[] = [];

    // 语言标签
    if (lang) {
      output.push(DIM(`┌─ ${lang}`));
    }

    // 代码行
    for (const line of lines) {
      output.push(CODE_BG(' ') + CODE_TEXT(line));
    }

    // 底部边框
    if (lang) {
      output.push(DIM('└' + '─'.repeat(Math.min(70, lines[0]?.length || 0 + 3))));
    }

    return output.join('\n') + '\n';
  }
}

/**
 * 创建流式渲染器
 */
export function createStreamRenderer(): StreamMarkdownRenderer {
  return new StreamMarkdownRenderer();
}