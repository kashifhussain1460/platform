import { ConfigService } from '@nestjs/config';
import { CircuitBreakerRegistry } from './circuit-breaker.registry';
import { CircuitOpenError } from './circuit-breaker';
import { RateLimiter, RateLimitedError } from './rate-limiter';
import { ResilientClientBase } from './resilient-client.base';

/** Exposes the protected guardedFetch for direct testing. */
class TestClient extends ResilientClientBase {
  call(resourceKey: string, url: string, rateLimit?: { limit: number; windowMs: number }) {
    return this.guardedFetch(resourceKey, url, undefined, rateLimit);
  }
}

describe('ResilientClientBase.guardedFetch', () => {
  // No Redis client (null) → the in-memory fallback path, per this repo's
  // own resilience-unit-test convention (circuit-breaker.registry.spec.ts).
  const config = new ConfigService({ CIRCUIT_FAILURE_THRESHOLD: '3' });

  function build() {
    const breakers = new CircuitBreakerRegistry(null, config);
    const rateLimiter = new RateLimiter(null, config);
    const client = new TestClient(breakers, rateLimiter);
    return { client, breakers, rateLimiter };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes the fetch through and records success on a 2xx response', async () => {
    const { client } = build();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await client.call('engine:test', 'https://example.test/ok');
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/ok', undefined);
  });

  it('trips the breaker after enough 5xx responses and fast-fails without calling fetch again', async () => {
    const { client } = build();
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    global.fetch = fetchMock as unknown as typeof fetch;

    // CIRCUIT_FAILURE_THRESHOLD=3 above.
    await client.call('engine:test-trip', 'https://example.test/fail');
    await client.call('engine:test-trip', 'https://example.test/fail');
    const third = await client.call('engine:test-trip', 'https://example.test/fail');
    expect(third.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // 4th attempt: breaker is OPEN, fetch must NOT be called again.
    await expect(client.call('engine:test-trip', 'https://example.test/fail')).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('uses the resourceKey verbatim — one key tripping does not affect a different key', async () => {
    const { client } = build();
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    global.fetch = fetchMock as unknown as typeof fetch;

    for (let i = 0; i < 3; i += 1) {
      await client.call('engine:chatwoot:company-A', 'https://example.test/fail');
    }
    await expect(
      client.call('engine:chatwoot:company-A', 'https://example.test/fail'),
    ).rejects.toBeInstanceOf(CircuitOpenError);

    // A DIFFERENT company's key must be completely unaffected — mirrors
    // Chatwoot's per-company resource key design (C-07).
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const other = await client.call('engine:chatwoot:company-B', 'https://example.test/ok');
    expect(other.ok).toBe(true);
  });

  it('enforces a shared rate-limit budget across calls with the SAME global key (M-07/C-10)', async () => {
    const { client } = build();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;

    const budget = { limit: 2, windowMs: 60_000 };
    // Two different "companies" both calling through the SAME global resource
    // key (as PostizClientService does) share the cap even though neither
    // individually approaches any per-company limit.
    await client.call('engine:postiz', 'https://example.test/company-a', budget);
    await client.call('engine:postiz', 'https://example.test/company-b', budget);
    await expect(
      client.call('engine:postiz', 'https://example.test/company-a-again', budget),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not rate-limit when no budget is supplied (Chatwoot has none)', async () => {
    const { client } = build();
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;

    for (let i = 0; i < 5; i += 1) {
      await client.call('engine:chatwoot:company-C', 'https://example.test/ok');
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
