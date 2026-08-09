import { RetryPolicyService } from './retry-policy.service';
import {
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  RETRY_MAX_ATTEMPTS,
} from './workflow-runtime.constants';

describe('RetryPolicyService (P1-05)', () => {
  const retry = new RetryPolicyService();

  describe('classification', () => {
    it.each([
      ['Connector for "gmail" is DEGRADED — step quarantined (connector unavailable)', 'CONNECTOR_UNAVAILABLE', true],
      ['Request failed with 429 rate limit exceeded', 'RATE_LIMITED', true],
      ['Node timed out after 30000ms', 'TIMEOUT', true],
      ['Unknown skill/tool: nope/nope', 'VALIDATION_ERROR', false],
      ['Unknown node type: LOOP', 'VALIDATION_ERROR', false],
      ['CONDITION expected a number but got "around 85"', 'VALIDATION_ERROR', false],
      ['Emma has reached its monthly budget limit', 'BUDGET_EXCEEDED', false],
      ['Subscription is past due — workflow execution is paused', 'SUBSCRIPTION_BLOCKED', false],
      ['Something exploded', 'NODE_ERROR', true],
    ])('%s → %s (retryable: %s)', (message, expectedClass, retryable) => {
      const decision = retry.classify(new Error(message), 1);
      expect(decision.failureClass).toBe(expectedClass);
      expect(decision.retry).toBe(retryable);
    });

    it('never retries a non-retryable class even on attempt 1', () => {
      // The point: retrying a VALIDATION_ERROR burns the whole budget on an
      // error that cannot change, and delays the human who must fix it.
      const decision = retry.classify(new Error('Unknown skill/tool: x/y'), 1);
      expect(decision.retry).toBe(false);
      expect(decision.reason).toContain('not retryable');
    });

    it('stops retrying once attempts are exhausted', () => {
      const ok = retry.classify(new Error('boom'), RETRY_MAX_ATTEMPTS - 1);
      expect(ok.retry).toBe(true);

      const exhausted = retry.classify(new Error('boom'), RETRY_MAX_ATTEMPTS);
      expect(exhausted.retry).toBe(false);
      expect(exhausted.reason).toContain('exhausted');
    });
  });

  describe('backoff', () => {
    it('uses FULL jitter — repeated calls differ', () => {
      // Without jitter every node that failed in one provider outage retries in
      // lockstep and re-DDoSes the provider the moment it recovers.
      const samples = new Set(
        Array.from({ length: 40 }, () => retry.backoffMs(5)),
      );
      expect(samples.size).toBeGreaterThan(1);
    });

    it('stays within [0, min(base * 2^(n-1), cap)] for every attempt', () => {
      for (let attempt = 1; attempt <= 20; attempt += 1) {
        const ceiling = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
        for (let i = 0; i < 25; i += 1) {
          const delay = retry.backoffMs(attempt);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(ceiling);
        }
      }
    });

    it('never exceeds the cap, however many attempts', () => {
      expect(retry.backoffMs(100)).toBeLessThanOrEqual(RETRY_CAP_MS);
    });
  });
});
