/**
 * Rich text layout: convert RichTextBlock[] to StyledRow[].
 *
 * Pure function: takes blocks + width + theme, returns styled rows.
 * Handles width degradation, code wrapping, diff prefixes, table fallback.
 * Every output row satisfies stringWidth(row) <= safeWidth.
 */

import stringWidth from 'string-width';
import { segmentGraphemes } from '../composer/grapheme';
import {
  type RichTextBlock,
  type RichTextSpan,
  type RichTextDocument,
  type RichTextStyleToken,
  type RichTextThemeResolver,
  type DiffLine,
} from './types';
import {
  type StyledRow,
  type StyledSpan,
  type TuiStyle,
  styleKey,
} from '../../tui-core/style';

export interface RichTextLayoutOptions {
  width: number;
  theme: RichTextThemeResolver;
  /** Left indentation for the content (continuation alignment). */
  indent?: number;
}

/**
 * Layout a RichTextDocument into StyledRow[].
 * Each row's visual width <= safeWidth.
 */
export function layoutRichText(doc: RichTextDocument, options: RichTextLayoutOptions): StyledRow[] {
  const safeWidth = Math.max(1, options.width);
  const rows: StyledRow[] = [];

  for (const block of doc.blocks) {
    const blockRows = layoutBlock(block, safeWidth, options.theme, options.indent ?? 0);
    rows.push(...blockRows);
  }

  return rows;
}

function layoutBlock(block: RichTextBlock, width: number, theme: RichTextThemeResolver, indent: number): StyledRow[] {
  switch (block.type) {
    case 'paragraph':
      return layoutParagraph(block.spans, width, theme('assistantText'), indent);
    case 'heading':
      return layoutParagraph(block.spans, width, theme('heading'), indent);
    case 'list':
      return layoutList(block, width, theme, indent);
    case 'quote':
      return layoutQuote(block, width, theme, indent);
    case 'code':
      return layoutCode(block.lines, block.language, width, theme('code'), indent);
    case 'diff':
      return layoutDiff(block.lines, width, theme, indent);
    case 'table':
      return layoutTable(block, width, theme, indent);
    case 'rule':
      return [[{ text: '─'.repeat(width), style: theme('muted') }]];
    default:
      return [];
  }
}

function layoutParagraph(spans: RichTextSpan[], width: number, style: TuiStyle, indent: number): StyledRow[] {
  const availableWidth = Math.max(1, width - indent);
  const styledSpans: StyledSpan[] = spans.map(s => ({
    text: s.text,
    style: resolveSpanStyle(s, style),
  }));

  // If no text content, return an empty row with indent.
  const fullText = styledSpans.map(s => s.text).join('');
  if (!fullText) return [[{ text: ' '.repeat(indent), style }]];

  // Check if all spans share the same style — if so, use simple wrap.
  const allSameStyle = styledSpans.every(s => styleKey(s.style) === styleKey(styledSpans[0].style));

  if (allSameStyle) {
    // Simple path: join text, wrap, apply single style.
    const lines = fullText.split('\n');
    const rows: StyledRow[] = [];
    for (const line of lines) {
      const wrapped = wrapText(line, availableWidth);
      for (const wrappedLine of wrapped) {
        rows.push([{ text: ' '.repeat(indent) + wrappedLine, style: styledSpans[0].style }]);
      }
    }
    return rows;
  }

  // Mixed-style path: build a character-to-style map, wrap the joined text,
  // then reconstruct spans per row preserving style boundaries.
  const charStyles: TuiStyle[] = [];
  for (const span of styledSpans) {
    for (const char of Array.from(span.text)) {
      charStyles.push(span.style);
    }
  }

  const lines = fullText.split('\n');
  const rows: StyledRow[] = [];
  let charOffset = 0;

  for (const line of lines) {
    const wrapped = wrapText(line, availableWidth);
    for (const wrappedLine of wrapped) {
      const lineStart = charOffset;
      const lineEnd = charOffset + Array.from(wrappedLine).length;
      // Build spans for this line from the charStyles map.
      const rowSpans: StyledSpan[] = [{ text: ' '.repeat(indent), style }];
      let currentSpanText = '';
      let currentSpanStyle: TuiStyle | null = null;

      for (let ci = lineStart; ci < lineEnd && ci < charStyles.length; ci++) {
        const ch = Array.from(fullText)[ci] || '';
        const chStyle = charStyles[ci];
        if (currentSpanStyle !== null && styleKey(chStyle) !== styleKey(currentSpanStyle)) {
          if (currentSpanText) {
            rowSpans.push({ text: currentSpanText, style: currentSpanStyle });
          }
          currentSpanText = ch;
          currentSpanStyle = chStyle;
        } else {
          currentSpanText += ch;
          currentSpanStyle = chStyle;
        }
      }
      if (currentSpanText && currentSpanStyle !== null) {
        rowSpans.push({ text: currentSpanText, style: currentSpanStyle });
      }

      rows.push(rowSpans);
      charOffset = lineEnd;
    }
    // Skip the newline character in the charStyles map.
    charOffset += 1;
  }

  return rows;
}

function wrapText(text: string, maxWidth: number): string[] {
  if (!text) return [''];
  if (stringWidth(text) <= maxWidth) return [text];

  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;

    if (stringWidth(candidate) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      // Hard-wrap long words.
      if (stringWidth(word) > maxWidth) {
        const chunks = splitByVisualWidth(word, maxWidth);
        lines.push(...chunks.slice(0, -1));
        current = chunks[chunks.length - 1];
      } else {
        current = word;
      }
    }
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function splitByVisualWidth(text: string, maxWidth: number): string[] {
  if (text.length === 0) return [''];
  const chunks: string[] = [];
  let current = '';
  for (const part of segmentGraphemes(text)) {
    const next = `${current}${part.segment}`;
    if (current && stringWidth(next) > maxWidth) {
      chunks.push(current);
      current = part.segment;
    } else {
      current = next;
    }
  }
  chunks.push(current);
  return chunks;
}

function layoutList(block: { ordered: boolean; items: RichTextBlock[][] }, width: number, theme: RichTextThemeResolver, indent: number): StyledRow[] {
  const rows: StyledRow[] = [];
  const marker = block.ordered ? '1. ' : '- ';
  const childIndent = indent + marker.length;

  block.items.forEach((item, i) => {
    const prefix = block.ordered ? `${i + 1}. ` : '- ';
    const availableWidth = Math.max(1, width - indent);

    // Render first block with prefix, rest with child indent.
    item.forEach((subBlock, j) => {
      if (j === 0) {
        const subRows = layoutBlock(subBlock, width, theme, indent);
        if (subRows.length > 0) {
          // Prepend marker to first row.
          const firstRow = subRows[0];
          rows.push([{ text: prefix + ' '.repeat(Math.max(0, indent)) + (firstRow[0]?.text ?? '').trimStart(), style: theme('muted') }]);
          rows.push(...subRows.slice(1));
        }
      } else {
        rows.push(...layoutBlock(subBlock, width, theme, childIndent));
      }
    });
    void availableWidth;
  });

  return rows;
}

function layoutQuote(block: { blocks: RichTextBlock[] }, width: number, theme: RichTextThemeResolver, indent: number): StyledRow[] {
  const rows: StyledRow[] = [];
  const quoteIndent = indent + 2;

  for (const subBlock of block.blocks) {
    const subRows = layoutBlock(subBlock, width, theme, quoteIndent);
    for (const row of subRows) {
      // Add quote prefix.
      rows.push([{ text: '> ', style: theme('muted') }, ...row]);
    }
  }

  return rows;
}

function layoutCode(lines: string[], _language: string | undefined, width: number, style: TuiStyle, indent: number): StyledRow[] {
  const availableWidth = Math.max(1, width - indent - 1); // 1 for border/prefix
  const rows: StyledRow[] = [];

  for (const line of lines) {
    if (stringWidth(line) <= availableWidth) {
      rows.push([{ text: ' '.repeat(indent) + line, style }]);
    } else {
      const wrapped = splitByVisualWidth(line, availableWidth);
      wrapped.forEach((chunk, i) => {
        const marker = i > 0 ? '↳' : ' ';
        rows.push([{ text: ' '.repeat(indent) + marker + chunk, style }]);
      });
    }
  }

  return rows;
}

function layoutDiff(lines: DiffLine[], width: number, theme: RichTextThemeResolver, indent: number): StyledRow[] {
  const rows: StyledRow[] = [];
  const availableWidth = Math.max(1, width - indent - 1);

  for (const line of lines) {
    const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
    const style = diffLineStyle(line.kind, theme);

    if (stringWidth(line.content) <= availableWidth) {
      rows.push([{ text: ' '.repeat(indent) + prefix + line.content, style }]);
    } else {
      const wrapped = splitByVisualWidth(line.content, availableWidth);
      wrapped.forEach((chunk, i) => {
        const marker = i > 0 ? '↳' : prefix;
        rows.push([{ text: ' '.repeat(indent) + marker + chunk, style }]);
      });
    }
  }

  return rows;
}

function diffLineStyle(kind: DiffLine['kind'], theme: RichTextThemeResolver): TuiStyle {
  switch (kind) {
    case 'add': return theme('diffAdded');
    case 'remove': return theme('diffRemoved');
    case 'hunk':
    case 'meta': return theme('diffHunk');
    case 'context': return theme('muted');
  }
}

function layoutTable(block: { headers: RichTextSpan[][]; rows: RichTextSpan[][][] }, width: number, theme: RichTextThemeResolver, indent: number): StyledRow[] {
  const availableWidth = Math.max(1, width - indent);

  // Measure column widths.
  const colCount = Math.max(block.headers.length, ...block.rows.map(r => r.length));
  if (colCount === 0) return [];

  const minColWidth = 3;
  const maxTotal = availableWidth;
  const idealColWidth = Math.floor(maxTotal / colCount);

  // If columns can't fit, fall back to key/value layout.
  if (idealColWidth < minColWidth) {
    return layoutTableAsKeyValue(block, width, theme, indent);
  }

  const colWidth = idealColWidth;
  const rows: StyledRow[] = [];

  // Header row.
  const headerRow: StyledSpan[] = [];
  for (let c = 0; c < colCount; c++) {
    const headerText = block.headers[c]?.map(s => s.text).join('') ?? '';
    const truncated = truncateToWidth(headerText, colWidth - 1);
    headerRow.push({ text: truncated.padEnd(colWidth), style: theme('heading') });
  }
  rows.push(headerRow);

  // Separator.
  rows.push([{ text: '-'.repeat(Math.min(colWidth * colCount, maxTotal)), style: theme('muted') }]);

  // Data rows.
  for (const row of block.rows) {
    const dataRow: StyledSpan[] = [];
    for (let c = 0; c < colCount; c++) {
      const cellText = row[c]?.map(s => s.text).join('') ?? '';
      const truncated = truncateToWidth(cellText, colWidth - 1);
      dataRow.push({ text: truncated.padEnd(colWidth), style: theme('assistantText') });
    }
    rows.push(dataRow);
  }

  return rows;
}

function layoutTableAsKeyValue(block: { headers: RichTextSpan[][]; rows: RichTextSpan[][][] }, width: number, theme: RichTextThemeResolver, indent: number): StyledRow[] {
  const rows: StyledRow[] = [];
  const keyWidth = Math.max(1, Math.floor(width / 3) - indent);

  for (let c = 0; c < block.headers.length; c++) {
    const key = block.headers[c]?.map(s => s.text).join('') ?? `col${c}`;
    rows.push([{ text: ' '.repeat(indent) + truncateToWidth(key, keyWidth).padEnd(keyWidth) + ': ', style: theme('heading') }]);
    for (const row of block.rows) {
      const value = row[c]?.map(s => s.text).join('') ?? '';
      rows.push([{ text: ' '.repeat(indent + keyWidth + 2) + value, style: theme('assistantText') }]);
    }
  }

  return rows;
}

function resolveSpanStyle(span: RichTextSpan, baseStyle: TuiStyle): TuiStyle {
  if (!span.bold && !span.italic && !span.code) return baseStyle;
  return {
    ...baseStyle,
    bold: span.bold || baseStyle.bold,
    italic: span.italic || baseStyle.italic,
    dim: span.code || baseStyle.dim,
  };
}

function truncateToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;
  // Truncate by graphemes.
  let result = '';
  for (const part of segmentGraphemes(text)) {
    if (stringWidth(result + part.segment) > maxWidth - 1) {
      return result + '…';
    }
    result += part.segment;
  }
  return result;
}
