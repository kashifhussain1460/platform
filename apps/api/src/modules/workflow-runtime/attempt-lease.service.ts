import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

/** How long a claimed lease stays valid without a heartbeat. */
export const LEASE_TTL_SECONDS = 60;
/** Heartbeat interval — comfortably under the TTL so a slow node stays owned. */
export const LEASE_HEARTBEAT_MS = 20_000;

export interface LeaseClaim {
  attemptId: string;
  workerId: string;
  expiresAt: Date;
}

/**
 * P1-04 — attempt leases (doc 16 §6.3, ambiguity A2).
 *
 * Guarantees at most one worker executes a given attempt.
 *
 * A **guarded single-statement UPDATE**, not `SELECT … FOR UPDATE SKIP LOCKED`.
 * Row locking would hold a transaction open for the attempt's whole lifetime —
 * for a 30-second HTTP call that means a 30-second open transaction, which
 * blocks vacuum and burns a connection. The UPDATE takes the lease and commits
 * immediately; the lease itself (not a DB lock) is what provides exclusion.
 *
 * A dead worker stops heartbeating, its lease expires within
 * `LEASE_TTL_SECONDS`, and the reaper recovers the attempt — satisfying doc
 * 00 §0.8's "orphan recovery < 60s" target.
 */
@Injectable()
export class AttemptLeaseService {
  private readonly logger = new Logger(AttemptLeaseService.name);
  /** Identifies this process in `leaseOwner`, for debugging a stuck attempt. */
  readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Try to take the lease. Returns null when another live worker owns it —
   * which is NOT an error: the caller should exit quietly.
   *
   * The `WHERE` clause is the whole mechanism: it only matches an attempt that
   * is unowned or whose lease has already expired, so two workers racing can
   * never both get a row back.
   *
   * WAVE 1: the status check is part of that guard, not decoration. A COMPLETED
   * attempt has its `leaseOwner` cleared in T2, so without it a redelivered
   * attempt job — BullMQ is at-least-once, and `removeOnComplete` frees the
   * jobId for reuse — would re-claim a FINISHED attempt and re-run its side
   * effect. That is precisely the duplicate external effect the whole runtime
   * exists to prevent.
   *
   * It is `IN ('PENDING','RUNNING')`, not `= 'PENDING'`: an attempt whose lease
   * expired is still RUNNING, and re-claiming it is how a dead worker's work is
   * recovered. Narrowing this to PENDING would close the duplicate-effect hole
   * but also disable that recovery. The two are not in tension — a FINISHED
   * attempt is never re-claimable, an unfinished one is — and in practice the
   * reaper reaches an expired attempt first and marks it `outcomeUnknown`
   * rather than letting it be retried blindly.
   */
  async claim(attemptId: string): Promise<LeaseClaim | null> {
    const expiresAt = new Date(Date.now() + LEASE_TTL_SECONDS * 1000);

    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "WorkflowStepAttempt"
         SET "leaseOwner"     = ${this.workerId},
             "leaseExpiresAt" = now() + make_interval(secs => ${LEASE_TTL_SECONDS}),
             "status"         = 'RUNNING',
             "startedAt"      = COALESCE("startedAt", now())
       WHERE "id" = ${attemptId}
         AND "status" IN ('PENDING', 'RUNNING')
         AND ("leaseOwner" IS NULL OR "leaseExpiresAt" < now())
      RETURNING "id"
    `;

    if (rows.length === 0) {
      this.logger.debug(`lease busy attempt=${attemptId}`);
      return null;
    }
    return { attemptId, workerId: this.workerId, expiresAt };
  }

  /**
   * Extend a lease this worker still owns. Returns false when ownership was
   * lost (the reaper already reclaimed it), which the caller must treat as
   * "stop working" — continuing would race the worker that now owns it.
   */
  async renew(attemptId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "WorkflowStepAttempt"
         SET "leaseExpiresAt" = now() + make_interval(secs => ${LEASE_TTL_SECONDS})
       WHERE "id" = ${attemptId}
         AND "leaseOwner" = ${this.workerId}
      RETURNING "id"
    `;
    return rows.length > 0;
  }

  /**
   * Hand an attempt BACK without having done its work, so another worker can
   * pick it up immediately instead of waiting out the TTL.
   *
   * The status returns to PENDING, which is what makes it claimable again now
   * that `claim` requires PENDING. Only ever call this when the side effect
   * definitely did NOT happen — a graceful shutdown before execution, say. An
   * attempt that already ran is finished by the attempt processor's T2 commit
   * (COMPLETED/FAILED) or, if the worker died mid-effect, by the reaper as
   * `outcomeUnknown`; neither is claimable again, on purpose.
   */
  async release(attemptId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "WorkflowStepAttempt"
         SET "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "status" = 'PENDING'
       WHERE "id" = ${attemptId}
         AND "leaseOwner" = ${this.workerId}
         AND "status" = 'RUNNING'
    `;
  }

  /**
   * Start a heartbeat that keeps the lease alive while a node runs. The
   * returned function MUST be called in a `finally` — a leaked interval keeps
   * an abandoned attempt looking alive forever, which is the one failure mode
   * the reaper cannot detect.
   */
  startHeartbeat(attemptId: string): () => void {
    const timer = setInterval(() => {
      void this.renew(attemptId).then((held) => {
        if (!held) {
          this.logger.warn(
            `lease lost during execution attempt=${attemptId} worker=${this.workerId}`,
          );
        }
      });
    }, LEASE_HEARTBEAT_MS);
    // Never hold the process open just for a heartbeat.
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

/**
 * Idempotency key for one attempt's side effect (doc 16 §6.4, ambiguity A3).
 *
 * Keyed per **attempt**, deliberately — NOT per node. A retry is a new attempt
 * and must be allowed to re-issue the call, because the previous one may have
 * failed before ever reaching the provider. Keying per node would make every
 * retry a silent no-op at the provider, which looks like success and is not.
 */
export function attemptIdempotencyKey(
  runId: string,
  nodeId: string,
  attempt: number,
): string {
  return createHash('sha256')
    .update(`${runId}:${nodeId}:${attempt}`)
    .digest('hex');
}
