/** Name of the BullMQ queue that drives async workflow execution. */
export const WORKFLOW_RUN_QUEUE = 'workflow-run';

/** Job name enqueued when a run is created (existing path). */
export const WORKFLOW_RUN_JOB = 'run';

/**
 * Job name for a scheduled (repeatable) trigger. The job carries a workflowId
 * (not a runId) — the processor creates the WorkflowRun then executes it. Used
 * as the repeatable job name so all SCHEDULE jobs share one handler branch.
 */
export const WORKFLOW_TRIGGER_JOB = 'trigger';

/**
 * Repeatable watchdog job name + scheduler id (registered once at boot via
 * `upsertJobScheduler`, same pattern as ConnectorHealthProcessor). Fires the
 * stuck-run sweep (see WORKFLOW_RUN_STUCK_TIMEOUT_MS below).
 */
export const WORKFLOW_RUN_WATCHDOG_JOB = 'watchdog';
export const WORKFLOW_RUN_WATCHDOG_SCHEDULER = 'workflow-run-watchdog';
export const WORKFLOW_RUN_WATCHDOG_EVERY_MS = 5 * 60_000;

/**
 * A run stuck in PENDING/RUNNING longer than this is presumed orphaned (e.g.
 * the worker process died mid-execution — a BullMQ job lock abandoned by a
 * hard process kill is NOT always reliably requeued/failed by BullMQ's own
 * stalled-job detection, especially across rapid repeated restarts) and is
 * swept to FAILED by the watchdog rather than being left stuck forever with
 * no visible error. Generous relative to a real run's actual duration (single
 * AI_STEP calls take seconds; a full multi-node run well under a minute) so
 * there is no realistic false-positive sweep of a merely-slow run.
 */
export const WORKFLOW_RUN_STUCK_TIMEOUT_MS = 10 * 60_000;

/**
 * Payload of a workflow-run job. Shapes that flow through the SAME queue:
 * - `{ runId }` — an already-created run (MANUAL/EVENT/WEBHOOK enqueue this).
 * - `{ runId, resume: true }` — resume a WAITING run whose APPROVAL was approved;
 *   the engine continues from `WorkflowRun.resumeNodeId` with the saved context.
 * - `{ workflowId, source }` — a scheduled/triggered fire; the processor
 *   creates a run (with that source) then executes it.
 * - `{ watchdog: true }` — the repeatable stuck-run sweep (no run/workflow id).
 */
export type WorkflowRunJobData =
  | {
      runId: string;
      resume?: boolean;
      workflowId?: never;
      source?: never;
      watchdog?: never;
      companyId?: string;
    }
  | {
      workflowId: string;
      source: string;
      runId?: never;
      resume?: never;
      watchdog?: never;
      companyId?: string;
    }
  | {
      watchdog: true;
      runId?: never;
      workflowId?: never;
      resume?: never;
      source?: never;
      companyId?: never;
    };

/**
 * WAVE 1 — what an internal dispatch may carry.
 *
 * Narrower than `WorkflowRunJobData` on purpose: a dispatch always concerns a
 * run that ALREADY EXISTS. Creating the run is `enqueueRun`'s job and nobody
 * else's, so a `{workflowId}` shape is not representable here and cannot be
 * reintroduced by accident.
 */
export interface RunDispatchJob {
  runId: string;
  resume?: boolean;
  companyId?: string;
}

/** Minimum SCHEDULE interval (ms) — guards against runaway repeatable jobs. */
export const MIN_SCHEDULE_MS = 15_000;

/**
 * Slot width used to deduplicate a CRON schedule fire. Cron's finest legal
 * granularity is one minute, so two fires inside the same minute are always a
 * duplicate delivery rather than two legitimate occurrences.
 */
export const CRON_SLOT_MS = 60_000;

/**
 * WAVE 1 — the idempotency key for one SCHEDULE occurrence.
 *
 * A schedule has TWO independent drivers: the BullMQ repeatable (worker
 * deployments) and `/admin/cron/workflow-schedules` (serverless deployments).
 * `addSchedule` refuses to register the repeatable in inline mode precisely
 * because both firing produces two runs per interval — but that guard only
 * holds if the deployment is cleanly one shape or the other. A leftover worker
 * on the same Redis, or a mixed deployment mid-rollout, defeats it, and the
 * result is every scheduled workflow silently running twice.
 *
 * Bucketing the fire time by the schedule's own interval turns that into a
 * database-level no-op: the second fire in the same slot resolves to the same
 * `(companyId, idempotencyKey)` and `enqueueRun` returns the first run.
 * Defence in depth, not a replacement for the inline guard.
 */
export function scheduleSlotKey(
  workflowId: string,
  config: { everyMs?: unknown } | null | undefined,
  nowMs: number,
): string {
  const everyMs = Number(config?.everyMs);
  const width =
    Number.isFinite(everyMs) && everyMs >= MIN_SCHEDULE_MS
      ? everyMs
      : CRON_SLOT_MS;
  return `schedule:${workflowId}:${Math.floor(nowMs / width)}`;
}

/**
 * Hard cap on how many nodes a single run may visit, so a cyclic or malformed
 * graph can never loop forever. The engine stops (FAILED) once exceeded.
 */
export const MAX_WORKFLOW_NODES = 50;

/**
 * Upper bound (ms) a WAIT node may block the in-process worker. Durable /
 * resumable waits via delayed jobs are a TODO; for now WAIT is a bounded sleep.
 */
export const MAX_WAIT_MS = 10_000;

/**
 * Marker placed in a system prompt identifying an AI-workflow-generation
 * request (WorkflowGeneratorService builds it; MockLlmProvider keys off it for
 * deterministic offline output — same contract pattern as employees.constants'
 * PLAN_PROMPT_MARKER).
 */
export const WORKFLOW_GENERATOR_MARKER = '[[VAEP:WORKFLOW_GENERATOR]]';

/** Delimiters wrapping the JSON list of the company's installed skills+tools. */
export const INSTALLED_SKILLS_OPEN = '<<<VAEP_SKILLS';
export const INSTALLED_SKILLS_CLOSE = 'VAEP_SKILLS>>>';

/** Delimiters wrapping the JSON list of the company's hired AI employees. */
export const EMPLOYEES_OPEN = '<<<VAEP_EMPLOYEES';
export const EMPLOYEES_CLOSE = 'VAEP_EMPLOYEES>>>';

/** Max LLM calls per generate() invocation: one attempt + one self-correction. */
export const GENERATION_MAX_ATTEMPTS = 2;

/**
 * Cap on user turns before the AI must return a draft instead of another
 * question (design spec, "User flow" point 3: capped at 3 rounds — after the
 * 3rd user reply, the next response must be a draft, never another question).
 */
export const GENERATION_MAX_QUESTION_ROUNDS = 3;
