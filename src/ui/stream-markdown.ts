/**
 * openhorse - 流式 Markdown 渲染器
 *
 * 只缓冲代码块，防止代码块断裂。
 * 其他内容直接透传，不做处理。
 */

import chalk from 'chalk';

const CODE_BG = chalk.bgHex('#1E293B');
const CODE_TEXT = chalk.hex('#E2E8F0');
const DIM = chalk.dim;

// ============================================================================
// 类型定义
// ============================================================================

export interface StreamRendererState {
  inCodeBlock: boolean;
  codeBlockLang: string;
  codeBlockBuffer: string;
}

// ============================================================================
// 流式渲染器
// ============================================================================

export class StreamMarkdownRenderer {
  private state: StreamRendererState = {
    inCodeBlock: false,
    codeBlockLang: '',
    codeBlockBuffer: '',
  };

  /**
   * 输入 chunk，返回渲染后的 ANSI 字符串
   *
   * 策略：
   * - 代码块内：缓冲直到代码块结束
   * - 代码块外：直接透传（不做任何处理）
   */
  feed(chunk: string): string {
    if (!chunk) return '';

    // 检测代码块开始/结束
    if (!this.state.inCodeBlock) {
      // 检测代码块开始
      const codeStart = chunk.indexOf('```');
      if (codeStart >= 0) {
        // 输出代码块前的内容
        const before = chunk.slice(0, codeStart);
        const after = chunk.slice(codeStart);

        // 解析语言
        const langMatch = after.match(/```(\w+)?/);
        this.state.codeBlockLang = langMatch?.[1] || '';
        this.state.inCodeBlock = true;
        this.state.codeBlockBuffer = '';

        // 输出代码块开始标记
        const langDisplay = this.state.codeBlockLang ? ` ${this.state.codeBlockLang}` : '';
        return before + '\n' + DIM(`┌─${langDisplay}`) + '\n';
      }

      // 无代码块：直接透传
      return chunk;
    }

    // 代码块内：检测结束
    const codeEnd = chunk.indexOf('```');
    if (codeEnd >= 0) {
      // 代码块结束
      const codeContent = chunk.slice(0, codeEnd);
      const after = chunk.slice(codeEnd + 3);

      // 输出累积的代码内容 + 当前 chunk 的代码部分
      const fullCode = this.state.codeBlockBuffer + codeContent;
      const lines = fullCode.split('\n');

      let output = '';
      for (const line of lines) {
        if (line.trim()) {
          output += CODE_BG(' ') + CODE_TEXT(line) + '\n';
        }
      }
      output += DIM('└──') + '\n';

      // 重置状态
      this.state.inCodeBlock = false;
      this.state.codeBlockLang = '';
      this.state.codeBlockBuffer = '';

      // 输出代码块后的内容
      return output + after;
    }

    // 代码块内但未结束：缓冲
    this.state.codeBlockBuffer += chunk;

    // 按行输出已完成的行
    const lines = this.state.codeBlockBuffer.split('\n');
    if (lines.length > 1) {
      // 输出除最后一行外的所有行
      let output = '';
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (line.trim() || i < lines.length - 2) {
          output += CODE_BG(' ') + CODE_TEXT(line) + '\n';
        }
      }
      // 最后一行保留在 buffer
      this.state.codeBlockBuffer = lines[lines.length - 1];
      return output;
    }

    // 未完成一行：不输出
    return '';
  }

  /**
   * 结束时输出剩余内容
   */
  flush(): string {
    if (this.state.inCodeBlock && this.state.codeBlockBuffer) {
      // 代码块未正常结束：输出剩余内容
      const lines = this.state.codeBlockBuffer.split('\n');
      let output = '';
      for (const line of lines) {
        if (line.trim()) {
          output += CODE_BG(' ') + CODE_TEXT(line) + '\n';
        }
      }
      output += DIM('└── (incomplete)') + '\n';
      return output;
    }
    return '';
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.state = {
      inCodeBlock: false,
      codeBlockLang: '',
      codeBlockBuffer: '',
    };
  }
}

/**
 * 创建流式渲染器
 */
export function createStreamRenderer(): StreamMarkdownRenderer {
  return new StreamMarkdownRenderer();
}