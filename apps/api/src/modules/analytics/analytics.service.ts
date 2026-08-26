import { Injectable } from '@nestjs/common';
import type {
  ActivityFeedDto,
  ActivityItemDto,
  AnalyticsRange,
  EmployeeKpiDto,
  KpiAttainmentDto,
  KpiTargets,
  OverviewDto,
} from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthorizationService } from '../authorization/authorization.service';
import {
  HOURLY_RATE_USD,
  hoursSavedFor,
  rangeStart,
} from './analytics.constants';

/** Per-status skill-execution counts. */
interface ToolCounts {
  actions: number;
  success: number;
  errors: number;
}

/**
 * The set of resources one caller may see, resolved once per request.
 *
 * `null` on either axis means "unrestricted" — an OWNER, or a member whose
 * department declares no scopes. That is deliberately distinct from an empty
 * array, which means "restricted, and nothing matches"; conflating the two is
 * how a scoping bug turns into a data leak.
 */
interface AnalyticsScope {
  employeeIds: string[] | null;
  workflowIds: string[] | null;
}

/**
 * Read-only KPI aggregation over EXISTING data. Every query is scoped by
 * companyId (from the JWT). Activity-style metrics are bounded by `range` on
 * their relevant `createdAt`; current-state counts (employees, pending
 * approvals) are point-in-time. Uses Prisma count/groupBy only — never loads
 * bulk SkillExecution/Message rows. No models are written.
 *
 * ## Phase 1 — authorization
 *
 * This controller had `@UseGuards(JwtAuthGuard)` and nothing else, so any
 * MEMBER could read KPI rows for EVERY AI employee in the company — including
 * ones the same user was correctly denied by `GET /employees`, which has
 * applied `authz.filter(actor, 'employee:read', …)` since WAVE 2. Two
 * endpoints, the same data, different answers: exactly the "list endpoint
 * leaks what the detail endpoint denies" failure `AuthorizationService` was
 * written to prevent.
 *
 * It now resolves the caller's visible employees (via `employee:read`, scoped
 * on `AiEmployee.role`) and visible workflows (via `workflow:read`, scoped on
 * `Workflow.category`) through the SAME policy, and every aggregate is bounded
 * by those sets. No second role model, no duplicated rules.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
  ) {}

  /**
   * Resolve what this caller may see.
   *
   * `actorUserId` absent = a machine caller already authorized at its own entry
   * point, matching `EmployeesService`/`WorkflowsService`'s convention.
   */
  private async scopeFor(
    companyId: string,
    actorUserId: string | undefined,
  ): Promise<AnalyticsScope> {
    const actor = await this.authz.actorById(companyId, actorUserId);
    if (!actor) return { employeeIds: null, workflowIds: null };

    const [employees, workflows] = await Promise.all([
      this.prisma.aiEmployee.findMany({
        where: { companyId },
        select: { id: true, role: true },
      }),
      this.prisma.workflow.findMany({
        where: { companyId },
        select: { id: true, category: true },
      }),
    ]);

    const visibleEmployees = await this.authz.filter(
      actor,
      'employee:read',
      employees,
      (e) => ({ type: 'employee', companyId, id: e.id, scope: e.role }),
    );
    const visibleWorkflows = await this.authz.filter(
      actor,
      'workflow:read',
      workflows,
      (w) => ({ type: 'workflow', companyId, id: w.id, scope: w.category }),
    );

    // Unrestricted callers keep `null` so their queries stay exactly as they
    // were — no `IN (...)` clause with every id in the tenant, which would turn
    // a cheap aggregate into a huge one as a company grows.
    const employeeRestricted = visibleEmployees.length !== employees.length;
    const workflowRestricted = visibleWorkflows.length !== workflows.length;
    return {
      employeeIds: employeeRestricted ? visibleEmployees.map((e) => e.id) : null,
      workflowIds: workflowRestricted ? visibleWorkflows.map((w) => w.id) : null,
    };
  }

  /** `employeeId` filter for a model that HAS the column. */
  private employeeFilter(scope: AnalyticsScope) {
    return scope.employeeIds === null
      ? {}
      : { employeeId: { in: scope.employeeIds } };
  }

  /** `workflowId` filter for WorkflowRun (which carries no employee axis). */
  private workflowFilter(scope: AnalyticsScope) {
    return scope.workflowIds === null
      ? {}
      : { workflowId: { in: scope.workflowIds } };
  }

  /** `id` filter for the AiEmployee table itself (its PK, not a foreign key). */
  private employeeIdIn(scope: AnalyticsScope) {
    return scope.employeeIds === null ? {} : { id: { in: scope.employeeIds } };
  }

  // --- Company overview ----------------------------------------------------

  async overview(
    companyId: string,
    range: AnalyticsRange,
    actorUserId?: string,
  ): Promise<OverviewDto> {
    const start = rangeStart(range);
    const createdAt = this.createdAtFilter(start);
    const scope = await this.scopeFor(companyId, actorUserId);
    const byEmployee = this.employeeFilter(scope);
    const byWorkflow = this.workflowFilter(scope);
    // Archived employees are gone from the roster (`EmployeesService.list`), so
    // counting them here would make the tile disagree with the page.
    const rosterWhere = { companyId, archivedAt: null, ...this.employeeIdIn(scope) };

    const [
      toolByStatus,
      conversations,
      assistantMessages,
      workflowByStatus,
      pendingApprovals,
      employees,
      activeEmployees,
    ] = await Promise.all([
      this.prisma.skillExecution.groupBy({
        by: ['status'],
        where: { companyId, ...createdAt, ...byEmployee },
        _count: { _all: true },
      }),
      this.prisma.conversation.count({
        where: { companyId, ...createdAt, ...byEmployee },
      }),
      this.prisma.message.count({
        where: {
          companyId,
          role: 'ASSISTANT',
          ...createdAt,
          ...(scope.employeeIds === null
            ? {}
            : { conversation: { employeeId: { in: scope.employeeIds } } }),
        },
      }),
      this.prisma.workflowRun.groupBy({
        by: ['status'],
        where: { companyId, ...createdAt, ...byWorkflow },
        _count: { _all: true },
      }),
      // Current-state counts (point-in-time; not range-bounded).
      this.prisma.approvalRequest.count({
        where: { companyId, status: 'PENDING', ...byEmployee },
      }),
      this.prisma.aiEmployee.count({ where: rosterWhere }),
      this.prisma.aiEmployee.count({ where: { ...rosterWhere, status: 'ACTIVE' } }),
    ]);

    const tool = this.toolCounts(toolByStatus);
    const workflowRuns = this.sumCount(workflowByStatus);
    const workflowCompleted = this.countFor(workflowByStatus, 'COMPLETED');
    const workflowFailed = this.countFor(workflowByStatus, 'FAILED');

    // Derived ILLUSTRATIVE estimates.
    const tasksCompleted = tool.success + assistantMessages + workflowCompleted;
    const hoursSaved = hoursSavedFor(tasksCompleted);
    const costSavings = hoursSaved * HOURLY_RATE_USD;
    const successDenominator = tool.actions + workflowRuns;
    const successRate =
      successDenominator > 0
        ? (tool.success + workflowCompleted) / successDenominator
        : null;
    const utilization = employees > 0 ? activeEmployees / employees : 0;

    return {
      range,
      toolActions: tool.actions,
      toolSuccess: tool.success,
      toolErrors: tool.errors,
      conversations,
      assistantMessages,
      workflowRuns,
      workflowCompleted,
      workflowFailed,
      pendingApprovals,
      employees,
      activeEmployees,
      tasksCompleted,
      hoursSaved,
      costSavings,
      successRate,
      utilization,
    };
  }

  // --- Per-employee KPI rows -----------------------------------------------

  async employees(
    companyId: string,
    range: AnalyticsRange,
    actorUserId?: string,
  ): Promise<EmployeeKpiDto[]> {
    const start = rangeStart(range);
    const createdAt = this.createdAtFilter(start);
    const scope = await this.scopeFor(companyId, actorUserId);
    const byEmployee = this.employeeFilter(scope);

    const employees = await this.prisma.aiEmployee.findMany({
      where: { companyId, archivedAt: null, ...this.employeeIdIn(scope) },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        role: true,
        status: true,
        kpiTargets: true,
      },
    });
    if (employees.length === 0) return [];

    const [toolRows, convRows, assistantByEmployee, approvalRows] =
      await Promise.all([
        this.prisma.skillExecution.groupBy({
          by: ['employeeId', 'status'],
          where: { companyId, employeeId: { not: null }, ...createdAt, ...byEmployee },
          _count: { _all: true },
        }),
        this.prisma.conversation.groupBy({
          by: ['employeeId'],
          where: { companyId, ...createdAt, ...byEmployee },
          _count: { _all: true },
        }),
        this.assistantMessagesByEmployee(companyId, createdAt, scope),
        this.prisma.approvalRequest.groupBy({
          by: ['employeeId'],
          where: {
            companyId,
            status: 'PENDING',
            employeeId: { not: null },
            ...byEmployee,
          },
          _count: { _all: true },
        }),
      ]);

    // Fold groupBy results into per-employee lookups.
    const tool = new Map<string, ToolCounts>();
    for (const row of toolRows) {
      if (!row.employeeId) continue;
      const cur = tool.get(row.employeeId) ?? { actions: 0, success: 0, errors: 0 };
      const n = row._count._all;
      cur.actions += n;
      if (row.status === 'SUCCESS') cur.success += n;
      if (row.status === 'ERROR') cur.errors += n;
      tool.set(row.employeeId, cur);
    }
    const conversations = new Map(
      convRows.map((r) => [r.employeeId, r._count._all]),
    );
    const pending = new Map(
      approvalRows
        .filter((r) => r.employeeId)
        .map((r) => [r.employeeId as string, r._count._all]),
    );

    return employees.map((e) => {
      const t = tool.get(e.id) ?? { actions: 0, success: 0, errors: 0 };
      const assistant = assistantByEmployee.get(e.id) ?? 0;
      const tasksCompleted = t.success + assistant;
      const pendingApprovals = pending.get(e.id) ?? 0;
      const kpiTargets = (e.kpiTargets as KpiTargets | null) ?? null;
      return {
        employeeId: e.id,
        name: e.name,
        role: e.role,
        status: e.status,
        toolActions: t.actions,
        toolSuccess: t.success,
        toolErrors: t.errors,
        conversations: conversations.get(e.id) ?? 0,
        assistantMessages: assistant,
        pendingApprovals,
        tasksCompleted,
        hoursSaved: hoursSavedFor(tasksCompleted),
        kpiTargets,
        attainment: attainmentFor(kpiTargets, {
          tasksCompleted,
          toolActions: t.actions,
          toolSuccess: t.success,
          pendingApprovals,
        }),
      };
    });
  }

  // --- "Today's AI Activity" feed ------------------------------------------

  async activity(
    companyId: string,
    range: AnalyticsRange,
    actorUserId?: string,
  ): Promise<ActivityFeedDto[]> {
    const start = rangeStart(range);
    const createdAt = this.createdAtFilter(start);
    const scope = await this.scopeFor(companyId, actorUserId);
    const byEmployee = this.employeeFilter(scope);

    const employees = await this.prisma.aiEmployee.findMany({
      where: { companyId, archivedAt: null, ...this.employeeIdIn(scope) },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, role: true },
    });
    if (employees.length === 0) return [];

    const [toolRows, assistantByEmployee] = await Promise.all([
      this.prisma.skillExecution.groupBy({
        by: ['employeeId', 'skillKey', 'tool'],
        where: { companyId, employeeId: { not: null }, ...createdAt, ...byEmployee },
        _count: { _all: true },
      }),
      this.assistantMessagesByEmployee(companyId, createdAt, scope),
    ]);

    // employeeId → [{label, count}] for skill/tool actions.
    const toolItems = new Map<string, ActivityItemDto[]>();
    for (const row of toolRows) {
      if (!row.employeeId) continue;
      const items = toolItems.get(row.employeeId) ?? [];
      items.push({ label: `${row.skillKey} · ${row.tool}`, count: row._count._all });
      toolItems.set(row.employeeId, items);
    }

    const feed: ActivityFeedDto[] = [];
    for (const e of employees) {
      const items = [...(toolItems.get(e.id) ?? [])].sort(
        (a, b) => b.count - a.count,
      );
      const messages = assistantByEmployee.get(e.id) ?? 0;
      if (messages > 0) items.push({ label: 'messages', count: messages });
      if (items.length === 0) continue; // only surface employees with activity
      feed.push({ employeeId: e.id, employee: e.name, role: e.role, items });
    }
    return feed;
  }

  // --- Helpers -------------------------------------------------------------

  private createdAtFilter(start: Date | undefined) {
    return start ? { createdAt: { gte: start } } : {};
  }

  /**
   * Assistant-message counts per employee. Message has no employeeId, so group
   * assistant messages by conversationId then fold via the (id → employeeId)
   * conversation map. Two aggregate queries — no bulk Message rows loaded.
   */
  private async assistantMessagesByEmployee(
    companyId: string,
    createdAt: Record<string, unknown>,
    scope: AnalyticsScope = { employeeIds: null, workflowIds: null },
  ): Promise<Map<string, number>> {
    const byEmployee = this.employeeFilter(scope);
    const [byConversation, conversations] = await Promise.all([
      this.prisma.message.groupBy({
        by: ['conversationId'],
        where: {
          companyId,
          role: 'ASSISTANT',
          ...createdAt,
          ...(scope.employeeIds === null
            ? {}
            : { conversation: { employeeId: { in: scope.employeeIds } } }),
        },
        _count: { _all: true },
      }),
      this.prisma.conversation.findMany({
        where: { companyId, ...byEmployee },
        select: { id: true, employeeId: true },
      }),
    ]);
    const conversationToEmployee = new Map(
      conversations.map((c) => [c.id, c.employeeId]),
    );
    const result = new Map<string, number>();
    for (const row of byConversation) {
      const employeeId = conversationToEmployee.get(row.conversationId);
      if (!employeeId) continue;
      result.set(employeeId, (result.get(employeeId) ?? 0) + row._count._all);
    }
    return result;
  }

  private toolCounts(
    rows: Array<{ status: string; _count: { _all: number } }>,
  ): ToolCounts {
    const counts: ToolCounts = { actions: 0, success: 0, errors: 0 };
    for (const row of rows) {
      counts.actions += row._count._all;
      if (row.status === 'SUCCESS') counts.success += row._count._all;
      if (row.status === 'ERROR') counts.errors += row._count._all;
    }
    return counts;
  }

  private sumCount(rows: Array<{ _count: { _all: number } }>): number {
    return rows.reduce((acc, r) => acc + r._count._all, 0);
  }

  private countFor(
    rows: Array<{ status: string; _count: { _all: number } }>,
    status: string,
  ): number {
    return rows.find((r) => r.status === status)?._count._all ?? 0;
  }
}

/**
 * KPI attainment (actual vs configured target, as a percent) for one employee
 * (P1 #6). Returns null when the employee has no kpiTargets; each field is null
 * when its specific target is unset (or, for success rate, when there are no
 * tool actions to measure). ILLUSTRATIVE — surfaced with a "target" hint in the
 * UI, never a billing figure.
 */
function attainmentFor(
  targets: KpiTargets | null,
  actual: {
    tasksCompleted: number;
    toolActions: number;
    toolSuccess: number;
    pendingApprovals: number;
  },
): KpiAttainmentDto | null {
  if (!targets || typeof targets !== 'object') return null;
  const pct = (value: number, target?: number): number | null =>
    typeof target === 'number' && target > 0
      ? Math.round((value / target) * 100)
      : null;
  const successRateActual =
    actual.toolActions > 0
      ? Math.round((actual.toolSuccess / actual.toolActions) * 100)
      : null;
  return {
    tasksPct: pct(actual.tasksCompleted, targets.tasksPerWeek),
    successRatePct:
      successRateActual !== null
        ? pct(successRateActual, targets.successRatePct)
        : null,
    approvalsPct: pct(actual.pendingApprovals, targets.approvalsMax),
    successRateActual,
  };
}
