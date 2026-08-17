'use client';

import { useMemo } from 'react';
import type { CircuitState, DlqJobDto } from '@vaep/types';
import {
  useConnectorCircuits,
  useDiscardDlqJob,
  useDlqJobs,
  useReplayDlqJob,
} from '../hooks';

const CIRCUIT_TONE: Record<CircuitState, string> = {
  CLOSED: 'bg-green-500/15 text-green-800',
  HALF_OPEN: 'bg-amber-500/15 text-amber-800',
  OPEN: 'bg-red-500/15 text-red-600',
};

const secondaryBtnClass =
  'rounded-lg border border-app-border-strong bg-app-surface px-3.5 py-1.5 text-sm font-medium text-app-ink-2 transition-colors hover:border-app-border-strong hover:bg-app-raised disabled:cursor-not-allowed disabled:opacity-50';
const destructiveBtnClass =
  'rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50';

/** Group failed jobs by queue for display. */
function byQueue(jobs: DlqJobDto[]): Record<string, DlqJobDto[]> {
  return jobs.reduce<Record<string, DlqJobDto[]>>((acc, job) => {
    (acc[job.queue] ??= []).push(job);
    return acc;
  }, {});
}

function JobRow({ job }: { job: DlqJobDto }) {
  const replay = useReplayDlqJob();
  const discard = useDiscardDlqJob();
  const busy = replay.isPending || discard.isPending;

  return (
    <li className="flex items-start justify-between gap-4 border-t border-app-border py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-app-ink">
          {job.name} <span className="text-app-ink-3">#{job.id}</span>
        </p>
        <p className="mt-0.5 truncate text-xs text-red-600" title={job.failedReason ?? ''}>
          {job.failedReason ?? 'Unknown failure'}
        </p>
        <p className="mt-0.5 text-xs text-app-ink-3">
          {job.attemptsMade} attempt(s)
          {job.finishedOn
            ? ` · failed ${new Date(job.finishedOn).toLocaleString()}`
            : ''}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          className={secondaryBtnClass}
          disabled={busy}
          onClick={() => replay.mutate({ queue: job.queue, jobId: job.id })}
        >
          Replay
        </button>
        <button
          className={destructiveBtnClass}
          disabled={busy}
          onClick={() => discard.mutate({ queue: job.queue, jobId: job.id })}
        >
          Discard
        </button>
      </div>
    </li>
  );
}

/**
 * System / DLQ panel (Unit C): failed jobs per queue with Replay/Discard, plus
 * per-connector circuit-breaker states. OWNER/ADMIN only; the queries are
 * company-scoped server-side. Light + read-mostly (15s polling).
 */
export function DlqPanel() {
  const { data: jobs, isLoading, isError, error } = useDlqJobs();
  const { data: circuits } = useConnectorCircuits();
  const grouped = useMemo(() => byQueue(jobs ?? []), [jobs]);
  const queues = Object.keys(grouped);
  const trippedCircuits = (circuits ?? []).filter((c) => c.state !== 'CLOSED');

  return (
    <section className="rounded-2xl border border-app-border bg-app-surface p-6">
      <header className="mb-4">
        <h2 className="text-lg font-semibold text-app-ink">System · Dead-letter queue</h2>
        <p className="mt-1 text-sm text-app-ink-3">
          Failed background jobs that exhausted their retries. Replay after a fix,
          or discard.
        </p>
      </header>

      {isLoading && <p className="text-sm text-app-ink-3">Loading…</p>}
      {isError && (
        <p className="text-sm text-red-600">
          {error?.message ?? 'Could not load the DLQ.'}
        </p>
      )}

      {!isLoading && !isError && queues.length === 0 && (
        <p className="rounded-xl bg-green-500/10 px-3 py-2 text-sm text-green-800">
          No failed jobs — all queues are healthy.
        </p>
      )}

      {queues.map((queue) => (
        <div key={queue} className="mb-4">
          <h3 className="text-sm font-semibold text-app-ink-2">
            {queue} <span className="text-app-ink-3">({grouped[queue].length})</span>
          </h3>
          <ul>
            {grouped[queue].map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </ul>
        </div>
      ))}

      {circuits && circuits.length > 0 && (
        <div className="mt-6 border-t border-app-border pt-4">
          <h3 className="mb-2 text-sm font-semibold text-app-ink-2">
            Connector circuits
          </h3>
          {trippedCircuits.length === 0 ? (
            <p className="text-sm text-app-ink-3">
              All {circuits.length} connector circuit(s) closed (healthy).
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {circuits.map((c) => (
                <li
                  key={c.connectorId}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    CIRCUIT_TONE[c.state]
                  }`}
                >
                  {c.skillKey}: {c.state}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
