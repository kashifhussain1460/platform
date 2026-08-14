import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

export type SuppressionChannel = 'EMAIL' | 'SMS' | 'SOCIAL';

export type SuppressionReason =
  | 'UNSUBSCRIBED'
  | 'BOUNCED'
  | 'COMPLAINED'
  | 'MANUAL'
  | 'CONSENT_WITHDRAWN';

/**
 * WAVE 3 §3.6 — "may we contact this person right now?"
 *
 * The check is deliberately a HARD BLOCK rather than a warning. Sending to a
 * suppressed address is not a degraded outcome that a human can review later:
 * the message has already arrived, and for a spam complaint or an unsubscribe
 * that single send is the compliance breach. There is no partial version of
 * "do not contact".
 *
 * Consent and suppression are kept apart on purpose. Consent is EVIDENCE (who
 * agreed, when, how). Suppression is an INSTRUCTION (never send here). They
 * diverge in both directions: a bounce suppresses an address that never gave
 * consent, and a withdrawal must create a suppression rather than merely delete
 * an old record.
 */
@Injectable()
export class SuppressionService {
  private readonly logger = new Logger(SuppressionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Normalise before comparing.
   *
   * A suppression that misses because the sender wrote `Alice@Example.COM` and
   * the unsubscribe recorded `alice@example.com` is worse than no list at all —
   * it reports protection it does not provide.
   */
  static normalize(address: string): string {
    return address.trim().toLowerCase();
  }

  /** Suppressed addresses among `addresses`, normalised. Empty = all sendable. */
  async findSuppressed(
    companyId: string,
    channel: SuppressionChannel,
    addresses: readonly string[],
  ): Promise<string[]> {
    const normalized = [
      ...new Set(addresses.map(SuppressionService.normalize).filter(Boolean)),
    ];
    if (normalized.length === 0) return [];

    const rows = await this.prisma.marketingSuppression.findMany({
      where: { companyId, channel, address: { in: normalized } },
      select: { address: true },
    });
    return rows.map((r) => r.address);
  }

  async isSuppressed(
    companyId: string,
    channel: SuppressionChannel,
    address: string,
  ): Promise<boolean> {
    return (await this.findSuppressed(companyId, channel, [address])).length > 0;
  }

  /**
   * Add an address to the list. Idempotent: a second unsubscribe, or a bounce
   * for an already-suppressed address, must not error — a provider will send
   * both, and a failing webhook handler retries for ever.
   */
  async suppress(input: {
    companyId: string;
    channel: SuppressionChannel;
    address: string;
    reason: SuppressionReason;
    source?: string;
  }): Promise<void> {
    const address = SuppressionService.normalize(input.address);
    if (!address) return;
    await this.prisma.marketingSuppression.upsert({
      where: {
        companyId_channel_address: {
          companyId: input.companyId,
          channel: input.channel,
          address,
        },
      },
      create: {
        companyId: input.companyId,
        channel: input.channel,
        address,
        reason: input.reason,
        source: input.source ?? null,
      },
      // Keep the ORIGINAL reason and timestamp: the first suppression is the one
      // that matters evidentially, and overwriting it would lose when the
      // obligation actually started.
      update: {},
    });
    this.logger.log(
      `suppressed ${input.channel} address for company=${input.companyId} reason=${input.reason}`,
    );
  }

  /**
   * Remove a suppression — only ever a deliberate admin act, and audited by the
   * caller. Not exposed to automation: nothing the platform decides on its own
   * should be able to re-enable contact with someone who opted out.
   */
  async unsuppress(
    companyId: string,
    channel: SuppressionChannel,
    address: string,
  ): Promise<void> {
    await this.prisma.marketingSuppression.deleteMany({
      where: {
        companyId,
        channel,
        address: SuppressionService.normalize(address),
      },
    });
  }

  list(companyId: string, channel?: SuppressionChannel) {
    return this.prisma.marketingSuppression.findMany({
      where: { companyId, ...(channel ? { channel } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  // --- Consent ---------------------------------------------------------------

  /**
   * Record a consent decision. Append-only: a withdrawal is a NEW row, so the
   * history of what someone agreed to and when survives. In a dispute the
   * question is never "is the flag true" but "what exactly did they agree to,
   * when, and how do you know".
   *
   * A withdrawal ALSO suppresses, because a consent record nothing enforces is
   * decoration.
   */
  async recordConsent(input: {
    companyId: string;
    channel: SuppressionChannel;
    address: string;
    status: 'GRANTED' | 'WITHDRAWN';
    source: string;
    evidence?: Record<string, unknown>;
  }): Promise<void> {
    const address = SuppressionService.normalize(input.address);
    if (!address) return;

    await this.prisma.marketingConsent.create({
      data: {
        companyId: input.companyId,
        channel: input.channel,
        address,
        status: input.status,
        source: input.source,
        evidence: (input.evidence ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
      },
    });

    if (input.status === 'WITHDRAWN') {
      await this.suppress({
        companyId: input.companyId,
        channel: input.channel,
        address,
        reason: 'CONSENT_WITHDRAWN',
        source: input.source,
      });
    } else {
      // Granting consent lifts a suppression that came FROM a withdrawal, and
      // only that. A bounce or a spam complaint is a deliverability fact, not a
      // permission one, and re-consenting must not clear it.
      await this.prisma.marketingSuppression.deleteMany({
        where: {
          companyId: input.companyId,
          channel: input.channel,
          address,
          reason: 'CONSENT_WITHDRAWN',
        },
      });
    }
  }

  /** The most recent consent decision for an address, or null. */
  async latestConsent(
    companyId: string,
    channel: SuppressionChannel,
    address: string,
  ) {
    return this.prisma.marketingConsent.findFirst({
      where: {
        companyId,
        channel,
        address: SuppressionService.normalize(address),
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
