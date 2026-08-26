import { Injectable } from '@nestjs/common';
import { asFetchResponse, type FetchResponseLike } from '../http/fetch-response';
import { CircuitBreakerRegistry } from './circuit-breaker.registry';
import { countsTowardCircuit } from './error-classifier';
import { RateLimiter, RateLimitedError } from './rate-limiter';

export interface GuardedFetchRateLimit {
  limit: number;
  windowMs: number;
}

/**
 * C-07: the standard outbound-protection layer for engine HTTP clients
 * (Postiz, Chatwoot, and any future engine). Every `fetch()` call an engine
 * client makes MUST go through `guardedFetch`, not raw `fetch()` — this is
 * enforced by putting the wrap in the CLIENT itself (subclasses extend this
 * base), not by a call-site convention that a future engine could forget.
 *
 * Before this existed, `SkillsService.runGuardedEgress` was the only wrap,
 * keyed on `installedSkillId` — but that resolves to `null` for a workflow
 * TOOL_ACTION with no employee-scoped `InstalledSkill` context (the common
 * case for a bare `TOOL_ACTION` node), and `MarketingSyncService.sweep()`
 * calls `PostizClientService` directly, bypassing `SkillsService` entirely.
 * Both paths ran completely unwrapped. Wrapping in the client fixes both at
 * once, for free, for any future caller too.
 *
 * `resourceKey` is the breaker/rate-limit IDENTITY, chosen by each subclass
 * based on how its provider is actually deployed — see each subclass's own
 * doc comment (a single shared instance needs one global key; a per-tenant
 * instance needs a per-tenant key, or one tenant's outage would trip the
 * breaker for every other tenant).
 */
@Injectable()
export abstract class ResilientClientBase {
  constructor(
    protected readonly breakers: CircuitBreakerRegistry,
    protected readonly rateLimiter: RateLimiter,
  ) {}

  protected async guardedFetch(
    resourceKey: string,
    input: string,
    init?: RequestInit,
    rateLimit?: GuardedFetchRateLimit,
  ): Promise<FetchResponseLike> {
    // 1) Circuit gate — OPEN → fast-fail, the provider is NOT called.
    await this.breakers.guard(resourceKey);

    // 2) Rate limit (only when the subclass supplies a budget for this call —
    //    Postiz's real instance-wide cap; Chatwoot has no documented one).
    if (rateLimit) {
      const allowed = await this.rateLimiter.tryAcquire(
        resourceKey,
        rateLimit.limit,
        rateLimit.windowMs,
      );
      if (!allowed) {
        throw new RateLimitedError(resourceKey);
      }
    }

    // 3) The call. A thrown error (network failure) records against the
    //    breaker via the SAME classifier SkillsService.runGuardedEgress uses.
    let res: FetchResponseLike;
    try {
      res = asFetchResponse(await fetch(input, init));
    } catch (err) {
      if (countsTowardCircuit(err)) {
        await this.breakers.recordFailure(resourceKey);
      }
      throw err;
    }

    // 4) `fetch()` does NOT throw on a non-2xx HTTP status — classify the
    //    response's own status the same way a thrown error would be, so a
    //    provider's 500/429 trips the breaker exactly like SkillsService's
    //    egress path already does for every other skill.
    if (res.ok) {
      await this.breakers.recordSuccess(resourceKey);
    } else if (countsTowardCircuit(res.status)) {
      await this.breakers.recordFailure(resourceKey);
    }
    return res;
  }
}
