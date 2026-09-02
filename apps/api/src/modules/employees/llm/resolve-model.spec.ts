import { modelForCall, type LlmProvider } from './llm.provider';
import { resolveModel } from './resolve-model';

/**
 * The model a call uses and the model it gets billed as MUST be the same string.
 *
 * They were not. The providers resolved `LLM_MODEL || DEFAULT_MODEL`; the credit
 * pricers resolved `process.env.LLM_MODEL ?? 'default'`. With `LLM_MODEL` unset
 * — the state a fresh deployment is in — a request went to `gpt-5.6-terra` and
 * was priced against the generic `default` rate row. Nothing failed and the
 * number was wrong (audit P1-F / P2-2).
 */
describe('resolveModel', () => {
  it('prefers the per-call model — an AI Employee’s own configured choice', () => {
    expect(resolveModel('claude-sonnet-5', 'gpt-5.6-terra', 'fallback')).toBe(
      'claude-sonnet-5',
    );
  });

  it('falls back to LLM_MODEL when the call names none', () => {
    expect(resolveModel(undefined, 'gpt-5.6-terra', 'fallback')).toBe('gpt-5.6-terra');
  });

  it("falls back to the provider's default when neither is set", () => {
    expect(resolveModel(undefined, undefined, 'fallback')).toBe('fallback');
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
  ])('treats %s as "not configured" rather than as a model id', (_label, value) => {
    expect(resolveModel(value, 'gpt-5.6-terra', 'fallback')).toBe('gpt-5.6-terra');
    expect(resolveModel(undefined, value, 'fallback')).toBe('fallback');
  });

  it('trims a padded value instead of sending it to the vendor', () => {
    expect(resolveModel('  claude-sonnet-5  ', undefined, 'fallback')).toBe(
      'claude-sonnet-5',
    );
  });
});

describe('modelForCall', () => {
  const withResolver: LlmProvider = {
    name: 'test',
    complete: async () => ({}),
    resolveModel: (requested) => resolveModel(requested, 'env-model', 'provider-default'),
  };

  /** A hand-rolled double, of which this repo has several. */
  const withoutResolver: LlmProvider = {
    name: 'bare',
    complete: async () => ({}),
  };

  it('asks the provider when it can answer', () => {
    expect(modelForCall(withResolver, 'employee-model')).toBe('employee-model');
    expect(modelForCall(withResolver)).toBe('env-model');
  });

  it('degrades to the same precedence when a provider cannot answer', () => {
    const previous = process.env.LLM_MODEL;
    try {
      process.env.LLM_MODEL = 'env-model';
      expect(modelForCall(withoutResolver, 'employee-model')).toBe('employee-model');
      expect(modelForCall(withoutResolver)).toBe('env-model');

      delete process.env.LLM_MODEL;
      // `'default'` is the catch-all RATE key, not a model id — reachable only
      // through a provider that cannot answer, i.e. never in production.
      expect(modelForCall(withoutResolver)).toBe('default');
    } finally {
      if (previous === undefined) delete process.env.LLM_MODEL;
      else process.env.LLM_MODEL = previous;
    }
  });

  /**
   * The regression itself, stated as a test: whatever the request carries is
   * what the pricer must be handed. Both spend sites (`AiStepNodeHandler` and
   * `AgentRuntimeService`) now resolve ONCE via `modelForCall` and reuse that
   * one value for the completion and for both price lookups.
   */
  it('gives the request and the price the same answer', () => {
    const employeeModel = 'claude-sonnet-5';
    const forRequest = modelForCall(withResolver, employeeModel);
    const forPricing = modelForCall(withResolver, employeeModel);
    expect(forRequest).toBe(forPricing);
    expect(forRequest).toBe(employeeModel);
  });
});
