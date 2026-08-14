import {
  Global,
  Inject,
  Module,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { CircuitBreakerRegistry } from './circuit-breaker.registry';
import { DlqService } from './dlq.service';
import { RateLimiter } from './rate-limiter';
import { createResilienceRedis, RESILIENCE_REDIS } from './redis.provider';

/**
 * Global resilience infra (Unit C, docs §4.4/§9): a shared Redis client backing
 * the per-connector circuit breakers and egress rate limiter, plus the DLQ admin
 * service. `@Global` so the egress path (SkillsService) and the admin module can
 * inject these without importing this module. The Redis client is quit on
 * shutdown so tests (which `app.close()`) don't leak a handle.
 */
@Global()
@Module({
  providers: [
    {
      provide: RESILIENCE_REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createResilienceRedis(config),
    },
    CircuitBreakerRegistry,
    RateLimiter,
    DlqService,
  ],
  // RESILIENCE_REDIS is exported so the realtime fan-out can publish on it.
  // It is @Optional() at every injection site, so a deployment without Redis
  // degrades rather than failing to boot.
  exports: [CircuitBreakerRegistry, RateLimiter, DlqService, RESILIENCE_REDIS],
})
export class ResilienceModule implements OnModuleDestroy {
  constructor(
    @Inject(RESILIENCE_REDIS) private readonly redis: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // best-effort; the process is shutting down
    }
  }
}
