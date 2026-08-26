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
import { ChatwootClientService } from './chatwoot-client.service';
import {
  CHATWOOT_PROVIDER,
  CHATWOOT_SIGNATURE_HEADER,
  CHATWOOT_TIMESTAMP_HEADER,
} from './support.constants';

interface ChatwootWebhookPayload {
  account?: { id?: number | string; name?: string };
  conversation?: { id?: number | string };
  sender?: { email?: string | null };
  message_type?: string;
  content?: string | null;
  id?: number | string;
}

/**
 * PUBLIC Chatwoot Agent-Bot webhook ingress (docs/architecture/engines/
 * chatwoot-engine.md §4/§20 — the Agent Bot / `outgoing_url` seam). Deliberately
 * NOT behind JwtAuthGuard/tenant guard: Chatwoot POSTs here with an HMAC
 * signature, not a JWT — same shape as BillingWebhookController.
 *
 * NON-NEGOTIABLE ORDERING, the entire reason this controller is written this
 * carefully: signature verification MUST complete successfully BEFORE any
 * `SupportConversation`/`SupportMessage` row is read or written, and any
 * failure returns 401 without touching those tables. The Marketing/Postiz
 * engine shipped an unauthenticated webhook write and had to fix it at final
 * review (see MarketingWebhookController's own comment) — this exists so that
 * mistake is not repeated for Support. The one read that happens pre-verification
 * is the `ChatwootAccount` lookup itself, which is required to even know which
 * secret to verify against; it is a read-only lookup keyed by the (untrusted,
 * attacker-controlled) `account.id` in the payload, not a write, and yields
 * nothing back to the caller other than a 401 either way.
 */
@Controller('engines/support/webhook')
export class SupportWebhookController {
  private readonly logger = new Logger(SupportWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chatwootClient: ChatwootClientService,
    private readonly crypto: CryptoService,
    // WAVE 3 §3.4 — RawEvent → dedup → CanonicalEvent → workflow trigger.
    private readonly ingest: CanonicalIngestService,
    private readonly audit: AuditLogService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers(CHATWOOT_SIGNATURE_HEADER) signature?: string,
    @Headers(CHATWOOT_TIMESTAMP_HEADER) timestamp?: string,
  ): Promise<{ ok: boolean }> {
    if (!req.rawBody) {
      throw new UnauthorizedException('Missing request body');
    }
    const rawBody = req.rawBody.toString('utf8');

    let payload: ChatwootWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as ChatwootWebhookPayload;
    } catch {
      throw new UnauthorizedException('Invalid payload');
    }

    const chatwootAccountId = idToString(payload.account?.id);
    if (!chatwootAccountId) {
      throw new UnauthorizedException('Missing account context');
    }

    // Resolve which company this claims to be from. S-07: chatwootAccountId
    // is now @unique (it is the webhook's own auth lookup key — a duplicate
    // here would be a cross-tenant risk, not just a data-quality one), so
    // this is a findUnique, not the findFirst it used to be.
    const account = await this.prisma.chatwootAccount.findUnique({
      where: { chatwootAccountId },
    });
    if (!account) {
      throw new UnauthorizedException('Unknown Chatwoot account');
    }

    const webhookSecret = this.crypto.decrypt(account.webhookSecret);
    const verified = this.chatwootClient.verifyWebhookSignature(
      rawBody,
      signature,
      timestamp,
      webhookSecret,
    );
    if (!verified) {
      this.logger.warn(
        `Rejected Chatwoot webhook: signature mismatch for chatwootAccountId=${chatwootAccountId}`,
      );
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // ---- Signature verified. Only past this line may Support* tables be written. ----

    // WAVE 3 §3.4 — the canonical pipeline, and the DEDUP GUARD that makes a
    // redelivery safe. Chatwoot (like every webhook provider) retries on
    // timeout; before this, each retry appended the same SupportMessage again
    // and there was no RawEvent, no CanonicalEvent and no workflow trigger at
    // all — nothing could ever react to a support conversation.
    //
    // Ingest happens BEFORE the local write, so the unique
    // (connectorId, bodyHash) row is what arbitrates concurrent duplicates.
    const ingest = await this.ingest.ingestVerified({
      companyId: account.companyId,
      // The engine's own account row stands in for a connector here; RawEvent
      // has no FK on connectorId precisely so both kinds can share the log.
      connectorId: account.id,
      provider: CHATWOOT_PROVIDER,
      rawBody: req.rawBody,
      headers: {
        [CHATWOOT_SIGNATURE_HEADER]: signature ?? null,
        [CHATWOOT_TIMESTAMP_HEADER]: timestamp ?? null,
      },
      // Enrich the stored payload with the two facts the pure mapper cannot
      // derive on its own: whether this is the conversation's first message
      // (NEW_TICKET vs TICKET_REPLIED) and the resolved conversation id.
      payload: await this.enrichForMapping(account.companyId, payload),
    });

    if (ingest.deduped) {
      // Already accepted. Returning 200 stops the provider retrying, and doing
      // nothing further is what keeps the side effects at-most-once.
      this.logger.log(
        `Duplicate Chatwoot delivery ignored (account=${chatwootAccountId})`,
      );
      return { ok: true };
    }

    await this.applyPayload(account.companyId, account.id, payload);
    await this.audit.record({
      companyId: account.companyId,
      action: 'support.webhook.received',
      entityType: 'RawEvent',
      entityId: ingest.rawEventId ?? undefined,
      metadata: {
        provider: CHATWOOT_PROVIDER,
        conversationId: idToString(payload.conversation?.id) ?? null,
        messageType: payload.message_type ?? null,
      },
    });
    return { ok: true };
  }

  /**
   * Add the facts a PURE mapper cannot compute: the mapper has no database, so
   * "is this the first message on this conversation?" — the difference between
   * NEW_TICKET and TICKET_REPLIED — has to be resolved here.
   */
  private async enrichForMapping(
    companyId: string,
    payload: ChatwootWebhookPayload,
  ): Promise<Record<string, unknown>> {
    const conversationId = idToString(payload.conversation?.id);
    let isFirstMessage = false;
    if (conversationId) {
      const existing = await this.prisma.supportConversation.findFirst({
        where: { companyId, chatwootConversationId: conversationId },
        select: { id: true },
      });
      isFirstMessage = !existing;
    }
    return {
      ...(payload as unknown as Record<string, unknown>),
      __conversationId: conversationId ?? null,
      __isFirstMessage: isFirstMessage,
    };
  }

  private async applyPayload(
    companyId: string,
    chatwootAccountRowId: string,
    payload: ChatwootWebhookPayload,
  ): Promise<void> {
    const chatwootConversationId = idToString(payload.conversation?.id);
    if (!chatwootConversationId) {
      // Account/inbox-level event with no conversation context — nothing to record.
      return;
    }

    const contactEmail = payload.sender?.email ?? undefined;
    // S-07: an atomic upsert, not a findFirst-then-create/update. The old
    // check-then-act had a real TOCTOU window — two near-simultaneous first
    // messages on a brand-new conversation could both miss the findFirst and
    // both create, silently splitting message history. Postgres resolves the
    // race at the constraint level (INSERT ... ON CONFLICT DO UPDATE), so
    // whichever request loses the race is routed into the update branch by
    // the DB itself instead of throwing.
    const conversation = await this.prisma.supportConversation.upsert({
      where: {
        companyId_chatwootConversationId: { companyId, chatwootConversationId },
      },
      update: {
        lastMessageAt: new Date(),
        ...(contactEmail ? { contactEmail } : {}),
      },
      create: {
        companyId,
        chatwootAccountId: chatwootAccountRowId,
        chatwootConversationId,
        contactEmail,
        lastMessageAt: new Date(),
      },
    });

    // Only an inbound customer message becomes a SupportMessage row here;
    // outbound replies are recorded where they're sent (RealSkillExecutor's
    // Chatwoot sendReply path), not re-derived from this webhook's own
    // `outgoing`/`activity`/`template` deliveries.
    if (payload.message_type === 'incoming' && payload.content) {
      await this.prisma.supportMessage.create({
        data: {
          companyId,
          conversationId: conversation.id,
          chatwootMessageId: idToString(payload.id) ?? null,
          direction: 'IN',
          content: payload.content,
        },
      });
    }
  }
}

function idToString(id: number | string | undefined | null): string | undefined {
  return id === undefined || id === null ? undefined : String(id);
}
