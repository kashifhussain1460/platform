import { Prisma } from '@prisma/client';
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
  lastAppliedEventId: string | null;
  lastAppliedEventCreatedAt: Date | null;
}

/**
 * A fake PrismaService exposing `subscription`, `processedWebhookEvent`, and
 * a pass-through `$transaction` — Task 6.1's dedupe-insert-first refactor
 * routes every webhook through a transaction now, so these tests must supply
 * one (a plain passthrough is enough: none of them ever race).
 */
function fakePrisma(row: FakeSubscriptionRow) {
  const current = { ...row };
  const processedEventIds = new Set<string>();
  const self: Record<string, unknown> = {
    subscription: {
      findUnique: jest.fn(async () => ({ ...current })),
      findUniqueOrThrow: jest.fn(async () => ({ ...current })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(current, data);
        return { ...current };
      }),
    },
    processedWebhookEvent: {
      create: jest.fn(async ({ data }: { data: { externalEventId: string } }) => {
        if (processedEventIds.has(data.externalEventId)) {
          throw new Prisma.PrismaClientKnownRequestError('duplicate', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        processedEventIds.add(data.externalEventId);
        return { id: 'pwe_1', ...data };
      }),
    },
  };
  self.$transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(self));
  return self as unknown as {
    subscription: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
    };
    processedWebhookEvent: { create: jest.Mock };
    $transaction: jest.Mock;
  };
}

function fakeProvider(
  event: Omit<BillingWebhookEvent, 'externalEventId' | 'payload' | 'createdAt'> & {
    externalEventId?: string;
    createdAt?: Date;
  },
): BillingProvider {
  const full: BillingWebhookEvent = {
    externalEventId: event.externalEventId ?? `evt_${Math.random()}`,
    payload: {},
    createdAt: event.createdAt ?? new Date(),
    ...event,
  };
  return {
    name: 'fake',
    ensureCustomer: jest.fn(),
    changePlan: jest.fn(),
    parseWebhookEvent: jest.fn(async () => full),
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

function fakeCreditLedger() {
  return { append: jest.fn() } as never;
}

function fakeCreditRefund() {
  return { refundFromStripeEvent: jest.fn().mockResolvedValue(undefined) } as never;
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
      lastAppliedEventId: null,
      lastAppliedEventCreatedAt: null,
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
      fakeCreditLedger(),
      fakeCreditRefund(),
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
      lastAppliedEventId: null,
      lastAppliedEventCreatedAt: null,
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
      fakeCreditLedger(),
      fakeCreditRefund(),
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
      lastAppliedEventId: null,
      lastAppliedEventCreatedAt: null,
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
      fakeCreditLedger(),
      fakeCreditRefund(),
    );

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(auditLog.record).not.toHaveBeenCalled();
  });
});

describe('BillingService webhook dedupe + out-of-order guard (Phase 6, Tasks 6.1/6.2)', () => {
  it('a redelivered event (same externalEventId) is a clean no-op the second time', async () => {
    const prisma = fakePrisma({
      id: 'sub_5',
      companyId: 'co_5',
      plan: 'PRO',
      status: 'ACTIVE',
      externalCustomerId: 'cus_5',
      externalSubscriptionId: 'sub_ext_5',
      currentPeriodEnd: null,
      provider: 'stripe',
      lastAppliedEventId: null,
      lastAppliedEventCreatedAt: null,
    });
    const provider = fakeProvider({
      type: 'invoice.payment_failed',
      externalEventId: 'evt_fixed',
      companyId: 'co_5',
      status: 'PAST_DUE',
    });
    const auditLog = fakeAuditLog();
    const service = new BillingService(
      prisma as never,
      provider,
      fakeUsageService(),
      auditLog as never,
      fakeNotifications(),
      fakeCreditLedger(),
      fakeCreditRefund(),
    );

    await service.handleWebhook(Buffer.from('{}'), 'sig');
    await service.handleWebhook(Buffer.from('{}'), 'sig'); // redelivery

    expect(auditLog.record).toHaveBeenCalledTimes(1);
  });

  it('a stale out-of-order PAST_DUE event arriving after a newer ACTIVE one does not revert status', async () => {
    const newer = new Date('2026-01-02T00:00:00Z');
    const older = new Date('2026-01-01T00:00:00Z');
    const prisma = fakePrisma({
      id: 'sub_6',
      companyId: 'co_6',
      plan: 'PRO',
      status: 'ACTIVE',
      externalCustomerId: 'cus_6',
      externalSubscriptionId: 'sub_ext_6',
      currentPeriodEnd: null,
      provider: 'stripe',
      lastAppliedEventId: 'evt_newer',
      lastAppliedEventCreatedAt: newer, // a newer event already applied
    });
    const provider = fakeProvider({
      type: 'invoice.payment_failed',
      externalEventId: 'evt_older',
      createdAt: older,
      companyId: 'co_6',
      status: 'PAST_DUE',
    });
    const service = new BillingService(
      prisma as never,
      provider,
      fakeUsageService(),
      fakeAuditLog() as never,
      fakeNotifications(),
      fakeCreditLedger(),
      fakeCreditRefund(),
    );

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(prisma.subscription.update).not.toHaveBeenCalled();
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
      lastAppliedEventId: null,
      lastAppliedEventCreatedAt: null,
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
      fakeCreditLedger(),
      fakeCreditRefund(),
    );

    const result = await service.getPortalUrl('co_4');

    expect(result).toEqual({ url: null });
  });
});
