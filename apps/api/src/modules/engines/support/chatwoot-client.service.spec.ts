import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ChatwootClientService } from './chatwoot-client.service';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { CircuitBreakerRegistry } from '../../../common/resilience/circuit-breaker.registry';
import { RateLimiter } from '../../../common/resilience/rate-limiter';

describe('ChatwootClientService', () => {
  const config = new ConfigService({
    CHATWOOT_BASE_URL: 'https://chatwoot.internal.test',
    CHATWOOT_PLATFORM_API_TOKEN: 'test-platform-token',
  });
  const crypto = new CryptoService(config);
  // No Redis client (null) → the in-memory fallback path, per this repo's
  // own resilience-unit-test convention.
  const breakers = new CircuitBreakerRegistry(null, config);
  const rateLimiter = new RateLimiter(null, config);
  const service = new ChatwootClientService(config, crypto, breakers, rateLimiter);

  it('sends a reply using the per-company agent bot token, not the platform token', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 42 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await service.sendReply('acct-1', 'conv-1', 'bot-token-abc', 'Hello, how can I help?');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/accounts/acct-1/conversations/conv-1/messages');
    expect(init.headers.api_access_token).toBe('bot-token-abc');
  });

  it('verifies a webhook signature correctly (real Chatwoot scheme: sha256=<hex of "ts.body">)', () => {
    const secret = 'shared-secret';
    const body = '{"event":"message_created"}';
    const ts = String(Math.floor(Date.now() / 1000));
    const validSig = `sha256=${createHmac('sha256', secret)
      .update(`${ts}.${body}`)
      .digest('hex')}`;
    expect(service.verifyWebhookSignature(body, validSig, ts, secret)).toBe(true);
    expect(service.verifyWebhookSignature(body, 'sha256=wrong', ts, secret)).toBe(false);
    // Missing/garbled headers must fail closed, not throw.
    expect(service.verifyWebhookSignature(body, undefined, ts, secret)).toBe(false);
    expect(service.verifyWebhookSignature(body, validSig, undefined, secret)).toBe(false);
    // A stale timestamp (outside the replay window) must be rejected even
    // with an otherwise-correct signature.
    const staleTs = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const staleSig = `sha256=${createHmac('sha256', secret)
      .update(`${staleTs}.${body}`)
      .digest('hex')}`;
    expect(service.verifyWebhookSignature(body, staleSig, staleTs, secret)).toBe(false);
  });
});
