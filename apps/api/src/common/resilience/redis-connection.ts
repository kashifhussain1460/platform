/**
 * Parse a `REDIS_URL` into ioredis/BullMQ connection options. Mirrors the helper
 * the KnowledgeModule uses for the BullMQ root connection, kept here so the
 * resilience infra (circuit-breaker store, rate limiter, DLQ queues) shares one
 * definition without importing a feature module.
 */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Set when the URL scheme is `rediss:` (TLS) — e.g. Upstash. */
  tls?: Record<string, never>;
}

export function redisConnectionFromUrl(url: string): RedisConnectionOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    // ioredis only auto-negotiates TLS when given the raw URL string; since
    // we deconstruct into host/port/user/pass, the `rediss:` scheme has to
    // be re-applied explicitly or the connection silently downgrades to a
    // plaintext connection that TLS-only providers (Upstash) will reject.
    ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}
