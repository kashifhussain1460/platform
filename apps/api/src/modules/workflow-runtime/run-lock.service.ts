import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * The transactional Prisma client handed to a `withRunLock` callback.
 *
 * Prisma's own `TransactionClient` — NOT `Omit<PrismaService, …>`, which would
 * drag in the NestJS lifecycle hooks (`onModuleInit`/`onModuleDestroy`) that a
 * transaction client does not have.
 */
export type PrismaTransaction = Prisma.TransactionClient;

/** What `withRunLock` returns when another worker already holds the run. */
export const LOCK_NOT_ACQUIRED = Symbol('LOCK_NOT_ACQUIRED');
export type LockNotAcquired = typeof LOCK_NOT_ACQUIRED;

/**
 * P1-04 — per-run serialisation (doc 16 §6.2, ambiguity A1).
 *
 * Guarantees at most one in-flight advance per run.
 *
 * A **Postgres advisory lock**, not a Redis lock. The state being protected
 * lives in Postgres, so the lock must share its failure domain: with a Redis
 * lock, a failover or an eviction could let two workers advance the same run
 * simultaneously and double-execute a node. The cost is one round trip.
 *
 * `pg_try_advisory_xact_lock` is transaction-scoped, so the lock is released on
 * commit OR rollback — including when the worker process dies mid-transaction.
 * That is why it must be taken inside a transaction and why there is no
 * "release" call to forget.
 */
@Injectable()
export class RunLockService {
  private readonly logger = new Logger(RunLockService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Run `fn` while holding the run's advisory lock, or return
   * `LOCK_NOT_ACQUIRED` immediately if another worker holds it.
   *
   * Losing the race is NOT an error: whoever holds the lock will enqueue the
   * next advance, so the caller should simply exit. Treating it as a failure
   * would send a perfectly healthy job to the DLQ.
   */
  async withRunLock<T>(
    runId: string,
    fn: (tx: PrismaTransaction) => Promise<T>,
  ): Promise<T | LockNotAcquired> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${runId}, 0)) AS locked
      `;
      if (!rows[0]?.locked) {
        this.logger.debug(`run lock busy run=${runId}`);
        return LOCK_NOT_ACQUIRED;
      }
      return fn(tx);
    });
  }
}
