import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis, { type Redis } from 'ioredis';
import { redisConnectionFromUrl } from './redis-connection';

/**
 * DI token for the shared resilience Redis client. Distinct from BullMQ's own
 * connections: this one backs the circuit-breaker store + rate-limiter token
 * buckets. `@Optional()` at injection sites means consumers degrade to their
 * in-memory fallback if it is ever null.
 */
export const RESILIENCE_REDIS = Symbol('RESILIENCE_REDIS');

/**
 * Build the shared resilience Redis client. Tuned to FAIL FAST when Redis is
 * unavailable (`enableOfflineQueue: false`, capped retries) so callers fall back
 * to their in-memory maps instead of hanging. An `error` listener swallows
 * connection errors (they would otherwise crash the process as unhandled).
 */
export function createResilienceRedis(config: ConfigService): Redis {
  const logger = new Logger('ResilienceRedis');
  const conn = redisConnectionFromUrl(config.getOrThrow<string>('REDIS_URL'));
  const client = new IORedis({
    host: conn.host,
    port: conn.port,
    username: conn.username,
    password: conn.password,
    tls: conn.tls,
    // Commands reject immediately while disconnected → in-memory fallback kicks in.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
    lazyConnect: false,
  });
  client.on('error', (err) => {
    // Best-effort: the breaker/limiter fall back to memory on command failure.
    logger.debug(`resilience redis error: ${err.message}`);
  });
  return client;
}
