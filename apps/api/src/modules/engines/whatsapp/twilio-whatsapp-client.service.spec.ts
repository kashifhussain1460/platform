import twilio from 'twilio';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerRegistry } from '../../../common/resilience/circuit-breaker.registry';
import { RateLimiter, RateLimitedError } from '../../../common/resilience/rate-limiter';
import { TwilioWhatsappClientService } from './twilio-whatsapp-client.service';

describe('TwilioWhatsappClientService', () => {
  const config = new ConfigService({});
  const breakers = new CircuitBreakerRegistry(null, config);
  const rateLimiter = new RateLimiter(null, config);
  const service = new TwilioWhatsappClientService(breakers, rateLimiter);

  it('sends a free-form message via the Twilio SDK', async () => {
    const create = jest.fn().mockResolvedValue({ sid: 'MM123', status: 'queued' });
    jest.spyOn(service as any, 'clientFor').mockReturnValue({ messages: { create } });

    const result = await service.sendFreeform({
      companyId: 'c_1',
      accountSid: 'ACxxx',
      authToken: 'secret',
      from: '+15550001111',
      to: '+15550002222',
      body: 'Hi there',
    });

    expect(create).toHaveBeenCalledWith({
      from: 'whatsapp:+15550001111',
      to: 'whatsapp:+15550002222',
      body: 'Hi there',
    });
    expect(result).toEqual({ sid: 'MM123', status: 'queued' });
  });

  it('sends a template message via the Twilio SDK', async () => {
    const create = jest.fn().mockResolvedValue({ sid: 'MM456', status: 'queued' });
    jest.spyOn(service as any, 'clientFor').mockReturnValue({ messages: { create } });

    const result = await service.sendTemplate({
      companyId: 'c_1',
      accountSid: 'ACxxx',
      authToken: 'secret',
      from: '+15550001111',
      to: '+15550002222',
      contentSid: 'HXabc',
      contentVariables: { '1': 'March 25' },
    });

    expect(create).toHaveBeenCalledWith({
      from: 'whatsapp:+15550001111',
      to: 'whatsapp:+15550002222',
      contentSid: 'HXabc',
      contentVariables: JSON.stringify({ '1': 'March 25' }),
    });
    expect(result).toEqual({ sid: 'MM456', status: 'queued' });
  });

  it('verifies a real Twilio-signed request via the SDK validator', () => {
    const authToken = 'test-auth-token';
    const url = 'https://example.com/engines/whatsapp/webhook';
    const params = { MessageSid: 'MM1', From: 'whatsapp:+15550002222', Body: 'hi' };
    // NOTE: task-4-brief.md's literal test code calls
    // `twilio.getExpectedTwilioSignature({ authToken } as any, url, params)`, but the
    // installed `twilio` SDK's actual signature is `(authToken: string, url, params)`
    // (see node_modules/twilio/lib/webhooks/webhooks.js) — passing an object there
    // throws inside crypto.createHmac ("key" argument must be a string...). Calling
    // it with the bare string below is the corrected, working form; the assertion
    // being exercised (verifyWebhookSignature's correctness) is unchanged.
    const signature = twilio.getExpectedTwilioSignature(authToken, url, params);

    expect(service.verifyWebhookSignature(authToken, signature, url, params)).toBe(true);
    expect(service.verifyWebhookSignature(authToken, 'wrong-signature', url, params)).toBe(false);
  });

  /**
   * I1 — the resilience layer was inert: `guard()` was called but neither
   * `recordSuccess` nor `recordFailure` ever was, so the circuit breaker could
   * not open on a real Twilio outage, and the injected `RateLimiter` was never
   * touched at all. These assertions are on the seams, since the breaker's own
   * state lives in Redis (absent in a unit test).
   */
  describe('resilience (C-07)', () => {
    const scoped = new TwilioWhatsappClientService(breakers, rateLimiter);

    beforeEach(() => jest.restoreAllMocks());

    it('gates on the breaker, takes a rate-limit token and records success — all keyed on the COMPANY', async () => {
      const guard = jest.spyOn(breakers, 'guard').mockResolvedValue(undefined);
      const recordSuccess = jest.spyOn(breakers, 'recordSuccess').mockResolvedValue(undefined);
      const tryAcquire = jest.spyOn(rateLimiter, 'tryAcquire').mockResolvedValue(true);
      jest.spyOn(scoped as any, 'clientFor').mockReturnValue({
        messages: { create: jest.fn().mockResolvedValue({ sid: 'MM1', status: 'queued' }) },
      });

      await scoped.sendFreeform({
        companyId: 'c_1',
        // A DIFFERENT account sid, to prove the key follows the tenant and not
        // the Twilio credential — two tenants can share a sandbox SID.
        accountSid: 'ACshared',
        authToken: 'secret',
        from: '+15550001111',
        to: '+15550002222',
        body: 'hi',
      });

      expect(guard).toHaveBeenCalledWith('engine:whatsapp:c_1');
      expect(tryAcquire).toHaveBeenCalledWith('engine:whatsapp:c_1', expect.any(Number), expect.any(Number));
      expect(recordSuccess).toHaveBeenCalledWith('engine:whatsapp:c_1');
    });

    it('records a failure against the breaker when Twilio errors', async () => {
      jest.spyOn(breakers, 'guard').mockResolvedValue(undefined);
      const recordFailure = jest.spyOn(breakers, 'recordFailure').mockResolvedValue(undefined);
      jest.spyOn(rateLimiter, 'tryAcquire').mockResolvedValue(true);
      jest.spyOn(scoped as any, 'clientFor').mockReturnValue({
        messages: { create: jest.fn().mockRejectedValue(Object.assign(new Error('Twilio down'), { status: 503 })) },
      });

      await expect(
        scoped.sendTemplate({
          companyId: 'c_1',
          accountSid: 'ACxxx',
          authToken: 'secret',
          from: '+15550001111',
          to: '+15550002222',
          contentSid: 'HXabc',
          contentVariables: {},
        }),
      ).rejects.toThrow('Twilio down');
      expect(recordFailure).toHaveBeenCalledWith('engine:whatsapp:c_1');
    });

    it('does NOT open the breaker on a plain validation error (our bad input, not Twilio failing)', async () => {
      jest.spyOn(breakers, 'guard').mockResolvedValue(undefined);
      const recordFailure = jest.spyOn(breakers, 'recordFailure').mockResolvedValue(undefined);
      jest.spyOn(rateLimiter, 'tryAcquire').mockResolvedValue(true);
      jest.spyOn(scoped as any, 'clientFor').mockReturnValue({
        messages: { create: jest.fn().mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 })) },
      });

      await expect(
        scoped.sendFreeform({
          companyId: 'c_1',
          accountSid: 'ACxxx',
          authToken: 'secret',
          from: '+15550001111',
          to: '+15550002222',
          body: 'hi',
        }),
      ).rejects.toThrow('bad request');
      expect(recordFailure).not.toHaveBeenCalled();
    });

    it('refuses the send when the rate-limit budget is exhausted, without calling Twilio', async () => {
      jest.spyOn(breakers, 'guard').mockResolvedValue(undefined);
      jest.spyOn(rateLimiter, 'tryAcquire').mockResolvedValue(false);
      const create = jest.fn();
      jest.spyOn(scoped as any, 'clientFor').mockReturnValue({ messages: { create } });

      await expect(
        scoped.sendFreeform({
          companyId: 'c_1',
          accountSid: 'ACxxx',
          authToken: 'secret',
          from: '+15550001111',
          to: '+15550002222',
          body: 'hi',
        }),
      ).rejects.toBeInstanceOf(RateLimitedError);
      expect(create).not.toHaveBeenCalled();
    });

    it('verifyCredentials fetches the Twilio account through the same guard', async () => {
      jest.spyOn(breakers, 'guard').mockResolvedValue(undefined);
      const recordSuccess = jest.spyOn(breakers, 'recordSuccess').mockResolvedValue(undefined);
      jest.spyOn(rateLimiter, 'tryAcquire').mockResolvedValue(true);
      const fetch = jest.fn().mockResolvedValue({ sid: 'ACxxx', status: 'active' });
      jest.spyOn(scoped as any, 'clientFor').mockReturnValue({
        api: { accounts: jest.fn().mockReturnValue({ fetch }) },
      });

      const result = await scoped.verifyCredentials({
        companyId: 'c_1',
        accountSid: 'ACxxx',
        authToken: 'secret',
      });

      expect(result).toEqual({ accountSid: 'ACxxx', status: 'active' });
      expect(fetch).toHaveBeenCalled();
      expect(recordSuccess).toHaveBeenCalledWith('engine:whatsapp:c_1');
    });
  });
});
