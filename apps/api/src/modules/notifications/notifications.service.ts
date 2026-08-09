import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MailService } from '../mail/mail.service';

/**
 * System (platform) email notifications — the events beyond auth's verification/
 * reset that warrant telling a human: team invites, approvals awaiting a
 * decision, account changes, billing failures.
 *
 * Deliberately a LEAF service (PrismaService [global] + MailService only, no
 * domain-module imports) so both ApprovalsModule and WorkflowsModule can use it
 * without reopening the Approvals → Workflows cycle the codebase avoids — the
 * same fork pattern as ApprovalRoutingModule.
 *
 * Two invariants:
 *  - **Best-effort.** Every method swallows its own errors. Sending mail must
 *    NEVER fail creating a user, running a workflow, or processing a billing
 *    webhook — the business action already happened; the email is a courtesy.
 *  - **Off = truly off.** When mail is disabled every method returns before it
 *    does any work (no recipient queries, no log noise), so dev/e2e are unaffected.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /** A teammate was added: tell them how to get in. Never emails a password. */
  async teamInvite(
    companyId: string,
    user: { email: string; name: string },
    inviterName?: string,
  ): Promise<void> {
    await this.run('teamInvite', async () => {
      const companyName = await this.companyName(companyId);
      const login = `${this.web()}/login`;
      const forgot = `${this.web()}/forgot-password`;
      await this.mail.send(
        user.email,
        `You've been added to ${companyName} on Orlixa`,
        `Hi ${user.name},\n\n${inviterName ? `${inviterName} ` : ''}added you to ${companyName} on Orlixa.\n\n` +
          `Sign in at ${login}. If you don't have a password yet, set one at ${forgot}.`,
      );
    });
  }

  /** An account was disabled/reactivated or its role changed. */
  async accountStatusChanged(
    companyId: string,
    user: { email: string; name: string },
    change: { disabled?: boolean; reactivated?: boolean; role?: string },
  ): Promise<void> {
    await this.run('accountStatusChanged', async () => {
      const companyName = await this.companyName(companyId);
      const what = change.disabled
        ? `Your access to ${companyName} on Orlixa has been turned off.`
        : change.reactivated
          ? `Your access to ${companyName} on Orlixa has been restored.`
          : change.role
            ? `Your role in ${companyName} on Orlixa was changed to ${change.role}.`
            : `Your account in ${companyName} on Orlixa was updated.`;
      await this.mail.send(
        user.email,
        `Your Orlixa account was updated`,
        `Hi ${user.name},\n\n${what}\n\nIf this wasn't expected, contact an administrator.`,
      );
    });
  }

  /** An approval is waiting for a decision — notify the assignee, else the admins. */
  async approvalRequested(
    companyId: string,
    opts: { assigneeUserId?: string | null; summary: string },
  ): Promise<void> {
    await this.run('approvalRequested', async () => {
      const url = `${this.web()}/approvals`;
      const recipients = await this.approvalRecipients(companyId, opts.assigneeUserId);
      for (const r of recipients) {
        await this.mail.send(
          r.email,
          'An approval needs your decision',
          `Hi ${r.name},\n\n${opts.summary}\n\nReview and decide: ${url}`,
        );
      }
    });
  }

  /** An approval breached its SLA and was escalated — notify the new decider. */
  async approvalEscalated(
    companyId: string,
    opts: { assigneeUserId?: string | null; summary: string },
  ): Promise<void> {
    await this.run('approvalEscalated', async () => {
      const url = `${this.web()}/approvals`;
      const recipients = await this.approvalRecipients(companyId, opts.assigneeUserId);
      for (const r of recipients) {
        await this.mail.send(
          r.email,
          'An approval was escalated to you',
          `Hi ${r.name},\n\n${opts.summary}\n\nIt is overdue and now needs your decision: ${url}`,
        );
      }
    });
  }

  /** A subscription payment failed — tell the company owners. */
  async paymentFailed(companyId: string): Promise<void> {
    await this.run('paymentFailed', async () => {
      const companyName = await this.companyName(companyId);
      const url = `${this.web()}/billing`;
      const owners = await this.prisma.user.findMany({
        where: { companyId, status: 'ACTIVE', role: 'OWNER' },
        select: { email: true, name: true },
      });
      for (const o of owners) {
        await this.mail.send(
          o.email,
          `Payment failed for ${companyName}`,
          `Hi ${o.name},\n\nWe couldn't process the latest payment for ${companyName} on Orlixa, ` +
            `so the subscription is now past due.\n\nUpdate your billing details to avoid interruption: ${url}`,
        );
      }
    });
  }

  /** Onboarding finished — a short welcome to the company's owners. */
  async welcome(companyId: string): Promise<void> {
    await this.run('welcome', async () => {
      const companyName = await this.companyName(companyId);
      const owners = await this.prisma.user.findMany({
        where: { companyId, status: 'ACTIVE', role: 'OWNER' },
        select: { email: true, name: true },
      });
      for (const o of owners) {
        await this.mail.send(
          o.email,
          `Welcome to Orlixa`,
          `Hi ${o.name},\n\n${companyName} is set up on Orlixa and your AI employees are ready. ` +
            `Head to ${this.web()}/dashboard to get started.`,
        );
      }
    });
  }

  // --- internals ------------------------------------------------------------

  /** Recipients for an approval: the named assignee if any, else the admins. */
  private async approvalRecipients(
    companyId: string,
    assigneeUserId?: string | null,
  ): Promise<{ email: string; name: string }[]> {
    if (assigneeUserId) {
      const user = await this.prisma.user.findFirst({
        where: { id: assigneeUserId, companyId, status: 'ACTIVE' },
        select: { email: true, name: true },
      });
      if (user) return [user];
      // A resolved assignee who is gone/disabled falls back to the admins rather
      // than silently notifying no one.
    }
    return this.prisma.user.findMany({
      where: { companyId, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
      select: { email: true, name: true },
      take: 25,
    });
  }

  private async companyName(companyId: string): Promise<string> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true },
    });
    return company?.name ?? 'your team';
  }

  private web(): string {
    return (
      this.config.get<string>('WEB_ORIGIN')?.replace(/\/$/, '') ??
      'http://localhost:3000'
    );
  }

  /** Skip entirely when mail is off; otherwise run best-effort (never throws). */
  private async run(ctx: string, fn: () => Promise<void>): Promise<void> {
    if (!this.mail.enabled()) return;
    try {
      await fn();
    } catch (err) {
      this.logger.warn(
        `notification "${ctx}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
