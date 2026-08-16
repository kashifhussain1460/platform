import { Injectable } from '@nestjs/common';
import {
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  RETRY_MAX_ATTEMPTS,
} from './workflow-runtime.constants';

/** Why a run/step failed — mirrors RunFailureClass (doc 00 §0.7.1). */
export type FailureClass =
  | 'NODE_ERROR'
  | 'CONNECTOR_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'APPROVAL_REJECTED'
  | 'BUDGET_EXCEEDED'
  | 'SUBSCRIPTION_BLOCKED'
  | 'VALIDATION_ERROR'
  | 'CANCELLED'
  | 'INTERNAL'
  | 'AUTHORIZATION_DENIED'
  /**
   * WAVE 2 — the worker died between the side effect and its bookkeeping
   * commit, so whether the external action happened is genuinely unknown.
   *
   * Its own class rather than `INTERNAL` because it is the one failure an
   * operator must treat differently from every other: before retrying anything,
   * somebody has to go and LOOK at the provider. Folded into `INTERNAL` it was
   * invisible in `workflow_failure_total{failure_class}` and unqueryable, so
   * "which runs might have half-sent an email?" had no answer.
   */
  | 'OUTCOME_UNKNOWN';

export interface RetryDecision {
  retry: boolean;
  failureClass: FailureClass;
  /** Delay before the next attempt, in ms. Only meaningful when `retry`. */
  delayMs: number;
  reason: string;
}

/**
 * P1-05 — retry classification and backoff (doc 16 §11–§12).
 *
 * The rule that matters most: **the three retry layers must not compound.**
 * BullMQ job retries, this runtime's per-node retry, and a connector's own HTTP
 * retry could otherwise multiply into 27 attempts for one logical call. Only
 * this layer retries business failures — BullMQ `attempts` is pinned to 1 for
 * `wf-node-attempt` and the runtime schedules its own retry as a NEW delayed
 * job, so the attempt count lives in the database where it can be inspected
 * rather than hidden inside Redis.
 */
@Injectable()
export class RetryPolicyService {
  /** Classify an error and decide whether another attempt is worthwhile. */
  classify(
    error: unknown,
    attempt: number,
    maxAttempts = RETRY_MAX_ATTEMPTS,
  ): RetryDecision {
    const failureClass = this.classifyError(error);
    const retryable = this.isRetryable(failureClass);
    const exhausted = attempt >= maxAttempts;

    if (!retryable) {
      return {
        retry: false,
        failureClass,
        delayMs: 0,
        reason: `${failureClass} is not retryable — another attempt cannot change the outcome`,
      };
    }
    if (exhausted) {
      return {
        retry: false,
        failureClass,
        delayMs: 0,
        reason: `attempt ${attempt} of ${maxAttempts} — retries exhausted`,
      };
    }
    return {
      retry: true,
      failureClass,
      delayMs: this.backoffMs(attempt),
      reason: `${failureClass} is transient — retrying attempt ${attempt + 1}/${maxAttempts}`,
    };
  }

  /**
   * Exponential backoff with FULL jitter.
   *
   * Jitter is not cosmetic: without it, every node that failed during one
   * provider outage retries in lockstep and re-DDoSes the provider the moment
   * it recovers.
   */
  backoffMs(attempt: number): number {
    const ceiling = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
    return Math.floor(Math.random() * ceiling);
  }

  /**
   * A retryable class is one where the SAME call might succeed later.
   * Retrying anything else burns the budget on an error that cannot change —
   * and delays the human who needs to fix it.
   */
  isRetryable(failureClass: FailureClass): boolean {
    switch (failureClass) {
      case 'NODE_ERROR':
      case 'CONNECTOR_UNAVAILABLE':
      case 'RATE_LIMITED':
      case 'TIMEOUT':
        return true;
      // `OUTCOME_UNKNOWN` is the one that matters most here: a
      // possibly-completed side effect must never be retried by machinery. Only
      // a human who has checked the provider can decide, and they do it by
      // starting a fresh run.
      case 'VALIDATION_ERROR':
      case 'AUTHORIZATION_DENIED':
      case 'APPROVAL_REJECTED':
      case 'BUDGET_EXCEEDED':
      case 'SUBSCRIPTION_BLOCKED':
      case 'CANCELLED':
      case 'INTERNAL':
      case 'OUTCOME_UNKNOWN':
        return false;
      default:
        return false;
    }
  }

  private classifyError(error: unknown): FailureClass {
    const message =
      error instanceof Error ? error.message : String(error ?? 'unknown');
    const lower = message.toLowerCase();

    // Order matters: the most specific signals first.
    if (lower.includes('quarantined') || lower.includes('connector unavailable')) {
      return 'CONNECTOR_UNAVAILABLE';
    }
    if (lower.includes('rate limit') || lower.includes('429')) {
      return 'RATE_LIMITED';
    }
    if (lower.includes('timed out') || lower.includes('timeout')) {
      return 'TIMEOUT';
    }
    if (lower.includes('budget limit')) {
      return 'BUDGET_EXCEEDED';
    }
    if (lower.includes('subscription is')) {
      return 'SUBSCRIPTION_BLOCKED';
    }
    if (
      lower.includes('unknown skill/tool') ||
      lower.includes('unknown node type') ||
      lower.includes('expected a number')
    ) {
      return 'VALIDATION_ERROR';
    }
    if (lower.includes('forbidden') || lower.includes('not permitted')) {
      return 'AUTHORIZATION_DENIED';
    }
    return 'NODE_ERROR';
  }
}
