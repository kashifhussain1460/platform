import twilio from 'twilio';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerRegistry } from '../../../common/resilience/circuit-breaker.registry';
import { RateLimiter } from '../../../common/resilience/rate-limiter';
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
});
