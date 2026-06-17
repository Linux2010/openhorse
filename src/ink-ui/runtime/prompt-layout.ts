import stringWidth from 'string-width';

export interface PromptVisualLine {
  logicalIndex: number;
  wrapIndex: number;
  content: string;
}

export function promptContentWidth(width: number): number {
  return Math.max(1, width - 4);
}

export function promptTextWidth(width: number): number {
  return Math.max(1, promptContentWidth(width) - 2);
}

export function splitByVisualWidth(text: string, maxWidth: number): string[] {
  if (text.length === 0) return [''];

  const chunks: string[] = [];
  let current = '';

  for (const char of text) {
    const next = `${current}${char}`;
    if (current && stringWidth(next) > maxWidth) {
      chunks.push(current);
      current = char;
    } else {
      current = next;
    }
  }

  chunks.push(current);
  return chunks;
}

export function getPromptVisualLines(value: string, width: number): PromptVisualLine[] {
  const lines = value.length > 0 ? value.split('\n') : [''];
  const maxTextWidth = promptTextWidth(width);

  return lines.flatMap((line, logicalIndex) =>
    splitByVisualWidth(line, maxTextWidth).map((content, wrapIndex) => ({
      logicalIndex,
      wrapIndex,
      content,
    }))
  );
}

export function formatPromptVisualLine(visualLine: PromptVisualLine, width: number): string {
  const prefix = visualLine.logicalIndex === 0 && visualLine.wrapIndex === 0 ? '› ' : '  ';
  const raw = `${prefix}${visualLine.content}`;
  const padding = Math.max(0, promptContentWidth(width) - stringWidth(raw));
  return raw + ' '.repeat(padding);
}
