/**
 * How a workflow run gets EXECUTED once it has been created.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The default (`queue`) enqueues a BullMQ job that a persistent `WorkflowProcessor`
 * consumes. That is the right architecture and stays the default.
 *
 * But on a **serverless-only deployment there is no persistent worker**, and the
 * gate that removes it (`QUEUE_WORKERS_ENABLED=false`) does not stop runs from
 * being created — so every run is enqueued and then sits `PENDING` for ever.
 * `queue-workers.ts` even documents the assumption: *"the persistent worker keeps
 * running on its current host"*. Where no such host exists, that assumption is
 * silently false and the product's core feature does nothing.
 *
 * `inline` closes that: the run is executed directly inside the request that
 * created it. `WorkflowEngine.execute/resume/trigger` are plain methods and the
 * processor is only a thin wrapper around them, so this needs **no engine change
 * at all** — only where the work is dispatched from.
 *
 * ── What you give up (say this out loud, don't bury it) ─────────────────────
 *  - **No retry or durability.** If the process dies mid-run, that run is
 *    orphaned; the watchdog will mark it FAILED but nothing retries it. (Failing
 *    is the right outcome for workflow side effects, which are not safe to
 *    replay — but the automatic recovery goes away.)
 *  - **A wall-clock ceiling per run**, set by the host's function timeout. Long
 *    chains of AI steps, and especially `WAIT`, can exceed it.
 *  - **One invocation is held per running workflow** — a concurrency and cost
 *    profile, not a bug.
 *  - **Queue-level rate limiting and the DLQ do not apply** to inline runs.
 *
 * ── The exit ────────────────────────────────────────────────────────────────
 * This is a stage, not a dead end. Deploy `main.ts` as one small always-on
 * worker with `QUEUE_WORKERS_ENABLED` unset and flip this back to `queue`; no
 * refactor, because the engine never knew the difference.
 */
export type WorkflowExecutionMode = 'queue' | 'inline';

export function workflowExecutionMode(): WorkflowExecutionMode {
  return process.env.WORKFLOW_EXECUTION_MODE === 'inline' ? 'inline' : 'queue';
}

export function isInlineExecution(): boolean {
  return workflowExecutionMode() === 'inline';
}

/**
 * ── On `WAIT` and inline execution ──────────────────────────────────────────
 * A `WAIT` node is an in-process sleep, so inline it spends the REQUEST's budget
 * rather than a worker's — which looks like it needs a tighter cap here.
 *
 * It does not. `MAX_WAIT_MS` (10s, `workflows.constants.ts`) already clamps every
 * WAIT, and 10s is comfortably inside any serverless timeout. An inline-specific
 * cap was written and then removed once measured: it was set ABOVE the existing
 * global cap and therefore did nothing at all.
 *
 * This note exists so the next person doesn't re-add it. If WAIT ever becomes
 * durable (P1-05 timers) the calculus changes — a resumable wait isn't a sleep.
 */
