import { Injectable } from '@nestjs/common';
import type {
  DashboardCompositionDto,
  DashboardWidgetDto,
  EmployeeRole,
  WidgetMetricDto,
} from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ProductContextService } from './product-context.service';

/**
 * Composes the dashboard from resolved capabilities.
 *
 * ## Why this is a separate service
 *
 * `ProductContextService` answers "what is relevant?". This answers "and what
 * are the numbers?". Keeping them apart matters because the second is
 * expensive and domain-specific: it reaches into HR, Marketing and Support
 * tables that the context resolver has no business knowing about, and it runs
 * only for the widgets a company actually has.
 *
 * ## The gap this closes
 *
 * `dashboardCapabilities` shipped in Phase 3 as a list of section NAMES with
 * nothing behind them — the Phase 3 audit said so explicitly, and warned Phase
 * 4 not to assume otherwise. `AnalyticsService` aggregates `SkillExecution`,
 * `Message`, `WorkflowRun` and `ApprovalRequest`: real, but identical for every
 * company regardless of who they hired. Meanwhile `LeaveRequest`,
 * `OnboardingTask`, `Campaign`, `ScheduledPost`, `SupportConversation` and
 * `HandoffRequest` are populated by shipped workflows and queried by no
 * dashboard at all.
 *
 * These are those queries.
 *
 * ## Rules it follows
 *
 * - Every query is `companyId`-scoped. No exceptions, no joins that escape it.
 * - A widget is built ONLY when the resolver says its capability is present,
 *   so a Marketing-only company runs no HR queries.
 * - Zero is not an error. A widget with no data returns a `setupHint` naming
 *   the next step rather than a row of zeroes.
 */
@Injectable()
export class DashboardComposerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly productContext: ProductContextService,
  ) {}

  async compose(
    companyId: string,
    user: { userId: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' },
  ): Promise<DashboardCompositionDto> {
    // Relevance first — the widget set is decided by the SAME resolver the
    // navigation uses, never by a second copy of the rules.
    const context = await this.productContext.resolve(companyId, user);
    const has = (capability: string) =>
      context.dashboardCapabilities.includes(capability);
    const hasRole = (role: EmployeeRole) =>
      context.configuration.hiredEmployeeRoles.includes(role);

    const widgets: DashboardWidgetDto[] = [];

    // Always present. A dashboard whose every widget is conditional can render
    // completely empty, which reads as a broken page rather than a new account.
    widgets.push(await this.companySummary(companyId, context.relevantEmployeeIds));

    if (hasRole('HR') || hasRole('RECRUITER')) {
      widgets.push(await this.hrActivity(companyId));
    }
    if (hasRole('MARKETING')) {
      widgets.push(await this.marketingActivity(companyId));
    }
    if (hasRole('SUPPORT')) {
      widgets.push(await this.supportActivity(companyId));
    }
    if (has('COMPANY_SUMMARY')) {
      widgets.push(await this.approvals(companyId));
    }

    return { companyId, widgets };
  }

  /** Roster + this week's activity. The one widget every company gets. */
  private async companySummary(
    companyId: string,
    visibleEmployeeIds: readonly string[],
  ): Promise<DashboardWidgetDto> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // Scoped to the employees THIS user may see, so the tile agrees with the
    // roster rather than quietly counting rows they are denied.
    const employeeFilter =
      visibleEmployeeIds.length > 0 ? { employeeId: { in: [...visibleEmployeeIds] } } : {};

    const [employees, activeEmployees, runs, toolCalls] = await Promise.all([
      this.prisma.aiEmployee.count({ where: { companyId, archivedAt: null } }),
      this.prisma.aiEmployee.count({
        where: { companyId, archivedAt: null, status: 'ACTIVE' },
      }),
      this.prisma.workflowRun.count({
        where: { companyId, createdAt: { gte: since } },
      }),
      this.prisma.skillExecution.count({
        where: { companyId, createdAt: { gte: since }, ...employeeFilter },
      }),
    ]);

    return {
      kind: 'COMPANY_SUMMARY',
      title: 'Your AI workforce',
      metrics: [
        { label: 'AI Employees', value: employees, href: '/employees' },
        { label: 'Active', value: activeEmployees, href: '/employees' },
        { label: 'Workflow runs (7d)', value: runs, href: '/runs' },
        { label: 'Actions taken (7d)', value: toolCalls, href: '/runs' },
      ],
      setupHint:
        employees === 0
          ? {
              message: 'You have not hired an AI Employee yet.',
              ctaLabel: 'Hire your first AI Employee',
              ctaHref: '/employees',
            }
          : null,
    };
  }

  /** HR: the people-ops work an HR or Recruiter employee actually produces. */
  private async hrActivity(companyId: string): Promise<DashboardWidgetDto> {
    const [staff, pendingLeave, openTasks, openSlots] = await Promise.all([
      this.prisma.staffMember.count({ where: { companyId } }),
      this.prisma.leaveRequest.count({ where: { companyId, status: 'PENDING' } }),
      this.prisma.onboardingTask.count({ where: { companyId, completedAt: null } }),
      this.prisma.interviewSlot.count({ where: { companyId, status: 'OPEN' } }),
    ]);

    const metrics: WidgetMetricDto[] = [
      { label: 'Staff records', value: staff, href: null },
      { label: 'Leave awaiting decision', value: pendingLeave, href: null, attention: pendingLeave > 0 },
      { label: 'Open onboarding tasks', value: openTasks, href: null, attention: openTasks > 0 },
      { label: 'Interview slots free', value: openSlots, href: '/scheduling' },
    ];

    return {
      kind: 'HR_ACTIVITY',
      title: 'HR',
      metrics,
      setupHint: hasNoData(metrics)
        ? {
            message:
              'Your HR AI Employee is ready. Add interview slots so it can start scheduling.',
            ctaLabel: 'Set up interview scheduling',
            ctaHref: '/scheduling',
          }
        : null,
    };
  }

  /** Marketing: campaigns and the publishing pipeline. */
  private async marketingActivity(companyId: string): Promise<DashboardWidgetDto> {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [campaigns, scheduled, awaitingApproval, published, accounts] =
      await Promise.all([
        this.prisma.campaign.count({ where: { companyId } }),
        this.prisma.scheduledPost.count({ where: { companyId, status: 'SCHEDULED' } }),
        this.prisma.scheduledPost.count({
          where: { companyId, status: 'PENDING_APPROVAL' },
        }),
        this.prisma.publishedPost.count({
          where: { companyId, publishedAt: { gte: since } },
        }),
        this.prisma.socialAccount.count({ where: { companyId } }),
      ]);

    const metrics: WidgetMetricDto[] = [
      { label: 'Campaigns', value: campaigns, href: null },
      { label: 'Scheduled posts', value: scheduled, href: null },
      { label: 'Awaiting approval', value: awaitingApproval, href: '/approvals', attention: awaitingApproval > 0 },
      { label: 'Published (30d)', value: published, href: null },
    ];

    return {
      kind: 'MARKETING_ACTIVITY',
      title: 'Marketing',
      metrics,
      // The specific hint the brief asks for — and the honest one: with no
      // connected account there is nowhere for a post to go.
      setupHint:
        accounts === 0
          ? {
              message:
                'Your Marketing AI Employee is ready. Connect a social account to start publishing.',
              ctaLabel: 'Connect a social account',
              ctaHref: '/skills',
            }
          : hasNoData(metrics)
            ? {
                message:
                  'No campaigns yet. Create one from a Marketing workflow template.',
                ctaLabel: 'Browse Marketing templates',
                ctaHref: '/workflows/templates',
              }
            : null,
    };
  }

  /** Support: conversations, escalations and the humans they land on. */
  private async supportActivity(companyId: string): Promise<DashboardWidgetDto> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [open, escalated, resolved, pendingHandoffs, connected] = await Promise.all([
      this.prisma.supportConversation.count({ where: { companyId, status: 'OPEN' } }),
      this.prisma.supportConversation.count({
        where: { companyId, status: 'ESCALATED' },
      }),
      this.prisma.supportConversation.count({
        // `lastMessageAt` is the only time column on this model; a resolved
        // conversation's last message is what dates the resolution.
        where: { companyId, status: 'RESOLVED', lastMessageAt: { gte: since } },
      }),
      this.prisma.handoffRequest.count({ where: { companyId, status: 'PENDING' } }),
      this.prisma.chatwootAccount.count({ where: { companyId } }),
    ]);

    const metrics: WidgetMetricDto[] = [
      { label: 'Open conversations', value: open, href: null },
      { label: 'Escalated', value: escalated, href: null, attention: escalated > 0 },
      { label: 'Resolved (7d)', value: resolved, href: null },
      { label: 'Waiting for a human', value: pendingHandoffs, href: null, attention: pendingHandoffs > 0 },
    ];

    return {
      kind: 'SUPPORT_ACTIVITY',
      title: 'Support',
      metrics,
      setupHint:
        connected === 0
          ? {
              message:
                'Your Support AI Employee is ready. Connect your support inbox so it can start replying.',
              ctaLabel: 'Connect support',
              ctaHref: '/skills',
            }
          : null,
    };
  }

  /** The approval queue, which every company with an AI Employee can fill. */
  private async approvals(companyId: string): Promise<DashboardWidgetDto> {
    const [pending, escalated] = await Promise.all([
      this.prisma.approvalRequest.count({ where: { companyId, status: 'PENDING' } }),
      this.prisma.approvalRequest.count({ where: { companyId, status: 'ESCALATED' } }),
    ]);
    return {
      kind: 'APPROVALS',
      title: 'Approvals',
      metrics: [
        { label: 'Awaiting decision', value: pending, href: '/approvals', attention: pending > 0 },
        { label: 'Escalated', value: escalated, href: '/approvals', attention: escalated > 0 },
      ],
      setupHint: null,
    };
  }
}

/** True when every metric is zero — i.e. the area is on but has produced nothing. */
function hasNoData(metrics: readonly WidgetMetricDto[]): boolean {
  return metrics.every((m) => m.value === 0);
}
