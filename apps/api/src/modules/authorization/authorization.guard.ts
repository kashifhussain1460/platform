import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { AuthorizationService } from './authorization.service';
import { PERMISSION_KEY } from './require-permission.decorator';
import type { AuthzAction, AuthzResourceType } from './authorization.types';

/**
 * WAVE 2 §2.2 — enforces `@RequirePermission(...)` after `JwtAuthGuard`.
 *
 * Checks only what is knowable without loading the resource: tenant, account
 * status and the company role floor. A route whose rule depends on the resource
 * itself must still call `AuthorizationService.assert(...)` once it has the row
 * — the guard cannot department-scope a workflow it has not read.
 *
 * It also caches the resolved actor on the request, so a handler that goes on to
 * do a resource-level check does not re-query the user.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authz: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<AuthzAction | undefined>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    // No declaration → this guard has nothing to say. Any existing @Roles guard
    // on the route still applies.
    if (!action) return true;

    const req = context
      .switchToHttp()
      .getRequest<
        Request & { user?: AuthenticatedUser; authzActor?: unknown }
      >();
    const user = req.user;
    if (!user) {
      throw new ForbiddenException('Not authenticated');
    }

    const actor = await this.authz.actorFor({
      userId: user.userId,
      companyId: user.companyId,
      role: user.role,
    });
    req.authzActor = actor;

    const decision = await this.authz.authorize(actor, action, {
      // No id and no scope: this is the pre-load floor check. Scope is
      // deliberately absent rather than guessed — a guessed scope would either
      // deny legitimately-shared resources or allow a scoped one by accident.
      type: action.split(':')[0] as AuthzResourceType,
      companyId: user.companyId,
    });

    if (!decision.allowed) {
      throw new ForbiddenException(decision.reason);
    }
    return true;
  }
}
