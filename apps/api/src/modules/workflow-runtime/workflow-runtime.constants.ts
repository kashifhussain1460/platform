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

/**
 * Build a BullMQ `jobId`.
 *
 * BullMQ 5 REJECTS a custom job id containing `:` — `Job.validateOptions` throws
 * `Custom Id cannot contain :`, because ids are interpolated straight into Redis
 * key names. Every job the durable runtime enqueued used `attempt:<id>` /
 * `advance:<id>:<ts>`, so every single `queue.add` threw and the runtime could
 * not execute one node. It went unnoticed because nothing dispatched to it: the
 * failures landed in the queue's `failed` set with no run attached to notice.
 *
 * Use this rather than hand-building ids, so the separator cannot regress.
 */
export function wfJobId(...parts: (string | number)[]): string {
  return parts.join('-').replace(/:/g, '-');
}

export const WF_ADVANCE_JOB = 'advance';
export const WF_ATTEMPT_JOB = 'attempt';
export const WF_TIMER_SWEEP_JOB = 'timer-sweep';
export const WF_TIMER_SWEEP_SCHEDULER = 'wf-timer-sweep';
/**
 * DORMANT. Nothing enqueues this job and no processor consumes the queue.
 *
 * The compensation STATES are modelled (`COMPENSATING`, `COMPENSATED` in
 * `run-state.ts`) because they are the correct target, but no run can reach
 * them: a failed step leaves every already-completed step exactly as it is —
 * a sent email stays sent. Reading the states and assuming the platform rolls a
 * workflow back is the mistake this comment exists to prevent.
 *
 * Semantics, and what an author should do instead:
 * `docs/ops/runtime-topology.md` §1.
 */
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

/**
 * The per-node timeout actually in force, `WORKFLOW_NODE_TIMEOUT_MS` overriding
 * the default.
 *
 * Read per call rather than captured at import: this constants module is
 * imported before `ConfigModule` has done anything, so a captured value would
 * freeze whatever the environment looked like at import time — the same
 * "configuration says one thing, execution does another" shape as the B1
 * finding.
 *
 * Ops reason to tune it UP: a genuinely slow provider. Reason to tune it DOWN:
 * a test that must prove the bound exists without waiting 30 seconds for it.
 */
export function nodeTimeoutMs(): number {
  const raw = Number(process.env.WORKFLOW_NODE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_NODE_TIMEOUT_MS;
}

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
  /**
   * WAVE 1 — the node that just finished, so the advance is one hop instead of a
   * re-derivation. A HINT ONLY: the reaper and the initial dispatch omit it and
   * the worker recomputes from Postgres, which is what lets a run survive a
   * total Redis loss.
   */
  fromNodeId?: string | null;
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
