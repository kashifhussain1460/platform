import { CreditReservationSweepService } from './credit-reservation-sweep.service';
import { METRIC } from '../../common/observability/metrics.registry';

/**
 * Credit system Phase 13, Task 13.2 — the "worker crashed mid-LLM-call"
 * chaos scenario for credit reservations (Failed-Executions Case 4/8).
 *
 * A real `SIGKILL` cannot be scripted inside a jest process (same limitation
 * `workflow-side-effect-safety.e2e-spec.ts` notes for the workflow engine),
 * so the crash state is reproduced directly: a `PENDING` reservation whose
 * lease has already expired, with no settle/release ever having run for it
 * — exactly what a worker dying between "reserve" and "settle" leaves
 * behind. This is a UNIT test (fully faked Prisma), not an e2e one,
 * DELIBERATELY: `CreditReservationSweepService.sweep()` is cross-tenant by
 * design (same as the workflow reaper), and the shared dev database used by
 * this repo's e2e suites holds real, unrelated tenant data that a live
 * `sweep()` call would also mutate — the exact caution the workflow-runtime
 * suite's own header comment already states for the same reason.
 */
describe('CreditReservationSweepService (worker-crash-mid-reservation chaos scenario)', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');
  const staleReservation = {
    id: 'res_1',
    companyId: 'company_1',
    status: 'PENDING',
    workflowStepRunId: null,
    leaseExpiresAt: new Date(now.getTime() - 60_000), // expired a minute ago
  };

  function makeService(updateManyCount: number) {
    const findMany = jest.fn().mockResolvedValue([staleReservation]);
    const updateMany = jest.fn().mockResolvedValue({ count: updateManyCount });
    const prisma = {
      creditReservation: { findMany, updateMany },
    } as unknown as import('../../common/prisma/prisma.service').PrismaService;
    const release = jest.fn().mockResolvedValue(undefined);
    const reservations = { release } as unknown as import('./credit-reservation.service').CreditReservationService;
    const counter = jest.fn();
    const metrics = { counter } as unknown as import('../../common/observability/metrics.registry').MetricsRegistry;
    return { service: new CreditReservationSweepService(prisma, reservations, metrics), findMany, updateMany, release, counter };
  }

  it('never opens the reservation for a second sweep (the guarded updateMany claims it exactly once)', async () => {
    const { service, updateMany } = makeService(1);
    await service.sweep(now);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: staleReservation.id, status: 'PENDING' },
      data: { status: 'EXPIRED_UNKNOWN' },
    });
  });

  it('increments credit_reservation_leak_detected_total for a genuinely orphaned reservation', async () => {
    const { service, counter } = makeService(1);
    await service.sweep(now);
    expect(counter).toHaveBeenCalledWith(
      METRIC.creditReservationLeakDetectedTotal,
      expect.any(String),
      { companyId: staleReservation.companyId },
    );
  });

  it('is never silently left held forever, and never double-charged: it is released back exactly once', async () => {
    const { service, release } = makeService(1);
    const result = await service.sweep(now);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: staleReservation.id, companyId: staleReservation.companyId }),
    );
    expect(result).toEqual({ swept: 1, expiredUnknown: 1 });
  });

  it('a concurrent sweep tick that loses the race (updateMany count=0) skips the row entirely — no double release', async () => {
    const { service, release, counter } = makeService(0);
    const result = await service.sweep(now);
    expect(release).not.toHaveBeenCalled();
    expect(counter).not.toHaveBeenCalled();
    expect(result).toEqual({ swept: 0, expiredUnknown: 0 });
  });
});
