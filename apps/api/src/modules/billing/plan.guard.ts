import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Plan } from '@vaep/types';
import type { AuthenticatedUser } from '../auth/auth.provider';
import { PLAN_KEY } from './decorators/plan.decorator';
import { BillingService } from './billing.service';

/**
 * Authorization guard that runs AFTER JwtAuthGuard (request.user populated).
 * Reads `@RequirePlan(...)` metadata; when absent the route is open to any
 * plan. Otherwise loads the caller's real subscription (self-healing to a
 * default STARTER if one somehow doesn't exist yet, same as every other
 * BillingService caller) and 403s if its plan isn't in the allowed list.
 *
 * This is the first real plan-tier enforcement in the codebase — every other
 * plan limit today is informational only (see PLAN_CATALOG comments). Written
 * generically enough that a future feature can reuse `@RequirePlan(...)` on
 * another endpoint, but nothing else is gated by it yet.
 */
@Injectable()
export class PlanGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly billing: BillingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowed = this.reflector.getAllAndOverride<Plan[] | undefined>(
      PLAN_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!allowed || allowed.length === 0) {
      return true;
    }
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const companyId = req.user?.companyId;
    if (!companyId) {
      throw new ForbiddenException('No authenticated company for this request');
    }
    const subscription = await this.billing.getSubscription(companyId);
    if (subscription.status !== 'ACTIVE') {
      throw new ForbiddenException(
        `Your subscription is ${subscription.status.replace('_', ' ').toLowerCase()} — resolve billing before using this feature.`,
      );
    }
    if (!allowed.includes(subscription.plan)) {
      throw new ForbiddenException(
        `This feature requires the ${allowed.join(' or ')} plan`,
      );
    }
    return true;
  }
}
