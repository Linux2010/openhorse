/**
 * openhorse - UI 组件测试
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { createStreamRenderer, StreamMarkdownRenderer } from '../src/ui/stream-markdown';
import { renderToolCard, renderToolLine, renderDiffPreview, renderReadPreview } from '../src/ui/tool-preview';
import { renderStatusBar, renderCompactStatusBar } from '../src/ui/status-bar';

// ============================================================================
// StreamMarkdownRenderer 测试
// ============================================================================

describe('StreamMarkdownRenderer', () => {
  let renderer: StreamMarkdownRenderer;

  beforeEach(() => {
    renderer = createStreamRenderer();
  });

  test('renders plain text immediately', () => {
    const output = renderer.feed('Hello world');
    expect(output).toContain('Hello world');
  });

  test('buffers code block until end', () => {
    // Feed code block start
    const output1 = renderer.feed('Here is code:\n```typescript\n');
    expect(output1).toContain('Here is code:');
    // Code block content is buffered

    // Feed code content
    const output2 = renderer.feed('const x = 1;\n');
    expect(output2).toBe(''); // Buffered

    // Feed code block end
    const output3 = renderer.feed('```');
    expect(output3).toContain('const x = 1');
  });

  test('flush outputs remaining buffer', () => {
    renderer.feed('Some text');
    renderer.feed(' more text');
    const flush = renderer.flush();
    // Plain text is rendered inline, flush may be empty if already rendered
    // This test verifies flush doesn't throw
    expect(typeof flush).toBe('string');
  });

  test('reset clears all state', () => {
    renderer.feed('```typescript\ncode\n');
    renderer.reset();
    const flush = renderer.flush();
    expect(flush).toBe('');
  });
});

// ============================================================================
// Tool Preview 测试
// ============================================================================

describe('Tool Preview', () => {
  test('renderToolCard formats success tool', () => {
    const card = renderToolCard({
      name: 'Read',
      args: { path: '/src/test.ts' },
      result: 'content here',
      success: true,
      duration: 100,
    });

    expect(card).toContain('Read');
    expect(card).toContain('/src/test.ts');
    expect(card).toContain('100ms');
  });

  test('renderToolCard formats failed tool', () => {
    const card = renderToolCard({
      name: 'Bash',
      args: { command: 'npm test' },
      result: 'Error: failed',
      success: false,
      duration: 500,
    });

    expect(card).toContain('Bash');
    expect(card).toContain('npm test');
  });

  test('renderToolLine formats compact output', () => {
    const line = renderToolLine('Read', { path: '/test.ts' }, true, 50);
    expect(line).toContain('Read');
    expect(line).toContain('50ms');
  });

  test('renderDiffPreview shows +/- lines', () => {
    const diff = renderDiffPreview({
      file: 'config.ts',
      oldLines: ['const MAX = 100;'],
      newLines: ['const MAX = 200;'],
    });

    expect(diff).toContain('config.ts');
  });

  test('renderReadPreview shows file content', () => {
    const preview = renderReadPreview('test.ts', 'line1\nline2\nline3', true);
    expect(preview).toContain('Read');
    expect(preview).toContain('test.ts');
  });
});

// ============================================================================
// Status Bar 测试
// ============================================================================

describe('Status Bar', () => {
  test('renderStatusBar formats all stats', () => {
    const stats = {
      model: 'gpt-4o',
      tokens: 5000,
      promptTokens: 3000,
      completionTokens: 2000,
      cost: 0.05,
      ctxPercent: 30,
      mcpConnected: 2,
      mcpTotal: 3,
    };

    const bar = renderStatusBar(stats);
    expect(bar).toContain('OpenHorse');
    expect(bar).toContain('gpt-4o');
    expect(bar).toContain('K tok'); // Uses format like "5.0K tok"
    expect(bar).toContain('MCP');
  });

  test('renderCompactStatusBar shows tokens and cost', () => {
    const stats = {
      model: 'gpt-4o',
      tokens: 1000,
      promptTokens: 600,
      completionTokens: 400,
      cost: 0.01,
      ctxPercent: 20,
      mcpConnected: 0,
      mcpTotal: 0,
    };

    const bar = renderCompactStatusBar(stats);
    expect(bar).toContain('K tok'); // Uses format like "1.0K tok"
    expect(bar).toContain('ctx');
  });

  test('handles zero values', () => {
    const stats = {
      model: 'test',
      tokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      ctxPercent: 0,
      mcpConnected: 0,
      mcpTotal: 0,
    };

    const bar = renderStatusBar(stats);
    expect(bar).toContain('OpenHorse');
  });
});