import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type ApprovalRequest } from '@prisma/client';
import type {
  ApprovalRequestDto,
  ApprovalRoutingConfig,
  ApprovalStatus,
  RoutingSnapshot,
  ToolCallDto,
} from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import {
  ApprovalRoutingService,
  type DeciderUser,
  type InitialRouting,
} from '../approval-routing/approval-routing.service';
import {
  toolRequiresApproval,
  type ApprovalPolicyEmployee,
} from '../skills/tool-approval-policy';
import { NotificationsService } from '../notifications/notifications.service';
import { SkillsService } from '../skills/skills.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { toApprovalRequestDto } from './approvals.mapper';
import {
  METRIC,
  MetricsRegistry,
} from '../../common/observability/metrics.registry';

/**
 * Re-exported from the shared policy module so there is exactly ONE definition
 * of both the shape and the rule (gap G25).
 */
export type { ApprovalPolicyEmployee };

/** Input to create a PENDING approval request for a proposed tool call. */
export interface CreateApprovalInput {
  companyId: string;
  employeeId?: string | null;
  conversationId?: string | null;
  skillKey: string;
  tool: string;
  args: Record<string, unknown>;
  description?: string;
}

/**
 * Approval Center: decides whether a proposed tool call must pause for human
 * review, captures PENDING requests, and applies a manager's decision (approve /
 * reject / modify). Two kinds of request are decided here:
 * - TOOL (default): a high-risk AI-employee tool call. Approve/modify EXECUTE the
 *   tool via SkillsService.runTool (which writes the SkillExecution audit row);
 *   reject never executes.
 * - WORKFLOW: a workflow run paused at an APPROVAL node. No tool is executed —
 *   approve RESUMES the run (WorkflowsService.resumeRun) and reject FAILS it
 *   (WorkflowsService.cancelRun); modify is treated as approve.
 *
 * Every query is scoped by companyId (from the JWT) so tenants never see each
 * other's data.
 */
/** Plain one-liner for a notification email — prefers the human description. */
function describeApproval(
  description: string | null,
  skillKey?: string | null,
  tool?: string | null,
): string {
  if (description && description.trim()) return description.trim();
  if (skillKey && tool) return `A request to run ${skillKey}.${tool} needs approval.`;
  return 'A request needs your approval.';
}

@Injectable()
export class ApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly skills: SkillsService,
    private readonly workflows: WorkflowsService,
    private readonly routing: ApprovalRoutingService,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
    private readonly metrics: MetricsRegistry,
  ) {}

  /**
   * True when this tool call must pause for approval: the catalog tool is
   * `highRisk`, OR the employee's approvalRules require all tools, OR its
   * `requireApprovalForTools` includes `skillKey` or `skillKey:tool`.
   */
  requiresApproval(
    employee: ApprovalPolicyEmployee,
    skillKey: string,
    tool: string,
  ): boolean {
    // Delegates to the shared policy so the chat path and the workflow engine
    // can never drift apart again (gap G25). Do not re-implement this here.
    return toolRequiresApproval(employee, skillKey, tool);
  }

  /**
   * Create a PENDING approval request capturing a proposed tool call. If the
   * acting employee's approvalRules declare routing (§8.1), the first level is
   * resolved and snapshotted here; otherwise the row is unrouted (chainId = its
   * own id, approverRuleType null → canDecide falls back to OWNER/ADMIN).
   */
  async createRequest(
    input: CreateApprovalInput,
  ): Promise<ApprovalRequestDto> {
    // §8.1.10: a fresh chain's first row must have chainId === its own id, which
    // Prisma's cuid() default doesn't expose pre-insert — generate it explicitly.
    const id = randomUUID();
    const initial = await this.resolveEmployeeRouting(
      input.companyId,
      input.employeeId ?? null,
    );
    const row = await this.prisma.approvalRequest.create({
      data: {
        id,
        chainId: id,
        companyId: input.companyId,
        employeeId: input.employeeId ?? null,
        conversationId: input.conversationId ?? null,
        skillKey: input.skillKey,
        tool: input.tool,
        args: (input.args ?? {}) as Prisma.InputJsonObject,
        description: input.description ?? null,
        status: 'PENDING',
        ...this.initialRoutingData(initial),
      },
    });
    await this.notifications.approvalRequested(input.companyId, {
      assigneeUserId: row.assigneeUserId,
      summary: describeApproval(row.description, input.skillKey, input.tool),
    });
    return toApprovalRequestDto(row);
  }

  async list(
    companyId: string,
    opts: { status?: ApprovalStatus; assignedToMeUserId?: string } = {},
  ): Promise<ApprovalRequestDto[]> {
    const rows = await this.prisma.approvalRequest.findMany({
      where: { companyId, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    const mapped = rows.map(toApprovalRequestDto);
    if (!opts.assignedToMeUserId) return mapped;
    // "My approval inbox": only requests this user is an eligible decider for.
    const decider = await this.loadDecider(companyId, opts.assignedToMeUserId);
    if (!decider) return [];
    return mapped.filter((r) => this.routing.canDecide(decider, r));
  }

  /** Every row of one logical decision (chain), oldest-first (§8.3). */
  async history(companyId: string, id: string): Promise<ApprovalRequestDto[]> {
    const anchor = await this.findOwned(companyId, id);
    const rows = await this.prisma.approvalRequest.findMany({
      where: { companyId, chainId: anchor.chainId },
      orderBy: [{ level: 'asc' }, { escalationTier: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toApprovalRequestDto);
  }

  async get(companyId: string, id: string): Promise<ApprovalRequestDto> {
    return toApprovalRequestDto(await this.findOwned(companyId, id));
  }

  /**
   * Approve. WORKFLOW → mark APPROVED and resume the paused run (no tool runs).
   * TOOL → execute the stored tool call now and record the result.
   */
  async approve(
    companyId: string,
    id: string,
    userId: string,
    note?: string,
  ): Promise<ApprovalRequestDto> {
    const req = await this.assertCanDecide(companyId, id, userId);
    const claimed = await this.claim(companyId, id, 'APPROVED', userId, note);
    // Non-final level: open the next sign-off level and defer the effect (§8.1.4).
    if (await this.tryOpenNextLevel(req)) {
      return toApprovalRequestDto(claimed);
    }
    if (req.kind === 'WORKFLOW') {
      return this.decideWorkflow(req, true, note);
    }
    const call = await this.execute(req);
    return this.finalize(id, call);
  }

  /**
   * Reject → mark REJECTED without executing. WORKFLOW → also FAIL the paused run
   * (WorkflowsService.cancelRun) so it never reaches the steps after the approval.
   */
  async reject(
    companyId: string,
    id: string,
    userId: string,
    note?: string,
  ): Promise<ApprovalRequestDto> {
    const req = await this.assertCanDecide(companyId, id, userId);
    const row = await this.claim(companyId, id, 'REJECTED', userId, note);
    // A reject at ANY level fails the whole chain — never opens a next level.
    if (req.kind === 'WORKFLOW') {
      return this.decideWorkflow(req, false, note);
    }
    return toApprovalRequestDto(row);
  }

  /**
   * Modify. TOOL → execute with the NEW args, record them, mark APPROVED.
   * WORKFLOW → modifying args is meaningless (no tool is gated), so treat it as a
   * plain approve (resume the run).
   */
  async modify(
    companyId: string,
    id: string,
    userId: string,
    args: Record<string, unknown>,
    note?: string,
  ): Promise<ApprovalRequestDto> {
    const req = await this.assertCanDecide(companyId, id, userId);
    const claimed = await this.claim(
      companyId,
      id,
      'APPROVED',
      userId,
      note ?? 'Modified before approval',
    );
    // Only the FINAL level's modify edits args; an earlier level's modify is a
    // plain approve (§8.1.10).
    if (await this.tryOpenNextLevel(req)) {
      return toApprovalRequestDto(claimed);
    }
    if (req.kind === 'WORKFLOW') {
      return this.decideWorkflow(req, true, note);
    }
    const call = await this.execute({ ...req, args: args as Prisma.JsonValue });
    return this.finalize(id, call, { ...args });
  }

  // --- Routing / eligibility (P3-05 §8.1) ----------------------------------

  /**
   * The security-critical gate (§8.1.11): the boundary moved from the removed
   * `@Roles('OWNER','ADMIN')` controller guard to here. Loads the deciding user
   * fresh (the JWT carries role but not department/team) and 403s if `canDecide`
   * fails. MUST run before `claim()` on every decide path.
   */
  private async assertCanDecide(
    companyId: string,
    id: string,
    userId: string,
  ): Promise<ApprovalRequest> {
    const req = await this.findOwned(companyId, id);
    const decider = await this.loadDecider(companyId, userId);
    if (!decider || !this.routing.canDecide(decider, req)) {
      throw new ForbiddenException(
        'You are not an eligible approver for this request',
      );
    }
    return req;
  }

  private async loadDecider(
    companyId: string,
    userId: string,
  ): Promise<DeciderUser | null> {
    return this.prisma.user.findFirst({
      where: { id: userId, companyId },
      select: { id: true, role: true, departmentId: true, teamId: true },
    });
  }

  /**
   * If the just-approved row's chain has a NEXT level, resolve it and create a new
   * PENDING row for it (level+1, tier 0), leaving the run WAITING. Returns true
   * when a next level was opened (caller must NOT run the final effect yet).
   */
  private async tryOpenNextLevel(req: ApprovalRequest): Promise<boolean> {
    const snap = req.routingSnapshot as RoutingSnapshot | null;
    if (!snap?.levels || snap.levels.length <= req.level) return false;
    const nextLevel = snap.levels[req.level]; // 0-based index `level` = the (level+1)-th level
    const resolved = await this.routing.resolveStep(req.companyId, nextLevel, {
      employeeId: req.employeeId,
    });
    const slaMinutes = nextLevel.slaMinutes ?? null;
    await this.prisma.approvalRequest.create({
      data: {
        companyId: req.companyId,
        kind: req.kind,
        employeeId: req.employeeId,
        conversationId: req.conversationId,
        workflowRunId: req.workflowRunId,
        skillKey: req.skillKey,
        tool: req.tool,
        args: (req.args ?? {}) as Prisma.InputJsonObject,
        description: req.description,
        status: 'PENDING',
        chainId: req.chainId,
        level: req.level + 1,
        escalationTier: 0,
        approverRuleType: resolved.approverRuleType,
        approverRuleValue: resolved.approverRuleValue ?? null,
        assigneeUserId: resolved.assigneeUserId ?? null,
        slaMinutes,
        dueAt: slaMinutes ? new Date(Date.now() + slaMinutes * 60_000) : null,
        timeoutPolicy: nextLevel.onTimeout ?? null,
        routingSnapshot: req.routingSnapshot as Prisma.InputJsonValue,
      },
    });
    // The next level's decider now owns the pending request — tell them.
    await this.notifications.approvalRequested(req.companyId, {
      assigneeUserId: resolved.assigneeUserId ?? null,
      summary: describeApproval(req.description, req.skillKey, req.tool),
    });
    return true;
  }

  /** Resolve the first routing level from an employee's approvalRules (TOOL-kind). */
  private async resolveEmployeeRouting(
    companyId: string,
    employeeId: string | null,
  ): Promise<InitialRouting | null> {
    if (!employeeId) return null;
    const employee = await this.prisma.aiEmployee.findFirst({
      where: { id: employeeId, companyId },
      select: { approvalRules: true },
    });
    const routing = (employee?.approvalRules as { routing?: ApprovalRoutingConfig } | null)
      ?.routing;
    return this.routing.resolveInitial(companyId, routing, { employeeId }, new Date());
  }

  /** The row fields for the FIRST level of a chain (or unrouted nulls). */
  private initialRoutingData(
    initial: InitialRouting | null,
  ): Partial<Prisma.ApprovalRequestUncheckedCreateInput> {
    if (!initial) {
      return { level: 1, escalationTier: 0 };
    }
    return {
      level: 1,
      escalationTier: 0,
      approverRuleType: initial.approverRuleType,
      approverRuleValue: initial.approverRuleValue,
      assigneeUserId: initial.assigneeUserId,
      slaMinutes: initial.slaMinutes,
      dueAt: initial.dueAt,
      timeoutPolicy: initial.timeoutPolicy,
      routingSnapshot: initial.snapshot as unknown as Prisma.InputJsonValue,
    };
  }

  // --- Internals -----------------------------------------------------------

  /**
   * Atomically claim a PENDING request by flipping its status — race-safe via a
   * conditional UPDATE (`WHERE status = 'PENDING'`): Postgres row-locks the first
   * writer, and a concurrent second writer's WHERE re-evaluates against the
   * now-committed row and matches zero rows. This is what actually prevents two
   * managers approving+rejecting (or double-approving) the SAME request at once —
   * the previous code only checked status with a separate SELECT (`findPending`)
   * BEFORE executing a tool/resuming a run, which both concurrent calls could
   * pass, leading to a tool executing twice or a run being both resumed and
   * cancelled. Throws ConflictException (same message as before) if the claim
   * is lost.
   */
  private async claim(
    companyId: string,
    id: string,
    status: 'APPROVED' | 'REJECTED',
    userId: string,
    note?: string,
  ): Promise<ApprovalRequest> {
    const result = await this.prisma.approvalRequest.updateMany({
      where: { id, companyId, status: 'PENDING' },
      data: {
        status,
        decidedById: userId,
        decidedAt: new Date(),
        note: note ?? null,
      },
    });
    if (result.count === 0) {
      const existing = await this.findOwned(companyId, id);
      throw new ConflictException(
        `Approval request is already ${existing.status.toLowerCase()}`,
      );
    }
    // WAVE 5 §5.3 — how long a human made the workflow wait. This is the one
    // metric here that measures PEOPLE rather than machines, and it is the one
    // that explains a "slow" automation to a customer: a 4-hour p95 approval
    // wait is not a platform performance problem, and without this metric it
    // looks exactly like one.
    const decided = await this.prisma.approvalRequest.findUnique({
      where: { id },
      select: { createdAt: true, kind: true },
    });
    if (decided) {
      this.metrics.observe(
        METRIC.approvalWaitDuration,
        'Time from approval request to human decision',
        Date.now() - decided.createdAt.getTime(),
        { kind: decided.kind, status },
      );
    }

    // Immutable trail for a money/PII-gating decision (P1-5). Single chokepoint
    // for human approve/reject/modify.
    await this.auditLog.record({
      companyId,
      actorUserId: userId,
      action: status === 'APPROVED' ? 'approval.approved' : 'approval.rejected',
      entityType: 'ApprovalRequest',
      entityId: id,
      metadata: { note: note ?? null },
    });
    return this.prisma.approvalRequest.findUniqueOrThrow({ where: { id } });
  }

  /**
   * Apply a decision to an ALREADY-CLAIMED WORKFLOW-kind request: resume
   * (approve) or cancel (reject) the paused run via WorkflowsService. No tool is
   * executed and no SkillExecution is written.
   */
  private async decideWorkflow(
    req: ApprovalRequest,
    approved: boolean,
    note: string | undefined,
  ): Promise<ApprovalRequestDto> {
    if (req.workflowRunId) {
      if (approved) {
        await this.workflows.resumeRun(req.workflowRunId, req.companyId);
      } else {
        await this.workflows.cancelRun(
          req.workflowRunId,
          note ?? 'Rejected by approver',
          req.companyId,
        );
      }
    }
    const row = await this.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: req.id },
    });
    return toApprovalRequestDto(row);
  }

  /**
   * Run the stored tool call via the Skills module (logs a SkillExecution). Only
   * called for TOOL-kind requests, whose skillKey/tool are always set (they are
   * nullable in the schema only so WORKFLOW-kind rows can omit them).
   */
  private execute(req: ApprovalRequest): Promise<ToolCallDto> {
    return this.skills.runTool(
      {
        companyId: req.companyId,
        employeeId: req.employeeId,
        conversationId: req.conversationId,
      },
      req.skillKey ?? '',
      req.tool ?? '',
      (req.args as Record<string, unknown>) ?? {},
    );
  }

  /**
   * Record the tool result (and optionally new args) on an ALREADY-CLAIMED
   * (status:APPROVED, decidedBy/At/note already set by `claim`) request.
   */
  private async finalize(
    id: string,
    call: ToolCallDto,
    args?: Record<string, unknown>,
  ): Promise<ApprovalRequestDto> {
    const row = await this.prisma.approvalRequest.update({
      where: { id },
      data: {
        result:
          call.result == null
            ? Prisma.JsonNull
            : (call.result as Prisma.InputJsonValue),
        ...(args ? { args: args as Prisma.InputJsonObject } : {}),
      },
    });
    return toApprovalRequestDto(row);
  }

  private async findOwned(
    companyId: string,
    id: string,
  ): Promise<ApprovalRequest> {
    const row = await this.prisma.approvalRequest.findFirst({
      where: { id, companyId },
    });
    if (!row) {
      throw new NotFoundException('Approval request not found');
    }
    return row;
  }

}
