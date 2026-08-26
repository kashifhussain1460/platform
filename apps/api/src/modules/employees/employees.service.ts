import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type AiEmployee, type Conversation } from '@prisma/client';
import type {
  AiEmployeeDto,
  ConversationDto,
  EmployeeDependenciesDto,
  MessageDto,
  RunResultDto,
} from '@vaep/types';
import { AuditLogService } from '../audit/audit-log.service';
import { AuthorizationService } from '../authorization/authorization.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { clampLimit } from '../../common/pagination';
import { UsageService, startOfCurrentMonthUtc } from '../usage/usage.service';
import { BillingService } from '../billing/billing.service';
import { maxEmployeesFor } from '../billing/billing.plans';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import {
  toConversationDto,
  toEmployeeDto,
  toMessageDto,
} from './employees.mapper';
import { AgentRuntimeService } from './runtime/agent-runtime.service';

/** Human-readable subscription-status reason shown when a hire is blocked. */
function statusReason(status: string): string {
  return status.replace('_', ' ').toLowerCase();
}

/**
 * Tenant-scoped CRUD for AI employees + their conversations, plus the message
 * entrypoint that drives the AgentRuntimeService. Every query is scoped by
 * companyId (from the JWT) so tenants never see each other's data.
 */
@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: AgentRuntimeService,
    private readonly billing: BillingService,
    private readonly usage: UsageService,
    // WAVE 2 §2.2 — the single authorization layer (global leaf module).
    private readonly authz: AuthorizationService,
    // Phase 1 — archive/hard-delete are audited separately, like the workflow
    // equivalents. AuditLogService is provided by the global AuditModule.
    private readonly audit: AuditLogService,
  ) {}

  // --- Employees -----------------------------------------------------------

  /**
   * Hiring is gated by the company's subscription (docs/specs/hiring-and-
   * subscription-linkage.md): a non-ACTIVE subscription (PAST_DUE/CANCELLED)
   * blocks new hires outright, and the plan's employee seat limit is enforced
   * against ACTIVE+PAUSED employees (DISABLED ones don't hold a seat, so
   * retiring one frees it up). A downgrade that leaves a company already over
   * its new limit is "grandfathered" — existing employees keep running, this
   * check just blocks the NEXT hire until the count is back at/under the
   * limit. The seat-count check + insert run inside one transaction, serialized
   * per-company by a Postgres advisory lock, so two concurrent hire requests
   * can't both slip past a soon-to-be-exceeded limit (a plain count-then-create
   * has exactly that race).
   */
  async create(
    companyId: string,
    dto: CreateEmployeeDto,
  ): Promise<AiEmployeeDto> {
    const subscription = await this.billing.getSubscription(companyId);
    if (subscription.status !== 'ACTIVE') {
      throw new ForbiddenException(
        `Your subscription is ${statusReason(subscription.status)} — resolve billing before hiring another AI employee.`,
      );
    }
    const maxEmployees = maxEmployeesFor(subscription.plan);

    const employee = await this.prisma.$transaction(async (tx) => {
      // Advisory lock scoped to this transaction (auto-released on commit/
      // rollback) — serializes concurrent hires for THIS company only.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${companyId}))`;

      if (maxEmployees !== null) {
        const seatCount = await tx.aiEmployee.count({
          where: { companyId, status: { in: ['ACTIVE', 'PAUSED'] } },
        });
        if (seatCount >= maxEmployees) {
          throw new ForbiddenException(
            `Your ${subscription.plan} plan allows up to ${maxEmployees} AI employees. Upgrade your plan or disable an existing employee to hire another.`,
          );
        }
      }

      return tx.aiEmployee.create({
        data: {
          companyId,
          name: dto.name,
          role: dto.role,
          persona: dto.persona ?? null,
          model: dto.model ?? null,
        },
      });
    });
    return toEmployeeDto(employee);
  }

  async list(
    companyId: string,
    limitRaw?: unknown,
    actorUserId?: string,
  ): Promise<AiEmployeeDto[]> {
    const employees = await this.prisma.aiEmployee.findMany({
      // Archived = deleted from the customer's point of view. The row survives
      // so history, credentials and audit rows survive with it, but it leaves
      // the roster — otherwise "delete" visibly does nothing.
      where: { companyId, archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: clampLimit(limitRaw),
    });

    // WAVE 2 §2.1 — an AI Employee's department axis is its `role` (HR,
    // MARKETING, …), the same axis knowledge is already scoped by. Filtering the
    // list matters as much as guarding the detail read: the roster itself tells
    // a Marketing admin what HR automation exists.
    const actor = await this.authz.actorById(companyId, actorUserId);
    const visible = actor
      ? await this.authz.filter(actor, 'employee:read', employees, (e) => ({
          type: 'employee' as const,
          companyId,
          id: e.id,
          scope: e.role,
        }))
      : employees;
    return visible.map(toEmployeeDto);
  }

  async get(
    companyId: string,
    id: string,
    actorUserId?: string,
  ): Promise<AiEmployeeDto> {
    const employee = await this.findOwnedEmployee(companyId, id);
    await this.assertEmployeeScope(
      companyId,
      actorUserId,
      employee,
      'employee:read',
    );
    const monthToDateCostUsd =
      employee.budgetLimit != null
        ? await this.usage.totalCostForEmployee(
            companyId,
            id,
            startOfCurrentMonthUtc(),
          )
        : null;
    return toEmployeeDto(employee, monthToDateCostUsd);
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateEmployeeDto,
  ): Promise<AiEmployeeDto> {
    await this.findOwnedEmployee(companyId, id);
    const employee = await this.prisma.aiEmployee.update({
      where: { id },
      data: {
        name: dto.name,
        status: dto.status,
        persona: dto.persona,
        model: dto.model,
        // Rich configuration (Step 5). TODO: budgetLimit / permissions /
        // approvalRules are persisted here but enforced by a future Approval Center.
        department: dto.department,
        managerName: dto.managerName,
        workingHoursStart: dto.workingHoursStart,
        workingHoursEnd: dto.workingHoursEnd,
        timezone: dto.timezone,
        language: dto.language,
        knowledgeAccess: dto.knowledgeAccess,
        budgetLimit: dto.budgetLimit,
        maxCreditsPerExecution: dto.maxCreditsPerExecution,
        maxCreditsPerTask: dto.maxCreditsPerTask,
        permissions:
          dto.permissions === undefined
            ? undefined
            : (dto.permissions as Prisma.InputJsonValue),
        approvalRules:
          dto.approvalRules === undefined
            ? undefined
            : (dto.approvalRules as Prisma.InputJsonValue),
        // Goals + KPI targets (P1 #6). goals is a string[]; kpiTargets is an
        // object that can be cleared with an explicit null (→ Prisma.JsonNull).
        goals:
          dto.goals === undefined
            ? undefined
            : (dto.goals as Prisma.InputJsonValue),
        kpiTargets:
          dto.kpiTargets === undefined
            ? undefined
            : dto.kpiTargets === null
              ? Prisma.JsonNull
              : (dto.kpiTargets as Prisma.InputJsonValue),
      },
    });
    return toEmployeeDto(employee);
  }

  /**
   * What deleting this employee would take with it.
   *
   * Read-only, and returned to the caller BEFORE anything is destroyed — the
   * workflow delete flow's "409 that names the blocker" idea, generalised so a
   * hard delete is an informed choice rather than a surprise.
   */
  async dependencies(
    companyId: string,
    id: string,
  ): Promise<EmployeeDependenciesDto> {
    const employee = await this.findOwnedEmployee(companyId, id);
    const [
      ownedConnections,
      conversations,
      memories,
      skillGrants,
      skillExecutions,
      approvalRequests,
      pendingApprovals,
      referencing,
    ] = await Promise.all([
      this.prisma.installedSkill.count({ where: { companyId, employeeId: id } }),
      this.prisma.conversation.count({ where: { companyId, employeeId: id } }),
      this.prisma.employeeMemory.count({ where: { companyId, employeeId: id } }),
      this.prisma.employeeSkill.count({ where: { companyId, employeeId: id } }),
      this.prisma.skillExecution.count({ where: { companyId, employeeId: id } }),
      this.prisma.approvalRequest.count({ where: { companyId, employeeId: id } }),
      this.prisma.approvalRequest.count({
        where: { companyId, employeeId: id, status: 'PENDING' },
      }),
      this.workflowsReferencing(companyId, id),
    ]);

    const inFlightRuns =
      referencing.length === 0
        ? 0
        : await this.prisma.workflowRun.count({
            where: {
              companyId,
              workflowId: { in: referencing },
              status: { in: ['PENDING', 'RUNNING', 'WAITING'] },
            },
          });

    return {
      employeeId: id,
      name: employee.name,
      ownedConnections,
      conversations,
      memories,
      skillGrants,
      skillExecutions,
      approvalRequests,
      pendingApprovals,
      referencingWorkflows: referencing.length,
      inFlightRuns,
    };
  }

  /**
   * Ids of this tenant's workflows whose graph names this employee.
   *
   * Matched on the serialized definition rather than a join, because there is
   * no `WorkflowNode` table — `employeeId` lives inside the `definition` JSON
   * (`AI_EMPLOYEE_STEP`/`AI_STEP`/`TOOL_ACTION`/`RETRIEVE` node configs). A
   * substring match on a cuid is precise enough to be useful and is only ever
   * used to WARN or BLOCK, never to widen anything.
   */
  private async workflowsReferencing(
    companyId: string,
    employeeId: string,
  ): Promise<string[]> {
    const rows = await this.prisma.workflow.findMany({
      where: {
        companyId,
        // Archived workflows can't run, so they can't be broken by this.
        archivedAt: null,
        definition: { string_contains: employeeId },
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Delete an AI employee.
   *
   * ## Why this is not `prisma.aiEmployee.delete()` any more
   *
   * It used to be exactly that, with one comment ("cascades to conversations,
   * messages and memories") that undersold what it did. The real blast radius,
   * from the schema's own `onDelete: Cascade` edges:
   *
   *   - `InstalledSkill` — the employee's PER-EMPLOYEE skill connections, i.e.
   *     their **encrypted OAuth credentials**, silently destroyed.
   *   - `Conversation` → `Message` — every chat transcript.
   *   - `EmployeeMemory`, `EmployeeFeedback` — everything the employee learned.
   *   - `EmployeeSkill` — the grant records an auditor would need to answer
   *     "what was this employee allowed to do in Q1?".
   *
   * plus the loose references with no FK at all (`SkillExecution.employeeId`,
   * `ApprovalRequest.employeeId`, `EmployeeCreditPeriodCounter.employeeId`,
   * and `employeeId` inside workflow node configs), which were left dangling.
   *
   * This is the same defect class as G29 (workflow delete destroying run
   * history) and gets the same, already-proven answer: **archive by default,
   * `?hard=true` for a genuine erasure**, blocked on live dependencies and
   * audited separately.
   */
  async remove(
    companyId: string,
    id: string,
    actorUserId?: string,
    opts: { hard?: boolean } = {},
  ): Promise<void> {
    const existing = await this.findOwnedEmployee(companyId, id);
    const deps = await this.dependencies(companyId, id);

    // Blocks BOTH paths: archiving an employee whose workflow is mid-run would
    // strand that run just as surely as deleting it.
    if (deps.inFlightRuns > 0) {
      throw new ConflictException(
        `Cannot delete "${existing.name}": ${deps.inFlightRuns} workflow run(s) that use it ` +
          'are still in flight. Wait for them to finish or cancel them first.',
      );
    }
    if (deps.pendingApprovals > 0) {
      throw new ConflictException(
        `Cannot delete "${existing.name}": ${deps.pendingApprovals} approval request(s) raised by ` +
          'it are still awaiting a decision. Approve or reject them first.',
      );
    }

    if (opts.hard) {
      await this.prisma.aiEmployee.delete({ where: { id } });
      this.logger.warn(
        `employee.hard_delete employee=${id} company=${companyId} actor=${actorUserId ?? 'unknown'} ` +
          `name="${existing.name}" — destroyed ${deps.conversations} conversation(s), ` +
          `${deps.memories} memory/ies, ${deps.skillGrants} skill grant(s) and ` +
          `${deps.ownedConnections} stored connection(s)`,
      );
      await this.audit.record({
        companyId,
        actorUserId,
        action: 'employee.hard_delete',
        entityType: 'AiEmployee',
        entityId: id,
        metadata: { name: existing.name, destroyed: { ...deps }, historyDestroyed: true },
      });
      return;
    }

    if (existing.archivedAt) {
      // Idempotent: DELETE must be safe to repeat.
      return;
    }

    // DISABLED (not PAUSED): a disabled employee is already refused by the chat
    // runtime and does not hold a plan seat, which is exactly the semantics an
    // archived employee needs. `archivedAt` is what distinguishes "retired by
    // an admin" from "deleted", so the roster can hide the latter.
    await this.prisma.aiEmployee.update({
      where: { id },
      data: { status: 'DISABLED', archivedAt: new Date() },
    });
    this.logger.log(
      `employee.archive employee=${id} company=${companyId} actor=${actorUserId ?? 'unknown'} ` +
        `name="${existing.name}" (history, credentials and audit rows retained)`,
    );
    await this.audit.record({
      companyId,
      actorUserId,
      action: 'employee.archive',
      entityType: 'AiEmployee',
      entityId: id,
      metadata: { name: existing.name, previousStatus: existing.status, retained: { ...deps } },
    });
  }

  // --- Conversations -------------------------------------------------------

  async startConversation(
    companyId: string,
    employeeId: string,
    title?: string,
  ): Promise<ConversationDto> {
    await this.findOwnedEmployee(companyId, employeeId);
    const conversation = await this.prisma.conversation.create({
      data: { companyId, employeeId, title: title ?? null },
    });
    return toConversationDto(conversation);
  }

  async listConversations(
    companyId: string,
    employeeId: string,
    limitRaw?: unknown,
  ): Promise<ConversationDto[]> {
    await this.findOwnedEmployee(companyId, employeeId);
    const conversations = await this.prisma.conversation.findMany({
      where: { companyId, employeeId },
      orderBy: { createdAt: 'desc' },
      take: clampLimit(limitRaw),
    });
    return conversations.map(toConversationDto);
  }

  // --- Messages ------------------------------------------------------------

  async listMessages(
    companyId: string,
    conversationId: string,
    limitRaw?: unknown,
  ): Promise<MessageDto[]> {
    await this.findOwnedConversation(companyId, conversationId);
    // Chat history reads chronologically (oldest first), so capping this
    // directly with `take` on an ascending order would return the OLDEST
    // messages, not the most recent ones a user actually wants when a
    // conversation exceeds the cap. Fetch the most recent N by ordering
    // DESC + take, then reverse back to chronological order -- identical
    // output to before for any conversation under the cap.
    const messages = await this.prisma.message.findMany({
      where: { companyId, conversationId },
      orderBy: { createdAt: 'desc' },
      take: clampLimit(limitRaw),
    });
    return messages.reverse().map(toMessageDto);
  }

  /** Run one agent turn: persists the user + assistant messages, returns the result. */
  async sendMessage(
    companyId: string,
    conversationId: string,
    content: string,
    idempotencyKey?: string | null,
  ): Promise<RunResultDto> {
    const conversation = await this.findOwnedConversation(
      companyId,
      conversationId,
    );
    const employee = await this.prisma.aiEmployee.findFirst({
      where: { id: conversation.employeeId, companyId },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }
    // Runtime throws 409 (ConflictException) if the employee is PAUSED/DISABLED.
    // Chat runs the full tool loop, so an external-action tool (send/egress) is
    // routed to a human approval rather than executed autonomously — the message
    // may carry untrusted pasted content (a CV/email) with an injected
    // instruction. Read-only tools still run autonomously.
    return this.runtime.run(employee, conversation, content, {
      forceApprovalForExternalActions: true,
      idempotencyKey: idempotencyKey ?? undefined,
    });
  }

  // --- Ownership helpers ---------------------------------------------------

  private async findOwnedEmployee(
    companyId: string,
    id: string,
  ): Promise<AiEmployee> {
    const employee = await this.prisma.aiEmployee.findFirst({
      where: { id, companyId },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }
    return employee;
  }

  /**
   * Department-scope a loaded employee (WAVE 2 §2.1).
   *
   * `actorUserId` absent means a machine caller (the workflow engine acting as
   * an employee, an onboarding installer) authorized at its own entry point.
   */
  private async assertEmployeeScope(
    companyId: string,
    actorUserId: string | undefined,
    employee: AiEmployee,
    action: 'employee:read' | 'employee:manage',
  ): Promise<void> {
    const actor = await this.authz.actorById(companyId, actorUserId);
    if (!actor) return;
    await this.authz.assert(actor, action, {
      type: 'employee',
      companyId,
      id: employee.id,
      scope: employee.role,
    });
  }

  private async findOwnedConversation(
    companyId: string,
    id: string,
  ): Promise<Conversation> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id, companyId },
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    return conversation;
  }
}
