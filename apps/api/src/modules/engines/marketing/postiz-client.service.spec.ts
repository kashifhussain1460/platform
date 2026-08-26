import { ConfigService } from '@nestjs/config';
import { CircuitBreakerRegistry } from '../../../common/resilience/circuit-breaker.registry';
import { RateLimiter } from '../../../common/resilience/rate-limiter';
import { PostizClientService } from './postiz-client.service';

describe('PostizClientService', () => {
  const config = new ConfigService({
    POSTIZ_BASE_URL: 'https://postiz.internal.test',
    POSTIZ_API_KEY: 'test-key',
  });
  // No Redis client (null) → the in-memory fallback path, per this repo's
  // own resilience-unit-test convention (circuit-breaker.registry.spec.ts,
  // rate-limiter.spec.ts) — no ioredis-mock needed.
  const breakers = new CircuitBreakerRegistry(null, config);
  const rateLimiter = new RateLimiter(null, config);
  const service = new PostizClientService(config, breakers, rateLimiter);

  it('builds the connect-url request against the configured base URL', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://instagram.com/oauth/authorize?...' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await service.getConnectUrl('instagram');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://postiz.internal.test/public/v1/social/instagram',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'test-key' }),
      }),
    );
    expect(result.url).toContain('instagram.com');
  });

  it('lists posts from the public API', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 'p_1', state: 'PUBLISHED', releaseId: 'ig_123', releaseURL: 'https://instagram.com/p/abc' },
      ],
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const posts = await service.listPosts();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://postiz.internal.test/public/v1/posts',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'test-key' }),
      }),
    );
    expect(posts[0].state).toBe('PUBLISHED');
  });

  it('throws with the response body when listPosts fails', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(service.listPosts()).rejects.toThrow('Postiz listPosts failed: 500');
  });

  it('M-10: gets per-integration analytics from the documented endpoint', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ integration: 'int_1', impressions: 1000 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await service.getIntegrationAnalytics('int_1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://postiz.internal.test/public/v1/analytics/int_1',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'test-key' }) }),
    );
    expect(result).toEqual({ integration: 'int_1', impressions: 1000 });
  });

  it('M-10: gets per-post analytics from the documented endpoint', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ post: 'p_1', likes: 42 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await service.getPostAnalytics('p_1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://postiz.internal.test/public/v1/analytics/post/p_1',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'test-key' }) }),
    );
    expect(result).toEqual({ post: 'p_1', likes: 42 });
  });

  it('M-10: throws with the response body when getPostAnalytics fails', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'not found',
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(service.getPostAnalytics('missing')).rejects.toThrow(
      'Postiz getPostAnalytics failed: 404',
    );
  });

  it('C-07: listPosts() — the method MarketingSyncService.sweep() calls directly, bypassing SkillsService entirely — is now protected by the SAME circuit breaker as every other call', async () => {
    // A fresh breaker/service pair so this test's failures don't pollute the
    // shared resourceKey the other tests in this file also use.
    const freshBreakers = new CircuitBreakerRegistry(null, config);
    const freshRateLimiter = new RateLimiter(null, config);
    const freshService = new PostizClientService(config, freshBreakers, freshRateLimiter);
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'down' });
    global.fetch = fetchMock as unknown as typeof fetch;

    // Default CIRCUIT_FAILURE_THRESHOLD is 5 (circuit-breaker.registry.ts).
    for (let i = 0; i < 5; i += 1) {
      await expect(freshService.listPosts()).rejects.toThrow();
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);

    // 6th call: breaker OPEN, fetch must NOT be invoked again.
    await expect(freshService.listPosts()).rejects.toThrow(/circuit/i);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
