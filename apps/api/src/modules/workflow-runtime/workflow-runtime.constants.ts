/**
 * P1-04…P1-07 — the durable runtime's queues and tuning (doc 16 §18).
 *
 * Five queues, split so that a cheap idempotent DECISION is never coupled to an
 * expensive, possibly-irreversible ATTEMPT. Collapsing them would make every
 * retry of the decision risk re-running the side effect.
 */

export const WF_RUN_ADVANCE_QUEUE = 'wf-run-advance';
export const WF_NODE_ATTEMPT_QUEUE = 'wf-node-attempt';
export const WF_TIMER_QUEUE = 'wf-timer';
export const WF_COMPENSATE_QUEUE = 'wf-compensate';
export const WF_DLQ_QUEUE = 'wf-dlq';

/** Every runtime queue, for DLQ registration (ledger R7 — one admin surface). */
export const WORKFLOW_RUNTIME_QUEUES = [
  WF_RUN_ADVANCE_QUEUE,
  WF_NODE_ATTEMPT_QUEUE,
  WF_TIMER_QUEUE,
  WF_COMPENSATE_QUEUE,
  WF_DLQ_QUEUE,
] as const;

export const WF_ADVANCE_JOB = 'advance';
export const WF_ATTEMPT_JOB = 'attempt';
export const WF_TIMER_SWEEP_JOB = 'timer-sweep';
export const WF_TIMER_SWEEP_SCHEDULER = 'wf-timer-sweep';
export const WF_COMPENSATE_JOB = 'compensate';

/**
 * Reaper cadence. 60s keeps orphan recovery inside doc 00 §0.8's <60s target
 * once combined with the 60s lease TTL.
 */
export const WF_TIMER_SWEEP_EVERY_MS = 60_000;

/** A run with no live attempt and no queued advance for this long is stuck. */
export const WF_STUCK_RUN_AFTER_MS = 5 * 60_000;

/** Default per-node execution timeout (doc 16 §6.6). */
export const DEFAULT_NODE_TIMEOUT_MS = 30_000;

/** Retry defaults (doc 16 §12). Full jitter; nodes may override maxAttempts. */
export const RETRY_BASE_MS = 1_000;
export const RETRY_CAP_MS = 300_000;
export const RETRY_MAX_ATTEMPTS = 3;

/** Per-company in-flight attempt cap — per-tenant fairness (doc 16 §14). */
export const MAX_INFLIGHT_ATTEMPTS_PER_COMPANY = 50;

/** Cap on a node's persisted output; oversized payloads are a common OOM. */
export const MAX_NODE_OUTPUT_BYTES = 256 * 1024;

export interface AdvanceJobData {
  runId: string;
  companyId: string;
}

export interface NodeAttemptJobData {
  runId: string;
  companyId: string;
  stepId: string;
  attemptId: string;
  nodeId: string;
  attempt: number;
}

export interface CompensateJobData {
  runId: string;
  companyId: string;
  reason: string;
}
