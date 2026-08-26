import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { RESILIENCE_REDIS } from '../../common/resilience/redis.provider';

/**
 * // FOUNDER-PENDING: §26/§27 — Option A conservative fixed default
 * (`COMPANY_MAX_CONCURRENT_EXECUTIONS`), RECOMMENDED over a per-plan tiered
 * cap (more precise, but invents pricing-tier numbers this repo doesn't have)
 * or no cap at all (the confirmed gap this task closes).
 */
const DEFAULT_MAX_CONCURRENT_EXECUTIONS = 10;
/** Safety TTL on the Redis counter — a crashed process that never calls
 * `release()` must not permanently lock a company out. */
const COUNTER_TTL_SECONDS = 300;

/**
 * Credit system Phase 10, Task 10.5 (§26/§27) — a per-company in-flight
 * execution cap, closing the confirmed gap that no such limiter exists
 * today. Same Redis-with-in-memory-fallback shape as `RateLimiter`
 * (`common/resilience/rate-limiter.ts`) — a `company:<id>` INCR/DECR counter
 * rather than that class's fixed-WINDOW token bucket, since concurrency
 * (how many are running RIGHT NOW) and rate (how many per time window) are
 * different questions with different primitives.
 *
 * `tryAcquire` is called on reserve; the caller MUST call `release` exactly
 * once when the execution ends (settle or release), in a `finally` — an
 * unreleased acquire only self-heals after `COUNTER_TTL_SECONDS`.
 */
@Injectable()
export class CompanyConcurrencyGuardService {
  private readonly logger = new Logger(CompanyConcurrencyGuardService.name);
  private readonly memory = new Map<string, number>();
  readonly maxConcurrent: number;

  constructor(
    @Optional() @Inject(RESILIENCE_REDIS) private readonly redis: Redis | null,
    config: ConfigService,
  ) {
    const raw = Number(config.get<string>('COMPANY_MAX_CONCURRENT_EXECUTIONS'));
    this.maxConcurrent = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_CONCURRENT_EXECUTIONS;
  }

  private key(companyId: string): string {
    return `vaep:concurrency:company:${companyId}`;
  }

  /** Attempt to reserve one in-flight execution slot for this company. */
  async tryAcquire(companyId: string): Promise<boolean> {
    const key = this.key(companyId);
    if (this.redis) {
      try {
        const count = await this.redis.incr(key);
        await this.redis.expire(key, COUNTER_TTL_SECONDS);
        if (count > this.maxConcurrent) {
          // Don't count the rejected attempt itself.
          await this.redis.decr(key);
          return false;
        }
        return true;
      } catch (err) {
        this.logger.debug(
          `redis concurrency guard failed, using memory: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    const current = this.memory.get(companyId) ?? 0;
    if (current >= this.maxConcurrent) return false;
    this.memory.set(companyId, current + 1);
    return true;
  }

  /** Release the slot acquired by a prior successful `tryAcquire`. Idempotent-safe (never goes below 0). */
  async release(companyId: string): Promise<void> {
    const key = this.key(companyId);
    if (this.redis) {
      try {
        const remaining = await this.redis.decr(key);
        if (remaining < 0) await this.redis.set(key, '0', 'EX', COUNTER_TTL_SECONDS);
        return;
      } catch (err) {
        this.logger.debug(
          `redis concurrency guard release failed, using memory: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    const current = this.memory.get(companyId) ?? 0;
    this.memory.set(companyId, Math.max(0, current - 1));
  }

  /** Current in-flight count for a company (observability/testing). */
  async current(companyId: string): Promise<number> {
    if (this.redis) {
      try {
        const value = await this.redis.get(this.key(companyId));
        return value ? Number(value) : 0;
      } catch {
        // fall through
      }
    }
    return this.memory.get(companyId) ?? 0;
  }
}
