import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { METRIC, MetricsRegistry } from '../../common/observability/metrics.registry';
import { CreditReservationService } from './credit-reservation.service';
import { CREDIT_RESERVATION_SWEEP_BATCH } from './credit-reservation-sweep.constants';

/**
 * Closes the plan's Final Architecture Decision Q8 "hard prerequisite":
 * register the sweep so it actually runs on this platform's
 * `QUEUE_WORKERS_ENABLED=false` deployment path (Phase 2, Task 2.8).
 *
 * Covers ONLY the chat/assist orphan case — cross-tenant, `WHERE
 * status='PENDING' AND workflowStepRunId IS NULL AND leaseExpiresAt <
 * now()`. Workflow-tied reservations are resolved by the durable engine's
 * own terminal-transition hook (a later phase), never by this sweep — a
 * workflow step has a much richer notion of "did this actually finish" than
 * a bare lease timer can express.
 */
@Injectable()
export class CreditReservationSweepService {
  private readonly logger = new Logger(CreditReservationSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: CreditReservationService,
    private readonly metrics: MetricsRegistry,
  ) {}

  async sweep(asOf: Date = new Date()): Promise<{ swept: number; expiredUnknown: number }> {
    const stale = await this.prisma.creditReservation.findMany({
      where: { status: 'PENDING', workflowStepRunId: null, leaseExpiresAt: { lt: asOf } },
      orderBy: { leaseExpiresAt: 'asc' },
      take: CREDIT_RESERVATION_SWEEP_BATCH,
    });

    let expiredUnknown = 0;
    let swept = 0;
    for (const row of stale) {
      try {
        // GUM-claim as EXPIRED_UNKNOWN first: if two sweep ticks race on the
        // same stale row, only one wins this updateMany (count===0 for the
        // loser, which skips it entirely) — this is what makes "claimed
        // exactly once even when the sweep runs twice concurrently" true.
        const claimed = await this.prisma.creditReservation.updateMany({
          where: { id: row.id, status: 'PENDING' },
          data: { status: 'EXPIRED_UNKNOWN' },
        });
        if (claimed.count === 0) continue;
        expiredUnknown += 1;
        this.metrics.counter(
          METRIC.creditReservationLeakDetectedTotal,
          'Stale reservations found and force-resolved by the sweep',
          { companyId: row.companyId },
        );

        // Default-to-release (§33): the safer failure direction for an
        // orphaned chat/assist reservation is giving the credits back, not
        // leaving them held forever.
        await this.reservations.release({
          reservationId: row.id,
          companyId: row.companyId,
          reason: 'Reservation-leak sweep: lease expired with no settlement or release',
        });
        swept += 1;
      } catch (err) {
        // One bad row must not stall the sweep loop for the rest of the batch.
        this.logger.error(
          `credit-reservation-sweep failed for reservation ${row.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (swept > 0) {
      this.logger.warn(`credit-reservation-sweep released ${swept} stale reservation(s)`);
    }
    return { swept, expiredUnknown };
  }
}
