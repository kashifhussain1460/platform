import type { Job } from 'bullmq';
import { runWithContext } from './execution-context';

/**
 * Re-establish the execution context inside a BullMQ worker.
 *
 * `AsyncLocalStorage` does NOT cross a process boundary: a job handler starts
 * with an empty store, so without this every log line, audit entry and metric
 * emitted by a worker is uncorrelated — and the queue hop is exactly where a
 * trace was most needed, because it is the boundary an operator cannot see
 * across by reading one service's logs.
 *
 * Ids are read from the job payload, which producers stamp when they enqueue.
 * A job with no correlation fields still gets a fresh requestId/traceId, so a
 * worker log line is at least groupable by job.
 */
export function runInJobContext<T>(job: Job, fn: () => Promise<T>): Promise<T> {
  const data = (job.data ?? {}) as Record<string, unknown>;
  return runWithContext(
    {
      // The job id makes every line of one job's execution groupable.
      requestId: `job:${job.name}:${job.id ?? 'unknown'}`,
      traceId: str(data.traceId) ?? str(data.correlationId),
      companyId: str(data.companyId),
      workflowId: str(data.workflowId),
      workflowRunId: str(data.runId) ?? str(data.workflowRunId),
      stepRunId: str(data.stepId),
      attemptId: str(data.attemptId),
      correlationId: str(data.correlationId),
    },
    fn,
  );
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
