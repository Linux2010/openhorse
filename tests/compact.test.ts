/**
 * Compact 服务测试
 */

import type { Message } from '../src/services/llm';
import { needsCompact, compactMessages } from '../src/services/compact/compact';
import { getAutoCompact, resetAutoCompact } from '../src/services/compact/auto-compact';

// Helper to create messages
function createMessages(count: number, content: string = 'test message'): Message[] {
  return Array(count).fill(null).map(() => ({
    role: 'user' as const,
    content: content,
  }));
}

describe('Compact Service', () => {
  beforeEach(() => {
    resetAutoCompact();
  });

  describe('needsCompact', () => {
    test('returns true for messages > threshold', () => {
      const msgs = createMessages(60);
      expect(needsCompact(msgs, 50)).toBe(true);
    });

    test('returns false for messages <= threshold', () => {
      const msgs = createMessages(30);
      expect(needsCompact(msgs, 50)).toBe(false);
    });

    test('returns false for messages exactly at threshold', () => {
      const msgs = createMessages(50);
      expect(needsCompact(msgs, 50)).toBe(false);
    });

    test('uses default threshold of 50', () => {
      const msgs = createMessages(51);
      expect(needsCompact(msgs)).toBe(true);
    });

    test('handles empty array', () => {
      const msgs: Message[] = [];
      expect(needsCompact(msgs, 50)).toBe(false);
    });
  });

  describe('compactMessages', () => {
    test('reduces message count', async () => {
      const msgs = createMessages(60, 'test message content here');
      const result = await compactMessages(msgs, { threshold: 50, maxMessages: 20 });

      expect(result.messages.length).toBeLessThan(msgs.length);
      expect(result.originalCount).toBe(60);
      expect(result.compactedCount).toBeLessThan(60);
      expect(result.ratio).toBeLessThan(1);
    });

    test('does not compact if below threshold', async () => {
      const msgs = createMessages(30);
      const result = await compactMessages(msgs, { threshold: 50 });

      expect(result.messages.length).toBe(msgs.length);
      expect(result.originalCount).toBe(30);
    });

    test('keeps system message', async () => {
      const msgs: Message[] = [
        { role: 'system', content: 'You are a helpful assistant' },
        ...createMessages(60),
      ];
      const result = await compactMessages(msgs, { threshold: 50, keepSystemMessage: true });

      expect(result.messages[0].role).toBe('system');
    });

    test('generates summary', async () => {
      const msgs = createMessages(60, 'test message content');
      const result = await compactMessages(msgs, { threshold: 50 });

      expect(result.summary).toBeDefined();
      expect(result.summary.length).toBeGreaterThan(0);
    });

    test('maxMessages controls how many recent messages to keep', async () => {
      const msgs = createMessages(60);
      const result = await compactMessages(msgs, { threshold: 50, maxMessages: 10 });

      // Should have ~10 recent messages + summary (2 messages) = ~12
      expect(result.messages.length).toBeLessThanOrEqual(14);
    });
  });

  describe('AutoCompact', () => {
    test('checkAndCompact triggers when above threshold', async () => {
      // Use messages > maxMessages to see actual compaction
      const autoCompact = getAutoCompact({ threshold: 10, maxMessages: 5 });
      const msgs = createMessages(20);

      const result = await autoCompact.checkAndCompact(msgs);
      // Should be compacted to ~5 recent + 2 summary = ~7
      expect(result.length).toBeLessThan(msgs.length);
    });

    test('checkAndCompact does nothing when below threshold', async () => {
      const autoCompact = getAutoCompact({ threshold: 50, maxMessages: 20 });
      const msgs = createMessages(30);

      const result = await autoCompact.checkAndCompact(msgs);
      expect(result.length).toBe(msgs.length);
    });

    test('checkAndCompact does nothing when messages <= maxMessages', async () => {
      // Even if threshold is exceeded, if maxMessages >= messages, no old messages to compact
      // But summary is still added (2 messages), so result = msgs.length + 2
      const autoCompact = getAutoCompact({ threshold: 5, maxMessages: 20 });
      const msgs = createMessages(15);

      const result = await autoCompact.checkAndCompact(msgs);
      // 15 > threshold 5 triggers compact, but maxMessages 20 >= 15
      // All 15 messages are "recent", but summary adds 2 messages
      expect(result.length).toBe(msgs.length + 2); // 15 + 2 summary messages
    });

    test('respects 30s interval between compacts', async () => {
      const autoCompact = getAutoCompact({ threshold: 10, maxMessages: 5 });
      const msgs = createMessages(30);

      // First compact should work
      const result1 = await autoCompact.checkAndCompact(msgs);
      expect(result1.length).toBeLessThan(msgs.length);

      // Immediate second call should not compact (interval check)
      // It returns the input messages unchanged
      const freshMsgs = createMessages(30);
      const result2 = await autoCompact.checkAndCompact(freshMsgs);
      expect(result2.length).toBe(freshMsgs.length); // interval prevented compact, returns input
    });

    test('forceCompact bypasses interval check', async () => {
      const autoCompact = getAutoCompact({ threshold: 10, maxMessages: 5 });
      const msgs = createMessages(30);

      // First compact
      await autoCompact.checkAndCompact(msgs);

      // Force compact should work even within interval
      const freshMsgs = createMessages(30);
      const result = await autoCompact.forceCompact(freshMsgs);
      expect(result.length).toBeLessThan(freshMsgs.length);
    });

    test('setEnabled(false) disables auto compact', async () => {
      const autoCompact = getAutoCompact({ threshold: 10, maxMessages: 5, enabled: false });
      const msgs = createMessages(30);

      const result = await autoCompact.checkAndCompact(msgs);
      expect(result.length).toBe(msgs.length); // no compact
    });

    test('getStats returns correct values', async () => {
      const autoCompact = getAutoCompact({ threshold: 10, maxMessages: 5 });
      const msgs = createMessages(30);

      await autoCompact.checkAndCompact(msgs);
      const stats = autoCompact.getStats();

      expect(stats.compactCount).toBe(1);
      expect(stats.threshold).toBe(10);
      expect(stats.enabled).toBe(true);
    });

    test('setThreshold updates threshold', async () => {
      const autoCompact = getAutoCompact({ threshold: 10 });
      autoCompact.setThreshold(100);

      const msgs = createMessages(30);
      const result = await autoCompact.checkAndCompact(msgs);
      expect(result.length).toBe(msgs.length); // below new threshold
    });
  });
});