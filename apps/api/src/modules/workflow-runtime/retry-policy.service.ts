import { Injectable } from '@nestjs/common';
import {
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  RETRY_MAX_ATTEMPTS,
} from './workflow-runtime.constants';
import { InsufficientCreditsError } from '../credits/credit-ledger.service';
import {
  EmployeeBudgetExceededError,
  WorkflowLimitExceededError,
  EmployeeExecutionCeilingExceededError,
  EmployeeTaskCeilingExceededError,
} from '../credits/credit-limits.service';

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
  /** Phase 8 (Enforcement), Task 8.3 — Layer 1: the company's credit balance is exhausted. */
  | 'INSUFFICIENT_CREDITS'
  /** Phase 8, Task 8.3 — Layer 2: this employee's own monthly credit budget is exhausted. */
  | 'EMPLOYEE_BUDGET_EXCEEDED'
  /** Phase 8, Task 8.3 — Layer 3: this workflow run's own configured credit cap is exhausted. */
  | 'WORKFLOW_LIMIT_EXCEEDED'
  /** Kill-critic gap fix (2026-08-20, round 2) — a single execution/task cost more than the employee's own configured ceiling, independent of the monthly budget. */
  | 'EMPLOYEE_EXECUTION_CEILING_EXCEEDED'
  | 'EMPLOYEE_TASK_CEILING_EXCEEDED'
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
      case 'INSUFFICIENT_CREDITS':
      case 'EMPLOYEE_BUDGET_EXCEEDED':
      case 'WORKFLOW_LIMIT_EXCEEDED':
      case 'EMPLOYEE_EXECUTION_CEILING_EXCEEDED':
      case 'EMPLOYEE_TASK_CEILING_EXCEEDED':
        return false;
      default:
        return false;
    }
  }

  private classifyError(error: unknown): FailureClass {
    // Phase 8, Task 8.3 — checked by TYPE, not message text, before the
    // string-matching fallback below: Layer 2's message is deliberately
    // VERBATIM-identical to the pre-existing dollar-based budget check's
    // text (§35.5's "must not be replaced" rule), so a message-substring
    // classifier alone could never tell the two apart. `instanceof` has no
    // such ambiguity.
    if (error instanceof InsufficientCreditsError) return 'INSUFFICIENT_CREDITS';
    if (error instanceof EmployeeBudgetExceededError) return 'EMPLOYEE_BUDGET_EXCEEDED';
    if (error instanceof WorkflowLimitExceededError) return 'WORKFLOW_LIMIT_EXCEEDED';
    if (error instanceof EmployeeExecutionCeilingExceededError) return 'EMPLOYEE_EXECUTION_CEILING_EXCEEDED';
    if (error instanceof EmployeeTaskCeilingExceededError) return 'EMPLOYEE_TASK_CEILING_EXCEEDED';

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
    // Phase 8/13 gap fix — the TOOL_ACTION path (tool-action.handler.ts)
    // re-wraps a runTool() `ok:false` into a plain `Error`, which loses the
    // typed `InsufficientCreditsError`/`WorkflowLimitExceededError` classes
    // the `instanceof` checks above rely on. Layer 2's text happens to match
    // 'budget limit' above by coincidence of reusing the old dollar-check
    // phrasing; Layer 1 and Layer 3 had no matching pattern at all, so both
    // fell through to the default NODE_ERROR (retryable) — meaning a
    // TOOL_ACTION blocked for zero company balance, or for hitting its
    // workflow's credit cap, was retried with backoff instead of failing
    // fast on a condition retrying cannot fix.
    if (lower.includes('run out of credits')) {
      return 'INSUFFICIENT_CREDITS';
    }
    if (lower.includes('configured credit limit')) {
      return 'WORKFLOW_LIMIT_EXCEEDED';
    }
    if (lower.includes('per-execution ceiling')) {
      return 'EMPLOYEE_EXECUTION_CEILING_EXCEEDED';
    }
    if (lower.includes('per-task ceiling')) {
      return 'EMPLOYEE_TASK_CEILING_EXCEEDED';
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
