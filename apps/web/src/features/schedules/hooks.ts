'use client';

import { useMemo } from 'react';
import type { WorkflowDto, WorkflowRunDto } from '@vaep/types';
import { useAllRuns, useWorkflows } from '@/features/workflows/hooks';
import { describeSchedule, nextRunAt } from '@/features/workflows/schedule';
import { useCurrentCompany } from '@/features/tenant/hooks';

export interface ScheduleRow {
  workflow: WorkflowDto;
  /** "Every Monday · 09:00" */
  summary: string;
  timeZone: string;
  /** Null for a custom cron we deliberately refuse to guess at. */
  nextRun: Date | null;
  lastRun: WorkflowRunDto | null;
  /** Whether the schedule is armed. PAUSED/DRAFT workflows never fire. */
  active: boolean;
}

/**
 * The schedules operations view (UX plan §22).
 *
 * Derived, not fetched: a "schedule" is not a separate entity in this platform —
 * it is a workflow whose trigger is SCHEDULE. Inventing a `/schedules` endpoint
 * would create a second source of truth for the same row and a second place for
 * pause/resume to disagree with the workflow's real status.
 *
 * `lastRun` comes from the same runs list the operations table uses, so the two
 * pages can never show different numbers.
 */
export function useSchedules() {
  const workflows = useWorkflows();
  const runs = useAllRuns({ limit: 200 });
  const { data: company } = useCurrentCompany();

  const timeZone =
    company?.timezone ||
    (typeof Intl !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : 'UTC');

  const rows = useMemo<ScheduleRow[]>(() => {
    const scheduled = (workflows.data ?? []).filter(
      (w) => w.triggerType === 'SCHEDULE' && w.status !== 'ARCHIVED',
    );

    // Runs arrive newest-first, so the first match per workflow is the latest.
    const latestByWorkflow = new Map<string, WorkflowRunDto>();
    for (const run of runs.data ?? []) {
      if (!latestByWorkflow.has(run.workflowId)) {
        latestByWorkflow.set(run.workflowId, run);
      }
    }

    const now = new Date();
    return scheduled.map((workflow) => ({
      workflow,
      summary: describeSchedule(workflow.triggerConfig),
      timeZone,
      // A paused workflow has no next run — showing one would be a lie about
      // what the platform is going to do.
      nextRun:
        workflow.status === 'ACTIVE'
          ? nextRunAt(workflow.triggerConfig, now, timeZone)
          : null,
      lastRun: latestByWorkflow.get(workflow.id) ?? null,
      active: workflow.status === 'ACTIVE',
    }));
  }, [workflows.data, runs.data, timeZone]);

  return {
    rows,
    isLoading: workflows.isLoading,
    isError: workflows.isError,
    error: workflows.error,
  };
}
