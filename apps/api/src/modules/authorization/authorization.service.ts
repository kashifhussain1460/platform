import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  decide,
  type ActorDepartment,
} from './authorization.policy';
import type {
  AuthzAction,
  AuthzActor,
  AuthzContext,
  AuthzDecision,
  AuthzResource,
} from './authorization.types';

/**
 * WAVE 2 §2.2 / §16 — THE authorization entry point.
 *
 * Before this, authorization was 72 `@Roles(...)` decorator sites plus a handful
 * of bespoke service-level checks. That is not a security model, it is a
 * convention: nothing could answer "who can read HR data?" without grepping, and
 * a new controller could simply forget.
 *
 * This service does not REPLACE the specialised checks that already exist and
 * are already tested — `WorkflowPermissionService` (per-workflow grants) and
 * `ApprovalRoutingService.canDecide` (who may decide a routed approval). Those
 * are richer than a generic policy and duplicating them would create exactly the
 * "two authorization systems" §19 forbids. This is the layer they compose under:
 * company role floor → tenant isolation → department scope, with the specialised
 * services consulted for their own resources.
 *
 * Deliberately a LEAF module (Prisma only) so any module can import it without
 * risking a cycle.
 */
@Injectable()
export class AuthorizationService {
  private readonly logger = new Logger(AuthorizationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The plan's `authorize(actor, action, resource, context)`.
   *
   * Returns a decision rather than throwing, so a caller that needs to FILTER
   * (list endpoints) uses the same rules as one that needs to REJECT. Two code
   * paths disagreeing about what a user may see is how a list endpoint ends up
   * leaking the titles of records the detail endpoint correctly denies.
   */
  async authorize(
    actor: AuthzActor,
    action: AuthzAction,
    resource: AuthzResource,
    context: AuthzContext = {},
  ): Promise<AuthzDecision> {
    const department = await this.departmentOf(actor);
    const decision = decide({ actor, action, resource, department });

    if (!decision.allowed) {
      this.logger.warn(
        `authz DENY user=${actor.userId} company=${actor.companyId} action=${action} ` +
          `resource=${resource.type}${resource.id ? `:${resource.id}` : ''} rule=${decision.rule} — ${decision.reason}`,
      );
    }
    void context;
    return decision;
  }

  /** `authorize` for the common case: throw 403 with the real reason. */
  async assert(
    actor: AuthzActor,
    action: AuthzAction,
    resource: AuthzResource,
    context: AuthzContext = {},
  ): Promise<void> {
    const decision = await this.authorize(actor, action, resource, context);
    if (!decision.allowed) {
      throw new ForbiddenException(decision.reason);
    }
  }

  /**
   * Keep only the resources the actor may act on.
   *
   * One department lookup for the whole list — the policy itself is pure, so
   * filtering a hundred rows costs one query, not a hundred.
   */
  async filter<T>(
    actor: AuthzActor,
    action: AuthzAction,
    items: readonly T[],
    toResource: (item: T) => AuthzResource,
  ): Promise<T[]> {
    if (items.length === 0) return [];
    const department = await this.departmentOf(actor);
    return items.filter(
      (item) =>
        decide({ actor, action, resource: toResource(item), department })
          .allowed,
    );
  }

  /**
   * Build an actor from a JWT payload, re-reading the fields that must not be
   * trusted from a token: `status` (a user disabled after the token was issued
   * still holds a valid one) and the department placement (moved since issue).
   */
  async actorFor(user: {
    userId: string;
    companyId: string;
    role: AuthzActor['role'];
  }): Promise<AuthzActor> {
    const row = await this.prisma.user.findFirst({
      where: { id: user.userId, companyId: user.companyId },
      select: {
        role: true,
        status: true,
        departmentId: true,
        teamId: true,
      },
    });
    return {
      userId: user.userId,
      companyId: user.companyId,
      // The stored role wins over the token's: a demotion must take effect
      // immediately, not when the access token happens to expire.
      role: row?.role ?? user.role,
      status: row?.status ?? 'ACTIVE',
      departmentId: row?.departmentId ?? null,
      teamId: row?.teamId ?? null,
    };
  }

  /**
   * Build an actor from ids alone, for a service that has the acting user's id
   * but not the JWT payload.
   *
   * Returns null when the user no longer exists in this tenant. Callers treat
   * null as "no actor" and therefore skip scope checks — that is correct for the
   * MACHINE callers this exists for (the workflow engine resuming a run, a
   * template installer), which have already been authorized at their own entry
   * point and have no human to scope to.
   */
  async actorById(
    companyId: string,
    userId: string | null | undefined,
  ): Promise<AuthzActor | null> {
    if (!userId) return null;
    const row = await this.prisma.user.findFirst({
      where: { id: userId, companyId },
      select: { role: true, status: true, departmentId: true, teamId: true },
    });
    if (!row) return null;
    return {
      userId,
      companyId,
      role: row.role,
      status: row.status,
      departmentId: row.departmentId,
      teamId: row.teamId,
    };
  }

  /** The actor's department and its configured scopes, or null if unplaced. */
  private async departmentOf(
    actor: AuthzActor,
  ): Promise<ActorDepartment | null> {
    if (!actor.departmentId) return null;
    const dept = await this.prisma.department.findFirst({
      where: { id: actor.departmentId, companyId: actor.companyId },
      select: { id: true, name: true, scopes: true },
    });
    if (!dept) return null;
    return { id: dept.id, name: dept.name, scopes: dept.scopes };
  }
}
