import { BillingService } from './billing.service';
import type { BillingProvider, BillingWebhookEvent } from './billing.provider';

interface FakeSubscriptionRow {
  id: string;
  companyId: string;
  plan: string;
  status: string;
  externalCustomerId: string | null;
  externalSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
  provider: string;
}

/** A fake PrismaService exposing only the subscription methods this service calls. */
function fakePrisma(row: FakeSubscriptionRow) {
  const current = { ...row };
  return {
    subscription: {
      findUnique: jest.fn(async () => ({ ...current })),
      findUniqueOrThrow: jest.fn(async () => ({ ...current })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(current, data);
        return { ...current };
      }),
    },
  };
}

function fakeProvider(
  event: BillingWebhookEvent | null,
): BillingProvider {
  return {
    name: 'fake',
    ensureCustomer: jest.fn(),
    changePlan: jest.fn(),
    parseWebhookEvent: jest.fn(async () => event),
  } as unknown as BillingProvider;
}

function fakeUsageService() {
  return { totalsForCompany: jest.fn() } as never;
}

function fakeAuditLog() {
  return { record: jest.fn().mockResolvedValue(undefined) };
}

function fakeNotifications() {
  return { paymentFailed: jest.fn().mockResolvedValue(undefined) } as never;
}

describe('BillingService payment-failure audit logging', () => {
  it('records billing.payment_failed on a genuine transition INTO past-due', async () => {
    const prisma = fakePrisma({
      id: 'sub_1',
      companyId: 'co_1',
      plan: 'PRO',
      status: 'ACTIVE',
      externalCustomerId: 'cus_1',
      externalSubscriptionId: 'sub_ext_1',
      currentPeriodEnd: null,
      provider: 'stripe',
    });
    const provider = fakeProvider({
      type: 'invoice.payment_failed',
      companyId: 'co_1',
      status: 'PAST_DUE',
    });
    const auditLog = fakeAuditLog();
    const service = new BillingService(
      prisma as never,
      provider,
      fakeUsageService(),
      auditLog as never,
      fakeNotifications(),
    );

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PAST_DUE' }),
      }),
    );
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'co_1',
        action: 'billing.payment_failed',
        entityType: 'Subscription',
        entityId: 'sub_1',
      }),
    );
  });

  it('does not re-log an already-past-due subscription receiving another past-due event', async () => {
    const prisma = fakePrisma({
      id: 'sub_2',
      companyId: 'co_2',
      plan: 'PRO',
      status: 'PAST_DUE',
      externalCustomerId: 'cus_2',
      externalSubscriptionId: 'sub_ext_2',
      currentPeriodEnd: null,
      provider: 'stripe',
    });
    const provider = fakeProvider({
      type: 'invoice.payment_failed',
      companyId: 'co_2',
      status: 'PAST_DUE',
    });
    const auditLog = fakeAuditLog();
    const service = new BillingService(
      prisma as never,
      provider,
      fakeUsageService(),
      auditLog as never,
      fakeNotifications(),
    );

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('a status-neutral event (e.g. a plan-only update) never logs a payment failure', async () => {
    const prisma = fakePrisma({
      id: 'sub_3',
      companyId: 'co_3',
      plan: 'STARTER',
      status: 'ACTIVE',
      externalCustomerId: 'cus_3',
      externalSubscriptionId: 'sub_ext_3',
      currentPeriodEnd: null,
      provider: 'stripe',
    });
    const provider = fakeProvider({
      type: 'customer.subscription.updated',
      companyId: 'co_3',
      plan: 'PRO',
      status: 'ACTIVE',
    });
    const auditLog = fakeAuditLog();
    const service = new BillingService(
      prisma as never,
      provider,
      fakeUsageService(),
      auditLog as never,
      fakeNotifications(),
    );

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(auditLog.record).not.toHaveBeenCalled();
  });
});

describe('BillingService.getPortalUrl', () => {
  it('returns url: null when the active provider has no createPortalSession', async () => {
    const prisma = fakePrisma({
      id: 'sub_4',
      companyId: 'co_4',
      plan: 'PRO',
      status: 'ACTIVE',
      externalCustomerId: 'cus_mock_co_4',
      externalSubscriptionId: null,
      currentPeriodEnd: null,
      provider: 'mock',
    });
    // Mock provider: no createPortalSession method at all.
    const provider = {
      name: 'mock',
      ensureCustomer: jest.fn(),
      changePlan: jest.fn(),
    } as unknown as BillingProvider;
    const service = new BillingService(
      prisma as never,
      provider,
      fakeUsageService(),
      fakeAuditLog() as never,
      fakeNotifications(),
    );

    const result = await service.getPortalUrl('co_4');

    expect(result).toEqual({ url: null });
  });
});
