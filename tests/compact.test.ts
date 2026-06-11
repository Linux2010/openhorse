import { getAutoCompact, resetAutoCompact, AutoCompact } from '../src/services/compact/auto-compact';
import type { Message } from '../src/services/llm';

function createMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    content: `Message ${i}`,
  }));
}

beforeEach(() => {
  resetAutoCompact();
});

afterEach(() => {
  resetAutoCompact();
});

describe('AutoCompact', () => {
  describe('token-based compact', () => {
    test('triggers compact when token usage exceeds 95%', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'test-model',
        threshold: 0.95,
        maxMessages: 5,
      });

      // 95% of 128000 (default) = 121600 tokens
      const msgs = createMessages(30);
      const result = await autoCompact.checkAndCompact(msgs, 125000);
      expect(result.length).toBeLessThan(msgs.length);
    });

    test('does nothing when below 95%', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'glm-5', // 202752 context
        maxMessages: 5,
      });

      const msgs = createMessages(30);
      // Only 1000 tokens, well below 95% of 202752
      const result = await autoCompact.checkAndCompact(msgs, 1000);
      expect(result.length).toBe(msgs.length);
    });

    test('respects 30s interval between compacts', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'test-model',
        maxMessages: 3,
      });

      const msgs = createMessages(30);
      const result1 = await autoCompact.checkAndCompact(msgs, 200000);
      expect(result1.length).toBeLessThan(msgs.length);

      // Immediate second call should not compact (interval check)
      const freshMsgs = createMessages(30);
      const result2 = await autoCompact.checkAndCompact(freshMsgs, 200000);
      expect(result2.length).toBe(freshMsgs.length);
    });

    test('forceCompact bypasses interval check', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'test-model',
        maxMessages: 3,
      });

      const msgs = createMessages(30);
      await autoCompact.checkAndCompact(msgs, 200000);

      // Force compact should work even within interval
      const freshMsgs = createMessages(30);
      const result = await autoCompact.forceCompact(freshMsgs);
      expect(result.length).toBeLessThan(freshMsgs.length);
    });

    test('setEnabled(false) disables auto compact', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'test-model',
        maxMessages: 5,
        enabled: false,
      });
      const msgs = createMessages(30);

      const result = await autoCompact.checkAndCompact(msgs, 200000);
      expect(result.length).toBe(msgs.length);
    });

    test('getStats returns correct values', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'glm-5',
        maxMessages: 5,
      });
      const msgs = createMessages(30);

      await autoCompact.checkAndCompact(msgs, 200000);
      const stats = autoCompact.getStats();

      expect(stats.compactCount).toBe(1);
      expect(stats.threshold).toBe(0.95);
      expect(stats.enabled).toBe(true);
      expect(stats.modelId).toBe('glm-5');
    });

    test('uses model-specific context window', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'glm-5', // 202752 context
      });

      const msgs = createMessages(30);

      // 100k tokens is 49% of glm-5's 202752 — should NOT compact
      const result = await autoCompact.checkAndCompact(msgs, 100000);
      expect(result.length).toBe(msgs.length);

      // Check ctxPercent
      const pct = autoCompact.getCtxPercent(100000);
      expect(pct).toBe(49);
    });

    test('setModel updates context window', async () => {
      const autoCompact = getAutoCompact({
        modelId: 'glm-5', // 202752
      });

      // 100k is 49% of glm-5
      expect(autoCompact.getCtxPercent(100000)).toBe(49);

      autoCompact.setModel('gpt-4o'); // 128000
      // 100k is 78% of gpt-4o's 128000
      expect(autoCompact.getCtxPercent(100000)).toBe(78);
    });
  });
});
