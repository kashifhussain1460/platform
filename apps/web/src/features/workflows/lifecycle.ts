import type { WorkflowDto, WorkflowRunStatus, WorkflowStatus } from '@vaep/types';

/**
 * USER-FACING state vocabulary (UX plan §15, §45, §46, §47).
 *
 * The backend keeps every lifecycle state it needs. The customer sees four:
 * Draft, Active, Paused, Archived. `VALIDATING`/`PUBLISHED` are internal
 * moments, not places a workflow lives — a published-but-inactive workflow is
 * still, from the operator's point of view, a draft that hasn't gone live.
 *
 * RUN states are the opposite case and are deliberately NOT collapsed (§46):
 * hiding "Waiting for approval" behind "Running" would make the platform lie
 * about what it is doing. Only the wording changes.
 */

export type StateTone = 'neutral' | 'good' | 'warn' | 'bad' | 'muted';

export interface StateLabel {
  label: string;
  tone: StateTone;
}

/** The four states a workflow list shows. */
export function workflowStateLabel(
  workflow: Pick<WorkflowDto, 'status'>,
): StateLabel {
  return workflowStatusLabel(workflow.status);
}

export function workflowStatusLabel(status: WorkflowStatus): StateLabel {
  switch (status) {
    case 'ACTIVE':
      return { label: 'Active', tone: 'good' };
    case 'PAUSED':
      return { label: 'Paused', tone: 'warn' };
    case 'ARCHIVED':
      return { label: 'Archived', tone: 'muted' };
    default:
      return { label: 'Draft', tone: 'neutral' };
  }
}

/** Every run state, in plain language. Nothing is hidden or merged. */
export function runStateLabel(status: WorkflowRunStatus): StateLabel {
  switch (status) {
    case 'PENDING':
      return { label: 'Queued', tone: 'neutral' };
    case 'RUNNING':
      return { label: 'Running', tone: 'neutral' };
    case 'WAITING':
      return { label: 'Waiting for approval', tone: 'warn' };
    case 'COMPENSATING':
      return { label: 'Undoing changes', tone: 'warn' };
    case 'COMPLETED':
      return { label: 'Completed', tone: 'good' };
    case 'FAILED':
      return { label: 'Failed', tone: 'bad' };
    case 'CANCELLED':
      return { label: 'Cancelled', tone: 'muted' };
    case 'TIMED_OUT':
      return { label: 'Timed out', tone: 'bad' };
    default:
      return { label: status, tone: 'neutral' };
  }
}

/** A run that is still going — drives polling and the "Running" counters. */
export function isRunInFlight(status: WorkflowRunStatus): boolean {
  return (
    status === 'PENDING' ||
    status === 'RUNNING' ||
    status === 'WAITING' ||
    status === 'COMPENSATING'
  );
}

/**
 * What the operator should DO about a failure (UX plan §28). Derived from the
 * engine's coarse `failureClass` — deliberately a small map with an honest
 * fallback, because inventing a confident recommendation for a class we don't
 * recognise is worse than saying "open the run and read the error".
 */
export function failureAdvice(failureClass: string | null): {
  impact: string;
  recommendation: string;
  action: { label: string; href: string } | null;
} {
  switch (failureClass) {
    case 'AUTHORIZATION_DENIED':
      return {
        impact: 'The step was refused, so nothing was sent or changed.',
        recommendation:
          'The connected account no longer has permission. Reconnect the skill, then run it again.',
        action: { label: 'Open skills', href: '/skills' },
      };
    case 'TIMEOUT':
      return {
        impact:
          'The step ran out of time. It may or may not have finished on the other side — check before retrying.',
        recommendation:
          'If the action did not happen, start a new run. If it did, leave it.',
        action: null,
      };
    case 'PROVIDER_ERROR':
      return {
        impact: 'The outside service rejected the request, so it did not complete.',
        recommendation:
          'This is usually temporary. Try again in a few minutes, or check that service’s status.',
        action: null,
      };
    case 'BUDGET_EXCEEDED':
      return {
        impact: 'The run stopped before finishing because a spending limit was hit.',
        recommendation: 'Raise the limit or wait for the next billing period.',
        action: { label: 'Open billing', href: '/billing' },
      };
    case 'APPROVAL_REJECTED':
      return {
        impact: 'Someone rejected the approval, so the remaining steps did not run.',
        recommendation:
          'Nothing is broken. Change the workflow or ask the approver, then start a new run.',
        action: { label: 'Open approvals', href: '/approvals' },
      };
    default:
      return {
        impact: 'The steps after the failing one did not run.',
        recommendation:
          'Open the failing step below to read what the platform reported, fix it, then start a new run.',
        action: null,
      };
  }
}

/** How the run was started, in words. */
export function triggerSourceLabel(source: string): string {
  switch (source) {
    case 'SCHEDULE':
      return 'Schedule';
    case 'WEBHOOK':
      return 'Webhook';
    case 'EVENT':
      return 'Event';
    case 'MANUAL':
      return 'Manual';
    default:
      return source;
  }
}
