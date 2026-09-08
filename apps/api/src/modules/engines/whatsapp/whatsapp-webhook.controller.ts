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
import { Prisma } from '@prisma/client';
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

    // `req.protocol` is only `https` when Express has been told to trust the
    // proxy that terminated TLS — `configureApp()` sets `trust proxy` for
    // exactly this reason. Without it every real (proxied) delivery would
    // reconstruct `http://…` while Twilio signed `https://…` and 401.
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

    // THE step that makes this feature exist. Task 7 originally deferred it to
    // "whatever consumes the NEW_LEAD canonical event" — and nothing ever did,
    // so `prisma.lead.create`/`upsert` appeared nowhere in the repository: the
    // Leads screen was permanently empty, all three `whatsapp.*` tools always
    // answered "Lead not found", and `send_message`'s 24h-window check could
    // never pass because no `Message` with `role: 'USER'` was ever written.
    //
    // It runs BEFORE `ingestVerified` on purpose: the canonical event's `data`
    // has to carry the real `leadId` (that is what the workflow template's
    // `{{trigger.data.leadId}}` binds to), and the mapper is a pure function
    // over the persisted RawEvent payload — so the id must exist before the
    // payload is written. Re-delivery safety does not depend on the ingest
    // dedupe flag: the Lead upsert is idempotent by its own unique key and the
    // Message write is keyed on Twilio's MessageSid (see below).
    const leadId = await this.recordInboundLead(account, params);

    const rawBody = req.rawBody ?? Buffer.from(new URLSearchParams(params as Record<string, string>).toString());
    const ingestResult = await this.ingest.ingestVerified({
      companyId: account.companyId,
      connectorId: account.id,
      provider: WHATSAPP_PROVIDER,
      // `rawBody` (the SIGNED bytes) is what the ingest dedupe hashes, and it is
      // untouched. `payload` carries one extra, clearly-namespaced Orlixa field
      // — `leadId` — because `mapWhatsapp` has no database access and the
      // canonical event is the only channel through which a workflow can learn
      // which Lead a message belongs to.
      rawBody,
      headers: { [TWILIO_SIGNATURE_HEADER]: signature },
      payload: { ...params, leadId },
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
      metadata: {
        provider: WHATSAPP_PROVIDER,
        from: params.From ?? null,
        messageSid: params.MessageSid ?? null,
        leadId,
      },
    });
    return { ok: true };
  }

  /**
   * Turn one verified inbound WhatsApp message into the rows the rest of the
   * product reads: a `Lead`, its `Conversation`, and a `Message` for the text
   * the customer actually sent.
   *
   * Returns the Lead id (or `null` when Twilio sent no `From` number, which is
   * not a thing a real inbound message does but is cheap to be total about).
   *
   * ## Idempotency
   *
   * Twilio retries a delivery whenever this endpoint is slow or errors, so
   * every write here has to survive being run twice:
   *
   * - the **Lead** is an `upsert` on `@@unique([companyId, source, phone])`, so
   *   the second message from the same number reuses the first message's Lead;
   * - the **Conversation** is created only when the Lead has none, and linked
   *   with a guarded `updateMany … WHERE conversationId IS NULL` so two
   *   concurrent deliveries cannot both claim the slot (the loser's empty
   *   Conversation row is simply left unused — harmless, and much cheaper than
   *   a transaction spanning an external redelivery);
   * - the **Message** carries `idempotencyKey = whatsapp:<MessageSid>`, reusing
   *   the `@@unique([conversationId, idempotencyKey])` the chat path already
   *   has, so a redelivered message cannot be appended to the thread twice.
   */
  private async recordInboundLead(
    account: { id: string; companyId: string; employeeId: string | null },
    params: TwilioInboundPayload,
  ): Promise<string | null> {
    const phone = params.From?.replace(/^whatsapp:/, '') ?? null;
    if (!phone) {
      this.logger.warn(
        `Verified WhatsApp delivery with no From number (sid=${params.MessageSid}) — no Lead recorded`,
      );
      return null;
    }

    const now = new Date();
    const lead = await this.prisma.lead.upsert({
      where: {
        companyId_source_phone: {
          companyId: account.companyId,
          source: 'WHATSAPP',
          phone,
        },
      },
      create: {
        companyId: account.companyId,
        source: 'WHATSAPP',
        phone,
        lastContactedAt: now,
      },
      update: { lastContactedAt: now },
    });

    let conversationId = lead.conversationId;
    if (!conversationId) {
      const employeeId = await this.resolveActingEmployeeId(account);
      if (!employeeId) {
        // `Conversation.employeeId` is a required FK, so without an employee
        // there is no thread to attach the message to. The Lead is still
        // recorded (it shows up on /leads with no conversation) rather than
        // dropping a real prospect on the floor — but say so loudly, because
        // this company's WhatsApp number is connected while nothing is staffed
        // to answer it.
        this.logger.warn(
          `No WhatsApp account employee and no ACTIVE SALES AI Employee for company=${account.companyId} — Lead ${lead.id} recorded without a conversation`,
        );
        return lead.id;
      }
      const conversation = await this.prisma.conversation.create({
        data: {
          companyId: account.companyId,
          employeeId,
          title: `WhatsApp ${phone}`,
        },
      });
      const linked = await this.prisma.lead.updateMany({
        where: { id: lead.id, conversationId: null },
        data: { conversationId: conversation.id },
      });
      if (linked.count === 1) {
        conversationId = conversation.id;
      } else {
        // A concurrent delivery linked one first; use theirs so both messages
        // land on the same thread.
        const fresh = await this.prisma.lead.findUnique({
          where: { id: lead.id },
          select: { conversationId: true },
        });
        conversationId = fresh?.conversationId ?? null;
      }
    }

    if (!conversationId) return lead.id;

    try {
      await this.prisma.message.create({
        data: {
          companyId: account.companyId,
          conversationId,
          role: 'USER',
          // Media-only WhatsApp messages carry no Body. An empty string keeps
          // the row (and therefore the 24h window) real rather than skipping
          // the message entirely.
          content: params.Body ?? '',
          idempotencyKey: params.MessageSid ? `whatsapp:${params.MessageSid}` : null,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.log(
          `Redelivered WhatsApp message already on the thread (sid=${params.MessageSid})`,
        );
      } else {
        throw err;
      }
    }

    return lead.id;
  }

  /**
   * Which AI Employee owns this conversation.
   *
   * The `WhatsAppAccount.employeeId` column exists for exactly this (its schema
   * comment points at this file), so a per-employee connection wins. Otherwise
   * fall back to the company's longest-serving ACTIVE, non-archived SALES
   * employee — the role the whole WhatsApp Sales Agent feature is built around.
   *
   * `orderBy createdAt asc` for the same reason the account lookup above has
   * one: a company with two Sales employees must resolve to the SAME one on
   * every message, not to whatever Postgres happens to return first.
   */
  private async resolveActingEmployeeId(account: {
    companyId: string;
    employeeId: string | null;
  }): Promise<string | null> {
    if (account.employeeId) return account.employeeId;
    const employee = await this.prisma.aiEmployee.findFirst({
      where: {
        companyId: account.companyId,
        status: 'ACTIVE',
        role: 'SALES',
        archivedAt: null,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return employee?.id ?? null;
  }
}
