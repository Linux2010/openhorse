/**
 * Lightweight ANSI SGR-to-StyledSpan parser.
 *
 * Converts tool output containing basic SGR colour/style codes into StyledSpan[]
 * for the rich-text layout engine, while stripping all other escape sequences
 * (cursor movement, erase, absolute positioning, etc.) that would corrupt the
 * TUI frame model.
 *
 * This is intentionally NOT a full terminal emulator. It only handles the
 * subset of SGR codes that external tools (jest, eslint, compilers) commonly
 * emit:
 *
 *   - SGR reset (0)
 *   - bold (1), dim (2)
 *   - foreground colours (30-37)
 *   - background colours (40-47)
 *   - bright foreground (90-97)
 *
 * All other escape sequences are discarded.
 */

import type { StyledSpan, TuiStyle, TuiColor } from '../../tui-core/style';

// --- Public API ---

export interface AnsiParserResult {
  spans: StyledSpan[];
}

/**
 * Parse tool output that may contain ANSI SGR escape codes into styled spans.
 * Non-SGR escape sequences (cursor movement, clear screen, etc.) are stripped.
 * Plain text between SGR codes is emitted with the current style.
 */
export function parseAnsiToStyledSpans(rawText: string): StyledSpan[] {
  const spans: StyledSpan[] = [];
  const text = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let current = '';
  let style: TuiStyle = {};
  let i = 0;

  const flush = () => {
    if (current.length > 0) {
      spans.push({ text: current, style });
      current = '';
    }
  };

  while (i < text.length) {
    const codePoint = text.codePointAt(i);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);

    if (codePoint === 0x1b) {
      // ESC found — try to parse the escape sequence
      const parsed = tryParseSgrSequence(text, i);
      if (parsed) {
        flush();
        style = mergeTuiStyle(style, parsed.style);
        i = parsed.nextIndex;
        continue;
      }
      // Not a recognised SGR sequence — skip the entire escape sequence
      flush();
      style = {}; // reset on unknown escape to avoid stale colour
      i = skipEscapeSequence(text, i + 1);
      continue;
    }

    // C0 control characters other than \n are stripped.
    if (codePoint < 0x20 && codePoint !== 0x0a) {
      i += 1;
      continue;
    }

    current += char;
    i += char.length;
  }

  flush();
  return spans;
}

// --- Internal helpers ---

interface ParsedSgr {
  style: TuiStyle;
  nextIndex: number;
}

function tryParseSgrSequence(text: string, escIndex: number): ParsedSgr | null {
  const next = text.codePointAt(escIndex + 1);
  if (next !== 0x5b) return null; // 0x5b = '['

  // Find the terminator (0x40–0x7e: @–~)
  let end = escIndex + 2;
  while (end < text.length) {
    const cp = text.codePointAt(end);
    if (cp === undefined) break;
    if (cp >= 0x40 && cp <= 0x7e) {
      const params = text.slice(escIndex + 2, end + 1); // include terminator
      const style = parseSgrParams(params);
      if (style === null) return null; // not an SGR sequence
      return { style, nextIndex: end + 1 };
    }
    end += 1;
  }

  return null; // unterminated
}

/**
 * Parse SGR parameters (the portion between `\x1b[` and `m`).
 * Returns null if the final character is not 'm' (not an SGR sequence).
 */
function parseSgrParams(params: string): TuiStyle | null {
  if (params.length === 0) return null; // CSI without params
  const final = params.codePointAt(params.length - 1);
  if (final !== 0x6d) return null; // not ending with 'm'

  const codes = params.slice(0, -1).split(';').map(c => parseInt(c, 10));
  if (codes.length === 0 || codes.every(isNaN)) return null;

  let result: TuiStyle = {};
  for (const code of codes) {
    if (isNaN(code)) continue;
    switch (code) {
      case 0:  result = {}; break;               // reset
      case 1:  result = { ...result, bold: true }; break;
      case 2:  result = { ...result, dim: true }; break;
      case 30: result = { ...result, foreground: named('black') }; break;
      case 31: result = { ...result, foreground: named('red') }; break;
      case 32: result = { ...result, foreground: named('green') }; break;
      case 33: result = { ...result, foreground: named('yellow') }; break;
      case 34: result = { ...result, foreground: named('blue') }; break;
      case 35: result = { ...result, foreground: named('magenta') }; break;
      case 36: result = { ...result, foreground: named('cyan') }; break;
      case 37: result = { ...result, foreground: named('white') }; break;
      case 39: result = { ...result, foreground: undefined }; break;  // default fg
      case 40: result = { ...result, background: named('black') }; break;
      case 41: result = { ...result, background: named('red') }; break;
      case 42: result = { ...result, background: named('green') }; break;
      case 43: result = { ...result, background: named('yellow') }; break;
      case 44: result = { ...result, background: named('blue') }; break;
      case 45: result = { ...result, background: named('magenta') }; break;
      case 46: result = { ...result, background: named('cyan') }; break;
      case 47: result = { ...result, background: named('white') }; break;
      case 49: result = { ...result, background: undefined }; break;  // default bg
      case 90: result = { ...result, foreground: named('black') }; break;
      case 91: result = { ...result, foreground: named('red') }; break;
      case 92: result = { ...result, foreground: named('green') }; break;
      case 93: result = { ...result, foreground: named('yellow') }; break;
      case 94: result = { ...result, foreground: named('blue') }; break;
      case 95: result = { ...result, foreground: named('magenta') }; break;
      case 96: result = { ...result, foreground: named('cyan') }; break;
      case 97: result = { ...result, foreground: named('white') }; break;
      // Unrecognised SGR codes are ignored (they are still valid SGR).
      default: break;
    }
  }
  return result;
}

const VALID_NAMED_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
type NamedColorValue = typeof VALID_NAMED_COLORS[number];

function named(name: string): TuiColor {
  // The SGR code mapping only produces valid named colors, but guard anyway.
  const value = VALID_NAMED_COLORS.includes(name as NamedColorValue)
    ? (name as NamedColorValue)
    : 'white';
  return { kind: 'named', value };
}

/** Merge a parsed SGR style on top of the current style. */
function mergeTuiStyle(current: TuiStyle, incoming: TuiStyle): TuiStyle {
  // If incoming is a reset (all fields undefined), return empty.
  const hasReset =
    incoming.foreground === undefined &&
    incoming.background === undefined &&
    incoming.bold === undefined &&
    incoming.dim === undefined;
  if (hasReset) return {};
  return {
    foreground: incoming.foreground !== undefined ? incoming.foreground : current.foreground,
    background: incoming.background !== undefined ? incoming.background : current.background,
    bold: incoming.bold !== undefined ? incoming.bold : current.bold,
    dim: incoming.dim !== undefined ? incoming.dim : current.dim,
  };
}

/**
 * Skip past an escape sequence starting from the character after ESC.
 * We only skip known SGR/CUP/ED/EL/etc sequences; for unknown sequences
 * we skip to the next printable character as a safety measure.
 */
function skipEscapeSequence(text: string, index: number): number {
  // For CSI sequences (starting with '['), skip past all parameter bytes
  // (0x30-0x3f) and intermediate bytes (0x20-0x2f) until the terminator.
  let i = index;
  if (i < text.length && text.codePointAt(i) === 0x5b) {
    // CSI sequence: skip '[' and all parameter/intermediate bytes
    i += 1;
    while (i < text.length) {
      const cp = text.codePointAt(i);
      if (cp === undefined) break;
      if (cp >= 0x30 && cp <= 0x3f) { i += 1; continue; } // parameter byte
      if (cp >= 0x20 && cp <= 0x2f) { i += 1; continue; } // intermediate byte
      if (cp >= 0x40 && cp <= 0x7e) { return i + 1; }     // final byte
      break; // not a valid CSI byte — bail out
    }
    return text.length;
  }

  // Non-CSI escape: skip until terminator or end of string.
  while (i < text.length) {
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    if (cp >= 0x40 && cp <= 0x7e) return i + 1;
    if (cp < 0x20 || cp > 0x7e) return i;
    i += 1;
  }
  return text.length;
}
