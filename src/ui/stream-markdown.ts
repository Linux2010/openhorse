/**
 * openhorse - 流式 Markdown 渲染器
 *
 * 支持流式渲染：标题、粗体、斜体、行内代码、列表、引用、链接、分割线、表格、代码块
 */

import chalk from 'chalk';

const CODE_BG = chalk.bgHex('#1E293B');
const CODE_TEXT = chalk.hex('#E2E8F0');
const DIM = chalk.dim;
const BOLD = chalk.bold;
const CYAN = chalk.cyan;
const GREEN = chalk.green;
const MAGENTA = chalk.magenta;

/**
 * 去除 ANSI 颜色码
 */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * 计算字符串在终端中的可见宽度（不含 ANSI 码）
 * CJK 字符占 2 格，普通字符占 1 格
 */
function visualWidth(str: string): number {
  const clean = stripAnsi(str);
  let width = 0;
  for (const ch of clean) {
    const cp = ch.codePointAt(0) || 0;
    width += (cp >= 0x1100 && (
      cp <= 0x115F || cp === 0x2329 || cp === 0x232A ||
      (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) ||
      (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE10 && cp <= 0xFE19) ||
      (cp >= 0xFE30 && cp <= 0xFE6F) ||
      (cp >= 0xFF01 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||
      (cp >= 0x20000 && cp <= 0x2FFFD) ||
      (cp >= 0x30000 && cp <= 0x3FFFD)
    )) ? 2 : 1;
  }
  return width;
}

// ============================================================================
// 类型定义
// ============================================================================

export interface StreamRendererState {
  inCodeBlock: boolean;
  codeBlockLang: string;
  codeBlockBuffer: string;
  pendingInline: string;
  // Table buffer state
  inTable: boolean;
  tableRows: string[];
}

// ============================================================================
// 流式渲染器
// ============================================================================

export class StreamMarkdownRenderer {
  private state: StreamRendererState = {
    inCodeBlock: false,
    codeBlockLang: '',
    codeBlockBuffer: '',
    pendingInline: '',
    inTable: false,
    tableRows: [],
  };

  /**
   * 输入 chunk，返回渲染后的 ANSI 字符串
   */
  feed(chunk: string): string {
    if (!chunk) return '';

    if (!this.state.inCodeBlock) {
      const codeStart = chunk.indexOf('```');
      if (codeStart >= 0) {
        // 先渲染代码块前的内容
        const before = chunk.slice(0, codeStart);
        const after = chunk.slice(codeStart);
        const langMatch = after.match(/```(\w+)?/);
        this.state.codeBlockLang = langMatch?.[1] || '';
        this.state.inCodeBlock = true;
        this.state.codeBlockBuffer = '';

        const langDisplay = this.state.codeBlockLang ? ` ${this.state.codeBlockLang}` : '';
        // 结束任何缓冲的表格
        let output = '';
        if (this.state.inTable) {
          output = this.flushTable();
        }
        return output + this.renderInlineBuffer(before) + '\n' + DIM(`┌─${langDisplay}`) + '\n';
      }

      // 非代码块：积累内容，遇到换行时渲染
      this.state.pendingInline += chunk;
      return this.consumePending();
    }

    // === 代码块内 ===
    const codeEnd = chunk.indexOf('```');
    if (codeEnd >= 0) {
      const codeContent = chunk.slice(0, codeEnd);
      const after = chunk.slice(codeEnd + 3);
      const fullCode = this.state.codeBlockBuffer + codeContent;
      const lines = fullCode.split('\n');

      let output = '';
      for (const line of lines) {
        if (line.trim()) {
          output += CODE_BG(' ') + CODE_TEXT(line) + '\n';
        }
      }
      output += DIM('└──') + '\n';

      this.state.inCodeBlock = false;
      this.state.codeBlockLang = '';
      this.state.codeBlockBuffer = '';

      return output + after;
    }

    this.state.codeBlockBuffer += chunk;

    // 输出已完成的行
    const lines = this.state.codeBlockBuffer.split('\n');
    if (lines.length > 1) {
      let output = '';
      for (let i = 0; i < lines.length - 1; i++) {
        output += CODE_BG(' ') + CODE_TEXT(lines[i]) + '\n';
      }
      this.state.codeBlockBuffer = lines[lines.length - 1];
      return output;
    }

    return '';
  }

  /**
   * 消耗 pendingInline 中已完成的部分
   * 表格行一直累积，遇到 `\n\n` 或非表格行时 flush
   */
  private consumePending(): string {
    let output = '';
    const nlIndex = this.state.pendingInline.lastIndexOf('\n');
    if (nlIndex === -1) return '';

    // 保留最后一个 \n（可能后面还有内容）
    const complete = this.state.pendingInline.slice(0, nlIndex);
    this.state.pendingInline = this.state.pendingInline.slice(nlIndex);

    const lines = complete.split('\n');
    for (const line of lines) {
      if (line === '') {
        // 空行：结束并 flush 表格
        if (this.state.inTable) {
          output += this.flushTable() + '\n';
        }
        continue;
      }

      if (line.startsWith('|')) {
        if (!this.state.inTable) {
          this.state.inTable = true;
          this.state.tableRows = [];
        }
        this.state.tableRows.push(line);
      } else {
        // 非表格行：flush 表格
        if (this.state.inTable) {
          output += this.flushTable() + '\n';
        }
        output += this.renderLine(line) + '\n';
      }
    }

    return output;
  }

  /**
   * 解析并渲染缓冲的表格
   */
  private flushTable(): string {
    if (!this.state.inTable || this.state.tableRows.length === 0) {
      this.state.inTable = false;
      this.state.tableRows = [];
      return '';
    }

    this.state.inTable = false;
    const rows = this.state.tableRows;
    this.state.tableRows = [];

    // 解析表格行
    const parsed: string[][] = [];
    let headerRow = 0;

    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i].split('|').slice(1, -1).map(c => c.trim());
      // 跳过分隔符行 (|---|---|)
      if (cells.every(c => /^[-:]+$/.test(c))) {
        headerRow = i + 1;
        continue;
      }
      parsed.push(cells);
    }

    if (parsed.length === 0) return '';

    // 计算每列最大宽度（基于可见宽度，CJK = 2）
    const colWidths: number[] = [];
    for (const row of parsed) {
      for (let c = 0; c < row.length; c++) {
        const w = visualWidth(row[c] || '');
        colWidths[c] = Math.max(colWidths[c] || 0, w);
      }
    }

    // 渲染表格
    const lines: string[] = [];

    for (let r = 0; r < parsed.length; r++) {
      const row = parsed[r]!;
      let line = CYAN('│ ');
      for (let c = 0; c < colWidths.length; c++) {
        const cell = row[c] || '';
        const rendered = r === 0 ? BOLD(this.renderInline(cell)) : this.renderInline(cell);
        const vw = visualWidth(cell);
        const pad = Math.max(0, (colWidths[c] || 0) - vw);
        line += rendered + ' '.repeat(pad) + CYAN(' │ ');
      }
      // Remove trailing space before closing
      line = line.slice(0, -1);
      lines.push(line);

      // 表头分隔线
      if (r === headerRow - 1) {
        let sepLine = DIM('├');
        for (let c = 0; c < colWidths.length; c++) {
          sepLine += DIM('─'.repeat((colWidths[c] || 0) + 2) + '┼');
        }
        sepLine = sepLine.slice(0, -1);
        lines.push(sepLine);
      }
    }

    // 顶部和底部边框
    let topLine = DIM('┌');
    for (let c = 0; c < colWidths.length; c++) {
      topLine += DIM('─'.repeat((colWidths[c] || 0) + 2) + '┬');
    }
    topLine = topLine.slice(0, -1);

    let botLine = DIM('└');
    for (let c = 0; c < colWidths.length; c++) {
      botLine += DIM('─'.repeat((colWidths[c] || 0) + 2) + '┴');
    }
    botLine = botLine.slice(0, -1);

    return '\n' + topLine + '\n' + lines.join('\n') + '\n' + botLine;
  }

  /**
   * 渲染一段文本的 Markdown 元素
   */
  private renderInlineBuffer(text: string): string {
    if (!text) return '';

    const lines = text.split('\n');
    const output: string[] = [];

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (line === '' && li < lines.length - 1) {
        output.push('');
        continue;
      }
      output.push(this.renderLine(line));
    }

    return output.join('\n');
  }

  /**
   * 渲染单行 Markdown
   */
  private renderLine(line: string): string {
    // Horizontal rule
    if (/^(-{3,}|[*]{3,})$/.test(line.trim())) {
      return DIM('─'.repeat(Math.min(line.length, 60)));
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const styled = this.renderInline(text);
      if (level <= 2) return '\n' + BOLD(CYAN(styled));
      if (level <= 4) return '\n' + BOLD(GREEN(styled));
      return '\n' + MAGENTA(styled);
    }

    // Blockquote
    if (line.startsWith('> ')) {
      return DIM('│ ') + this.renderInline(line.slice(2));
    }
    if (line.startsWith('>')) {
      return DIM('│ ') + this.renderInline(line.slice(1).trim());
    }

    // Unordered list
    const listMatch = line.match(/^(\s*)([-*+])\s+(.*)$/);
    if (listMatch) {
      return listMatch[1] + CYAN('• ') + this.renderInline(listMatch[3]);
    }

    // Ordered list
    const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (orderedMatch) {
      return orderedMatch[1] + CYAN(orderedMatch[2] + '.') + ' ' + this.renderInline(orderedMatch[3]);
    }

    return this.renderInline(line);
  }

  /**
   * 渲染 inline Markdown 元素
   */
  private renderInline(text: string): string {
    // Inline code: `code`
    text = text.replace(/`([^`]+)`/g, (_m, code) => CODE_BG(' ') + CODE_TEXT(code));

    // Bold: **text** or __text__
    text = text.replace(/\*\*(.+?)\*\*/g, (_m, b) => BOLD(b));
    text = text.replace(/__(.+?)__/g, (_m, b) => BOLD(b));

    // Italic: *text* or _text_
    text = text.replace(/\*(.+?)\*/g, (_m, i) => chalk.italic(i));
    text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, (_m, i) => chalk.italic(i));

    // Links: [text](url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, lt, url) => {
      return BOLD(CYAN(lt)) + DIM(` (${url})`);
    });

    return text;
  }

  /**
   * 结束时输出剩余内容
   */
  flush(): string {
    let output = '';

    if (this.state.inCodeBlock && this.state.codeBlockBuffer) {
      const lines = this.state.codeBlockBuffer.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          output += CODE_BG(' ') + CODE_TEXT(line) + '\n';
        }
      }
      output += DIM('└── (incomplete)') + '\n';
    }

    if (this.state.inTable) {
      output += this.flushTable() + '\n';
    }

    if (this.state.pendingInline) {
      output += this.renderInlineBuffer(this.state.pendingInline);
      this.state.pendingInline = '';
    }

    return output;
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.state = {
      inCodeBlock: false,
      codeBlockLang: '',
      codeBlockBuffer: '',
      pendingInline: '',
      inTable: false,
      tableRows: [],
    };
  }
}

/**
 * 创建流式渲染器
 */
export function createStreamRenderer(): StreamMarkdownRenderer {
  return new StreamMarkdownRenderer();
}
