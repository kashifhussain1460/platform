import type { Plan } from '@vaep/types';
import type { Subscription } from '@prisma/client';
import type {
  BillingCompany,
  BillingProvider,
  ChangePlanResult,
  EnsureCustomerResult,
} from '../billing.provider';

/**
 * DEFAULT billing backend: fully offline / deterministic, no external calls.
 * Fabricates a stable `cus_mock_<companyId>` customer id and switches plans
 * immediately (status stays ACTIVE). Used by tests and local dev.
 */
export class MockBillingProvider implements BillingProvider {
  readonly name = 'mock';

  ensureCustomer(company: BillingCompany): Promise<EnsureCustomerResult> {
    return Promise.resolve({ externalCustomerId: `cus_mock_${company.id}` });
  }

  changePlan(
    _subscription: Subscription,
    plan: Plan,
  ): Promise<ChangePlanResult> {
    // Immediate switch — no proration, no external subscription, no checkout.
    // Credit system Phase 6, Task 6.2 (Q17 fix): a real stored instant, one
    // calendar month out — never left null the way this branch used to,
    // which made a freshly-created mock subscription's period end
    // permanently unknown.
    return Promise.resolve({ plan, status: 'ACTIVE', currentPeriodEnd: addOneMonth(new Date()) });
  }
}

/** One calendar month out, matching a monthly billing cycle. */
function addOneMonth(date: Date): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}
