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
import { ChatwootClientService } from './chatwoot-client.service';

/**
 * §39 — Chatwoot, behind the shared connector contract.
 *
 * Thin delegation to `ChatwootClientService`. Note what it does NOT do: no
 * credential decryption beyond the one lookup verification needs, no audit, no
 * retry. Those belong to the platform layers, and an adapter that re-implemented
 * them would be the second system §55 forbids.
 */
@Injectable()
export class ChatwootEngineAdapter implements EngineAdapter {
  readonly engineKey = 'chatwoot';

  constructor(
    private readonly chatwoot: ChatwootClientService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  capabilities(): readonly EngineCapability[] {
    // `connect` is absent for the same reason as Plane's: `provisionAccount`
    // throws rather than pretending, because the sequence has never been run
    // against a live Chatwoot. Declaring it would hide that.
    return ['disconnect', 'healthCheck', 'refresh', 'handleWebhook'];
  }

  tools(): readonly string[] {
    return ['chatwoot.reply_to_conversation', 'chatwoot.list_conversations'];
  }

  connect(): Promise<never> {
    return Promise.reject(
      new EngineCapabilityUnsupportedError(
        this.engineKey,
        'connect',
        'account provisioning needs a live Chatwoot instance to verify the sequence against; an account is registered out of band today',
      ),
    );
  }

  async disconnect(companyId: string): Promise<void> {
    await this.prisma.chatwootAccount.deleteMany({ where: { companyId } });
  }

  async healthCheck(companyId: string): Promise<EngineHealth> {
    const account = await this.prisma.chatwootAccount.findFirst({
      where: { companyId },
      select: { id: true },
    });
    return account
      ? { ok: true }
      : { ok: false, detail: 'no Chatwoot account is registered for this company' };
  }

  refresh(): Promise<void> {
    // An agent-bot token does not expire, so there is nothing to refresh.
    return Promise.resolve();
  }

  reconcile(): Promise<{ checked: number; updated: number }> {
    return Promise.reject(
      new EngineCapabilityUnsupportedError(
        this.engineKey,
        'reconcile',
        'conversations are event-driven; Chatwoot state is not mirrored locally',
      ),
    );
  }

  /**
   * Verify an inbound delivery. Chatwoot's HMAC covers `timestamp.body` and is
   * NOT Plane's scheme — sharing a verifier between them would have to guess,
   * and a signature check that guesses is not a signature check.
   *
   * Ingestion stays in `SupportWebhookController`, which resolves the tenant and
   * calls the canonical pipeline; a second ingress path is what §37 forbids.
   */
  async handleWebhook(input: {
    rawBody: Buffer;
    headers: Record<string, string | undefined>;
  }): Promise<EngineWebhookResult> {
    const signature = input.headers['x-chatwoot-signature'];
    if (!signature) return { verified: false };

    let payload: { account?: { id?: unknown } };
    try {
      payload = JSON.parse(input.rawBody.toString('utf8')) as {
        account?: { id?: unknown };
      };
    } catch {
      return { verified: false };
    }

    const accountId = payload.account?.id;
    if (accountId == null) return { verified: false };

    const account = await this.prisma.chatwootAccount.findFirst({
      where: { chatwootAccountId: String(accountId) },
      select: { webhookSecret: true },
    });
    if (!account?.webhookSecret) return { verified: false };

    // Chatwoot signs `timestamp.body`, so the timestamp header is part of the
    // signature — not decoration. Missing it means the delivery cannot be
    // verified, and the verifier says so rather than ignoring the field.
    return {
      verified: this.chatwoot.verifyWebhookSignature(
        input.rawBody.toString('utf8'),
        signature,
        input.headers['x-chatwoot-timestamp'],
        this.crypto.decrypt(account.webhookSecret),
      ),
    };
  }
}
