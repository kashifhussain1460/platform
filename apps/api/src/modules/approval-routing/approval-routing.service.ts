import { Injectable } from '@nestjs/common';
import type {
  ApprovalEscalationStep,
  ApprovalRoutingConfig,
  ApproverRuleType,
  ResolvedAssignee,
  Role,
  RoutingSnapshot,
} from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { roleSatisfies } from '../auth/roles.guard';
import { resolveTemplate } from '../workflows/engine/template';

/** Default cap on runaway escalation chains (doc 08 §8.1.7). */
export const DEFAULT_MAX_ESCALATIONS = 3;

/** A user, as far as `canDecide` needs to know it (loaded fresh from the DB). */
export interface DeciderUser {
  id: string;
  role: Role;
  departmentId: string | null;
  teamId: string | null;
}

/** The routing fields to write onto the FIRST row of a chain (level 1, tier 0). */
export interface InitialRouting {
  approverRuleType: ApproverRuleType | null;
  approverRuleValue: string | null;
  assigneeUserId: string | null;
  slaMinutes: number | null;
  dueAt: Date | null;
  timeoutPolicy: string | null;
  snapshot: RoutingSnapshot;
}

/**
 * The ONLY code that resolves an approval routing rule to a decider (doc 08 §8.1).
 * Lives in its own dependency-light module (PrismaService only) that BOTH
 * WorkflowsModule (engine pauseForApproval) and ApprovalsModule (createRequest /
 * canDecide / chain advance) import — mirroring the LlmModule fork that keeps
 * Approvals→Workflows one-directional/acyclic (§8.1.3).
 */
@Injectable()
export class ApprovalRoutingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * May THIS user decide THIS request? Reuses the exported `roleSatisfies`
   * (OWNER ⊇ ADMIN ⊇ MEMBER) rather than reimplementing the hierarchy. An
   * unrouted (null-rule) request reproduces today's EXACT OWNER/ADMIN rule — this
   * is the security-critical fallback (§8.1.11).
   */
  canDecide(
    user: DeciderUser,
    req: {
      approverRuleType: ApproverRuleType | null;
      approverRuleValue: string | null;
      assigneeUserId: string | null;
    },
  ): boolean {
    if (!req.approverRuleType) {
      return roleSatisfies(user.role, ['ADMIN']); // unrouted legacy path
    }
    switch (req.approverRuleType) {
      case 'ANY_ADMIN':
        return roleSatisfies(user.role, ['ADMIN']);
      case 'ROLE':
        return req.approverRuleValue
          ? roleSatisfies(user.role, [req.approverRuleValue as Role])
          : false;
      case 'USER':
        return !!req.approverRuleValue && user.id === req.approverRuleValue;
      case 'DEPARTMENT':
        return (
          user.departmentId != null &&
          user.departmentId === req.approverRuleValue
        );
      case 'TEAM':
        return user.teamId != null && user.teamId === req.approverRuleValue;
      case 'EMPLOYEE_MANAGER':
        return req.assigneeUserId != null && user.id === req.assigneeUserId;
      default:
        return false;
    }
  }

  /** Resolve one routing/escalation step to a concrete assignee + rule. */
  async resolveStep(
    companyId: string,
    step: ApprovalEscalationStep,
    ctx: { runContext?: Record<string, unknown>; employeeId?: string | null },
  ): Promise<ResolvedAssignee> {
    // A WORKFLOW-kind target may be a {{a.b.c}} template resolved against the run
    // context (§8.1.7). A cross-tenant/unknown id simply never matches canDecide —
    // treated as "nobody qualifies yet", never a throw (§8.1.10).
    const target =
      step.target && ctx.runContext
        ? resolveTemplate(step.target, ctx.runContext) || undefined
        : step.target;

    switch (step.rule) {
      case 'USER':
        return { approverRuleType: 'USER', approverRuleValue: target, assigneeUserId: target };
      case 'ROLE':
        return { approverRuleType: 'ROLE', approverRuleValue: target };
      case 'DEPARTMENT':
        return { approverRuleType: 'DEPARTMENT', approverRuleValue: target };
      case 'TEAM':
        return { approverRuleType: 'TEAM', approverRuleValue: target };
      case 'ANY_ADMIN':
        return { approverRuleType: 'ANY_ADMIN' };
      case 'EMPLOYEE_MANAGER': {
        let managerUserId: string | undefined;
        if (ctx.employeeId) {
          const employee = await this.prisma.aiEmployee.findFirst({
            where: { id: ctx.employeeId, companyId },
            select: { managerUserId: true },
          });
          managerUserId = employee?.managerUserId ?? undefined;
        }
        return { approverRuleType: 'EMPLOYEE_MANAGER', assigneeUserId: managerUserId };
      }
      default:
        return { approverRuleType: 'ANY_ADMIN' };
    }
  }

  /** Snapshot a routing config (fills the two chain-wide defaults) for storage. */
  snapshot(routing: ApprovalRoutingConfig): RoutingSnapshot {
    return {
      levels: routing.levels,
      maxEscalations: routing.maxEscalations ?? DEFAULT_MAX_ESCALATIONS,
      defaultOnTimeout: routing.defaultOnTimeout ?? 'NONE',
    };
  }

  /**
   * Resolve the FIRST level of a routing config into the row fields + snapshot to
   * persist. Returns null when there are no levels (caller falls back to the exact
   * unrouted behaviour). Shared by the engine (WORKFLOW-kind) and createRequest
   * (TOOL-kind) so the two never drift.
   */
  async resolveInitial(
    companyId: string,
    routing: ApprovalRoutingConfig | undefined,
    ctx: { runContext?: Record<string, unknown>; employeeId?: string | null },
    now: Date,
  ): Promise<InitialRouting | null> {
    if (!routing?.levels?.length) return null;
    const level = routing.levels[0];
    const resolved = await this.resolveStep(companyId, level, ctx);
    return {
      approverRuleType: resolved.approverRuleType,
      approverRuleValue: resolved.approverRuleValue ?? null,
      assigneeUserId: resolved.assigneeUserId ?? null,
      slaMinutes: level.slaMinutes ?? null,
      dueAt: level.slaMinutes
        ? new Date(now.getTime() + level.slaMinutes * 60_000)
        : null,
      timeoutPolicy: level.onTimeout ?? null,
      snapshot: this.snapshot(routing),
    };
  }
}
