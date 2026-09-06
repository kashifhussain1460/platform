import {
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { AuditLogService } from '../../audit/audit-log.service';
import { CanonicalIngestService } from '../../events/ingestion/canonical-ingest.service';
import { TwilioWhatsappClientService } from './twilio-whatsapp-client.service';
import { TWILIO_SIGNATURE_HEADER, WHATSAPP_PROVIDER } from './whatsapp.constants';

interface TwilioInboundPayload {
  MessageSid?: string;
  From?: string;
  To?: string;
  Body?: string;
}

/**
 * PUBLIC Twilio inbound-message webhook (docs/plans/2026-09-06-whatsapp-sales-engine-plan.md §4).
 * Deliberately NOT behind JwtAuthGuard/tenant guard — Twilio POSTs here
 * form-encoded, signed with X-Twilio-Signature, not a JWT.
 *
 * NON-NEGOTIABLE ORDERING (the same discipline support-webhook.controller.ts
 * documents, learned from Postiz's webhook shipping unauthenticated and
 * needing a final-review fix): signature verification MUST complete
 * successfully BEFORE any Lead/Conversation/Message row is read or written.
 * The one pre-verification read is the WhatsAppAccount lookup by the
 * (untrusted) `To` number — required to know which auth token to verify
 * against — read-only, yields nothing but a 401 either way.
 */
@Controller('engines/whatsapp/webhook')
export class WhatsappWebhookController {
  private readonly logger = new Logger(WhatsappWebhookController.name);

  constructor(
    private readonly twilioClient: TwilioWhatsappClientService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly ingest: CanonicalIngestService,
    private readonly audit: AuditLogService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers(TWILIO_SIGNATURE_HEADER) signature?: string,
  ): Promise<{ ok: boolean }> {
    if (!signature) {
      throw new UnauthorizedException('Missing X-Twilio-Signature header');
    }
    const params = req.body as TwilioInboundPayload;
    const toNumber = params.To?.replace(/^whatsapp:/, '');
    if (!toNumber) {
      throw new UnauthorizedException('Missing To number');
    }

    // whatsappSenderNumber is unique per-company (@@unique([companyId, whatsappSenderNumber])),
    // NOT globally unique, so this lookup can in principle match >1 row. In production a real
    // WhatsApp Business Account number can only be registered to one Twilio (sub)account at a
    // time, so a genuine collision between two different Orlixa companies' real numbers isn't
    // realistically possible. The one known collision case is Twilio's shared WhatsApp Sandbox
    // test number, used identically by every trial account during dev/onboarding — a documented,
    // accepted risk for non-production use. orderBy makes the (otherwise arbitrary) choice
    // between colliding rows deterministic/reproducible rather than whatever Postgres returns first.
    const account = await this.prisma.whatsAppAccount.findFirst({
      where: { whatsappSenderNumber: toNumber },
      orderBy: { createdAt: 'asc' },
    });
    if (!account) {
      throw new UnauthorizedException('Unknown WhatsApp sender number');
    }

    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const authToken = this.crypto.decrypt(account.twilioAuthToken);
    const verified = this.twilioClient.verifyWebhookSignature(
      authToken,
      signature,
      url,
      params as unknown as Record<string, unknown>,
    );
    if (!verified) {
      this.logger.warn(`Rejected WhatsApp webhook: signature mismatch for account=${account.id}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // ---- Signature verified. Only past this line may Lead/Conversation/Message tables be written. ----

    const rawBody = req.rawBody ?? Buffer.from(new URLSearchParams(params as Record<string, string>).toString());
    const ingestResult = await this.ingest.ingestVerified({
      companyId: account.companyId,
      connectorId: account.id,
      provider: WHATSAPP_PROVIDER,
      rawBody,
      headers: { [TWILIO_SIGNATURE_HEADER]: signature },
      payload: params,
    });

    if (ingestResult.deduped) {
      this.logger.log(`Duplicate WhatsApp delivery ignored (sid=${params.MessageSid})`);
      return { ok: true };
    }

    await this.audit.record({
      companyId: account.companyId,
      action: 'whatsapp.webhook.received',
      entityType: 'RawEvent',
      entityId: ingestResult.rawEventId ?? undefined,
      metadata: { provider: WHATSAPP_PROVIDER, from: params.From ?? null, messageSid: params.MessageSid ?? null },
    });
    return { ok: true };
  }
}
