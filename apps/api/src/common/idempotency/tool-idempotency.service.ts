import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface RunIdempotentParams<T> {
  companyId: string;
  skillKey: string;
  tool: string;
  /** Caller-computed dedup key — this service has no opinion on its shape. */
  key: string;
  /** How long a COMPLETED result is replayed before a fresh attempt is allowed. */
  windowMs: number;
  /** The actual external side effect. Runs at most once per (key, window). */
  effect: () => Promise<T>;
}

export interface RunIdempotentResult<T> {
  result: T;
  /** True when a prior COMPLETED result was replayed — `effect` did NOT run. */
  deduped: boolean;
}

/**
 * M-06: the generic, engine-agnostic idempotency primitive. `postiz.
 * publish_now` already has its own working record-before-effect pattern
 * (`ScheduledPost.idempotencyKey`) — left as-is, not rewritten. This exists
 * so its SIBLING `schedule_post` (which had NONE — a retried call created a
 * real duplicate scheduled post at Postiz) and any future external-effect
 * tool (a Chatwoot reply, a future payment/CRM-mutation tool) get the same
 * protection without inventing a new dedicated column on their own table
 * every time. Never names a specific provider.
 *
 * Lives in `common/` (not `modules/skills/`) so `RealSkillExecutor` can
 * depend on it directly without a module-import cycle — mirrors why
 * `ApprovalRoutingService`/`NotificationsService` are dependency-light forks.
 */
@Injectable()
export class ToolIdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async runIdempotent<T>(
    params: RunIdempotentParams<T>,
  ): Promise<RunIdempotentResult<T>> {
    const { companyId, skillKey, tool, key, windowMs, effect } = params;
    const where = {
      companyId_skillKey_tool_idempotencyKey: {
        companyId,
        skillKey,
        tool,
        idempotencyKey: key,
      },
    };

    // 1) Claim the row BEFORE calling the effect (record-before-effect).
    let recordId: string;
    try {
      const created = await this.prisma.toolIdempotencyRecord.create({
        data: { companyId, skillKey, tool, idempotencyKey: key, status: 'PENDING' },
      });
      recordId = created.id;
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
      ) {
        throw err;
      }
      // Lost the race (or a genuine prior call) — decide from the winning row.
      const prior = await this.prisma.toolIdempotencyRecord.findUniqueOrThrow({ where });
      const withinWindow = Date.now() - prior.createdAt.getTime() < windowMs;

      if (prior.status === 'COMPLETED' && withinWindow) {
        return { result: prior.resultJson as T, deduped: true };
      }
      if (prior.status === 'PENDING' && withinWindow) {
        throw new ConflictException(
          `${skillKey}.${tool} is already in flight for this request`,
        );
      }
      // FAILED, or COMPLETED outside the window: treat as a fresh attempt,
      // reusing the same row rather than opening a second one.
      const reopened = await this.prisma.toolIdempotencyRecord.update({
        where: { id: prior.id },
        data: { status: 'PENDING', resultJson: Prisma.JsonNull, errorMessage: null },
      });
      recordId = reopened.id;
    }

    // 2) The effect.
    try {
      const result = await effect();
      await this.prisma.toolIdempotencyRecord.update({
        where: { id: recordId },
        data: { status: 'COMPLETED', resultJson: result as Prisma.InputJsonValue },
      });
      return { result, deduped: false };
    } catch (err) {
      await this.prisma.toolIdempotencyRecord.update({
        where: { id: recordId },
        data: {
          status: 'FAILED',
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  }
}
