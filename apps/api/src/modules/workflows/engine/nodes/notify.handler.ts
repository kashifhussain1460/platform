import { Injectable, Logger } from '@nestjs/common';
import type { Role } from '@vaep/types';
import { NotificationsService } from '../../../notifications/notifications.service';
import { resolveTemplate } from '../template';
import type {
  NodeExecContext,
  NodeHandler,
  NodeResult,
} from './node-handler';

const ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'MEMBER'];

/**
 * NOTIFY — hardening plan §30, "PAUSE the Novu engine, FIX the NOTIFY contract".
 *
 * ## What was wrong
 *
 * This node returned `{ message, notified: true }` and sent nothing. Not just
 * inert — it ASSERTED delivery. A run log reading `notified: true` beside an
 * escalation nobody received is worse than a node that plainly does nothing,
 * because it answers the question "was anyone told?" incorrectly.
 *
 * ## What it does now
 *
 * Resolves recipients inside the company and delivers through the existing
 * `NotificationsService` (the "notification abstraction → provider interface"
 * the plan asks for; email is its first provider, and a Novu adapter can become
 * another later WITHOUT touching this node — which is the point of the seam).
 *
 * ## Why it still does nothing by default
 *
 * A node configured with only `message` — every NOTIFY node that exists today —
 * reports `delivered: false` with a reason, and sends no mail. Silently turning
 * existing graphs into email the next time they run is a blast radius nobody
 * asked for. Adding a recipient is the explicit opt-in.
 *
 * ## Why it cannot email an arbitrary address
 *
 * Recipients are users of the acting company, addressed by id, role or
 * department. A NOTIFY that could take a free-text address would be an
 * unapproved outbound channel available to any workflow — precisely what the
 * high-risk TOOL_ACTION approval gate exists to prevent, and what doc 27 §0.4
 * warns about when it says a real message is a TOOL_ACTION.
 */
@Injectable()
export class NotifyNodeHandler implements NodeHandler {
  readonly type = 'NOTIFY' as const;
  private readonly logger = new Logger(NotifyNodeHandler.name);

  constructor(private readonly notifications: NotificationsService) {}

  async execute({
    companyId,
    node,
    context,
    dryRun,
  }: NodeExecContext): Promise<NodeResult> {
    const cfg = node.config ?? {};
    const message = resolveTemplate(cfg.message, context);

    const userIds = stringList(cfg.notifyUserIds, context);
    const roles = stringList(cfg.notifyRoles, context)
      .map((r) => r.toUpperCase())
      .filter((r): r is Role => (ROLES as readonly string[]).includes(r));
    const departmentId = resolveTemplate(cfg.notifyDepartmentId, context).trim();

    // A dry run must be PROVABLY side-effect free — and this node's side effect
    // is mail, which cannot be taken back.
    if (dryRun) {
      const preview = {
        message,
        delivered: false,
        dryRun: true,
        reason: 'dry run — no notification was sent',
      };
      return { output: preview, contextValue: preview };
    }

    const result = await this.notifications.workflowNotify(companyId, {
      message,
      ...(userIds.length ? { userIds } : {}),
      ...(roles.length ? { roles } : {}),
      ...(departmentId ? { departmentId } : {}),
    });

    // Still logged, so a NOTIFY with no recipients keeps its old usefulness as a
    // run-log marker.
    this.logger.log(
      `NOTIFY[${node.id}]: ${message} — delivered=${result.delivered} recipients=${result.recipientCount}` +
        (result.reason ? ` (${result.reason})` : ''),
    );

    const output = {
      message,
      delivered: result.delivered,
      recipientCount: result.recipientCount,
      ...(result.reason ? { reason: result.reason } : {}),
    };
    return { output, contextValue: output };
  }
}

/**
 * Accept a JSON array, a comma-separated string, or a single value — all three
 * are what an author or a `{{template}}` realistically produces, and rejecting
 * two of them would fail at runtime on a node that looked correctly configured.
 */
function stringList(
  raw: unknown,
  context: Record<string, unknown>,
): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((v) => resolveTemplate(v, context).trim())
      .filter((v) => v.length > 0);
  }
  const resolved = resolveTemplate(raw, context).trim();
  if (!resolved) return [];
  return resolved
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}
