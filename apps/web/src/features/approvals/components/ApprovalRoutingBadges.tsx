'use client';

import { AlarmClock, ArrowUpRight, Layers, UserCheck } from 'lucide-react';
import type { ApprovalRequestDto, ApproverRuleType } from '@vaep/types';
import { useDepartments, useTeams } from '@/features/organization/hooks';
import { useUsers } from '@/features/users/hooks';

/**
 * What the routing engine decided about THIS request, shown to the approver.
 *
 * The routing fields have been on `ApprovalRequestDto` since Wave P3-05 —
 * `approverRuleType`, `approverRuleValue`, `assigneeUserId`, `level`, `dueAt`,
 * `escalationTier`, `autoDecided` — and the queue rendered none of them. So a
 * routed approval was indistinguishable from an unrouted one, and a customer
 * who configured "the department head signs off first" had no way to see it had
 * worked.
 *
 * Deliberately read-only. Re-routing a request that is already pending is a
 * different feature with its own authorization question; this only reports.
 */

/** Human phrasing for a rule + its target, matching the builder's wording. */
function describeRule(
  rule: ApproverRuleType,
  target: string | null,
  assigneeName: string | null,
  targetName: string | null,
): string {
  switch (rule) {
    case 'ANY_ADMIN':
      return 'Any owner or admin';
    case 'USER':
      return assigneeName ?? targetName ?? 'A specific person';
    case 'ROLE':
      return target ? `Anyone with the ${target.toLowerCase()} role` : 'Anyone with a role';
    case 'DEPARTMENT':
      return targetName ? `${targetName} department` : 'A department';
    case 'TEAM':
      return targetName ? `${targetName} team` : 'A team';
    case 'EMPLOYEE_MANAGER':
      return assigneeName
        ? `${assigneeName} (the AI Employee's manager)`
        : "The AI Employee's manager";
    default:
      return 'Assigned';
  }
}

/** "in 3 hours" / "2 hours overdue" — a due date only matters relative to now. */
function describeDue(dueAt: string): { text: string; overdue: boolean } {
  const ms = new Date(dueAt).getTime() - Date.now();
  const overdue = ms < 0;
  const mins = Math.round(Math.abs(ms) / 60_000);
  const amount =
    mins < 60
      ? `${mins} min`
      : mins < 60 * 48
        ? `${Math.round(mins / 60)} hr`
        : `${Math.round(mins / 1440)} days`;
  return { text: overdue ? `${amount} overdue` : `due in ${amount}`, overdue };
}

const badgeCls =
  'inline-flex items-center gap-1 rounded-full bg-app-raised px-2 py-0.5 text-xs font-medium text-app-ink-2';

export function ApprovalRoutingBadges({ request }: { request: ApprovalRequestDto }) {
  const { data: users } = useUsers();
  const { data: departments } = useDepartments();
  const { data: teams } = useTeams();

  // An UNROUTED request is the historical default, not a misconfiguration: any
  // owner or admin decides it. Saying nothing is the right amount of noise.
  if (!request.approverRuleType) return null;

  const assigneeName =
    users?.find((u) => u.id === request.assigneeUserId)?.name ?? null;
  const targetName =
    request.approverRuleType === 'DEPARTMENT'
      ? departments?.find((d) => d.id === request.approverRuleValue)?.name ?? null
      : request.approverRuleType === 'TEAM'
        ? teams?.find((t) => t.id === request.approverRuleValue)?.name ?? null
        : request.approverRuleType === 'USER'
          ? users?.find((u) => u.id === request.approverRuleValue)?.name ?? null
          : null;

  const due = request.dueAt ? describeDue(request.dueAt) : null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className={badgeCls}>
        <UserCheck className="h-3 w-3" />
        {describeRule(
          request.approverRuleType,
          request.approverRuleValue,
          assigneeName,
          targetName,
        )}
      </span>

      {/* Only meaningful in a multi-level chain; "Sign-off 1" alone is noise. */}
      {request.level > 1 && (
        <span className={badgeCls}>
          <Layers className="h-3 w-3" />
          Sign-off {request.level}
        </span>
      )}

      {request.escalationTier > 0 && (
        <span className="inline-flex items-center gap-1 rounded-full bg-status-warning/15 px-2 py-0.5 text-xs font-medium text-sl-warning">
          <ArrowUpRight className="h-3 w-3" />
          Escalated {request.escalationTier === 1 ? 'once' : `${request.escalationTier} times`}
        </span>
      )}

      {due && request.status === 'PENDING' && (
        <span
          className={
            due.overdue
              ? 'inline-flex items-center gap-1 rounded-full bg-status-failed/15 px-2 py-0.5 text-xs font-medium text-sl-failed'
              : badgeCls
          }
        >
          <AlarmClock className="h-3 w-3" />
          {due.text}
        </span>
      )}

      {/* The one case an approver MUST be able to see after the fact: nobody
          decided this, a timeout policy did. */}
      {request.autoDecided && (
        <span className="inline-flex items-center gap-1 rounded-full bg-status-warning/15 px-2 py-0.5 text-xs font-medium text-sl-warning">
          Decided automatically by the time limit
        </span>
      )}
    </div>
  );
}
