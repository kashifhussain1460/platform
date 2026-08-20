import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { SubscriptionDto } from '@vaep/types';
import { PlanGuard } from './plan.guard';
import type { BillingService } from './billing.service';

function makeContext(companyId: string): ExecutionContext {
  const req = { user: { companyId } };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('PlanGuard', () => {
  it('allows any plan when no @RequirePlan metadata is present', async () => {
    const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
    const billing = { getSubscription: jest.fn() } as unknown as BillingService;
    const guard = new PlanGuard(reflector, billing);

    await expect(guard.canActivate(makeContext('co_1'))).resolves.toBe(true);
    expect(billing.getSubscription).not.toHaveBeenCalled();
  });

  it('throws ForbiddenException when the company plan is not in the allowed list', async () => {
    const reflector = {
      getAllAndOverride: () => ['BUSINESS', 'ENTERPRISE'],
    } as unknown as Reflector;
    const billing = {
      getSubscription: jest.fn().mockResolvedValue({ plan: 'STARTER', status: 'ACTIVE' } as SubscriptionDto),
    } as unknown as BillingService;
    const guard = new PlanGuard(reflector, billing);

    await expect(guard.canActivate(makeContext('co_1'))).rejects.toThrow(ForbiddenException);
  });

  it('allows a company whose plan is in the allowed list', async () => {
    const reflector = {
      getAllAndOverride: () => ['BUSINESS', 'ENTERPRISE'],
    } as unknown as Reflector;
    const billing = {
      getSubscription: jest.fn().mockResolvedValue({ plan: 'BUSINESS', status: 'ACTIVE' } as SubscriptionDto),
    } as unknown as BillingService;
    const guard = new PlanGuard(reflector, billing);

    await expect(guard.canActivate(makeContext('co_1'))).resolves.toBe(true);
  });

  it('throws ForbiddenException for a PAST_DUE company even when its plan matches', async () => {
    const reflector = {
      getAllAndOverride: () => ['BUSINESS', 'ENTERPRISE'],
    } as unknown as Reflector;
    const billing = {
      getSubscription: jest
        .fn()
        .mockResolvedValue({ plan: 'BUSINESS', status: 'PAST_DUE' } as SubscriptionDto),
    } as unknown as BillingService;
    const guard = new PlanGuard(reflector, billing);

    await expect(guard.canActivate(makeContext('co_1'))).rejects.toThrow(ForbiddenException);
  });
});
