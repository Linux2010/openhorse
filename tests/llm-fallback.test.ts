/**
 * Fallback Model E2E Test
 *
 * Verifies that the LLMService correctly switches to the fallback model
 * after consecutive 529 (overloaded) errors.
 */

import { LLMService, FallbackTriggeredError } from '../src/services/llm';
import OpenAI from 'openai';

describe('LLMService fallback model', () => {
  test('triggerFallback switches model', () => {
    const llm = new LLMService({
      apiKey: 'test',
      model: 'primary-model',
      fallbackModel: 'fallback-model',
    });

    expect(llm.getModel()).toBe('primary-model');
    expect(llm.isUsingFallback()).toBe(false);

    llm.triggerFallback();

    expect(llm.getModel()).toBe('fallback-model');
    expect(llm.isUsingFallback()).toBe(true);
  });

  test('triggerFallback is a no-op when no fallbackModel is configured', () => {
    const llm = new LLMService({
      apiKey: 'test',
      model: 'primary-model',
    });

    llm.triggerFallback();

    expect(llm.getModel()).toBe('primary-model');
    expect(llm.isUsingFallback()).toBe(false);
  });

  test('triggerFallback only switches once even if called multiple times', () => {
    const llm = new LLMService({
      apiKey: 'test',
      model: 'primary-model',
      fallbackModel: 'fallback-model',
    });

    llm.triggerFallback();
    llm.triggerFallback();
    llm.triggerFallback();

    expect(llm.getModel()).toBe('fallback-model');
  });

  test('resetToPrimary keeps the (already-swapped) model but clears the fallback flag', () => {
    const llm = new LLMService({
      apiKey: 'test',
      model: 'primary-model',
      fallbackModel: 'fallback-model',
    });

    llm.triggerFallback();
    expect(llm.isUsingFallback()).toBe(true);

    llm.resetToPrimary();
    expect(llm.isUsingFallback()).toBe(false);
  });

  test('chatStream triggers fallback after 3 consecutive 529 errors', async () => {
    const llm = new LLMService({
      apiKey: 'test',
      model: 'primary-model',
      fallbackModel: 'fallback-model',
      maxRetries: 5,
      retryBaseDelay: 1, // speed up test
    });

    // Build a 529 APIError to throw
    const make529 = () => {
      const err = new OpenAI.APIError(
        529,
        { error: { message: 'overloaded' } },
        'overloaded',
        {} as any,
      );
      return err;
    };

    let callCount = 0;
    const createSpy = jest.fn(async () => {
      callCount++;
      // First 3 calls throw 529; subsequent calls succeed with a tiny stream
      if (callCount <= 3) throw make529();

      // Return an async iterable that yields one final chunk
      async function* stream() {
        yield {
          choices: [{ delta: { content: 'recovered' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          model: 'fallback-model',
        };
      }
      return stream() as any;
    });

    // Inject the spy into the OpenAI client
    (llm as any).client.chat.completions.create = createSpy;

    const result = await llm.chatStream([{ role: 'user', content: 'hi' }]);

    // The fallback should have been triggered before success
    expect(llm.isUsingFallback()).toBe(true);
    expect(llm.getModel()).toBe('fallback-model');

    // The OpenAI client was called multiple times (3 failures + 1 success)
    expect(createSpy).toHaveBeenCalledTimes(4);

    // The model in the final call's params should be the fallback
    const lastCallArgs: any = (createSpy.mock.calls as any[])[3][0];
    expect(lastCallArgs.model).toBe('fallback-model');

    expect(result.content).toBe('recovered');
  });

  test('FallbackTriggeredError contains both model names', () => {
    const err = new FallbackTriggeredError('opus', 'haiku');
    expect(err.originalModel).toBe('opus');
    expect(err.fallbackModel).toBe('haiku');
    expect(err.message).toMatch(/opus/);
    expect(err.message).toMatch(/haiku/);
  });
});
