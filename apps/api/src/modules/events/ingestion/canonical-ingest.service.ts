import { createHash } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EVENT_NORMALIZE_JOB,
  EVENT_NORMALIZE_QUEUE,
  type NormalizeJobData,
} from '../events.constants';

export interface VerifiedIngestInput {
  companyId: string;
  /**
   * The thing that received this event. For a connector webhook that is the
   * `InstalledSkill` id; for an engine webhook it is the engine's own account
   * row (`ChatwootAccount.id`, `PlaneWorkspace.id`). `RawEvent.connectorId` has
   * no foreign key precisely so both can share the log — the pairing with
   * `externalId` is what has to be unique, not what kind of thing it points at.
   */
  connectorId: string;
  provider: string;
  /** The exact bytes whose signature was verified — the dedupe key is its hash. */
  rawBody: Buffer;
  headers: Record<string, unknown>;
  payload: unknown;
}

export interface VerifiedIngestResult {
  deduped: boolean;
  rawEventId: string | null;
}

/**
 * WAVE 3 §3.2 — the shared tail of the canonical event pipeline.
 *
 * ```
 * Webhook → Signature Verification → RawEvent → Dedup → CanonicalEvent
 *         → Tenant Resolution → Trigger Matching → Durable Workflow Run
 * ```
 *
 * The first two steps are provider-specific and MUST stay with the engine that
 * owns them — the plan is explicit that Plane does not sign the way Chatwoot
 * does, and Chatwoot's scheme includes a timestamp neither of the others use.
 * Everything after verification is identical for every provider, and that is
 * what lives here.
 *
 * Before this, the Chatwoot webhook verified its HMAC and then wrote
 * `SupportConversation` / `SupportMessage` directly: no RawEvent, no dedup, no
 * CanonicalEvent, no workflow trigger, no audit. A redelivery — which every
 * webhook provider does on timeout — appended the same message again, and no
 * workflow could ever react to a support conversation at all.
 */
@Injectable()
export class CanonicalIngestService {
  private readonly logger = new Logger(CanonicalIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(EVENT_NORMALIZE_QUEUE)
    private readonly queue: Queue<NormalizeJobData>,
  ) {}

  /**
   * Record an ALREADY-VERIFIED provider delivery and hand it to normalization.
   *
   * Call this only after the caller's own signature check has passed. It writes
   * `signatureVerified: true` and does not re-check, because it cannot: the
   * scheme belongs to the provider.
   *
   * `deduped: true` means this exact signed body was already accepted. Callers
   * MUST treat that as "do nothing further" — it is the guard that makes a
   * provider redelivery safe.
   */
  async ingestVerified(
    input: VerifiedIngestInput,
  ): Promise<VerifiedIngestResult> {
    // Keyed on a hash of the SIGNED BODY, not on a delivery-id header. The HMAC
    // covers the body but not the header, so an attacker holding one captured
    // valid request could replay it with a mutated header and defeat
    // header-based dedupe — each replay minting a fresh RawEvent → workflow run
    // with real side effects. Same reasoning as the connector path.
    const externalId = `sha256:${createHash('sha256')
      .update(input.rawBody)
      .digest('hex')}`;

    const existing = await this.prisma.rawEvent.findUnique({
      where: {
        connectorId_externalId: { connectorId: input.connectorId, externalId },
      },
    });
    if (existing) {
      this.logger.debug(
        `duplicate ${input.provider} delivery ignored connector=${input.connectorId}`,
      );
      return { deduped: true, rawEventId: existing.id };
    }

    let raw;
    try {
      raw = await this.prisma.rawEvent.create({
        data: {
          companyId: input.companyId,
          connectorId: input.connectorId,
          provider: input.provider,
          externalId,
          signatureVerified: true,
          headers: input.headers as Prisma.InputJsonObject,
          payload: this.toJsonPayload(input.payload),
          status: 'RECEIVED',
        },
      });
    } catch (err) {
      // Two concurrent deliveries of the same body: the loser is a duplicate.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const winner = await this.prisma.rawEvent.findUnique({
          where: {
            connectorId_externalId: {
              connectorId: input.connectorId,
              externalId,
            },
          },
        });
        return { deduped: true, rawEventId: winner?.id ?? null };
      }
      throw err;
    }

    await this.queue.add(
      EVENT_NORMALIZE_JOB,
      { rawEventId: raw.id, companyId: input.companyId },
      { removeOnComplete: true, removeOnFail: 100 },
    );

    return { deduped: false, rawEventId: raw.id };
  }

  /** Prisma's Json column rejects a bare scalar; wrap anything non-object. */
  private toJsonPayload(payload: unknown): Prisma.InputJsonValue {
    if (payload && typeof payload === 'object') {
      return payload as Prisma.InputJsonValue;
    }
    return { value: payload ?? null } as Prisma.InputJsonValue;
  }
}
