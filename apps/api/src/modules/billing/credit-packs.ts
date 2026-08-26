import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { CreditPack } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Credit system Phase 5 (PAYG), Task 5.1 — the DB-authoritative `CreditPack`
 * catalog with a checked-in bootstrap list, mirroring `billing.plans.ts`'s
 * `PLAN_CATALOG` shape (§16 Option C's hybrid pattern applied to packs):
 * code is the source of truth for WHICH packs exist and their validation
 * keys; the DB row is the source of truth for the numbers, so a price
 * correction is a data change, never a deploy.
 */
export interface DefaultCreditPack {
  packKey: string;
  displayName: string;
  /** // FOUNDER-PENDING: illustrative sizes/prices — see §18/§40 of the plan. */
  creditAmount: number;
  bonusPercent: number;
  priceUsd: number;
}

/** Valid `packKey`s, for DTO validation — the set of packs code knows how to reason about. */
export const CREDIT_PACK_IDS = ['SMALL', 'MEDIUM', 'LARGE'] as const;
export type CreditPackId = (typeof CREDIT_PACK_IDS)[number];

/**
 * // FOUNDER-PENDING: every number below is illustrative, pending founder
 * approval (§18/§40) — chosen only to be internally consistent (bigger pack
 * = better $/credit rate) and easy to reason about in tests, not derived
 * from any real cost or market analysis.
 */
export const DEFAULT_CREDIT_PACKS: DefaultCreditPack[] = [
  { packKey: 'SMALL', displayName: 'Small top-up', creditAmount: 1_000, bonusPercent: 0, priceUsd: 10 },
  { packKey: 'MEDIUM', displayName: 'Medium top-up', creditAmount: 5_500, bonusPercent: 10, priceUsd: 50 },
  { packKey: 'LARGE', displayName: 'Large top-up', creditAmount: 12_000, bonusPercent: 20, priceUsd: 100 },
];

/** Idempotent upsert on `packKey` + `effectiveFrom` — shared by boot self-seed and the standalone script, so the two paths never drift. */
export async function seedCreditPacks(prisma: PrismaService): Promise<number> {
  let count = 0;
  for (const pack of DEFAULT_CREDIT_PACKS) {
    const existing = await prisma.creditPack.findFirst({
      where: { packKey: pack.packKey, active: true },
    });
    if (existing) continue;
    await prisma.creditPack.create({
      data: {
        packKey: pack.packKey,
        displayName: pack.displayName,
        creditAmount: pack.creditAmount,
        bonusPercent: pack.bonusPercent,
        priceUsd: pack.priceUsd,
        stripePriceId: (process.env[`STRIPE_PRICE_CREDITS_${pack.packKey}`] ?? '').trim() || null,
        active: true,
      },
    });
    count += 1;
  }
  return count;
}

@Injectable()
export class CreditPackCatalogService implements OnModuleInit {
  private readonly logger = new Logger(CreditPackCatalogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Self-seeds the first-party catalog on boot (mirrors WorkflowTemplatesModule's own pattern) — safe to run on every boot, upsert-shaped. */
  async onModuleInit(): Promise<void> {
    const created = await seedCreditPacks(this.prisma);
    if (created > 0) {
      this.logger.log(`seeded ${created} credit pack(s)`);
    }
  }

  /** Active, currently-effective packs, in catalog order. */
  async listActive(): Promise<CreditPack[]> {
    const now = new Date();
    const rows = await this.prisma.creditPack.findMany({
      where: {
        active: true,
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
    });
    const order = new Map(CREDIT_PACK_IDS.map((id, i) => [id, i]));
    return rows.sort((a, b) => (order.get(a.packKey as CreditPackId) ?? 99) - (order.get(b.packKey as CreditPackId) ?? 99));
  }
}
