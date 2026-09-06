import { Injectable } from '@nestjs/common';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EngineCapabilityUnsupportedError,
  type EngineAdapter,
  type EngineCapability,
  type EngineHealth,
  type EngineWebhookResult,
} from '../engine-adapter';
import { TwilioWhatsappClientService } from './twilio-whatsapp-client.service';

/**
 * §39 — WhatsApp (via Twilio), behind the shared connector contract.
 *
 * Thin delegation to TwilioWhatsappClientService, mirroring
 * ChatwootEngineAdapter exactly: no credential decryption beyond the one
 * lookup verification needs, no audit, no retry — those belong to the
 * platform layers.
 *
 * `connect` is unsupported here for the same reason as Chatwoot's: account
 * provisioning is a manual "paste your Twilio SID/token/sender number" form
 * on the frontend (Task 12), not a browser OAuth redirect, so there is no
 * server-side handshake for this method to perform.
 *
 * `handleWebhook` is likewise not declared in `capabilities()`: Twilio
 * signature verification needs the full reconstructed request URL, which
 * only WhatsappWebhookController (Task 7) has, so this adapter can never
 * perform a real verification. Rather than declare the capability and
 * return a stubbed `{ verified: false }` — which would fail every real
 * delivery if anything ever dispatched to it — the method throws
 * `EngineCapabilityUnsupportedError`, and the webhook controller never
 * calls it, mirroring how `SupportWebhookController` never calls
 * `ChatwootEngineAdapter.handleWebhook` either.
 */
@Injectable()
export class WhatsappEngineAdapter implements EngineAdapter {
  readonly engineKey = 'whatsapp';

  constructor(
    private readonly client: TwilioWhatsappClientService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  capabilities(): readonly EngineCapability[] {
    return ['disconnect', 'healthCheck', 'refresh'];
  }

  tools(): readonly string[] {
    return ['whatsapp.send_message', 'whatsapp.send_template', 'whatsapp.get_conversation'];
  }

  connect(): Promise<never> {
    return Promise.reject(
      new EngineCapabilityUnsupportedError(
        this.engineKey,
        'connect',
        'account connection is a direct Twilio-credentials form (frontend), not a server-side OAuth handshake',
      ),
    );
  }

  async disconnect(companyId: string): Promise<void> {
    await this.prisma.whatsAppAccount.deleteMany({ where: { companyId } });
  }

  async healthCheck(companyId: string): Promise<EngineHealth> {
    const account = await this.prisma.whatsAppAccount.findFirst({
      where: { companyId },
      select: { id: true },
    });
    return account
      ? { ok: true }
      : { ok: false, detail: 'no WhatsApp account is registered for this company' };
  }

  refresh(): Promise<void> {
    // A Twilio Account SID/Auth Token pair does not expire, so there is nothing to refresh.
    return Promise.resolve();
  }

  reconcile(): Promise<{ checked: number; updated: number }> {
    return Promise.reject(
      new EngineCapabilityUnsupportedError(
        this.engineKey,
        'reconcile',
        'conversations are event-driven via the inbound webhook; no local state mirrors a remote poll',
      ),
    );
  }

  /**
   * Not declared in `capabilities()`: Twilio's signature covers the full
   * reconstructed request URL plus the parsed form params, not the raw body
   * bytes alone — verification needs the resolved account's auth token AND
   * the exact request URL, and only WhatsappWebhookController (Task 7) has
   * both. There is no way for this adapter to do real, load-bearing
   * verification, so — matching how `connect()` is excluded above for the
   * same reason — the capability is correctly left off the "honest half" of
   * the contract rather than declared and then never able to return
   * `verified: true`. The method itself still exists (the interface
   * requires it) but throws instead of pretending to check anything.
   */
  handleWebhook(input: {
    rawBody: Buffer;
    headers: Record<string, string | undefined>;
  }): Promise<EngineWebhookResult> {
    void input;
    return Promise.reject(
      new EngineCapabilityUnsupportedError(
        this.engineKey,
        'handleWebhook',
        'Twilio signature verification needs the full reconstructed request URL, only available in the webhook controller — verification happens there, not in this adapter',
      ),
    );
  }
}
