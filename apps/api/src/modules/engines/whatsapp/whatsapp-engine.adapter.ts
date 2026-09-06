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
    return ['disconnect', 'healthCheck', 'refresh', 'handleWebhook'];
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
   * Signature verification only — ingestion stays in WhatsappWebhookController
   * (Task 7), which resolves the tenant and calls the canonical pipeline. A
   * second ingress path is what this codebase's §37 forbids (see
   * ChatwootEngineAdapter's identical doc comment).
   */
  async handleWebhook(input: {
    rawBody: Buffer;
    headers: Record<string, string | undefined>;
  }): Promise<EngineWebhookResult> {
    void input;
    // Twilio's signature covers the URL + parsed form params, not the raw
    // body bytes alone — verification needs the resolved account's auth
    // token AND the exact request URL, both of which only the controller
    // has. This method exists to satisfy the EngineAdapter contract's
    // capability declaration; the real check happens in the controller,
    // matching the note in engine-adapter.ts that ingestion stays out of
    // the adapter.
    return { verified: false };
  }
}
